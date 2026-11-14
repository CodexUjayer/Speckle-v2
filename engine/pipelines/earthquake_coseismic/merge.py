"""3.01 earthquake_coseismic: ascending + descending merge.

WHY. One SAR geometry only sees part of the ground. The radar looks sideways, so slopes facing it are squeezed
(foreshortening / layover) and slopes facing away are stretched or shadowed; a single ascending or descending pair
therefore lights up some slopes and misses the others. The two geometries look from opposite sides, so each one
covers the other's blind spots. Before this module the pipeline analysed both but drew only the single best pair.

WHAT. Given the per-pair analyses the pipeline already made (every one lives on the SAME G80 core grid of the tile),
take the best pair of each direction and build, pixel by pixel:

  * geometry_coverage  0 = seen by neither, 1 = ascending only, 2 = descending only, 3 = both
  * detected_merged    0 = nothing detected, 1 = ascending only, 2 = descending only, 3 = both. The detection rule is
                       each geometry's OWN rule (max(k*sigma, floor, iono floor)); a pixel counts when EITHER geometry
                       crosses its own threshold. "Seen by one geometry and quiet" is never turned into "no change":
                       coverage says where a geometry did not look.
  * threshold_merged   the smaller (more sensitive) of the thresholds of the geometries that saw the pixel, in metres.
  * displacement_up / displacement_east   ONLY where both geometries saw the pixel, the event window is known (every
                       pair spans the event, so both measured the same step) and the two look vectors are different
                       enough: line-of-sight values are NOT averaged (they are different projections of the motion);
                       they are solved for the east and up components of the motion with the north component assumed
                       to be zero (the radar is nearly blind to north-south motion). The size of what that assumption
                       ignores is reported (median |north| coefficient of each geometry).

This module only reads analyses and returns arrays and numbers. It decides no verdict: the status, the forward-model
screens and the evidence that drive them still use the single best pair (see verdict.py).
"""
from __future__ import annotations

import numpy as np

from .lib_local import encode_layer

DIRECTION_NAMES = {"A": "ascending", "D": "descending"}


def direction_of(stack) -> str | None:
    """'A' / 'D' from a stack's direction ('A', 'ascending', 'DESCENDING', ...), else None."""
    d = str(getattr(stack, "direction", "") or "").strip().upper()[:1]
    return d if d in ("A", "D") else None


def best_per_direction(analyses: list, directions: dict) -> dict:
    """{'A': analysis, 'D': analysis} (either may be missing). Same tie-break as the verdict's single best pair:
    largest affected area, then most valid pixels. `directions` maps stack_key -> 'A' | 'D' | None."""
    out: dict = {}
    for a in analyses:
        d = directions.get(a.stack_key)
        if d is None or getattr(a, "summary", None) is None:
            continue
        key = (a.summary.affected_area_km2, a.summary.valid_pixels)
        cur = out.get(d)
        if cur is None or key > (cur.summary.affected_area_km2, cur.summary.valid_pixels):
            out[d] = a
    return out


def _pair_info(a) -> dict:
    return {"stack": a.stack_key, "pair_index": a.pair_index, "ref_time": a.ref_time, "sec_time": a.sec_time,
            "granule_ids": list(a.granule_ids), "detected_pixels": int(a.summary.detected_pixels),
            "affected_area_km2": float(a.summary.affected_area_km2)}


def merge(analyses: list, directions: dict, *, event_mode: bool, decompose: bool = True,
          min_geometry_det: float = 0.3) -> dict:
    """-> {"ok": bool, "reason": str|None, ...}. When ok, "arrays" holds the merged rasters (float / uint8 grids on
    the core grid, row 0 = north like every other layer) and "summary" holds plain numbers for the evidence."""
    best = best_per_direction(analyses, directions)
    if "A" not in best or "D" not in best:
        have = ", ".join(DIRECTION_NAMES[k] for k in sorted(best)) or "none"
        return {"ok": False, "reason": f"merge needs an analysed pair from BOTH ascending and descending stacks "
                                       f"(analysed: {have})", "available": sorted(best)}
    a, d = best["A"], best["D"]
    shapes = {np.shape(x.mask) for x in (a, d)} | {np.shape(x.disp) for x in (a, d)}
    if len(shapes) != 1:
        return {"ok": False, "reason": f"ascending and descending pairs are on different grids {sorted(shapes)}; "
                                       "not merged (never resampled silently)", "available": ["A", "D"]}

    seen_a = np.asarray(a.mask, dtype=bool)
    seen_d = np.asarray(d.mask, dtype=bool)
    det_a = np.asarray(a.grids["detected"]) > 0
    det_d = np.asarray(d.grids["detected"]) > 0
    det_a &= seen_a
    det_d &= seen_d

    coverage = (seen_a.astype(np.uint8) + 2 * seen_d.astype(np.uint8)).astype(np.uint8)
    detected = (det_a.astype(np.uint8) + 2 * det_d.astype(np.uint8)).astype(np.uint8)

    thr_a = np.where(seen_a, np.asarray(a.grids["thresholds"], dtype=np.float64), np.nan)
    thr_d = np.where(seen_d, np.asarray(d.grids["thresholds"], dtype=np.float64), np.nan)
    with np.errstate(all="ignore"):
        thr = np.fmin(thr_a, thr_d)                    # fmin ignores a NaN side; NaN only where neither saw it

    px_dx, px_dy = a.pixel_size
    px_km2 = abs(px_dx * px_dy) / 1e6
    n_a_only = int(((coverage == 1)).sum())
    n_d_only = int(((coverage == 2)).sum())
    n_both = int(((coverage == 3)).sum())
    n_union = int((detected > 0).sum())
    best_single = max(int(det_a.sum()), int(det_d.sum()))
    summary = {
        "pairs": {"A": _pair_info(a), "D": _pair_info(d)},
        "pixel_area_km2": px_km2,
        "seen_km2": {"ascending_only": n_a_only * px_km2, "descending_only": n_d_only * px_km2,
                     "both": n_both * px_km2, "either": (n_a_only + n_d_only + n_both) * px_km2},
        "detected_pixels": {"ascending_only": int((detected == 1).sum()), "descending_only": int((detected == 2).sum()),
                            "both": int((detected == 3).sum()), "union": n_union,
                            "best_single_geometry": best_single},
        "detected_km2": {"union": n_union * px_km2, "best_single_geometry": best_single * px_km2,
                         "gained_by_merging": (n_union - best_single) * px_km2},
        "decomposition": {"attempted": False, "reason": None},
        "windows_differ": (a.ref_time, a.sec_time) != (d.ref_time, d.sec_time),
    }
    arrays = {"geometry_coverage": coverage, "detected_merged": detected, "threshold_merged": thr}
    # the same three pictures for EACH geometry alone: this is what the UI's Ascending / Descending switch shows
    # (outside a geometry's coverage: not detected / no threshold / no value, never a made-up zero)
    for tag, x, seen in (("ascending", a, seen_a), ("descending", d, seen_d)):
        arrays[f"detected_{tag}"] = np.where(seen, np.asarray(x.grids["detected"]), 0).astype(np.uint8)
        arrays[f"threshold_{tag}"] = thr_a if tag == "ascending" else thr_d
        arrays[f"displacement_los_{tag}"] = np.where(seen, np.asarray(x.disp, dtype=np.float64), np.nan)

    # ---- east / up decomposition: only where both geometries measured the same event ------------------------
    dec = summary["decomposition"]
    if not decompose:
        dec["reason"] = "switched off (earthquake.merge_decompose = false)"
    elif not event_mode:
        dec["reason"] = ("no event window: the ascending and descending pairs cover different dates, so their line-of-sight "
                         "values are not two views of the same motion; only detection is merged")
    elif a.los_enu is None or d.los_enu is None:
        missing = [DIRECTION_NAMES[k] for k, x in (("A", a), ("D", d)) if x.los_enu is None]
        dec["reason"] = f"line-of-sight vectors missing for {' and '.join(missing)}"
    else:
        la = np.asarray(a.los_enu, dtype=np.float64)
        ld = np.asarray(d.los_enu, dtype=np.float64)
        ea, na, ua = la[0], la[1], la[2]
        ed, nd, ud = ld[0], ld[1], ld[2]
        da = np.asarray(a.disp, dtype=np.float64)
        dd = np.asarray(d.disp, dtype=np.float64)
        sa = np.asarray(a.sigma_eff, dtype=np.float64)
        sd = np.asarray(d.sigma_eff, dtype=np.float64)
        det_m = ea * ud - ed * ua                       # determinant of [[ea, ua], [ed, ud]]
        ok = (seen_a & seen_d & np.isfinite(da) & np.isfinite(dd) & np.isfinite(det_m)
              & (np.abs(det_m) >= float(min_geometry_det)))
        east = np.full(da.shape, np.nan)
        up = np.full(da.shape, np.nan)
        s_e = np.full(da.shape, np.nan)
        s_u = np.full(da.shape, np.nan)
        with np.errstate(all="ignore"):
            east[ok] = ((da * ud - dd * ua) / det_m)[ok]
            up[ok] = ((ea * dd - ed * da) / det_m)[ok]
            sa0 = np.where(np.isfinite(sa), sa, 0.0)
            sd0 = np.where(np.isfinite(sd), sd, 0.0)
            s_e[ok] = (np.sqrt(ud ** 2 * sa0 ** 2 + ua ** 2 * sd0 ** 2) / np.abs(det_m))[ok]
            s_u[ok] = (np.sqrt(ed ** 2 * sa0 ** 2 + ea ** 2 * sd0 ** 2) / np.abs(det_m))[ok]
        n_ok = int(ok.sum())
        dec["n_pixels"] = n_ok
        dec["n_both_seen"] = n_both
        dec["n_rejected_ill_conditioned"] = int((seen_a & seen_d & np.isfinite(det_m) & (np.abs(det_m) < float(min_geometry_det))).sum())
        if n_ok == 0:
            dec["reason"] = ("no pixel was seen by both geometries with look vectors that differ enough "
                             f"(|determinant| >= {min_geometry_det:g})")
        else:
            dec["attempted"] = True
            dec["reason"] = None
            dec["north_assumed_zero"] = True
            dec["median_abs_north_coefficient"] = {
                "ascending": float(np.nanmedian(np.abs(na[ok]))), "descending": float(np.nanmedian(np.abs(nd[ok])))}
            dec["median_sigma_mm"] = {"east": float(np.nanmedian(s_e[ok]) * 1000.0), "up": float(np.nanmedian(s_u[ok]) * 1000.0)}
            dec["max_abs_mm"] = {"east": float(np.nanmax(np.abs(east[ok])) * 1000.0), "up": float(np.nanmax(np.abs(up[ok])) * 1000.0)}
            arrays["displacement_east"] = east
            arrays["displacement_up"] = up
            arrays["sigma_east"] = s_e
            arrays["sigma_up"] = s_u
    return {"ok": True, "reason": None, "available": ["A", "D"], "arrays": arrays, "summary": summary}


def encode_layers(result: dict) -> dict[str, dict]:
    """Merged rasters -> layer payloads (same encoder as every other layer; bounds are added by the caller)."""
    arrays = result["arrays"]
    dec = result["summary"]["decomposition"]
    out: dict[str, dict] = {}
    out["geometry_coverage"] = encode_layer(
        "geometry_coverage", arrays["geometry_coverage"],
        units="0 = seen by neither geometry, 1 = ascending only, 2 = descending only, 3 = both",
        colormap="binary", vmin=0, vmax=3,
        note="Where each geometry actually measured. Quiet pixels seen by only one geometry are not proof of no change "
             "on the slopes the other geometry would have seen.")
    out["geometry_coverage"]["categories"] = [
        {"value": 1, "label": "ascending only", "tone": "positive"},
        {"value": 2, "label": "descending only", "tone": "negative"},
        {"value": 3, "label": "both geometries", "tone": "neutral"},
    ]
    out["detected_merged"] = encode_layer(
        "detected_merged", arrays["detected_merged"],
        units="0 = nothing detected, 1 = ascending only, 2 = descending only, 3 = both",
        colormap="binary", vmin=0, vmax=3,
        note="A pixel is detected when EITHER geometry crosses its own threshold max(k·σ, floor, ionosphere floor). "
             "Direction (toward / away) is not shown: it is relative to each geometry's own line of sight.")
    out["detected_merged"]["categories"] = [
        {"value": 1, "label": "ascending only", "tone": "positive"},
        {"value": 2, "label": "descending only", "tone": "negative"},
        {"value": 3, "label": "both geometries", "tone": "neutral"},
    ]
    out["threshold_merged"] = encode_layer(
        "threshold_merged", arrays["threshold_merged"],
        units="m: smaller of the detection thresholds of the geometries that saw the pixel", colormap="sequential",
        note="Best available sensitivity at each pixel. Detection itself is per geometry (see detected_merged).")
    for tag in ("ascending", "descending"):
        out[f"detected_{tag}"] = encode_layer(
            f"detected_{tag}", arrays[f"detected_{tag}"],
            units=f"1 = toward sensor, 2 = away, 0 = not detected ({tag} pass alone)",
            colormap="binary", vmin=0, vmax=2,
            note=f"Detection by the {tag} pass alone, with its own rule max(k·σ, floor, ionosphere floor). "
                 "Where this pass did not measure (layover, shadow, low coherence) it shows 0, which is NOT proof of no change.")
        out[f"detected_{tag}"]["categories"] = [
            {"value": 1, "label": "toward sensor", "tone": "positive"},
            {"value": 2, "label": "away from sensor", "tone": "negative"},
        ]
        out[f"threshold_{tag}"] = encode_layer(
            f"threshold_{tag}", arrays[f"threshold_{tag}"],
            units=f"m: detection threshold of the {tag} pass alone", colormap="sequential",
            note=f"Sensitivity of the {tag} pass alone; blank where this pass did not measure.")
        out[f"displacement_los_{tag}"] = encode_layer(
            f"displacement_los_{tag}", arrays[f"displacement_los_{tag}"],
            units="m (line of sight, + = toward sensor)", colormap="diverging_teal_terracotta",
            note=f"Line-of-sight movement seen by the {tag} pass alone. It is one projection of the motion; "
                 "it is not averaged with the other pass.")
    if "displacement_up" in arrays:
        n_asc = dec["median_abs_north_coefficient"]["ascending"]
        n_dsc = dec["median_abs_north_coefficient"]["descending"]
        note_n = (f"east and up solved from the two line-of-sight values with north-south motion assumed zero "
                  f"(median north coefficient: ascending {n_asc:.2f}, descending {n_dsc:.2f}; north-south motion leaks "
                  "into east/up by about that fraction). Only where both geometries saw the pixel.")
        out["displacement_up"] = encode_layer(
            "displacement_up", arrays["displacement_up"], units="m (+ = up)",
            colormap="diverging_teal_terracotta", note=note_n)
        out["displacement_east"] = encode_layer(
            "displacement_east", arrays["displacement_east"], units="m (+ = east)",
            colormap="diverging_teal_terracotta", note=note_n)
    return out


def evidence_claim(summary: dict) -> str:
    """One self-contained sentence for the evidence list."""
    a, d = summary["pairs"]["A"], summary["pairs"]["D"]
    det = summary["detected_km2"]
    seen = summary["seen_km2"]
    s = (f"Ascending ({a['stack']}) and descending ({d['stack']}) were merged: together they measured "
         f"{seen['either']:.1f} km² ({seen['both']:.1f} km² by both, {seen['ascending_only']:.1f} ascending only, "
         f"{seen['descending_only']:.1f} descending only). Detected area is {det['union']:.1f} km² merged versus "
         f"{det['best_single_geometry']:.1f} km² for the better single geometry")
    if det["gained_by_merging"] > 0:
        s += f" (+{det['gained_by_merging']:.1f} km² seen only because the other side was added)."
    else:
        s += " (merging added no area)."
    dec = summary["decomposition"]
    if dec.get("n_pixels"):
        s += (f" East and up motion were solved on {dec['n_pixels']} pixels seen by both, assuming no north-south motion.")
    elif dec.get("reason"):
        s += f" East/up decomposition not done: {dec['reason']}."
    if summary["windows_differ"]:
        s += (f" The two pairs cover different dates (ascending {str(a['ref_time'])[:10]}..{str(a['sec_time'])[:10]}, "
              f"descending {str(d['ref_time'])[:10]}..{str(d['sec_time'])[:10]}).")
    return s

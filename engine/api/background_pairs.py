"""Pair workers for the Data Lab's difference view (GET /api/background/diff) — §4.5 extension.

The science the UI must never do: differences and ratios are computed on RAW values, on one
pixel grid, inside the engine — never on rendered PNGs. Everything the single-granule preview
built is reused, not forked:

  * find_granule + decode_granule_id for pair validation (same product / track / frame /
    direction, dates and temporal gap; a mismatch is a 422 with a plain-language reason);
  * ONE provider fetch for BOTH granules (the layer regex hits both clips in a single pass);
  * finite_view's integer-fill masking, to_db, decimate, auto_range(symmetric), render;
  * the preview lock (single concurrent read), the preview cache (render_version included);
  * resample_mean when the two dates sit on different grids of the same CRS (never a reproject).

Honesty rules carried over (§0): a pixel with value <= 0 in EITHER date has no dB value and no
ratio and is NO-DATA (transparent), never a painted value; an all-NaN difference answers 422
with the engine's text, never a blank image; the metadata states the pair, the mode, the dates,
the gap and the numbers — no sentence claims what changed.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from . import background as _bg
from .background import (
    BackgroundError,
    _LAYER_CAP,
    _cache_paths,
    _extent_lonlat,
    _render_notes,
    _take_preview_lock,
    check_range,
    find_granule,
)
# the speckle noise model lives in the common preprocessing (P10); the API only reuses it
from engine.common.p10_temporal_stack import speckle_sigma_db  # noqa: F401  (re-exported: compute_diff and the tests use this name)

# --------------------------------------------------------------------------- #
# which difference modes exist for which layer (engine-decided; the UI mirrors it)
# --------------------------------------------------------------------------- #
DIFF_MODES = ("db_diff", "ratio", "z_db", "coh_diff", "los_m", "los_mm")

# role -> the modes that are defined for it. Phase 1: GCOV backscatter power and GUNW
# coherence. Phase 3: unw_phase -> los_m / los_mm (each granule's phase converted to
# line-of-sight metres with its own referencing, THEN differenced as displacements).
_VALID_BY_ROLE = {
    "cov": ("db_diff", "ratio", "z_db"),
    "unw_coherence": ("coh_diff",),
    "unw_phase": ("los_m", "los_mm"),
}

_MODE_LABELS = {
    "db_diff": "decibel difference (later minus earlier)",
    "ratio": "power ratio (later / earlier)",
    "z_db": "dB change in speckle-noise units (later minus earlier, the preprocessing noise model)",
    "coh_diff": "coherence difference (later minus earlier)",
    "los_m": "line-of-sight displacement difference in metres",
    "los_mm": "line-of-sight displacement difference in millimetres",
}

_MODE_REASONS = {
    "db_diff": "decibel differences are offered for backscatter power layers (GCOV) only",
    "ratio": "power ratios are offered for backscatter power layers (GCOV) only",
    "z_db": "the speckle-normalised change is offered for backscatter power layers (GCOV) only",
    "coh_diff": "coherence differences are offered for interferometric coherence layers (GUNW) only",
    "los_m": "line-of-sight differences are offered for unwrapped phase layers (GUNW) only",
    "los_mm": "line-of-sight differences are offered for unwrapped phase layers (GUNW) only",
}

_PHASE_NOTE = ("unwrappedPhase is already a difference between two dates: subtracting two RAW "
               "interferograms mixes reference phases across (at least) three dates and their "
               "connected components cannot be tied to each other. Use mode los_m / los_mm: each "
               "granule's phase is converted to line-of-sight displacement with its own "
               "referencing first, and the displacements are then differenced")


def diff_modes_for(layer_key: str) -> dict:
    """Every mode -> {valid, reason} for one flat layer key (pure: no provider, no config).
    The engine decides; the UI only mirrors this to enable / disable buttons and show the reason.
    A layer with no known role gets no modes at all — never a guess."""
    from engine.common.layers import parse_layer_key
    info = parse_layer_key(layer_key).info
    if info is None:
        return {m: {"valid": False,
                    "reason": "the engine does not know this layer's role, so no difference is defined for it"}
                for m in DIFF_MODES}
    if info.role == "unw_phase":
        out = {m: {"valid": m in _VALID_BY_ROLE["unw_phase"], "reason": None} for m in DIFF_MODES}
        for m in DIFF_MODES:
            if not out[m]["valid"]:
                out[m]["reason"] = _PHASE_NOTE if m in ("db_diff", "ratio", "z_db", "coh_diff") else _MODE_REASONS[m]
        return out
    valid = _VALID_BY_ROLE.get(info.role, ())
    if not valid:
        return {m: {"valid": False, "reason": _MODE_REASONS[m]} for m in DIFF_MODES}
    return {m: {"valid": m in valid, "reason": None if m in valid else _MODE_REASONS[m]}
            for m in DIFF_MODES}


def resolve_mode(requested: str, layer_key: str) -> str:
    """'auto' (the default) -> the one valid mode for this layer; a named mode -> itself.
    Anything else, or a mode that is not valid for this layer, is a 422 naming the reason."""
    modes = diff_modes_for(layer_key)
    valid = [m for m, v in modes.items() if v["valid"]]
    if requested == "auto":
        if not valid:
            raise BackgroundError(422, f"no difference mode is defined for layer {layer_key!r}: "
                                       + "; ".join(f"{m} — {modes[m]['reason']}" for m in DIFF_MODES))
        return valid[0]
    if requested not in DIFF_MODES:
        raise BackgroundError(400, f"mode {requested!r} not in auto|{'|'.join(DIFF_MODES)}")
    if not modes[requested]["valid"]:
        raise BackgroundError(422, f"{requested} is not defined for layer {layer_key!r}: "
                                   f"{modes[requested]['reason']}")
    return requested


# --------------------------------------------------------------------------- #
# pair validation (decoded facts only — cheap, before any provider read)
# --------------------------------------------------------------------------- #
def _dates_of(dec: dict) -> list:
    """The dates that place this granule in time: both ends for a pair product, else its start."""
    if dec.get("product_decoded") in ("GUNW", "GOFF"):
        return [t for t in (dec.get("ref_time"), dec.get("sec_time")) if t]
    return [t for t in (dec.get("start"),) if t]


def _parse(iso: str):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def validate_pair(dec_a: dict, dec_b: dict) -> dict:
    """Same product / track / frame / direction, or a 422 with a plain-language reason.
    -> the pair facts the metadata reports back (dates, gap, which end is later)."""
    pa, pb = dec_a.get("product_decoded"), dec_b.get("product_decoded")
    if pa is None or pb is None:
        raise BackgroundError(422, "at least one granule matches no verified filename layout — "
                                   "the engine cannot validate the pair")
    if pa != pb:
        raise BackgroundError(422, f"these are different products ({pa} and {pb}): a difference "
                                   "needs the same layer of the same product type on both dates")
    for field in ("track", "frame", "direction"):
        va, vb = dec_a.get(field), dec_b.get(field)
        if va is None or vb is None:
            continue                      # undecoded on one side: stated in the facts, never guessed
        if va != vb:
            raise BackgroundError(422, f"the two granules are not the same acquisition geometry: "
                                       f"{field} {va} vs {vb} — their pixels do not measure the "
                                       "same ground and cannot be differenced")
    da, db = _dates_of(dec_a), _dates_of(dec_b)
    if not da or not db:
        raise BackgroundError(422, "at least one granule has no decoded acquisition date — "
                                   "the temporal gap cannot be stated")
    ta = max(_parse(t) for t in da)
    tb = max(_parse(t) for t in db)
    is_pair = pa in ("GUNW", "GOFF")
    return {
        "product": pa,
        "track": dec_a.get("track"), "frame": dec_a.get("frame"), "direction": dec_a.get("direction"),
        "date_a": dec_a.get("sec_time") if is_pair else da[-1],
        "date_b": dec_b.get("sec_time") if is_pair else db[-1],
        "window_a": da if is_pair else None,
        "window_b": db if is_pair else None,
        "gap_days": round(abs((tb - ta).total_seconds()) / 86400.0, 4),
        "later": "a" if ta > tb else ("b" if tb > ta else None),
        "gap_rule": ("gap between the pairs' secondary (later) dates" if is_pair
                     else "gap between the acquisition dates"),
    }


# --------------------------------------------------------------------------- #
# the math (pure functions: the synthetic-array tests live against these)
# --------------------------------------------------------------------------- #
def compute_diff(view_a, view_b, mode: str, *, looks=None, default_looks: float = 25.0,
                 nochange_k: float | None = None) -> tuple:
    """Two aligned 2-D float views -> (difference, note). For db/ratio/coh the views are RAW
    values (no-data already NaN); for los_m / los_mm they are ALREADY CONVERTED line-of-sight
    displacements (diff() converts each date on its own phase, with its own referencing, then
    aligns). The rule the whole feature hangs on: <= 0 in EITHER date is no-data for dB and
    ratio — a logarithm and a meaningful ratio both need positive power. Coherence and LOS
    subtract directly."""
    import numpy as np
    from . import background_img as bimg
    a = np.asarray(view_a, np.float64)
    b = np.asarray(view_b, np.float64)
    if a.shape != b.shape:
        raise BackgroundError(422, f"the two dates' arrays are not on one grid "
                                   f"({a.shape} vs {b.shape}) and cannot be differenced here")
    if mode in ("los_m", "los_mm"):
        d = (b - a).astype(np.float32)
        note = ("difference of line-of-sight displacements (second granule minus first), each "
                "converted from its own unwrapped phase with its own pair referencing and "
                "unwrapping gate; + toward the sensor"
                + ("; values in millimetres" if mode == "los_mm" else "; values in metres"))
        return d, note
    if mode == "db_diff":
        d = (bimg.to_db(b) - bimg.to_db(a)).astype(np.float32)
        note = ("decibel difference, second date minus first, computed on raw power on one pixel "
                "grid; pixels at or below zero power in either date have no dB value and are no-data")
    elif mode == "ratio":
        ok = np.isfinite(a) & np.isfinite(b) & (a > 0) & (b > 0)
        d = np.full(a.shape, np.nan, np.float32)
        d[ok] = (b[ok] / a[ok]).astype(np.float32)
        note = ("linear power ratio, second date over first, computed on raw power; pixels at or "
                "below zero power in either date are no-data")
    elif mode == "z_db":
        # The preprocessing noise model (P08 dB, P10 speckle floor): one date's dB has a speckle std of
        # 4.343/sqrt(looks); the difference of two independent dates has sqrt(2) times that. z = dB change
        # / that std, so |z| is "how many speckle sigmas": it is the same unit P11's no-change rule uses.
        db = (bimg.to_db(b).astype(np.float64) - bimg.to_db(a).astype(np.float64))
        sigma = np.sqrt(2.0) * speckle_sigma_db(looks, default_looks)
        d = (db / sigma).astype(np.float32)
        s1 = float(np.nanmedian(np.atleast_1d(speckle_sigma_db(looks, default_looks))))
        note = (f"dB change (second minus first) divided by sqrt(2) x the speckle floor 4.343/sqrt(looks) "
                f"({'per-pixel numberOfLooks' if looks is not None else f'assumed {default_looks:g} looks'}"
                f"; one-date floor {s1:.2f} dB) — the preprocessing's own noise model, two dates only "
                "(no multi-date baseline); pixels at or below zero power in either date are no-data")
        if nochange_k is not None:
            fin = np.isfinite(d)
            if fin.any():
                share = float((np.abs(d[fin]) > float(nochange_k)).mean()) * 100.0
                note += (f"; {share:.1f}% of valid pixels lie beyond ±{float(nochange_k):g} sigma "
                         "(the no-change limit of the stable-ground mask, P11)")
    elif mode == "coh_diff":
        d = (b - a).astype(np.float32)
        note = "coherence difference, second date minus first, on raw coherence values"
    else:
        raise BackgroundError(400, f"mode {mode!r} not in {'|'.join(DIFF_MODES)}")
    return d, note


def _looks_on_grid(grid, shape):
    """numberOfLooks of this clip when it sits on the SAME grid as the power layer; None otherwise (the
    caller then states the assumed default looks — never a silent guess)."""
    import numpy as np
    from engine.common.layers import parse_layer_key
    if grid is None:
        return None
    for k in grid.layers:
        if parse_layer_key(k).role == "n_looks":
            arr = grid.layers[k]
            if getattr(arr, "ndim", 2) == 3:
                arr = arr[arr.shape[0] // 2]
            if tuple(arr.shape[-2:]) != tuple(shape):
                return None
            return np.asarray(arr, np.float64)
    return None


def align_pair(grid_a, view_a, grid_b, view_b) -> tuple:
    """Two same-name layers from two clips -> (view_a, view_b, target_grid, facts).
    Same grid -> used as is (an exact pixel-for-pixel difference). Different grids in the SAME
    CRS -> the finer grid is aggregated onto the coarser one with resample_mean (the mean of its
    valid pixels; never an invention). Different CRS -> 422: the engine does not reproject."""
    import numpy as np
    from . import background_img as bimg
    for g in (grid_a, grid_b):
        if getattr(g, "x", None) is None or getattr(g, "y", None) is None:
            raise BackgroundError(422, "one of the two dates has no grid axes for this layer — "
                                       "its pixels cannot be placed")
    same = (grid_a is grid_b) or (
        grid_a.epsg == grid_b.epsg
        and view_a.shape == view_b.shape
        and np.array_equal(np.asarray(grid_a.x), np.asarray(grid_b.x))
        and np.array_equal(np.asarray(grid_a.y), np.asarray(grid_b.y)))
    if same:
        return view_a, view_b, grid_a, {"same_grid": True, "resampled": None}
    if grid_a.epsg != grid_b.epsg:
        raise BackgroundError(422, f"the two dates are on different projections (EPSG:{grid_a.epsg} vs "
                                   f"EPSG:{grid_b.epsg}); the engine does not reproject for a difference")
    dxa = abs(float(grid_a.x[1]) - float(grid_a.x[0])) if len(grid_a.x) > 1 else 0.0
    dxb = abs(float(grid_b.x[1]) - float(grid_b.x[0])) if len(grid_b.x) > 1 else 0.0
    # target = the coarser posting: aggregating loses the least information and never invents values
    if dxa >= dxb:
        target, other, arr_t, arr_o = grid_a, grid_b, view_a, view_b
    else:
        target, other, arr_t, arr_o = grid_b, grid_a, view_b, view_a
    try:
        moved = bimg.resample_mean(arr_o, other.x, other.y, target.x, target.y)
    except ValueError as err:
        raise BackgroundError(422, f"the two dates' grids could not be aligned: {err}") from err
    views = (arr_t, moved) if target is grid_a else (moved, arr_t)
    dx_t = abs(float(target.x[1]) - float(target.x[0])) if len(target.x) > 1 else 0.0
    dx_o = abs(float(other.x[1]) - float(other.x[0])) if len(other.x) > 1 else 0.0
    facts = {"same_grid": False,
             "resampled": f"the {dx_o:g} m grid was aggregated onto the {dx_t:g} m grid "
                          "(mean of the valid finer pixels)"}
    return views[0], views[1], target, facts


# --------------------------------------------------------------------------- #
# GET /api/background/diff  (click-only; clipped; capped; cached; single concurrent)
# --------------------------------------------------------------------------- #
def diff(source, *, id_a: str, id_b: str, layer: str, bbox: tuple, max_px: int,
         mode: str = "auto", cmap: str = "auto", lo: float | None = None, hi: float | None = None,
         use_cache: bool = True, cfg=None) -> dict:
    """-> {png: bytes, meta: {...}} — same response shape as preview(), plus the `diff` block
    (pair facts, gap, validation, per-mode validity, mode notes) and the difference's own stats."""
    import json

    import numpy as np
    from engine.common.grids import edge_corners_lonlat
    from . import background_img as bimg
    from .preview_cfg import PreviewConfigError, load_preview_config
    try:
        cfg = cfg or load_preview_config()
    except PreviewConfigError as err:
        raise BackgroundError(500, str(err))
    if id_a == id_b:
        raise BackgroundError(400, "id_a and id_b are the same granule: a difference needs two dates")
    if cmap not in ("auto", "diverging", "viridis", "magma", "gray"):
        raise BackgroundError(400, f"cmap {cmap!r} not in auto|diverging|viridis|magma|gray")
    max_px = max(16, min(int(max_px or 256), _LAYER_CAP))
    fixed = check_range(lo, hi)
    use_mode = resolve_mode(mode, layer)          # 400/422 before any provider read

    # cache: what was ASKED (ids, layer, mode as resolved, cmap as requested) + the render
    # version — exactly the preview cache's rule, so bumping render_version retires these too.
    png_path, json_path = _cache_paths(
        f"diff:{id_a}|{id_b}", layer, bbox, max_px, cmap, scale=use_mode,
        render_version=cfg.render_version, rng=fixed, quality="",
        extra=("kind=diff",))
    if use_cache and json_path.exists() and png_path.exists():
        try:
            meta = json.loads(json_path.read_text())
            meta["cache_hit"] = True
            return {"png": png_path.read_bytes(), "meta": meta}
        except Exception:
            pass                      # a corrupt cache entry is re-rendered, never served

    _take_preview_lock()
    try:
        ref_a, dec_a = find_granule(source, id_a, bbox)
        ref_b, dec_b = find_granule(source, id_b, bbox)
        pair = validate_pair(dec_a, dec_b)                  # 422 on mismatch, before the fetch

        from engine.common.layers import parse_layer_key
        los_mode = use_mode in ("los_m", "los_mm")
        info = parse_layer_key(layer).info
        if los_mode and (info is None or info.role != "unw_phase"):
            raise BackgroundError(422, f"mode {use_mode!r} differences line-of-sight displacement "
                                       "converted from unwrapped phase; this layer is not an "
                                       "unwrapped phase layer")

        layers = re.escape(layer.replace("__", "/"))
        if los_mode:
            # the connected components ride along (the same gate the pipelines apply), fetched
            # in the same pass for BOTH granules
            layers += r"|/grids/frequency[A-Z]/unwrappedInterferogram/[HV]{2}/connectedComponents$"
        if use_mode == "z_db":
            layers += r"|/grids/frequency[A-Z]/numberOfLooks$"      # the speckle floor's own input (P10)
        fr = source.fetch(tuple(bbox), None, None, None, layers, granules=[ref_a, ref_b])
        if fr.errors:
            gid, why = next(iter(fr.errors.items()))
            raise BackgroundError(502, f"the engine could not read this granule: {gid}: {why}")
        by_id = {c.granule.granule_id: c for c in fr.clips}
        for gid in (id_a, id_b):
            if gid not in by_id:
                why = fr.skipped.get(gid) or "the bbox does not overlap this granule's grids"
                raise BackgroundError(422, f"granule {gid} produced no clip for this box: {why}")
        clip_a, clip_b = by_id[id_a], by_id[id_b]

        def _layer_of(clip, gid):
            for g in clip.grids.values():
                if layer in g.layers:
                    return g, g.layers[layer]
            raise BackgroundError(404, f"layer {layer!r} is not part of granule {gid} "
                                       "(the provider's clip did not include it)")
        grid_a, arr_a = _layer_of(clip_a, id_a)
        grid_b, arr_b = _layer_of(clip_b, id_b)

        view_a = bimg.finite_view(arr_a, mask_int_fill=True)
        view_b = bimg.finite_view(arr_b, mask_int_fill=True)
        los_facts_a = los_facts_b = None
        if los_mode:
            from engine.common.config import load_common_config
            from . import background_los
            common_cfg = load_common_config()
            radar = common_cfg.radar
            cc_min = common_cfg.decode.cc_min

            def _gate_cc(clip, grid, view, gid):
                cc = _bg._conn_comp_on_grid(clip, grid, view.shape[-2:])
                if cc is None:
                    return view, None
                keep = cc >= cc_min
                n = int((~keep & np.isfinite(view)).sum())
                return (np.where(keep, view, np.float32(np.nan)).astype(np.float32),
                        f"{n} of {view.size} pixels in this box have connectedComponents < "
                        f"{cc_min} and are no-data (granule {gid})")

            view_a, gate_a = _gate_cc(clip_a, grid_a, view_a, id_a)
            view_b, gate_b = _gate_cc(clip_b, grid_b, view_b, id_b)
            view_a, los_facts_a = background_los.phase_to_los(view_a, dec_a, radar, mm=(use_mode == "los_mm"))
            view_b, los_facts_b = background_los.phase_to_los(view_b, dec_b, radar, mm=(use_mode == "los_mm"))
            # referencing: two pairs that SHARE a reference date differ by a pure secondary
            # difference; otherwise the difference crosses four dates and must be stated
            ref_a_date = min(str(dec_a.get("ref_time") or ""), str(dec_a.get("sec_time") or ""))
            ref_b_date = min(str(dec_b.get("ref_time") or ""), str(dec_b.get("sec_time") or ""))
            shared_ref = bool(ref_a_date and ref_b_date and ref_a_date == ref_b_date)
            referencing = {
                "shared_reference_date": shared_ref,
                "reference_date_a": ref_a_date or None,
                "reference_date_b": ref_b_date or None,
                "window_a": [dec_a.get("ref_time"), dec_a.get("sec_time")],
                "window_b": [dec_b.get("ref_time"), dec_b.get("sec_time")],
                "note": ("both granules share one reference date, so the difference is the "
                         "displacement between their two secondary dates"
                         if shared_ref else
                         "the granules do NOT share a reference date: this difference crosses "
                         "both pairs' windows and mixes reference phases — read it as the "
                         "change between two independent displacement estimates, never as a "
                         "single time interval"),
                "formula": los_facts_a["formula"],
                "assumptions": los_facts_a["assumptions"],
            }
            for f, g in ((gate_a, "a"), (gate_b, "b")):
                if f:
                    referencing[f"cc_gate_{g}"] = f
        raw_a_shape, raw_b_shape = view_a.shape, view_b.shape
        view_a, view_b, grid, gfacts = align_pair(grid_a, view_a, grid_b, view_b)
        zkw = {}
        if use_mode == "z_db":
            from engine.common.config import load_common_config
            common_cfg = load_common_config()
            zkw = {"default_looks": common_cfg.temporal.default_looks,
                   "nochange_k": common_cfg.stable.nochange_k}
            la = _looks_on_grid(grid_a, raw_a_shape)
            lb = _looks_on_grid(grid_b, raw_b_shape)
            if gfacts["same_grid"] and la is not None and lb is not None and la.shape == view_a.shape:
                zkw["looks"] = np.nanmean(np.stack([la, lb]), axis=0)   # both dates' looks, per pixel
        d, mode_note = compute_diff(view_a, view_b, use_mode, **zkw)

        finite = d[np.isfinite(d)]
        if finite.size == 0:
            raise BackgroundError(422, "no valid pixels in this difference — every pixel of the "
                                       "box is no-data in at least one of the two dates"
                                       + (" (values at or below zero have no dB value or ratio)"
                                          if use_mode != "coh_diff" else ""))

        shown, stride = bimg.decimate(d, max_px)
        use_cmap = "diverging" if cmap == "auto" else cmap
        if fixed is not None:
            lo, hi = fixed
        elif use_mode == "ratio":
            # the neutral point of a ratio is 1: the range is symmetric AROUND 1 so "no change"
            # always sits on the diverging map's mid colour
            p2, p98 = np.percentile(finite, [2, 98])
            s = max(abs(float(p2) - 1.0), abs(float(p98) - 1.0))
            lo, hi = (1.0 - s, 1.0 + s) if s > 0 else (0.5, 1.5)
        else:
            lo, hi = bimg.auto_range(shown, symmetric=True)
        body = bimg.render(shown, use_cmap, lo, hi)

        corners, corners_note = (None, "no grid axes for this layer")
        if grid is not None and getattr(grid, "x", None) is not None and getattr(grid, "y", None) is not None:
            if (len(grid.y), len(grid.x)) != tuple(view_a.shape[-2:]):
                corners_note = "no corners: the grid axes do not match the array shape"
            else:
                corners, corners_note = edge_corners_lonlat(grid.x, grid.y, int(grid.epsg), stride=int(stride))

        modes = diff_modes_for(layer)
        notes = [mode_note, f"{pair['gap_rule']}: {pair['gap_days']:g} days"]
        if gfacts["resampled"]:
            notes.append(gfacts["resampled"])
        notes += _render_notes(finite, shown, use_cmap, lo, hi, fixed is not None)
        meta = {
            "id": id_b, "layer": layer,
            "cmap": use_cmap, "cmap_requested": cmap,
            "scale": use_mode, "scale_requested": mode,
            "unit": ("m (LOS, + toward sensor)" if use_mode == "los_m"
                     else "mm (LOS, + toward sensor)" if use_mode == "los_mm"
                     else cfg.unit_by_diff_mode(use_mode)),
            "render_version": cfg.render_version, "lo": lo, "hi": hi,
            "range_fixed": fixed is not None,
            "nan_fraction": float(1.0 - np.isfinite(d).mean()),
            "shown_stride": int(stride), "shown_shape": [int(shown.shape[0]), int(shown.shape[1])],
            "epsg": int(grid.epsg) if grid is not None else None,
            "clip_bbox_lonlat": _extent_lonlat(grid, grid.epsg) if grid is not None else None,
            "corners_lonlat": corners, "corners_note": corners_note,
            "requested_bbox": [float(v) for v in bbox],
            "slice_note": None,
            "notes": notes,
            "nodata_rule": ("no-data in either date; integer fill = dtype max/min"
                            + ("; values at or below zero (no dB value or ratio)"
                               if use_mode != "coh_diff" else "")),
            "stats": bimg.stats(d, d),
            "wire_bytes": {k: v for k, v in (fr.stats or {}).items() if isinstance(v, (int, float))},
            "clip_source": clip_b.source,
            "max_px_cap": _LAYER_CAP,
            "cache_hit": False,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "diff": {
                "mode": use_mode, "mode_label": _MODE_LABELS[use_mode],
                "id_a": id_a, "id_b": id_b,
                "date_a": pair["date_a"], "date_b": pair["date_b"],
                "window_a": pair["window_a"], "window_b": pair["window_b"],
                "gap_days": pair["gap_days"], "later": pair["later"], "gap_rule": pair["gap_rule"],
                "validation": {k: pair[k] for k in ("product", "track", "frame", "direction")},
                "same_grid": gfacts["same_grid"], "resampled": gfacts["resampled"],
                "modes": modes,
                **({"referencing": referencing} if los_mode else {}),
            },
        }
        try:
            png_path.parent.mkdir(parents=True, exist_ok=True)
            png_path.write_bytes(body)
            json_path.write_text(json.dumps(meta))
        except Exception:
            pass                      # cache write failures never fail the diff
        return {"png": body, "meta": meta}
    finally:
        _bg._PREVIEW_LOCK.release()

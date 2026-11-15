"""3.08 deforestation - core algorithm (statistics, sequential change).

method (manifest): per-pixel CUSUM on HV dB against a robust baseline; persistence rule (>= 2-3 consecutive epochs below
baseline by >= k dB); patch filter >= 0.5 ha; cause attribution: fire (FIRMS in patch) | clearing (geometric patch, roads) |
windthrow (post-storm cluster).

What the literature changed (see README): L-band loss has two stages. Felled trees left on the ground RAISE HH (about +1.2 dB)
while HV barely moves; HV falls (1.5-3.2 dB) once the debris is cleared, weeks to months later. So three channels run:
  A  HV drop                         late-stage, the definitive one
  B  HH rise  + C  HV-HH ratio drop  early-stage, accepted only when BOTH fire together and HV is not rising (rain raises both
                                     bands and HV most, so it cannot satisfy this)
A pixel is CONFIRMED when its channel stays at the new level for `persist_epochs` usable epochs (flagged-wet epochs are
neutral), UNCONFIRMED when the series ends before that. Everything is deterministic.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from engine.lib.changepoint import first_true_from, page_cusum, persistence
from engine.lib.geo import lonlat_to_utm

from .lib_local import block_sum, expand_blocks, label8, majority, parse_time, patch_shape, px_lonlat
from .types import CLASS_BOTH, CLASS_EARLY, CLASS_HV, CLASS_UNCONFIRMED, EXC_NOT_FOREST, EXC_PRIOR_NONFOREST


# ------------------------------------------------------------------------------------------------------------------
# pixel detection
# ------------------------------------------------------------------------------------------------------------------
def _post_mean(d: np.ndarray, usable: np.ndarray, onset: np.ndarray) -> np.ndarray:
    tot = np.zeros(onset.shape)
    n = np.zeros(onset.shape)
    for t in range(d.shape[0]):
        live = (onset >= 0) & (t >= onset) & usable[t] & np.isfinite(d[t])
        tot += np.where(live, np.nan_to_num(d[t]), 0.0)
        n += live
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, tot / n, np.nan)


def _channel(z, d, usable, evaluate, first_testable, direction, k, h, z_shift, floor_db, persist):
    zz = np.where(usable & evaluate[None], z, np.nan).astype(np.float64)
    zz[:first_testable] = np.nan                       # CUSUM accumulates only from the first tested epoch
    cus = page_cusum(zz, k, h, direction)
    sign = -1.0 if direction == "down" else 1.0
    shifted = (sign * z >= z_shift) & (sign * d >= floor_db)
    onset = np.where(cus["alarm"] >= 0, first_true_from(shifted & usable, cus["onset"]), -1)
    onset = np.where(onset >= first_testable, onset, -1)
    per = persistence(shifted, usable, onset)
    confirmed = (onset >= 0) & (per["count"] >= persist)
    pending = (onset >= 0) & ~confirmed & ~per["broken"] & (per["count"] >= 1)
    return {"alarm": cus["alarm"], "onset": onset, "count": per["count"], "broken": per["broken"], "confirmed": confirmed,
            "pending": pending, "peak": cus["peak"]}


def _window_mean(d: np.ndarray, usable: np.ndarray, start: np.ndarray, end: np.ndarray) -> tuple:
    """Mean of d over usable epochs t with start <= t < end (per pixel) and the number of epochs that entered it."""
    tot = np.zeros(start.shape)
    n = np.zeros(start.shape)
    for t in range(d.shape[0]):
        live = (start >= 0) & (t >= start) & (t < end) & usable[t] & np.isfinite(d[t])
        tot += np.where(live, np.nan_to_num(d[t]), 0.0)
        n += live
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, tot / n, np.nan), n


def detect_core(z_hv, z_hh, z_ratio, d_hv, d_hh, d_ratio, usable, evaluate, flood_prone, first_testable, P) -> dict:
    """Two-stage detector on standardised (z) and dB (d) residual cubes (E, H, W). Pure: no bundle, no I/O.

    A  HV drop (late stage): CUSUM + persistence + post-onset level.
    E  early stage: the moisture-robust HV-HH ratio CUSUM carries the detection; HH is a DIRECTION constraint on the window
       between the ratio onset and the HV onset (HH rising, HV neither falling yet nor rising). Rain raises HV more than HH so
       the ratio goes UP and cannot pass; a finished clear-cut has no such window. Flood-prone ground additionally needs A."""
    n_ep = d_hv.shape[0]
    A = _channel(z_hv, d_hv, usable, evaluate, first_testable, "down", P.cusum_k, P.cusum_h, P.z_shift, P.shift_floor_db, P.persist_epochs)
    drop = _post_mean(d_hv, usable, A["onset"])
    conf_a = A["confirmed"] & (drop <= -P.shift_floor_db)
    H, W = evaluate.shape
    ok = np.zeros((H, W), bool)
    onset_e = np.full((H, W), -1, np.int32)
    pend_e = np.zeros((H, W), bool)
    count_e = np.zeros((H, W), np.int16)
    if z_hh is not None and z_ratio is not None:
        C = _channel(z_ratio, d_ratio, usable & np.isfinite(z_ratio), evaluate, first_testable, "down", P.cusum_k, P.cusum_h, P.z_shift,
                     P.shift_floor_db, P.persist_epochs)
        end = np.where(conf_a, A["onset"], n_ep)
        hh_w, n_w = _window_mean(d_hh, usable, C["onset"], end)
        hv_w, _ = _window_mean(d_hv, usable, C["onset"], end)
        ok = (C["confirmed"] & (n_w >= P.persist_epochs) & (np.nan_to_num(hh_w, nan=-9.0) >= 0.5 * P.min_rise_db)
              & (np.nan_to_num(hv_w, nan=-9.0) > -0.5 * P.min_drop_db) & (np.nan_to_num(hv_w, nan=9.0) <= P.hv_not_rising_db))
        ok &= ~(flood_prone & ~conf_a)
        onset_e = np.where(ok, C["onset"], -1).astype(np.int32)
        pend_e = (C["alarm"] >= 0) & ~ok & ~C["broken"] & (C["count"] >= 1) & ~conf_a
        count_e = C["count"]
    earlier = ok & conf_a & (onset_e < A["onset"])
    cls = np.zeros((H, W), np.uint8)
    cls[(A["pending"] | pend_e) & evaluate] = CLASS_UNCONFIRMED
    cls[ok & ~conf_a & evaluate] = CLASS_EARLY
    cls[conf_a & evaluate] = CLASS_HV
    cls[earlier & evaluate] = CLASS_BOTH
    onset = np.full((H, W), -1, np.int32)
    onset = np.where(A["pending"] | pend_e, np.where(A["onset"] >= 0, A["onset"], -1), onset)
    onset = np.where(ok & ~conf_a, onset_e, onset)
    onset = np.where(conf_a, np.where(earlier, onset_e, A["onset"]), onset)
    onset = np.where(cls >= CLASS_HV, onset, np.where(cls == CLASS_UNCONFIRMED, onset, -1)).astype(np.int32)
    rise = _post_mean(d_hh, usable, np.where(cls >= CLASS_HV, onset, -1)) if d_hh is not None else np.full((H, W), np.nan)
    ratio_ch = _post_mean(d_ratio, usable, np.where(cls >= CLASS_HV, onset, -1)) if d_ratio is not None else np.full((H, W), np.nan)
    hv_post = _post_mean(d_hv, usable, np.where(cls >= CLASS_HV, onset, -1))
    return {"cls": cls, "onset": onset, "hv_drop_db": hv_post, "hh_change_db": rise, "ratio_change_db": ratio_ch,
            "persist": np.maximum(A["count"], count_e).astype(np.int16), "conf_a": conf_a, "conf_e": ok}


def detect(prep, P) -> dict:
    first_testable = prep.n_ref and (max(i for i, f in enumerate(prep.epoch_flags) if f["reference"]) + 1)
    d_hv = prep.hv - prep.ref_hv
    d_hh = (prep.hh - prep.ref_hh) if prep.hh is not None else None
    d_ratio = (prep.ratio - prep.ref_ratio) if prep.ratio is not None else None
    res = detect_core(prep.z_hv, prep.z_hh, prep.z_ratio, d_hv, d_hh, d_ratio, prep.usable, prep.evaluate, prep.flood_prone, first_testable, P)
    res = _refine(res, prep, P)
    res["first_testable"] = int(first_testable)
    return res


def _refine(res: dict, prep, P) -> dict:
    """Detection runs on the multilooked series (noise control); this puts the patch EDGE back at raw resolution so that
    multilooking cannot inflate areas: a confirmed pixel, or a pixel of its 1-px halo, is kept only when its OWN (unsmoothed)
    post-onset level shows at least `refine_fraction` of the required change. HV drop for HV-class pixels, HH rise for
    early-stage pixels. Confirmed pixels that fail are dropped; halo pixels that pass join the neighbour's class and onset."""
    cls = res["cls"]
    conf = cls >= CLASS_HV
    if not conf.any() or prep.hv_raw is None:
        return res
    big = 10 ** 6
    cand = ndi.binary_dilation(conf, structure=np.ones((3, 3), bool)) & prep.evaluate
    on_min = ndi.grey_erosion(np.where(conf, res["onset"], big).astype(np.int64), size=(3, 3), mode="nearest")
    onset_use = np.where(conf, res["onset"], np.where(cand & (on_min < big), on_min, -1)).astype(np.int32)
    cls_nb = ndi.grey_dilation(np.where(conf, cls, 0).astype(np.uint8), size=(3, 3))
    flagged = np.array([f["flagged"] for f in prep.epoch_flags])
    usable_raw = np.isfinite(prep.hv_raw) & ~flagged[:, None, None]
    drop = _post_mean(prep.hv_raw - prep.ref_hv_raw, usable_raw, onset_use)
    rise = _post_mean(prep.hh_raw - prep.ref_hh_raw, usable_raw, onset_use) if prep.hh_raw is not None else np.full(cls.shape, np.nan)
    cls_use = np.where(conf, cls, cls_nb)
    hv_ok = np.nan_to_num(drop, nan=0.0) <= -P.refine_fraction * P.min_drop_db
    hh_ok = np.nan_to_num(rise, nan=-9.0) >= P.refine_fraction * P.min_rise_db
    keep = cand & (cls_use >= CLASS_HV) & np.where(cls_use == CLASS_EARLY, hh_ok & (np.nan_to_num(drop, nan=0.0) <= P.hv_not_rising_db), hv_ok)
    out = dict(res)
    new = np.where(keep, cls_use, np.where(cls == CLASS_UNCONFIRMED, cls, 0)).astype(np.uint8)
    out["cls"] = new
    out["onset"] = np.where(keep, onset_use, np.where(new == CLASS_UNCONFIRMED, res["onset"], -1)).astype(np.int32)
    out["hv_drop_db"] = np.where(keep, drop, res["hv_drop_db"])
    out["hh_change_db"] = np.where(keep & np.isfinite(rise), rise, res["hh_change_db"])
    out["refined"] = True
    return out


def patch_timeline(prep, rr, cc, P, first_testable: int) -> dict:
    """Patch-mean HV / HH / ratio change per epoch (raw resolution, moisture-corrected) and the two onsets it supports.

    Averaging a patch's >= 13 pixels cuts speckle by about sqrt(N), so the TIMING that pixel noise blurs is reliable here:
      hv_onset     first usable epoch from which HV stays at least half the required drop below the reference
      early_onset  first epoch of a stretch (before hv_onset, >= persist usable epochs) where the HV-HH ratio fell, HH rose
                   and HV neither fell nor rose: felled trees on the ground (L-band early stage)
    -> {"hv_onset", "early_onset", "series": [...]} (indices into the epoch list, None when absent)."""
    E = prep.hv_raw.shape[0]
    flags = [f["flagged"] for f in prep.epoch_flags]
    d_hv = np.array([np.nanmean(prep.hv_raw[t][rr, cc] - prep.ref_hv_raw[rr, cc]) if np.isfinite(prep.hv_raw[t][rr, cc]).any() else np.nan for t in range(E)])
    d_hh = np.array([np.nanmean(prep.hh_raw[t][rr, cc] - prep.ref_hh_raw[rr, cc]) if prep.hh_raw is not None and np.isfinite(prep.hh_raw[t][rr, cc]).any()
                     else np.nan for t in range(E)])
    d_ra = d_hv - d_hh
    usable = [t for t in range(first_testable, E) if not flags[t] and np.isfinite(d_hv[t])]
    thr = 0.5 * P.min_drop_db
    hv_onset = None
    for i, t in enumerate(usable):
        if all(d_hv[u] <= -thr for u in usable[i:]):
            hv_onset = t
            break
    early_onset = None
    if prep.hh_raw is not None:
        cand = [t for t in usable if (hv_onset is None or t < hv_onset)
                and d_ra[t] <= -0.8 * P.ratio_drop_db and d_hh[t] >= 0.5 * P.min_rise_db and -thr < d_hv[t] <= P.hv_not_rising_db]
        for i, t in enumerate(cand):
            run = [u for u in usable if t <= u and (hv_onset is None or u < hv_onset)]
            if len(run) >= P.persist_epochs and all(u in cand for u in run):
                early_onset = t
                break
    start = early_onset if early_onset is not None else hv_onset
    persist = 0 if start is None else sum(1 for t in usable if t >= start and (d_hv[t] <= -thr or d_ra[t] <= -0.8 * P.ratio_drop_db))
    series = [{"time": prep.times[t].strftime("%Y-%m-%dT%H:%M:%SZ"), "hv_db": None if not np.isfinite(d_hv[t]) else round(float(d_hv[t]), 2),
               "hh_db": None if not np.isfinite(d_hh[t]) else round(float(d_hh[t]), 2),
               "ratio_db": None if not np.isfinite(d_ra[t]) else round(float(d_ra[t]), 2), "usable": t in usable} for t in range(E)]
    return {"hv_onset": hv_onset, "early_onset": early_onset, "series": series, "persistence": persist}


def _patch_mask(cls: np.ndarray, P) -> np.ndarray:
    return majority(cls >= CLASS_HV, P.despeckle_px)


def _components(mask: np.ndarray, min_px: int) -> tuple:
    lab, n = label8(mask)
    if n == 0:
        return lab, []
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    return lab, [i for i in range(1, n + 1) if sizes[i] >= min_px]


def null_screen(prep, P, seed: int) -> dict:
    """Exploratory null: re-run the SAME detector on series built only from the reference epochs (leave-one-out inflated), so
    anything it confirms is a false alarm of the rule. NOT a calibrated false-alarm rate (the reference window is short)."""
    if P.null_draws <= 0:
        return {"draws": 0, "note": "null screen switched off"}
    rng = np.random.default_rng(seed)
    ref = [i for i, f in enumerate(prep.epoch_flags) if f["reference"]]
    n = len(ref)
    infl = n / max(n - 1, 1)
    E = prep.hv.shape[0]
    first = ref[-1] + 1
    min_px = int(np.ceil(P.min_patch_ha * 1e4 / prep.pixel_m ** 2))
    out = []
    zero_hh = prep.z_hh is not None and prep.z_ratio is not None
    for _ in range(P.null_draws):
        pick = rng.choice(ref, size=E, replace=True)
        zh = (prep.z_hv[pick] * infl)
        zh_h = (prep.z_hh[pick] * infl) if zero_hh else None
        zr = (prep.z_ratio[pick] * infl) if zero_hh else None
        res = detect_core(zh, zh_h, zr, zh * prep.sigma_hv, (zh_h * prep.sigma_hh) if zero_hh else None,
                          (zr * prep.sigma_ratio) if zero_hh else None, prep.usable, prep.evaluate, prep.flood_prone, first, P)
        lab, keep = _components(_patch_mask(res["cls"], P), min_px)
        px = int(sum((lab == i).sum() for i in keep))
        out.append({"patches": len(keep), "ha": px * prep.pixel_m ** 2 / 1e4,
                    "confirmed_px": int((res["cls"] >= CLASS_HV).sum())})
    ev = max(int(prep.evaluate.sum()), 1)
    return {"draws": P.null_draws, "patches": [o["patches"] for o in out], "ha": [round(o["ha"], 3) for o in out],
            "ha_max": float(max(o["ha"] for o in out)), "confirmed_px_rate_max": float(max(o["confirmed_px"] for o in out) / ev),
            "note": ("Exploratory null screen: the same rule applied to series resampled from the reference epochs only (leave-one-out "
                     "inflated). It measures the rule's own false alarms under that model, NOT a calibrated false-alarm rate.")}


# ------------------------------------------------------------------------------------------------------------------
# patches
# ------------------------------------------------------------------------------------------------------------------
def extract_patches(res: dict, prep, P, db_diff_hv=None, z_prev_hv=None) -> tuple:
    """-> (patches, rejected_weak, labelled mask of the kept patches). Patch dicts hold pixel index arrays under _rows/_cols."""
    min_px = int(np.ceil(P.min_patch_ha * 1e4 / prep.pixel_m ** 2))
    lab, keep = _components(_patch_mask(res["cls"], P), min_px)
    pix_ha = prep.pixel_m ** 2 / 1e4
    nonforest = np.isin(prep.exclusion, (EXC_NOT_FOREST, EXC_PRIOR_NONFOREST))
    near_nf = ndi.binary_dilation(nonforest, iterations=3) if nonforest.any() else nonforest
    kept, weak = [], 0
    out_lab = np.zeros(lab.shape, np.int32)
    for i in keep:
        m = lab == i
        rr, cc = np.nonzero(m)
        cls = res["cls"][rr, cc]
        conf = cls >= CLASS_HV
        onset = res["onset"][rr, cc]
        o = int(np.median(onset[conf])) if conf.any() else -1
        if o < 0:
            continue
        tline = patch_timeline(prep, rr, cc, P, res["first_testable"])
        if tline["early_onset"] is not None:
            o = tline["early_onset"]
        elif tline["hv_onset"] is not None:
            o = tline["hv_onset"]
        drop = float(np.nanmean(res["hv_drop_db"][rr, cc][conf])) if np.isfinite(res["hv_drop_db"][rr, cc][conf]).any() else float("nan")
        hh_ch = res["hh_change_db"][rr, cc]
        rise = float(np.nanmean(hh_ch)) if np.isfinite(hh_ch).any() else float("nan")
        rat = res["ratio_change_db"][rr, cc]
        ratio_ch = float(np.nanmean(rat)) if np.isfinite(rat).any() else float("nan")
        n_early = int((cls == CLASS_EARLY).sum())
        n_hv = int(((cls == CLASS_HV) | (cls == CLASS_BOTH)).sum())
        strong = (np.isfinite(drop) and drop <= -P.min_drop_db) or (n_early >= 0.5 * conf.sum() and np.isfinite(rise) and rise >= P.min_rise_db)
        if not strong:
            weak += 1
            continue
        k = len(kept) + 1
        prev = max(o - 1, 0)
        for t in range(o - 1, -1, -1):
            if prep.usable[t][rr, cc].mean() >= 0.5:
                prev = t
                break
        out_lab[m] = k
        sh = patch_shape(m[rr.min():rr.max() + 1, cc.min():cc.max() + 1], prep.pixel_m)
        i0, j0, i1, j1 = sh["bbox_px"]
        i0 += rr.min(); i1 += rr.min(); j0 += cc.min(); j1 += cc.min()
        lon_w, lat_s = px_lonlat(i1 - 0.5, j0 - 0.5, prep.x, prep.y, prep.epsg)
        lon_e, lat_n = px_lonlat(i0 - 0.5, j1 - 0.5, prep.x, prep.y, prep.epsg)
        lon_c, lat_c = px_lonlat(rr.mean(), cc.mean(), prep.x, prep.y, prep.epsg)
        step = None
        if db_diff_hv is not None and o < db_diff_hv.shape[0]:
            v = db_diff_hv[o][rr, cc]
            step = float(np.nanmedian(v)) if np.isfinite(v).any() else None
        zstep = None
        if z_prev_hv is not None and o < z_prev_hv.shape[0]:
            v = z_prev_hv[o][rr, cc]
            zstep = float(np.nanmedian(v)) if np.isfinite(v).any() else None
        if tline["early_onset"] is not None:
            stage = "early" if tline["hv_onset"] is None else "early_then_late"
        else:
            stage = "late"
        kept.append({
            "id": k, "_rows": rr, "_cols": cc, "area_ha": float(len(rr) * pix_ha), "area_px": int(len(rr)), "onset_index": o,
            "onset_time": prep.times[o].strftime("%Y-%m-%dT%H:%M:%SZ"), "prev_epoch_time": prep.times[prev].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "loss_window": [prep.times[prev].strftime("%Y-%m-%dT%H:%M:%SZ"), prep.times[o].strftime("%Y-%m-%dT%H:%M:%SZ")],
            "stage": stage, "timeline": tline["series"], "hv_onset_time": None if tline["hv_onset"] is None else prep.times[tline["hv_onset"]].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "early_onset_time": None if tline["early_onset"] is None else prep.times[tline["early_onset"]].strftime("%Y-%m-%dT%H:%M:%SZ"), "hv_drop_db": drop, "hh_change_db": rise, "ratio_change_db": ratio_ch,
            "step_db": step, "step_z": zstep, "persistence_epochs": int(tline["persistence"]) if tline["persistence"] else int(np.median(res["persist"][rr, cc][conf])),
            "pixel_persistence_epochs": int(np.median(res["persist"][rr, cc][conf])),
            "unconfirmed_fraction": float((cls == CLASS_UNCONFIRMED).mean()),
            "centroid_lonlat": [float(lon_c), float(lat_c)],
            "bbox_lonlat": [float(min(lon_w, lon_e)), float(min(lat_s, lat_n)), float(max(lon_w, lon_e)), float(max(lat_s, lat_n))],
            "shape": {k2: v for k2, v in sh.items() if k2 != "bbox_px"},
            "flood_prone_fraction": float(prep.flood_prone[rr, cc].mean()),
            "mean_slope_deg": None if prep.slope is None else _nm(prep.slope[rr, cc]),
            "mean_hand_m": None if prep.hand is None else _nm(prep.hand[rr, cc]),
            "mean_tree_cover_pct": None if prep.tree_cover is None else _nm(prep.tree_cover[rr, cc]),
            "mean_local_incidence_deg": None if prep.local_incidence is None else _nm(prep.local_incidence[rr, cc]),
            "near_nonforest_fraction": float(near_nf[rr, cc].mean()),
        })
    kept.sort(key=lambda p: -p["area_ha"])
    remap = {p["id"]: j + 1 for j, p in enumerate(kept)}
    lut = np.zeros(int(out_lab.max()) + 1, np.int32)
    for old, new in remap.items():
        lut[old] = new
    for p in kept:
        p["id"] = remap[p["id"]]
    return kept, weak, lut[out_lab]


def _nm(a):
    a = np.asarray(a, dtype=np.float64)
    return float(np.nanmean(a)) if np.isfinite(a).any() else None


def hotspot_cells(label_map: np.ndarray, patches: list, prep, P) -> list:
    """Loss density on a coarse grid (hotspot_cell_m): hectares of confirmed loss per cell, strongest first."""
    cell = max(1, int(round(P.hotspot_cell_m / prep.pixel_m)))
    ha = block_sum(label_map > 0, cell) * prep.pixel_m ** 2 / 1e4
    order = np.argsort(-ha, axis=None)
    total = float(ha.sum())
    out = []
    for flat in order[: P.hotspot_top_n * 3]:
        r, c = np.unravel_index(flat, ha.shape)
        if ha[r, c] < P.min_patch_ha or len(out) >= P.hotspot_top_n:
            break
        i0, i1 = r * cell, min((r + 1) * cell, prep.rows)
        j0, j1 = c * cell, min((c + 1) * cell, prep.cols)
        lon_w, lat_s = px_lonlat(i1 - 0.5, j0 - 0.5, prep.x, prep.y, prep.epsg)
        lon_e, lat_n = px_lonlat(i0 - 0.5, j1 - 0.5, prep.x, prep.y, prep.epsg)
        lon_c, lat_c = px_lonlat((i0 + i1 - 1) / 2, (j0 + j1 - 1) / 2, prep.x, prep.y, prep.epsg)
        ids = sorted({int(v) for v in np.unique(label_map[i0:i1, j0:j1]) if v > 0})
        out.append({"rank": len(out) + 1, "loss_ha": float(ha[r, c]), "share_of_total": float(ha[r, c] / total) if total else 0.0,
                    "cell_m": float(cell * prep.pixel_m), "patch_ids": ids, "centroid_lonlat": [float(lon_c), float(lat_c)],
                    "bbox_lonlat": [float(min(lon_w, lon_e)), float(min(lat_s, lat_n)), float(max(lon_w, lon_e)), float(max(lat_s, lat_n))],
                    "_cell": (int(r), int(c))})
    return out


def density_layer(label_map: np.ndarray, prep, P) -> np.ndarray:
    cell = max(1, int(round(P.hotspot_cell_m / prep.pixel_m)))
    ha = block_sum(label_map > 0, cell) * prep.pixel_m ** 2 / 1e4
    return expand_blocks(ha, cell, label_map.shape).astype(np.float32)


# ------------------------------------------------------------------------------------------------------------------
# cause attribution
# ------------------------------------------------------------------------------------------------------------------
def geometry_class(sh: dict, P) -> str:
    if sh["elongation"] >= P.road_elongation_min and sh["width_m"] <= P.road_max_width_m:
        return "road_like"
    if sh["rectangularity"] >= P.rectangularity_min:
        return "rectilinear"
    return "irregular"


def attribute(patch: dict, prep, fires, tracks, P, triggers: dict, event_window) -> dict:
    """fires / tracks: list of dicts, or None when that source was not available (then the answer says so)."""
    t_on = parse_time(patch["onset_time"])
    t_prev = parse_time(patch["prev_epoch_time"])
    if t_prev >= t_on:
        t_prev = t_on - _days(12)
    gc = geometry_class(patch["shape"], P)
    basis, fire_info, storm_info = [], {"checked": fires is not None, "hits": 0, "frp_sum": 0.0, "nearest_m": None}, {"checked": tracks is not None, "evidence": []}
    if fires:
        lo, hi = t_prev - _days(P.fire_window_days), t_on + _days(P.fire_window_days)
        sel = [f for f in fires if lo <= parse_time(f["date"]) <= hi]
        if sel:
            fx, fy = lonlat_to_utm([f["lon"] for f in sel], [f["lat"] for f in sel], prep.epsg)
            px, py = prep.x[patch["_cols"]], prep.y[patch["_rows"]]
            step = max(1, len(px) // 1500)
            px, py = px[::step], py[::step]
            d = np.sqrt((fx[:, None] - px[None]) ** 2 + (fy[:, None] - py[None]) ** 2).min(axis=1)
            near = d <= P.fire_buffer_m + prep.pixel_m
            fire_info.update(hits=int(near.sum()), nearest_m=float(d.min()),
                             frp_sum=float(sum((sel[i].get("frp") or 0.0) for i in np.flatnonzero(near))))
    if tracks:
        lo = t_prev - _days(P.storm_window_days)
        for p in tracks:
            tt = parse_time(p["time"])
            if lo <= tt <= t_on and (p.get("wind_kt") or 0) >= P.storm_min_wind_kt and (p.get("distance_km") or 1e9) <= P.storm_max_distance_km:
                storm_info["evidence"].append({"sid": p.get("sid"), "name": p.get("name"), "time": p["time"], "wind_kt": p.get("wind_kt"),
                                               "distance_km": p.get("distance_km")})
    trig = bool((triggers or {}).get("storm"))
    in_window = False
    if event_window and event_window[0] and event_window[1]:
        in_window = parse_time(event_window[0]) <= t_on <= parse_time(event_window[1]) + _days(12)
    storm_ok = bool(storm_info["evidence"]) or trig or in_window
    abrupt = patch["step_db"] is not None and patch["step_db"] <= -P.abrupt_step_db
    if fire_info["hits"] > 0:
        cause = "fire"
        basis.append(f"{fire_info['hits']} VIIRS active-fire detection(s) within {P.fire_buffer_m:.0f} m of the patch around the loss date")
        if patch["hh_change_db"] == patch["hh_change_db"] and patch["hh_change_db"] < 0:
            basis.append("HH fell (L-band burn scars lower co-pol; weak supporting hint)")
    elif storm_ok and gc == "irregular":
        cause = "windthrow"
        basis.append("a storm affected the tile before the loss date and the patch is irregular, not cleared in straight lines")
    elif gc in ("road_like", "rectilinear") or abrupt:
        cause = "clearing"
        if gc == "road_like":
            basis.append("narrow linear patch (track or road)")
        elif gc == "rectilinear":
            basis.append("compact straight-edged patch")
        if abrupt:
            basis.append(f"abrupt backscatter step ({patch['step_db']:.1f} dB in one epoch)")
    else:
        cause = "unattributed"
        basis.append("neither fire, storm nor a clear-cut geometry supports a cause")
    if patch["near_nonforest_fraction"] >= 0.5 and cause == "clearing":
        basis.append("sits against existing non-forest (a clearing edge advancing)")
    caveats = []
    if fires is None and cause != "fire":
        caveats.append("FIRMS was unavailable: fire loss is not excluded")
    if tracks is None and cause != "windthrow":
        caveats.append("IBTrACS was unavailable: storm damage is not excluded")
    return {"cause": cause, "basis": [b for b in basis if b], "geometry": gc, "fire": fire_info, "storm": {**storm_info, "trigger": trig, "in_event_window": in_window},
            "caveats": caveats}


def _days(n: float):
    from datetime import timedelta
    return timedelta(days=float(n))


# ------------------------------------------------------------------------------------------------------------------
# R7 agreement
# ------------------------------------------------------------------------------------------------------------------
def rasterize_alerts(alerts, prep, t_lo, t_hi) -> tuple:
    """-> (rank raster (H,W) int8, -1 = none; date ordinal raster int32; n alerts inside the tile and window)."""
    from .lib_local import points_to_pixels
    rank = np.full((prep.rows, prep.cols), -1, np.int8)
    day = np.zeros((prep.rows, prep.cols), np.int32)
    sel = [a for a in alerts if t_lo <= parse_time(a["date"]) <= t_hi]
    if not sel:
        return rank, day, 0
    r, c, ok = points_to_pixels([a["lon"] for a in sel], [a["lat"] for a in sel], prep.x, prep.y, prep.epsg, prep.pixel_m)
    n = 0
    for a, rr, cc, k in zip(sel, r, c, ok):
        if not k:
            continue
        n += 1
        if a["rank"] > rank[rr, cc]:
            rank[rr, cc] = a["rank"]
        o = parse_time(a["date"]).toordinal()
        day[rr, cc] = o if day[rr, cc] == 0 else min(day[rr, cc], o)
    return rank, day, n


def r7_agreement(patch: dict, rank: np.ndarray, day: np.ndarray, P) -> dict:
    cov = ndi.binary_dilation(rank >= 0, iterations=1)
    rr, cc = patch["_rows"], patch["_cols"]
    hit = cov[rr, cc]
    frac = float(hit.mean())
    label = "agrees" if frac >= P.r7_overlap_min else ("partial" if frac > 0 else "none")
    offs = None
    d = day[rr, cc]
    if (d > 0).any():
        offs = float(np.median(d[d > 0]) - parse_time(patch["onset_time"]).toordinal())
    return {"label": label, "overlap_fraction": frac, "best_confidence_rank": int(rank[rr, cc].max()), "median_alert_minus_onset_days": offs}

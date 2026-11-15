"""3.08 deforestation - own_prep on top of the SceneBundle (one stack at a time).

own_prep (manifest): forest mask, exclude water / layover / steep slopes, flag epochs within 48 h of rain, prefer cross-pol
HV for moisture robustness. What is done, in order:

 1. crop everything to the tile proper (halo removed) on G20; G80 layers go up through `grids.index_map_20_to_80`.
 2. forest candidates = WorldCover tree/mangrove OR S4 tree cover >= threshold; exclusions (each recorded, none silent):
    water (land cover + JRC occurrence), layover / shadow / out-of-range incidence (bundle masks AND geometry),
    steep slope, built-up. Low HAND is kept but marked flood-prone (it needs HV confirmation later).
 3. reference = the EARLY window (not the bundle baseline, which P10 builds from every epoch before the newest one and
    which a mid-window clearing therefore contaminates). The bundle baseline is still used: as a floor/diagnostic and to
    measure that contamination.
 4. tile-wide common-mode correction per epoch (iterated, robust median over stable forest, pixels with a recent big drop
    excluded): rain / soil moisture lifts L-band HV by 1-2 dB and more, the same size as the signal being sought.
 5. per-pixel standardised residuals z for HV, HH and HV-HH, with sigma = max(robust sigma of the reference, speckle floor
    from numberOfLooks, min_sigma_db).
 6. pixels that were already non-forest at the start, have too few valid epochs or changed INSIDE the reference window
    (the bundle's z_prev shows the step) are excluded and counted - they cannot be timed honestly.
"""
from __future__ import annotations

import numpy as np

from scipy import ndimage as ndi

from engine.common.ancillary import WC_MANGROVE, WC_TREE, WC_WATER
from engine.common.config import DeforestationCfg

from .lib_local import iso, nanmedian0, parse_time, robust_sigma
from .types import (EXC_BUILTUP, EXC_EARLY_CHANGE, EXC_FEW_VALID, EXC_GEOMETRY, EXC_NONE, EXC_NOT_FOREST, EXC_PRIOR_NONFOREST,
                    EXC_STEEP, EXC_WATER, Prepared)

DB_PER_NEPER = 4.342944819032518
MAD_SIGMA_C = 1.4826
_CROSS = (("HV", "HH"), ("VH", "VV"))


def _noop(_name: str) -> None:
    return None


def _g20(dual, bundle, rs, cs):
    """A Dual (or None) -> (H, W) array on the cropped G20 grid, or None."""
    if dual is None or not getattr(dual, "available", False):
        return None
    a = dual.g20 if dual.g20 is not None else np.asarray(dual.g80).ravel()[bundle.grids.index_map_20_to_80]
    return np.asarray(a)[rs, cs]


def _pick_pols(bs, P: DeforestationCfg):
    for cross, co in _CROSS:
        if cross == P.pol or (P.pol == "HV" and cross == "HV"):
            if cross in bs.gamma0_db:
                return cross, (co if co in bs.gamma0_db else None)
    for cross, co in _CROSS:
        if cross in bs.gamma0_db:
            return cross, (co if co in bs.gamma0_db else None)
    return None, None


def _sub(mask: np.ndarray, cap: int = 20000) -> np.ndarray:
    idx = np.flatnonzero(mask.ravel())
    if idx.size > cap:
        idx = idx[:: int(np.ceil(idx.size / cap))]
    out = np.zeros(mask.size, bool)
    out[idx] = True
    return out.reshape(mask.shape)


def _offsets(x: np.ndarray, ref: np.ndarray, sel: np.ndarray) -> np.ndarray:
    """Per-epoch median of (x - ref) over the selected pixels; NaN where an epoch has no selected valid pixel."""
    out = np.full(x.shape[0], np.nan)
    for i in range(x.shape[0]):
        v = (x[i] - ref)[sel]
        v = v[np.isfinite(v)]
        if v.size >= 50:
            out[i] = float(np.median(v))
    return out


def prepare_stack(bundle, key: str, P: DeforestationCfg, rain_mm: dict | None = None, use=_noop) -> tuple:
    """-> (Prepared | None, skip_reason | None)."""
    stack = bundle.stacks[key]
    bs = stack.backscatter
    if bs is None or not bs.epochs:
        return None, "the stack has no backscatter (GCOV) epochs"
    use("stacks[*].backscatter.gamma0_db")
    cross, co = _pick_pols(bs, P)
    if cross is None:
        return None, "no cross-polarised (HV/VH) backscatter in the stack"
    g20 = bundle.grids.g20
    rs, cs = g20.core_slices()
    use("grids.g20")
    x_ax, y_ax = np.asarray(g20.x)[cs], np.asarray(g20.y)[rs]
    H, W = len(y_ax), len(x_ax)
    E = len(bs.epochs)
    times = [parse_time(e.time) for e in bs.epochs]
    use("stacks[*].backscatter.epochs")
    days = np.array([(t - times[0]).total_seconds() / 86400.0 for t in times])

    hv_raw = np.asarray(bs.gamma0_db[cross])[:, rs, cs].astype(np.float32)
    hh_raw = np.asarray(bs.gamma0_db[co])[:, rs, cs].astype(np.float32) if co else None
    valid_ep = np.isfinite(hv_raw).reshape(E, -1).mean(axis=1)
    use("stacks[*].backscatter.valid")
    good = [i for i in range(E) if valid_ep[i] >= 0.2 and bool(np.asarray(bs.valid[i][rs, cs]).mean() >= 0.2)]
    if len(good) < P.min_epochs:
        return None, f"only {len(good)} epoch(s) with usable HV coverage; {P.min_epochs} are needed"
    n_ref = int(min(max(P.ref_epochs_min, round(P.ref_fraction * len(good))), len(good) - P.persist_epochs))
    if n_ref < P.ref_epochs_min:
        return None, f"{len(good)} usable epochs leave {n_ref} for the reference (< {P.ref_epochs_min})"
    ref_idx = good[:n_ref]

    # ---- static masks ----------------------------------------------------------------------------------------
    anc = bundle.ancillary
    lc = _g20(anc.landcover, bundle, rs, cs)
    if lc is not None and float((lc > 0).mean()) < 0.5:
        lc = None
    ctx = anc.context
    tree = _g20(ctx.get("tree_cover"), bundle, rs, cs) if "tree_cover" in ctx else None
    built = _g20(ctx.get("builtup"), bundle, rs, cs) if "builtup" in ctx else None
    slope = _g20(anc.slope_deg, bundle, rs, cs)
    hand = _g20(anc.hand_m, bundle, rs, cs)
    wocc = _g20(anc.water_occurrence_pct, bundle, rs, cs)
    for nm, arr in (("ancillary.landcover", lc), ("ancillary.context[tree_cover]", tree), ("ancillary.context[builtup]", built),
                    ("ancillary.slope_deg", slope), ("ancillary.hand_m", hand), ("ancillary.water_occurrence_pct", wocc)):
        if arr is not None:
            use(nm)
    forest_parts = []
    if lc is not None:
        forest_parts.append(np.isin(lc, (WC_TREE, WC_MANGROVE)))
    if tree is not None:
        with np.errstate(invalid="ignore"):
            forest_parts.append(np.nan_to_num(tree, nan=0.0) >= P.tree_cover_min_pct)
    if not forest_parts:
        return None, "no forest map in the bundle (needs land cover or S4 tree cover)"
    forest = np.logical_or.reduce(forest_parts)
    exclusion = np.full((H, W), EXC_NONE, dtype=np.uint8)

    def mark(mask, code):
        exclusion[(exclusion == EXC_NONE) & mask] = code

    mark(~forest, EXC_NOT_FOREST)
    water = np.zeros((H, W), bool)
    if lc is not None:
        water |= lc == WC_WATER
    if wocc is not None:
        with np.errstate(invalid="ignore"):
            water |= np.nan_to_num(wocc, nan=0.0) >= P.water_occurrence_max_pct
    mark(water, EXC_WATER)
    geom_bad = np.zeros((H, W), bool)
    for nm in ("layover", "shadow", "low_incidence", "high_incidence"):
        m = getattr(bs.masks, nm, None)
        if m is not None:
            geom_bad |= np.asarray(m, bool)[rs, cs]
            use(f"stacks[*].backscatter.masks.{nm}")
    g = stack.geometry
    if g is not None:
        for nm in ("layover", "shadow"):
            m = _g20(getattr(g, nm), bundle, rs, cs)
            if m is not None:
                geom_bad |= m.astype(bool)
                use(f"stacks[*].geometry.{nm}")
    lia = _g20(g.local_incidence_deg, bundle, rs, cs) if g is not None else None
    if lia is not None:
        use("stacks[*].geometry.local_incidence_deg")
        with np.errstate(invalid="ignore"):
            geom_bad |= np.isfinite(lia) & ((lia < 15.0) | (lia > 70.0))
    mark(geom_bad, EXC_GEOMETRY)
    if slope is not None:
        with np.errstate(invalid="ignore"):
            mark(np.nan_to_num(slope, nan=0.0) > P.slope_max_deg, EXC_STEEP)
    if built is not None:
        with np.errstate(invalid="ignore"):
            mark(np.nan_to_num(built, nan=0.0) >= P.builtup_max_pct, EXC_BUILTUP)
    flood_prone = np.zeros((H, W), bool)
    if hand is not None:
        with np.errstate(invalid="ignore"):
            flood_prone = np.isfinite(hand) & (hand <= P.hand_flood_prone_m)
    eval_pre = exclusion == EXC_NONE
    if not eval_pre.any():
        return None, "every pixel of the tile is excluded (non-forest, water, geometry, slope or built-up)"

    # stable ground (coherent, gentle, not water) as the preferred reference set for the common-mode offset. The
    # `no_change` component is NOT used: it is evaluated on the newest epoch and would force that epoch's offset to zero.
    sel = eval_pre.copy()
    if stack.stable is not None and getattr(stack.stable, "components", None):
        comp = stack.stable.components
        st = np.ones((H, W), bool)
        n_comp = 0
        for nm in ("coherence", "slope", "not_water"):
            if nm in comp:
                a = _g20(comp[nm], bundle, rs, cs)
                if a is not None:
                    st &= a.astype(bool)
                    n_comp += 1
        if n_comp and int((st & eval_pre).sum()) >= 300:
            sel = st & eval_pre
            use("stacks[*].stable.components")
    sel = _sub(sel)

    # ---- reference + iterated common-mode correction ---------------------------------------------------------
    def corrected(raw, off):
        return raw - off[:, None, None].astype(np.float32)

    off_hv = np.zeros(E)
    off_hh = np.zeros(E)
    recent_big_drop = np.zeros((H, W), bool)
    ref_hv = ref_hh = None
    for it in range(3):
        hvc = corrected(hv_raw, np.nan_to_num(off_hv))
        ref_hv = nanmedian0(hvc[ref_idx], 0)
        s = sel & ~recent_big_drop
        if P.normalize_common_mode:
            off_hv = _offsets(hv_raw, ref_hv, s)
            if hh_raw is not None:
                hhc = corrected(hh_raw, np.nan_to_num(off_hh))
                ref_hh = nanmedian0(hhc[ref_idx], 0)
                off_hh = _offsets(hh_raw, ref_hh, s)
        else:
            off_hv[:] = 0.0
            off_hh[:] = 0.0
        hvc = corrected(hv_raw, np.nan_to_num(off_hv))
        tail = [i for i in good[-3:]]
        with np.errstate(all="ignore"):
            recent_big_drop = nanmedian0(hvc[tail], 0) - ref_hv <= -P.min_drop_db
    cap = P.common_mode_cap_db
    over_cap = np.array([(np.isfinite(off_hv[i]) and abs(off_hv[i]) > cap) or (np.isfinite(off_hh[i]) and abs(off_hh[i]) > cap)
                         for i in range(E)])
    off_hv_c = np.where(np.isfinite(off_hv) & ~over_cap, off_hv, 0.0)
    off_hh_c = np.where(np.isfinite(off_hh) & ~over_cap, off_hh, 0.0)
    hv = corrected(hv_raw, off_hv_c)
    hh = corrected(hh_raw, off_hh_c) if hh_raw is not None else None
    for i in range(E):
        if over_cap[i]:
            hv[i] = np.nan
            if hh is not None:
                hh[i] = np.nan
    ref_hv = nanmedian0(hv[ref_idx], 0)
    ref_hh = nanmedian0(hh[ref_idx], 0) if hh is not None else None
    ratio = (hv - hh) if hh is not None else None
    ref_ratio = nanmedian0(ratio[ref_idx], 0) if ratio is not None else None

    # ---- per-pixel speckle floor (numberOfLooks) -----------------------------------------------------------------
    if bs.n_looks is not None:
        looks = nanmedian0(np.asarray(bs.n_looks)[good][:, rs, cs], 0)
        floor = DB_PER_NEPER / np.sqrt(np.clip(np.nan_to_num(looks, nan=25.0), 1.0, None))
        use("stacks[*].backscatter.n_looks")
    else:
        fl = bs.baseline.speckle_floor_db if bs.baseline is not None and bs.baseline.speckle_floor_db else DB_PER_NEPER / 5.0
        floor = np.full((H, W), float(fl))
    use("stacks[*].backscatter.baseline.speckle_floor_db")

    # ---- per-pixel exclusions that need the series ------------------------------------------------------------
    n_valid_ref = np.isfinite(hv[ref_idx]).sum(axis=0)
    after = [i for i in good if i not in ref_idx]
    n_valid_after = np.isfinite(hv[after]).sum(axis=0)
    few = (n_valid_ref < P.min_ref_valid) | (n_valid_after < 1)
    m_t = float(np.nanmedian(ref_hv[eval_pre])) if eval_pre.any() else np.nan
    s_t = float(robust_sigma(ref_hv[eval_pre], 0, med=np.float64(m_t))) if eval_pre.any() else np.nan
    nf_thr = m_t - max(P.nonforest_k * s_t, 2.5)
    prior_nf = np.isfinite(ref_hv) & (ref_hv < nf_thr)
    early = np.zeros((H, W), bool)
    if n_ref >= 4:
        first2 = nanmedian0(hv[ref_idx[:2]], 0)
        last2 = nanmedian0(hv[ref_idx[-2:]], 0)
        step_ok = np.ones((H, W), bool)
        if bs.z_prev is not None and cross in bs.z_prev:
            use("stacks[*].backscatter.z_prev")
            zp = np.asarray(bs.z_prev[cross])[:, rs, cs]
            lo, hi = ref_idx[1], ref_idx[-1] + 1
            with np.errstate(all="ignore"):
                step_ok = np.nan_to_num(np.nanmin(zp[lo:hi], axis=0), nan=0.0) <= -3.0
        with np.errstate(all="ignore"):
            early = (last2 - first2 <= -P.min_drop_db) & step_ok
    mark(prior_nf, EXC_PRIOR_NONFOREST)
    mark(few, EXC_FEW_VALID)
    mark(early, EXC_EARLY_CHANGE)
    evaluate = exclusion == EXC_NONE

    # ---- multilook + sigma + z (after the exclusions: smoothing only ever mixes TESTED forest pixels) ---------------
    sm = int(max(1, P.smooth_px))
    ref_hv_raw, ref_hh_raw, ref_ratio_raw = ref_hv, ref_hh, ref_ratio
    hv_raw_c, hh_raw_c = hv, hh

    def smooth(cube):
        """Mask-aware boxcar (normalised convolution over tested forest pixels only); NaN where < 1/3 of the window has data."""
        if sm <= 1 or cube is None:
            return cube
        out = np.empty_like(cube)
        for i in range(cube.shape[0]):
            v = np.isfinite(cube[i]) & evaluate
            num = ndi.uniform_filter(np.where(v, cube[i], 0.0).astype(np.float32), size=sm, mode="constant")
            den = ndi.uniform_filter(v.astype(np.float32), size=sm, mode="constant")
            with np.errstate(all="ignore"):
                out[i] = np.where(den >= 0.34, num / np.maximum(den, 1e-6), np.nan)
        return out

    hv_s, hh_s = smooth(hv), smooth(hh)
    ratio_s = (hv_s - hh_s) if hh_s is not None else None
    ref_hv_s = nanmedian0(hv_s[ref_idx], 0)
    ref_hh_s = nanmedian0(hh_s[ref_idx], 0) if hh_s is not None else None
    ref_ratio_s = nanmedian0(ratio_s[ref_idx], 0) if ratio_s is not None else None
    n_eff = float(sm * sm)

    def noise(cube_s, ref_s, floor_scale):
        """Per-pixel noise of the (smoothed) residual: the larger of (a) the tile-wide robust sigma pooled over every tested pixel
        and reference epoch (thousands of values: stable, unlike a 4-sample MAD), (b) the pixel's own MAD, (c) a floor."""
        r = (cube_s[ref_idx] - ref_s)[:, evaluate]
        r = r[np.isfinite(r)]
        if r.size >= 200:
            pooled = MAD_SIGMA_C * float(np.median(np.abs(r - np.median(r)))) * float(np.sqrt(n_ref / max(n_ref - 1, 1)))
        else:
            pooled = float(np.nanmedian(floor)) / np.sqrt(n_eff) * floor_scale
        own = np.nan_to_num(robust_sigma(cube_s[ref_idx], 0, med=ref_s), nan=0.0)
        return np.maximum(np.maximum(own, pooled), P.min_sigma_db * floor_scale).astype(np.float32), pooled

    sigma_hv, pooled_hv = noise(hv_s, ref_hv_s, 1.0)
    sigma_hh, pooled_hh = noise(hh_s, ref_hh_s, 1.0) if hh_s is not None else (None, None)
    sigma_ratio, pooled_ratio = noise(ratio_s, ref_ratio_s, float(np.sqrt(2.0))) if ratio_s is not None else (None, None)
    pred = float(np.sqrt(1.0 + 1.0 / n_ref))          # prediction interval: the reference mean itself has error
    with np.errstate(all="ignore"):
        z_hv = ((hv_s - ref_hv_s) / (sigma_hv * pred)).astype(np.float32)
        z_hh = ((hh_s - ref_hh_s) / (sigma_hh * pred)).astype(np.float32) if hh_s is not None else None
        z_ratio = ((ratio_s - ref_ratio_s) / (sigma_ratio * pred)).astype(np.float32) if ratio_s is not None else None
    hv, hh, ratio = hv_s, hh_s, ratio_s
    ref_hv, ref_hh, ref_ratio = ref_hv_s, ref_hh_s, ref_ratio_s
    if bs.hv_hh_db is not None:
        use("stacks[*].backscatter.hv_hh_db")                    # cross-checked against the ratio rebuilt from the corrected bands

    # ---- epoch table -----------------------------------------------------------------------------------------
    flags = []
    for i in range(E):
        reasons = []
        if i not in good:
            reasons.append("no usable coverage")
        if over_cap[i]:
            reasons.append(f"tile-wide offset beyond {cap:g} dB (not corrected)")
        elif np.isfinite(off_hv[i]) and (abs(off_hv[i]) > P.common_mode_flag_db or (np.isfinite(off_hh[i]) and abs(off_hh[i]) > P.common_mode_flag_db)):
            reasons.append("tile-wide moisture offset")
        r = (rain_mm or {}).get(i)
        if r is not None and r >= P.rain_flag_mm:
            reasons.append(f"rain {r:.0f} mm in 48 h before the pass")
        flags.append({"index": i, "time": iso(times[i]), "hv_offset_db": None if not np.isfinite(off_hv[i]) else round(float(off_hv[i]), 3),
                      "hh_offset_db": None if not np.isfinite(off_hh[i]) else round(float(off_hh[i]), 3),
                      "rain_mm_48h": None if r is None else round(float(r), 1), "flagged": bool(reasons), "reasons": reasons,
                      "reference": i in ref_idx})
    flagged = np.array([f["flagged"] for f in flags])
    usable = np.isfinite(hv) & ~flagged[:, None, None]
    # reference epochs are never "tested" epochs, but a flagged one still must not testify
    ev_n = int(evaluate.sum())
    base = bs.baseline
    base_chk = None
    if base is not None and cross in base.median_db:
        use("stacks[*].backscatter.baseline")
        bm = np.asarray(base.median_db[cross])[rs, cs]
        with np.errstate(all="ignore"):
            d = np.abs(bm - ref_hv)[evaluate]
        d = d[np.isfinite(d)]
        base_chk = {"n_prior_epochs": int(base.n_epochs), "epoch_indices": [int(i) for i in base.epoch_indices],
                    "history_days": float(base.history_days), "cold_start": bool(base.cold_start), "seasonal_ok": bool(base.seasonal_ok),
                    "median_abs_diff_to_own_reference_db": None if not d.size else round(float(np.median(d)), 3),
                    "fraction_gt_1db": None if not d.size else round(float((d > 1.0).mean()), 4),
                    "reading": "a large difference means the bundle baseline (all epochs before the newest) is contaminated by "
                               "clearings inside the window; this pipeline therefore uses its own early reference"}
        use("stacks[*].backscatter.baseline.median_db")
        use("stacks[*].backscatter.baseline.sigma_db")
        for _n in ("history_days", "n_epochs", "epoch_indices", "cold_start", "seasonal_ok"):
            use(f"stacks[*].backscatter.baseline.{_n}")
    diag = {"cross_pol": cross, "co_pol": co, "n_epochs": E, "n_good_epochs": len(good), "n_ref": n_ref, "reference_epochs": [int(i) for i in ref_idx],
            "forest_candidate_fraction": round(float(forest.mean()), 4), "evaluated_fraction": round(float(ev_n / (H * W)), 4),
            "flood_prone_fraction_of_evaluated": round(float((flood_prone & evaluate).sum() / max(ev_n, 1)), 4),
            "offset_pixels": int(sel.sum()), "offset_set": "stable forest (coherence/slope/not_water)" if bool(sel.sum()) and stack.stable is not None and sel.sum() != _sub(eval_pre).sum() else "forest candidates",
            "forest_ref_hv_db": {"median": None if not np.isfinite(m_t) else round(m_t, 3), "robust_sigma": None if not np.isfinite(s_t) else round(s_t, 3),
                                 "nonforest_threshold": None if not np.isfinite(nf_thr) else round(float(nf_thr), 3)},
            "excluded_px": {k: int((exclusion == c).sum()) for k, c in (("not_forest", EXC_NOT_FOREST), ("water", EXC_WATER), ("geometry", EXC_GEOMETRY),
                                                                         ("steep", EXC_STEEP), ("builtup", EXC_BUILTUP),
                                                                         ("prior_nonforest", EXC_PRIOR_NONFOREST), ("few_valid", EXC_FEW_VALID),
                                                                         ("early_change", EXC_EARLY_CHANGE))},
            "wet_epoch_fraction": round(float(flagged.mean()), 3), "valid_fraction_evaluated": round(float(np.isfinite(hv)[:, evaluate].mean()), 4) if ev_n else 0.0,
            "bundle_baseline": base_chk, "sigma_hv_median_db": round(float(np.nanmedian(sigma_hv[evaluate])), 3) if ev_n else None, "smooth_px": sm,
            "pixel_speckle_floor_db": round(float(np.nanmedian(floor[evaluate])), 3) if ev_n else None,
            "pooled_sigma_db": {"hv": round(pooled_hv, 3), "hh": None if pooled_hh is None else round(pooled_hh, 3), "ratio": None if pooled_ratio is None else round(pooled_ratio, 3)},
            "has_hh": co is not None, "offset_correction": bool(P.normalize_common_mode)}
    pix = float(abs(g20.dx))
    prep = Prepared(key=key, times=times, days=days, rows=H, cols=W, x=x_ax, y=y_ax, epsg=int(g20.epsg), pixel_m=pix, hv=hv, hh=hh, ratio=ratio, hv_raw=hv_raw_c, hh_raw=hh_raw_c, ref_hv_raw=ref_hv_raw, ref_hh_raw=ref_hh_raw,
                    z_hv=z_hv, z_hh=z_hh, z_ratio=z_ratio, ref_hv=ref_hv, ref_hh=ref_hh, ref_ratio=ref_ratio, sigma_hv=sigma_hv, sigma_hh=sigma_hh, sigma_ratio=sigma_ratio, usable=usable,
                    evaluate=evaluate, exclusion=exclusion, flood_prone=flood_prone, n_ref=n_ref, epoch_flags=flags, slope=slope, hand=hand,
                    tree_cover=tree, local_incidence=lia, diag=diag, core=(rs.start, cs.start))
    return prep, None

"""3.08 deforestation - corroborating cues from the interferometric stack (M1 coherence, M3 offsets, LOS).

None of these decides anything alone; each is reported with its numbers and may only raise or lower the within-tier score a
little (verdict.py). What is expected, from the L-band literature:
  * ground cleared of forest has HIGH, temporally stable coherence (no canopy volume decorrelation) and low backscatter
    (boreal L-band PALSAR work; not validated for the tropics here), and the pair that SPANS the clearing decorrelates;
  * pixel-offset correlation peaks fall where the surface changed (weak cue, reported only);
  * a patch that also moved (|LOS| beyond atmosphere-sized noise) may be a landslide that stripped the forest, not a clearing.
"""
from __future__ import annotations

import numpy as np

from .lib_local import parse_time

MAD_SIGMA = 1.4826


def _flat80(bundle, rows, cols, core) -> np.ndarray:
    idx = np.asarray(bundle.grids.index_map_20_to_80)[rows + core[0], cols + core[1]]
    return np.unique(idx.ravel())


def _series(arr, flat) -> np.ndarray:
    a = np.asarray(arr)
    out = np.full(a.shape[0], np.nan)
    flat2 = a.reshape(a.shape[0], -1)[:, flat].astype(np.float64)
    for i in range(a.shape[0]):
        v = flat2[i][np.isfinite(flat2[i])]
        if v.size:
            out[i] = float(v.mean())
    return out


def _split(pairs, t_prev, t_on):
    pre, span, post = [], [], []
    for i, p in enumerate(pairs):
        if not (getattr(p, "times_resolved", False) and p.ref_time and p.sec_time):
            continue
        r, s = parse_time(p.ref_time), parse_time(p.sec_time)
        if s <= t_prev:
            pre.append(i)
        elif r <= t_prev and s >= t_on:
            span.append(i)
        elif r >= t_on:
            post.append(i)
    return pre, span, post


def _mean(a, idx):
    v = a[idx] if len(idx) else np.array([])
    v = v[np.isfinite(v)]
    return float(v.mean()) if v.size else None


def interferometric_cues(bundle, stack, patch: dict, core: tuple, P, use=lambda n: None) -> dict:
    """-> {"coherence": {...}, "offsets": {...}, "ground_motion": {...}}; every block says 'unavailable' with a reason when it cannot run."""
    ifg = stack.interferometric
    t_prev, t_on = parse_time(patch["prev_epoch_time"]), parse_time(patch["onset_time"])
    out = {"coherence": {"cue": "unavailable", "reason": "no interferometric pairs in this stack"},
           "offsets": {"cue": "unavailable", "reason": "no pixel offsets in this stack"},
           "ground_motion": {"flag": None, "reason": "no usable LOS displacement"}}
    flat = _flat80(bundle, patch["_rows"], patch["_cols"], core)
    if ifg is not None and ifg.pairs:
        pre, span, post = _split(ifg.pairs, t_prev, t_on)
        if ifg.coherence is not None:
            use("stacks[*].interferometric.coherence")
            use("stacks[*].interferometric.pairs")
            coh = _series(ifg.coherence, flat)
            pre_m, span_m, post_m = _mean(coh, pre), _mean(coh, span), _mean(coh, post)
            cue, why = "neutral", "no pair pattern that separates cleared ground from forest"
            if pre_m is None and post_m is None and span_m is None:
                cue, why = "unavailable", "no resolved pair falls before, across or after the loss date"
            elif pre_m is not None and post_m is not None and post_m - pre_m >= P.coherence_delta:
                cue, why = "supports", f"coherence rose {post_m - pre_m:+.2f} after the loss date (stable cleared ground)"
            elif pre_m is not None and span_m is not None and pre_m - span_m >= 1.5 * P.coherence_delta:
                cue, why = "supports", f"the pair spanning the loss date lost {pre_m - span_m:.2f} coherence"
            lat_z = None
            cb = ifg.coherence_baseline
            if cb is not None:
                use("stacks[*].interferometric.coherence_baseline")
                med, mad, lat = (np.asarray(cb.median).ravel()[flat], np.asarray(cb.mad).ravel()[flat], np.asarray(cb.latest).ravel()[flat])
                sg = max(float(np.nanmean(mad)) * MAD_SIGMA, 0.02) if np.isfinite(mad).any() else 0.02
                if np.isfinite(med).any() and np.isfinite(lat).any():
                    lat_z = float((np.nanmean(lat) - np.nanmean(med)) / sg)
            out["coherence"] = {"cue": cue, "reason": why, "pre": pre_m, "spanning": span_m, "post": post_m,
                                "n_pairs": {"pre": len(pre), "spanning": len(span), "post": len(post)}, "latest_vs_baseline_z": lat_z}
        if ifg.los_m is not None and (span or post):
            use("stacks[*].interferometric.los_m")
            use("stacks[*].interferometric.sigma_m")
            use("stacks[*].interferometric.conn_comp")
            los = np.asarray(ifg.los_m).reshape(len(ifg.pairs), -1)
            sig = np.asarray(ifg.sigma_m).reshape(len(ifg.pairs), -1)
            cc = np.asarray(ifg.conn_comp).reshape(len(ifg.pairs), -1)
            best = None
            for i in span + post:
                allv = los[i][(cc[i] > 0) & np.isfinite(los[i])]
                loc = los[i][flat]
                ok = (cc[i][flat] > 0) & np.isfinite(loc)
                if allv.size < 20 or ok.sum() < 2:
                    continue
                ref = float(np.median(allv))
                disp = float(np.median(loc[ok]) - ref)
                sg = float(np.nanmedian(sig[i][flat][ok])) if np.isfinite(sig[i][flat][ok]).any() else 0.0
                thr = max(P.los_abs_min_m, P.los_k * sg)
                if best is None or abs(disp) > abs(best["los_m"]):
                    best = {"los_m": disp, "threshold_m": thr, "pair_index": i, "flag": abs(disp) >= thr}
            if best is not None:
                out["ground_motion"] = {**best, "reason": ("the patch moved relative to the tile: a landslide could have removed the forest"
                                                           if best["flag"] else "no movement beyond the noise level")}
        pk = None
        off = stack.offsets
        if off is not None and getattr(off, "peak", None) is not None and getattr(off, "pairs", None):
            use("stacks[*].offsets.peak")
            s = _series(off.peak, flat)
            o_pre, o_span, o_post = _split(off.pairs, t_prev, t_on)
            a, b = _mean(s, o_pre), _mean(s, o_post)
            out["offsets"] = {"cue": "informational", "pre": a, "post": b,
                              "reason": "correlation-peak change is reported, not scored (weak cue at 80 m over forest)"}
    return out

"""What else could explain this tile? (EQ_AUDIT follow-up: say more than "not supported" / "insufficient".)

For a NOT_SUPPORTED or INSUFFICIENT_EVIDENCE answer the pipeline now also reports a short list of ALTERNATIVE EXPLANATIONS,
each with numbers measured on THIS scene, a plain reading, an indication and the next step that would settle it:

    {"id", "title", "indication", "reading", "measured", "next_step"}

indication is one of
    "indicated"      the data point this way (a stated, checkable criterion is met),
    "not_indicated"  tested and the data do not point this way,
    "cannot_tell"    the data are not enough to say either way,
    "not_run"        the check could not be evaluated (reason in `reading`).

Rules of the house:
* Nothing here changes the status. An alternative is a lead to follow, never a result. A "fit" found by searching is
  reported with a search-adjusted p-value, so a good-looking match that a search always finds is not sold as evidence.
* Every item is computed from the bundle; no item is a generic disclaimer. An item that cannot be computed says so.
* One failing check never breaks the verdict: each is wrapped and degrades to `not_run`.
"""
from __future__ import annotations

import dataclasses
import math

import numpy as np

from . import model
from .types import EqParams

MECH_STRIKES = tuple(range(0, 360, 30))
MECH_DIPS = (30, 50, 70)
MECH_RAKES = (-90, -45, 0, 45, 90)
RAMP_INDICATED_FRACTION = 0.70          # share of detected pixels that vanish once a plane is removed
RAMP_NOT_INDICATED_FRACTION = 0.30
UNSTABLE_INDICATED_SHARE = 0.50         # share of detected pixels on ground the bundle calls unstable ...
UNSTABLE_MARGIN = 0.20                  # ... and at least this much above the unstable share of the whole tile
SEARCH_ALPHA = 0.05
MAX_EXTRA_EVENTS = 3


def _item(id_: str, title: str, indication: str, reading: str, next_step: str, measured: dict | None = None) -> dict:
    return {"id": id_, "title": title, "indication": indication, "reading": reading, "next_step": next_step,
            "measured": measured or {}}


def _guard(id_: str, title: str, fn) -> dict | None:
    try:
        return fn()
    except Exception as ex:  # noqa: BLE001 - degrade, never break the verdict
        return _item(id_, title, "not_run", f"could not be evaluated ({type(ex).__name__}: {ex}).",
                     "Report this as a bug; the verdict itself is unaffected.")


# --------------------------------------------------------------------------------------------------- atmosphere / orbit ramp
def ramp_alternative(best) -> dict | None:
    """Would the detections survive removing one smooth plane (the simplest orbit / long-wavelength atmosphere error)?"""
    title = "A smooth atmosphere or orbit ramp"
    if best.summary.detected_pixels == 0:
        return None
    disp = np.asarray(best.disp, dtype=np.float64)
    ok = np.asarray(best.mask, dtype=bool) & np.isfinite(disp)
    thr = np.asarray(best.grids["thresholds"], dtype=np.float64)
    ii, jj = np.nonzero(ok)
    if ii.size < 30:
        return _item("ramp", title, "cannot_tell", "too few valid pixels to fit a plane.",
                     "Use a pair with more coherent pixels.")
    A = np.c_[ii, jj, np.ones(ii.size)]
    coef, *_ = np.linalg.lstsq(A, disp[ok], rcond=None)
    # remove the TILT only: the data are already referenced to the far field, so the level must not be moved
    tilt = coef[0] * (ii - ii.mean()) + coef[1] * (jj - jj.mean())
    resid = disp[ok] - tilt
    ss_tot = float(((disp[ok] - disp[ok].mean()) ** 2).sum())
    r2 = float((tilt ** 2).sum()) / ss_tot if ss_tot > 0 else 0.0
    before = int((np.abs(disp[ok]) > thr[ok]).sum())
    after = int((np.abs(resid) > thr[ok]).sum())
    removed = 1.0 - after / before if before else 0.0
    m = {"detected_before": before, "detected_after_plane_removal": after, "fraction_removed": round(removed, 3),
         "plane_variance_explained": round(r2, 3)}
    if removed >= RAMP_INDICATED_FRACTION:
        return _item("ramp", title, "indicated",
                     f"{removed:.0%} of the detected pixels disappear when one plane is removed (the plane explains {r2:.0%} of the "
                     "variance): this looks like a smooth ramp, not a localised deformation.",
                     "Compare a second pair or the other look direction: atmosphere changes between passes, tectonic motion does not.", m)
    if removed < RAMP_NOT_INDICATED_FRACTION:
        return _item("ramp", title, "not_indicated",
                     f"only {removed:.0%} of the detected pixels disappear after removing a plane (it explains {r2:.0%} of the variance): "
                     "the signal is localised, not a ramp.", "None needed for this explanation.", m)
    return _item("ramp", title, "cannot_tell",
                 f"{removed:.0%} of the detected pixels disappear after removing a plane: part of the signal may be a ramp.",
                 "Re-run with detrend=true, or compare a second pair.", m)


# ----------------------------------------------------------------------------------------- a different mechanism, same event
def _surrogates(disp, mask, k, seed):
    field = np.where(mask & np.isfinite(disp), disp, 0.0)
    amp = np.abs(np.fft.rfft2(field))
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
    done = 0
    while done < k:
        m = min(50, k - done)
        phase = np.angle(np.fft.rfft2(rng.standard_normal((m,) + field.shape), axes=(-2, -1)))
        yield np.fft.irfft2(amp[None] * np.exp(1j * phase), s=field.shape, axes=(-2, -1))
        done += m


def mechanism_alternative(best, ev, epsg: int, params: EqParams, n_surrogates: int = 199) -> dict:
    """Search strike x dip x rake at the event's own location and magnitude for a mechanism that fits the data, and test the
    BEST fit against the same search on phase-randomised copies of the data (so the search itself is accounted for)."""
    title = f"A different mechanism for event {ev.id}"
    disp = np.asarray(best.disp, dtype=np.float64)
    mask = np.asarray(best.mask, dtype=bool) & np.isfinite(disp)
    trials = [(float(s), float(d), float(r)) for s in MECH_STRIKES for d in MECH_DIPS for r in MECH_RAKES]
    preds = []
    for t in trials:
        pred, _ = model.prediction_field(best, dataclasses.replace(ev, nodal_planes=(t,)), epsg, 0)
        preds.append(pred)
    if any(p is None for p in preds):
        return _item("mechanism", title, "not_run", "the forward model could not be evaluated for this event.",
                     "Check that the event has a location and depth.")
    P = np.stack([np.asarray(p, dtype=np.float64) for p in preds])
    ok = mask & np.isfinite(P).all(axis=0)
    if int(ok.sum()) < 30:
        return _item("mechanism", title, "not_run", "too few valid pixels for a mechanism search.", "Use a pair with more coherent pixels.")
    X = P[:, ok]
    Xc = X - X.mean(axis=1, keepdims=True)
    xn = np.sqrt((Xc ** 2).sum(axis=1))
    xn[xn == 0] = np.inf
    mvec = disp[ok]
    mc = mvec - mvec.mean()
    mn = math.sqrt(float((mc ** 2).sum()))
    r_obs = (Xc @ mc) / (xn * (mn if mn > 0 else np.inf))
    q = params.peak_quantile
    ratio = np.quantile(np.abs(mvec), q) / np.maximum(np.quantile(np.abs(X), q, axis=1), 1e-12)
    b = int(np.argmax(r_obs))
    ii, jj = np.nonzero(ok)
    exceed, total = 0, 0
    for S in _surrogates(disp, mask, n_surrogates, params.surrogate_seed):
        v = S[:, ii, jj]
        v = v - v.mean(axis=1, keepdims=True)
        den = np.sqrt((v ** 2).sum(axis=1))[:, None] * xn[None, :]
        with np.errstate(invalid="ignore", divide="ignore"):
            r = np.nan_to_num((v @ Xc.T) / den, nan=-1.0)
        exceed += int((r.max(axis=1) >= r_obs[b]).sum())
        total += v.shape[0]
    p_search = (1.0 + exceed) / (total + 1.0)
    amp_ok = (1.0 / model.AMPLITUDE_RATIO_FACTOR) < ratio[b] < model.AMPLITUDE_RATIO_FACTOR
    s, d, r = trials[b]
    m = {"n_mechanisms_searched": len(trials), "best_strike": s, "best_dip": d, "best_rake": r,
         "best_pattern_correlation": round(float(r_obs[b]), 3), "best_amplitude_ratio": round(float(ratio[b]), 2),
         "search_adjusted_p": round(p_search, 4), "n_surrogates": total}
    cat = ", ".join(f"{p[0]:.0f}/{p[1]:.0f}/{p[2]:.0f}" for p in ev.nodal_planes) or "none published"
    if p_search <= SEARCH_ALPHA and amp_ok and r_obs[b] > model.PATTERN_CORRELATION_MIN:
        return _item("mechanism", title, "indicated",
                     f"a mechanism strike {s:.0f} / dip {d:.0f} / rake {r:.0f} (catalogue: {cat}) fits the data (r = {r_obs[b]:.2f}, amplitude "
                     f"ratio {ratio[b]:.2f}) better than {1 - p_search:.0%} of the best fits found on phase-scrambled copies of the same "
                     f"data, after searching {len(trials)} mechanisms. The event may be right and its published mechanism wrong or preliminary.",
                     "Wait for the reviewed moment tensor or finite-fault model, or compare this mechanism with the regional tectonics. "
                     "Treat it as a lead: it was chosen after seeing the data.", m)
    return _item("mechanism", title, "not_indicated",
                 f"the best of {len(trials)} mechanisms (strike {s:.0f} / dip {d:.0f} / rake {r:.0f}) reaches r = {r_obs[b]:.2f}, but a search "
                 f"over that many mechanisms finds a fit that good by chance in {p_search:.0%} of phase-scrambled copies of the data "
                 "(or the amplitude does not match). A wrong published mechanism is not what the data point to.",
                 "None needed for this explanation.", m)


# ----------------------------------------------------------------------------------- other catalogued events outside the screen
def other_events_alternative(best, events, selection, epsg: int, params: EqParams, summary) -> dict | None:
    title = "A catalogued event the screen did not consider"
    ranked_ids = {e.id for e, _ in selection.ranked}
    by_id = {e.id: e for e in events}
    far = [by_id[x["id"]] for x in selection.excluded
           if x["id"] in by_id and " km from the footprint" in str(x.get("reason", "")) and by_id[x["id"]].nodal_planes
           and x["id"] not in ranked_ids]
    far.sort(key=lambda e: -(e.magnitude if e.magnitude is not None else -1))
    far = far[:MAX_EXTRA_EVENTS]
    n_far_all = sum(1 for x in selection.excluded if " km from the footprint" in str(x.get("reason", "")))
    if n_far_all == 0:
        return None
    if not far:
        return _item("other_events", title, "cannot_tell",
                     f"{n_far_all} in-window event(s) lie beyond {params.max_event_distance_km:.0f} km and publish no usable mechanism.",
                     "Supply nodal planes for them, or raise max_event_distance_km and re-run.", {"n_excluded_for_distance": n_far_all})
    alpha = params.correlation_alpha
    rows = []
    for ev in far:
        scr = model.forward_screen(best, ev, epsg, params, plane_index=0)
        if scr.get("skipped"):
            continue
        need = params.predicted_signal_min_factor * float(getattr(summary, "threshold_median_m", 0.0) or 0.0)
        p = scr.get("correlation_p")
        padj = min(1.0, p * len(far)) if p is not None else None
        amp_ok = (1.0 / model.AMPLITUDE_RATIO_FACTOR) < scr["amplitude_ratio"] < model.AMPLITUDE_RATIO_FACTOR
        corr_ok = scr["pattern_correlation"] > model.PATTERN_CORRELATION_MIN and (padj is None or padj <= alpha)
        informative = not (need > 0 and scr["predicted_peak_m"] < need)
        rows.append({"event_id": ev.id, "magnitude": ev.magnitude, "predicted_peak_mm": round(scr["predicted_peak_m"] * 1000, 2),
                     "amplitude_ratio": round(scr["amplitude_ratio"], 2), "pattern_correlation": round(scr["pattern_correlation"], 3),
                     "adjusted_p": None if padj is None else round(padj, 4), "informative": informative,
                     "passes": bool(amp_ok and corr_ok and informative)})
    if not rows:
        return _item("other_events", title, "not_run", "the forward model could not be evaluated for the excluded events.",
                     "Check their nodal planes and depth.")
    hit = [r for r in rows if r["passes"]]
    if hit:
        h = hit[0]
        return _item("other_events", title, "indicated",
                     f"event {h['event_id']} (Mw {h['magnitude']}), outside the {params.max_event_distance_km:.0f} km screening limit, predicts "
                     f"{h['predicted_peak_mm']} mm here and matches (ratio {h['amplitude_ratio']}, r {h['pattern_correlation']}, "
                     f"adjusted p {h['adjusted_p']}). A large distant earthquake can leave a smooth signal over a whole tile.",
                     "Re-run with max_event_distance_km large enough to include it, and read the result for that event.", {"events": rows})
    return _item("other_events", title, "not_indicated",
                 f"{len(rows)} of {n_far_all} in-window event(s) beyond {params.max_event_distance_km:.0f} km were screened and none explains the "
                 "data (too weak here to test, or no match).", "None needed for this explanation.", {"events": rows})


# --------------------------------------------------------------------------------------------- non-tectonic surface change
def surface_alternative(best, stable_mask_core) -> dict | None:
    title = "Surface change that is not tectonic (vegetation, water, steep ground)"
    if best.summary.detected_pixels == 0:
        return None
    if stable_mask_core is None:
        return _item("surface", title, "cannot_tell", "the bundle carries no stable-ground mask to check against.",
                     "Build the bundle with the DEM and coherence layers so ground stability can be assessed.")
    det = np.asarray(best.grids["detected"]) != 0
    valid = np.asarray(best.mask, dtype=bool)
    unstable = ~np.asarray(stable_mask_core, dtype=bool)
    if stable_mask_core.shape != det.shape or not det.any() or not valid.any():
        return None
    share_det = float(unstable[det].mean())
    share_tile = float(unstable[valid].mean())
    m = {"detected_on_unstable_ground": round(share_det, 3), "tile_unstable_share": round(share_tile, 3)}
    if share_det >= UNSTABLE_INDICATED_SHARE and share_det >= share_tile + UNSTABLE_MARGIN:
        return _item("surface", title, "indicated",
                     f"{share_det:.0%} of the detected pixels sit on ground the bundle marks unstable, against {share_tile:.0%} of the tile: "
                     "the signal follows unstable surface (water, steep or poorly coherent ground), which tectonic motion would not.",
                     "Check the detected area against imagery and the GCOV backscatter change; a landslide or flood is a likelier cause.", m)
    return _item("surface", title, "not_indicated",
                 f"{share_det:.0%} of the detected pixels sit on unstable ground, about what the tile as a whole has ({share_tile:.0%}).",
                 "None needed for this explanation.", m)


# ------------------------------------------------------------------------------------------- signal larger than the tile
def edge_alternative(best, params: EqParams) -> dict | None:
    et = getattr(best, "edge_touch", None)
    if et is None:
        return None
    title = "A signal larger than the tile"
    m = {"reference_ring_detected_fraction": round(float(et), 3), "limit": params.edge_touch_max_fraction}
    if et > params.edge_touch_max_fraction:
        return _item("tile_size", title, "indicated",
                     f"{et:.0%} of the reference ring is itself detected as movement (limit {params.edge_touch_max_fraction:.0%}): the "
                     "movement extends past the tile, and referencing to the tile edge removed part of it.",
                     "Re-run on a larger area, or with reference_strategy=fullFrameMedian / stableFarField.", m)
    return _item("tile_size", title, "not_indicated", f"only {et:.0%} of the reference ring is detected: the signal is contained in the tile.",
                 "None needed for this explanation.", m)


# --------------------------------------------------------------------------------- nothing detected: expected or contradicting?
def undetected_alternative(best, screens: list, summary) -> dict | None:
    """With no detection, say whether finding nothing is what the event itself predicts."""
    if summary.detected_pixels > 0:
        return None
    bs = model.best_screen(screens)
    if bs is None:
        return None
    title = "Nothing detected although an event is catalogued"
    thr = float(getattr(summary, "threshold_median_m", 0.0) or 0.0)
    pred = bs["predicted_peak_m"]
    valid_frac = float(np.asarray(best.mask, dtype=bool).mean())
    m = {"event_id": bs["event_id"], "predicted_peak_mm": round(pred * 1000, 2), "detection_threshold_mm": round(thr * 1000, 2),
         "valid_pixel_fraction": round(valid_frac, 3)}
    if thr > 0 and pred < thr:
        return _item("undetected", title, "indicated",
                     f"event {bs['event_id']} predicts at most {pred * 1000:.1f} mm over this tile, below the {thr * 1000:.1f} mm detection "
                     "threshold: finding nothing is what the event itself predicts, not a contradiction.",
                     "A more sensitive pair (lower noise) or a tile nearer the source is needed to see whether the event left anything here.", m)
    if valid_frac < 0.5:
        return _item("undetected", title, "indicated",
                     f"the event predicts {pred * 1000:.1f} mm (above the {thr * 1000:.1f} mm threshold) but only {valid_frac:.0%} of the tile "
                     "is coherent: the signal may sit on decorrelated ground the pair cannot see.",
                     "Use a pair with a shorter baseline, or a later pair after the surface has recovered coherence.", m)
    return _item("undetected", title, "not_indicated",
                 f"the event predicts {pred * 1000:.1f} mm, above the {thr * 1000:.1f} mm threshold, over a coherent tile ({valid_frac:.0%} valid): "
                 "the missing signal contradicts the event as modelled.",
                 "Check the published mechanism and depth; a deeper or smaller rupture predicts less at the surface.", m)


# --------------------------------------------------------------------------------------------- by elimination: a localised source
def localised_source_alternative(by_id: dict, best) -> dict | None:
    """Not a fit: what is left when the cheap alternatives are ruled out. Reported as such."""
    if best.summary.detected_pixels == 0:
        return None
    ramp, tile, surf = by_id.get("ramp"), by_id.get("tile_size"), by_id.get("surface")
    if not (ramp and tile and ramp["indication"] == "not_indicated" and tile["indication"] == "not_indicated"):
        return None
    if surf is not None and surf["indication"] == "indicated":
        return None
    title = "A real, localised source that the catalogued event does not explain"
    return _item("localised_source", title, "indicated",
                 "by elimination, not by fit: the signal is localised (not a ramp), contained in the tile"
                 + (" and not tied to unstable ground" if surf is not None and surf["indication"] == "not_indicated" else "")
                 + ", yet no screened event reproduces it. A source missing from the catalogue, or modelled with the wrong mechanism, "
                 "depth or size, is what remains.",
                 "Check local and regional networks and aftershock catalogues; wait for a reviewed moment tensor or finite-fault model; "
                 "set eq_params.explore_uncatalogued=true for a single vertical-fault fit (slow, and it cannot represent a bowl).",
                 {"detected_pixels": int(best.summary.detected_pixels)})


# ------------------------------------------------------------------------------------------------- too weak to test here
def weak_alternative(rule: str | None, extra: dict) -> dict | None:
    if rule not in ("predicted_signal_below_noise", "weak_prediction_no_match"):
        return None
    pred, need = extra.get("predicted_peak_m", 0.0), extra.get("required_predicted_peak_m", 0.0)
    return _item("too_weak", "The event is real but too weak to test on this tile", "indicated",
                 f"event {extra.get('best_event_id')} predicts {pred * 1000:.1f} mm here; this tile can only test signals above "
                 f"{need * 1000:.1f} mm, so a match or a mismatch would mean nothing.",
                 "Use a lower-noise pair (shorter baseline, quieter atmosphere), or a tile closer to the source.",
                 {"predicted_peak_mm": round(pred * 1000, 2), "testable_above_mm": round(need * 1000, 2)})


# --------------------------------------------------------------------------------------------------- one look direction only
def single_stack_alternative(n_stacks_analysed: int, n_stacks_bundle: int) -> dict | None:
    if n_stacks_analysed != 1:
        return None
    title = "A second look direction"
    if n_stacks_bundle > 1:
        return _item("second_stack", title, "cannot_tell", "only one of the bundle's stacks produced a usable pair here.",
                     "Check why the other stack(s) failed (coherence, time window); a second line of sight tests the same source independently.")
    return _item("second_stack", title, "cannot_tell", "only one look direction exists for this tile and window.",
                 "Add a pair from the opposite pass direction when one is acquired: it tests the same source independently.")


# ------------------------------------------------------------------------------------------------------ uncatalogued source
def uncatalogued_alternative(best, epsg: int, params: EqParams) -> dict | None:
    from . import uncatalogued
    title = "A source nobody catalogued"
    if best.summary.detected_pixels == 0:
        return None
    fit = uncatalogued.fit_uncatalogued(best, best.summary, epsg, params)
    if not fit.get("attempted"):
        return _item("uncatalogued", title, "not_run", f"the source fit was not attempted: {fit.get('reason')}.", "None.")
    m = {"converged": bool(fit.get("converged")), "rms_ratio": fit.get("rms_ratio"), "pattern_correlation": fit.get("pattern_correlation"),
         "parameters": fit.get("parameters")}
    if fit.get("converged"):
        return _item("uncatalogued", title, "indicated",
                     f"a single vertical strike-slip source fits the signal (residual RMS {fit.get('rms_ratio', float('nan')):.2f} x the field RMS, "
                     f"r {fit.get('pattern_correlation', float('nan')):.2f}) although no catalogued event matches. This is a fit, not a detection.",
                     "Look for a smaller or unreported event (local networks, aftershock catalogues) and for creep or a non-seismic source.", m)
    return _item("uncatalogued", title, "not_indicated",
                 "a simple single-source model does not fit the signal well enough (the fit did not converge).", "None needed for this explanation.", m)


# ----------------------------------------------------------------------------------------------------------- next steps by rule
NEXT_STEP_BY_RULE = {
    "search_incomplete": "Re-run once the ASF/CMR listing is complete, or supply the missing granules; the quiet result is not trusted until then.",
    "los_convention_suspect": "Verify radar.los_vector_points and set radar.look_side; the signed comparison needs a correct line-of-sight convention.",
    "stacks_disagree": "Inspect coherence and unwrapping on the contradicting stack; if it is clean, the single-stack match is probably chance or a wrong mechanism.",
    "events_unscreenable": "Wait for a reviewed moment tensor (e.g. USGS W-phase) or supply nodal planes; the mechanism search below shows what would fit.",
    "predicted_signal_below_noise": "A quieter pair or a tile nearer the source is needed; this tile cannot test the event.",
    "weak_prediction_no_match": "A quieter pair or a tile nearer the source is needed; the mismatch at this size is not evidence against the event.",
    "screen_fail": "See the alternatives below: they say which other explanation the data point to, if any.",
}


def explore(*, status: str, rule: str | None, extra: dict, best, screens: list, selection, events: list, epsg: int,
            params: EqParams, stable_mask_core, n_stacks_analysed: int, n_stacks_bundle: int, uncatalogued_ok: bool = True) -> dict:
    """-> {"next_step": str | None, "alternatives": [item, ...]} (indicated items first, then cannot_tell, not_run, not_indicated)."""
    items: list[dict | None] = []
    summary = best.summary
    items.append(_guard("ramp", "A smooth atmosphere or orbit ramp", lambda: ramp_alternative(best)))
    # the event whose mechanism we question: the decisive screened event, else the first ranked event without a usable mechanism
    bs = model.best_screen(screens)
    ev = None
    if bs is not None:
        ev = next((e for e, _ in selection.ranked if e.id == bs["event_id"]), None)
    if ev is None and selection.ranked:
        ev = selection.ranked[0][0]
    if ev is not None and summary.detected_pixels > 0:
        items.append(_guard("mechanism", f"A different mechanism for event {ev.id}",
                            lambda: mechanism_alternative(best, ev, epsg, params)))
    items.append(_guard("other_events", "A catalogued event the screen did not consider",
                        lambda: other_events_alternative(best, events, selection, epsg, params, summary)))
    items.append(_guard("surface", "Surface change", lambda: surface_alternative(best, stable_mask_core)))
    items.append(_guard("tile_size", "A signal larger than the tile", lambda: edge_alternative(best, params)))
    items.append(_guard("undetected", "Nothing detected", lambda: undetected_alternative(best, screens, summary)))
    items.append(_guard("too_weak", "Too weak to test", lambda: weak_alternative(rule, extra)))
    items.append(_guard("second_stack", "A second look direction", lambda: single_stack_alternative(n_stacks_analysed, n_stacks_bundle)))
    if uncatalogued_ok and status == "NOT_SUPPORTED":
        items.append(_guard("uncatalogued", "A source nobody catalogued", lambda: uncatalogued_alternative(best, epsg, params)))
    out = [i for i in items if i]
    loc = _guard("localised_source", "A localised source", lambda: localised_source_alternative({i["id"]: i for i in out}, best))
    if loc:
        out.append(loc)
    order = {"indicated": 0, "cannot_tell": 1, "not_run": 2, "not_indicated": 3}
    out.sort(key=lambda i: order.get(i["indication"], 9))
    return {"next_step": NEXT_STEP_BY_RULE.get(rule or ""), "alternatives": out}


def summary_sentence(result: dict) -> str | None:
    """One plain sentence for the result summary."""
    alts = result.get("alternatives") or []
    if not alts:
        return None
    ind = [a for a in alts if a["indication"] == "indicated"]
    if ind:
        return "Other explanations the data point to: " + "; ".join(a["title"].lower() for a in ind[:3]) + " (see alternatives)."
    tell = [a for a in alts if a["indication"] == "cannot_tell"]
    n_no = sum(1 for a in alts if a["indication"] == "not_indicated")
    if tell:
        return (f"No alternative explanation stands out ({n_no} checked and not indicated); the data cannot settle: "
                + "; ".join(a["title"].lower() for a in tell[:2]) + ".")
    return f"No alternative explanation stands out ({n_no} checked and not indicated)."

"""3.08 deforestation - returns P, status, evidence[] (engine/verdict schema).

output (manifest): rank score (never a probability) for forest loss, area ha, cause label, persistence count, agreement with R7.

Entry point: run(bundle, providers=None) -> PipelineResult (engine/registry.py). `providers` injects offline sources:
{"alerts": fn(bbox,t0,t1), "fires": fn(bbox,t0,t1), "rain": fn(lat,lon,days), "tracks": fn(lat,lon,t0,t1,max_km), "loss": fn(polys)}.

Status decision table (first match wins; every rule id is in detail.decision.rule):
  no_data                       empty bundle / no M2 backscatter                                   -> INSUFFICIENT_EVIDENCE
  no_analysable_stack           every stack failed a precondition (reasons listed)                   -> INSUFFICIENT_EVIDENCE
  too_little_forest             tested forest < min_forest_fraction of the tile                      -> INSUFFICIENT_EVIDENCE
  too_few_valid                 valid HV share of tested forest < min_valid_forest_fraction          -> INSUFFICIENT_EVIDENCE
  too_wet                       more than max_wet_epoch_fraction of the epochs flagged wet           -> INSUFFICIENT_EVIDENCE
  power_low                     per-pixel noise too large to see min_drop_db                         -> INSUFFICIENT_EVIDENCE
  indistinguishable_from_null   confirmed area <= null_margin x the largest null-draw area           -> INSUFFICIENT_EVIDENCE
  loss_found                    >= 1 confirmed patch >= min_patch_ha, beats the null                 -> SUPPORTED
  candidates_unconfirmed        only candidates whose series ended before persistence                -> INSUFFICIENT_EVIDENCE
  no_loss_found                 enough evidence, nothing confirmed                                   -> NOT_SUPPORTED
raw_p is an uncalibrated WITHIN-TIER rank score in [0,1] (heuristic weights in README), never a probability.
"""
from __future__ import annotations

import hashlib
import math

import numpy as np
from scipy import ndimage as ndi

from engine.common.result import LayerRef, PipelineResult

from . import fetch as _fetch
from .cues import interferometric_cues
from .lib_local import core_bounds_lonlat, iso, majority, parse_time
from .model import (attribute, density_layer, detect, extract_patches, hotspot_cells, null_screen, r7_agreement, rasterize_alerts)
from .prep import prepare_stack
from .report import evidence, fmt_ha, make_layers, usage_ledger
from .types import CAUSES, CLASS_HV, CLASS_UNCONFIRMED, PIPELINE_VERSION, load_params

REFERENCES_USED = [
    "Watanabe et al. 2018, IEEE JSTARS 11(6): early-stage L-band deforestation (HH rise, then HV fall)",
    "JICA-JAXA JJ-FAST Technical Note v11 (2026): operational L-band alerts, HH-first, flood / slope / built-up masks, accuracy figures",
    "Koyama et al. 2017/2021: rainfall effects on L-band forest backscatter (HV +2 dB after heavy rain)",
    "Reiche et al. 2021, ERL: RADD alerts (Sentinel-1) - the independent R7 comparison",
    "Aquino et al. 2022, Front. For. Glob. Change: CuSum change detection on SAR time series",
    "Page 1955 / Taylor 2000: CUSUM",
]
RELEVANT_FLAGS = ("cold_start", "no_dem", "water_proxy", "water_unknown", "epoch_all_invalid", "epoch_without_data", "empty_clip", "fetch_degraded",
                  "fetch_error", "fetch_failed", "ancillary_missing", "ancillary_partial", "ancillary_error", "baseline_excludes_event", "looks_missing",
                  "search_incomplete", "no_granules", "track_mismatch", "stable_mask_unavailable", "stable_mask_empty")


def _seed(bundle, key: str) -> int:
    return int(hashlib.sha256(f"{bundle.bundle_id}|{key}|deforestation".encode()).hexdigest()[:8], 16)


def _result(bundle, status, summary, rule, evid, warnings, detail, raw_p=None, **kw) -> PipelineResult:
    detail = {**detail, "decision": {"rule": rule}, "status_meaning": _meaning(status, rule),
              "raw_p_meaning": "raw_p is a within-tier rank score between 0 and 1. It is NOT a probability and is not calibrated."}
    return PipelineResult(pipeline="deforestation", tile=bundle.tile.id, epoch=bundle.epoch, status=status, summary=summary, raw_p=raw_p,
                          evidence=evid, warnings=warnings, bundle_id=bundle.bundle_id, detail=detail,
                          versions={"pipeline": PIPELINE_VERSION}, references_used=REFERENCES_USED, **kw)


def _insufficient(bundle, rule, why, extra_detail=None, warnings=None, evid=None, **kw):
    ev = [evidence(f"insufficient.{rule}", "insufficient", why, level="decision")] + (evid or [])
    return _result(bundle, "INSUFFICIENT_EVIDENCE", f"Not enough evidence to judge forest loss on this tile: {why}", rule, ev, warnings or [],
                   {"narrative": {"headline": f"Forest loss cannot be judged here: {why}", "reliability": None}, "detections": [], **(extra_detail or {})},
                   min_epochs_met=kw.pop("min_epochs_met", None), **kw)


def _meaning(status: str, rule: str | None) -> str:
    return {"SUPPORTED": "At least one patch of forest, at least the minimum area, dropped to a new radar level that persisted, beyond what the "
                         "rule produces on pure noise. It is a lead to inspect, not a verified loss.",
            "NOT_SUPPORTED": "Enough clean passes were available and no patch of the minimum size changed the way cleared forest does.",
            "INSUFFICIENT_EVIDENCE": "The data cannot decide: " + {
                "no_data": "there is no usable backscatter.", "no_analysable_stack": "no stack passed the preconditions.",
                "too_little_forest": "too little tested forest in the tile.", "too_few_valid": "too much of the forest has no valid measurements.",
                "too_wet": "too many passes were rain / moisture affected.", "power_low": "radar noise is larger than the change being sought.",
                "indistinguishable_from_null": "what was found is no larger than the rule produces on noise.",
                "candidates_unconfirmed": "changes were seen but the series ended before they persisted long enough to confirm."}.get(rule or "", "see the evidence.")}.get(status, "")


def _dil(mask, it=1):
    return ndi.binary_dilation(mask, iterations=it) if mask.any() else mask


def _bbox_area_ha(b) -> float:
    lat = math.radians((b[1] + b[3]) / 2)
    return abs(b[2] - b[0]) * 111320.0 * math.cos(lat) * abs(b[3] - b[1]) * 110540.0 / 1e4


def run(bundle, providers=None) -> PipelineResult:
    used: set = set()
    use = used.add
    for n in ("status", "capabilities", "tile", "request.as_of", "request.t0", "request.t1", "request.triggers", "request.active_codes", "epoch",
              "grids.g80", "grids.index_map_20_to_80", "depth", "flags", "provenance"):
        use(n)
    trig = dict(bundle.request.triggers or {})
    P = load_params(trig)
    warnings: list = []
    base_detail = {"params": {k: getattr(P, k) for k in P.__dataclass_fields__}, "tile": {"id": bundle.tile.id, "bbox_lonlat": list(bundle.tile.bbox_lonlat)}}
    if bundle.status == "empty" or not bundle.stacks or not bundle.has("M2"):
        return _insufficient(bundle, "no_data", "the bundle has no NISAR backscatter (GCOV) for this tile",
                             {**base_detail, "bundle_usage": usage_ledger(used)}, min_epochs_met=False)
    rd = bundle.routing.decisions.get("deforestation") if bundle.routing is not None else None
    if bundle.routing is not None:
        use("routing.decisions"); use("routing.quality"); use("routing.landcover_hist")
    routing = None if rd is None else {"applies": rd.applies, "reasons": list(rd.reasons), "needs": list(rd.needs), "proxy": rd.proxy}
    use("request.event_window")

    # ---- fetch (never fatal) --------------------------------------------------------------------------------
    all_times = sorted({parse_time(e.time) for s in bundle.stacks.values() if s.backscatter for e in s.backscatter.epochs})
    ctx = _fetch.fetch_context(bundle, all_times, P, providers) if all_times else {}
    rain_by_iso = {iso(t): ctx.get("rain_by_epoch", {}).get(i) for i, t in enumerate(all_times)}
    provenance = [pv for k in ("alerts", "fires", "rain", "tracks") for pv in (ctx.get(k) or {}).get("provenance", [])]
    sources = {k: {"available": v["available"], "n": len(v["items"]), "error": v["error"], "source": v["source"]} for k, v in ctx.items() if isinstance(v, dict) and "available" in v}
    for k, v in sources.items():
        if not v["available"]:
            warnings.append(f"{k}: {v['error']}")

    # ---- per stack ---------------------------------------------------------------------------------------------
    stacks, skipped = {}, {}
    summaries = {}
    for key in sorted(bundle.stacks):
        st = bundle.stacks[key]
        use("stacks[*].quality")
        summ = {"track": st.track, "direction": st.direction, "coverage_g20": st.quality.coverage_g20, "valid_fraction_g20": st.quality.valid_fraction_g20}
        if st.geometry is not None:
            for nm in ("incidence_deg", "heading_deg", "consistency_deg"):
                use(f"stacks[*].geometry.{nm}")
            inc = st.geometry.incidence_deg.g20 if st.geometry.incidence_deg.g20 is not None else st.geometry.incidence_deg.g80
            summ.update(mean_incidence_deg=None if inc is None else float(np.nanmean(inc)), heading_deg=st.geometry.heading_deg,
                        geometry_consistency_deg=st.geometry.consistency_deg)
        summaries[key] = summ
        if st.backscatter is None:
            skipped[key] = "no backscatter epochs"
            continue
        rain_map = {i: rain_by_iso.get(iso(parse_time(e.time))) for i, e in enumerate(st.backscatter.epochs)}
        prep, why = prepare_stack(bundle, key, P, rain_map, use)
        if prep is None:
            skipped[key] = why
            continue
        res = detect(prep, P)
        bs = st.backscatter
        rs, cs = bundle.grids.g20.core_slices()
        dd = zz = None
        if bs.db_diff_prev is not None and prep.diag["cross_pol"] in bs.db_diff_prev:
            use("stacks[*].backscatter.db_diff_prev")
            dd = np.asarray(bs.db_diff_prev[prep.diag["cross_pol"]])[:, rs, cs]
        if bs.z_prev is not None and prep.diag["cross_pol"] in bs.z_prev:
            zz = np.asarray(bs.z_prev[prep.diag["cross_pol"]])[:, rs, cs]
        patches, weak, lab = extract_patches(res, prep, P, dd, zz)
        nul = null_screen(prep, P, _seed(bundle, key))
        stacks[key] = {"prep": prep, "res": res, "patches": patches, "weak": weak, "lab": lab, "null": nul}
        summ.update(analysed=True, **{k: prep.diag[k] for k in ("n_epochs", "n_good_epochs", "n_ref", "evaluated_fraction", "wet_epoch_fraction")})
    if not stacks:
        return _insufficient(bundle, "no_analysable_stack", "no stack passed the preconditions (" + "; ".join(f"{k}: {v}" for k, v in skipped.items()) + ")",
                             {**base_detail, "stacks": summaries, "skipped_stacks": skipped, "routing": routing, "sources": sources, "bundle_usage": usage_ledger(used)},
                             warnings, provenance=provenance, min_epochs_met=False)
    lead_key = max(stacks, key=lambda k: (stacks[k]["prep"].diag["evaluated_fraction"] * stacks[k]["prep"].diag["n_good_epochs"], k))
    lead = stacks[lead_key]["prep"]
    H, W = lead.rows, lead.cols
    t_newest = max(t for s in stacks.values() for t in s["prep"].times)
    pix_ha = lead.pixel_m ** 2 / 1e4

    # ---- guards on evidence quality ------------------------------------------------------------------------------
    ev_frac = lead.diag["evaluated_fraction"]
    val_frac = max(s["prep"].diag["valid_fraction_evaluated"] for s in stacks.values())
    wet = min(s["prep"].diag["wet_epoch_fraction"] for s in stacks.values())
    sig = float(np.nanmedian([s["prep"].diag["sigma_hv_median_db"] for s in stacks.values() if s["prep"].diag["sigma_hv_median_db"] is not None] or [np.nan]))
    stack_diag = {k: {**s["prep"].diag, "epoch_flags": s["prep"].epoch_flags, "null": s["null"], "n_patches": len(s["patches"]), "rejected_weak_patches": s["weak"]}
                  for k, s in stacks.items()}
    common = {**base_detail, "stacks": summaries, "skipped_stacks": skipped, "stack_diagnostics": stack_diag, "routing": routing, "sources": sources, "lead_stack": lead_key}

    # ---- fuse patches across stacks --------------------------------------------------------------------------------
    cand = []
    for key, s in stacks.items():
        for p in s["patches"]:
            p["_stack"] = key
            cand.append(p)
    cand.sort(key=lambda p: (-p["area_ha"], p["_stack"], p["id"]))
    covered = np.zeros((H, W), bool)
    patches = []
    for p in cand:
        if covered[p["_rows"], p["_cols"]].mean() >= 0.5:
            continue
        covered[p["_rows"], p["_cols"]] = True
        patches.append(p)
    conf_masks = {k: _dil(s["lab"] > 0) for k, s in stacks.items()}
    for i, p in enumerate(patches, 1):
        p["id"] = i
        p["stacks_confirming"] = [k for k, m in conf_masks.items() if m[p["_rows"], p["_cols"]].mean() >= 0.3]
        p["stacks_not_confirming"] = [k for k in stacks if k not in p["stacks_confirming"] and stacks[k]["prep"].evaluate[p["_rows"], p["_cols"]].mean() >= 0.5]
    lab_map = np.zeros((H, W), np.int32)
    for p in patches:
        lab_map[p["_rows"], p["_cols"]] = p["id"]
    total_ha = float(sum(p["area_ha"] for p in patches))
    unconf = np.zeros((H, W), bool)
    for s in stacks.values():
        unconf |= majority(s["res"]["cls"] == CLASS_UNCONFIRMED, 3)
    unconf &= lab_map == 0
    unconf_ha = float(unconf.sum() * pix_ha)
    null_ha_max = max((s["null"].get("ha_max", 0.0) for s in stacks.values()), default=0.0)
    n_stacks_ok = len(stacks)

    guard = None
    if ev_frac < P.min_forest_fraction:
        guard = ("too_little_forest", f"only {100 * ev_frac:.1f}% of the tile is forest that could be tested (needs {100 * P.min_forest_fraction:.0f}%)")
    elif val_frac < P.min_valid_forest_fraction:
        guard = ("too_few_valid", f"only {100 * val_frac:.0f}% of the tested forest has valid HV measurements (needs {100 * P.min_valid_forest_fraction:.0f}%)")
    elif wet > P.max_wet_epoch_fraction:
        guard = ("too_wet", f"{100 * wet:.0f}% of the passes are rain / moisture affected (limit {100 * P.max_wet_epoch_fraction:.0f}%)")
    elif np.isfinite(sig) and P.min_drop_db / sig < 1.0:
        guard = ("power_low", f"per-pixel radar noise ({sig:.1f} dB) is larger than the {P.min_drop_db:g} dB change being sought")
    if guard is not None:
        return _insufficient(bundle, guard[0], guard[1], {**common, "bundle_usage": usage_ledger(used)}, warnings, provenance=provenance, min_epochs_met=True)

    # ---- attribution + corroboration -------------------------------------------------------------------------------
    fires = ctx["fires"]["items"] if ctx["fires"]["available"] else None
    tracks = ctx["tracks"]["items"] if ctx["tracks"]["available"] else None
    alerts_av = ctx["alerts"]["available"]
    rank = day = None
    unmatched_ha = None
    r7_n = 0
    if alerts_av:
        from datetime import timedelta
        rank, day, r7_n = rasterize_alerts(ctx["alerts"]["items"], lead, min(all_times) - timedelta(days=12), t_newest + timedelta(days=12))
        unmatched = _dil(rank >= 0) & lead.evaluate & ~_dil(lab_map > 0, 2)
        unmatched_ha = float(unmatched.sum() * pix_ha)
    for p in patches:
        prep = stacks[p["_stack"]]["prep"]
        p["attribution"] = attribute(p, prep, fires, tracks, P, trig, bundle.request.event_window)
        p["r7"] = r7_agreement(p, rank, day, P) if alerts_av else {"label": "unavailable", "overlap_fraction": None}
        p["cues"] = interferometric_cues(bundle, bundle.stacks[p["_stack"]], p, prep.core, P, use)
    loss = _fetch.fetch_loss_years(patches, P, providers)
    provenance += loss["provenance"]
    for p in patches:
        yrs = loss["results"].get(p["id"])
        if yrs is None:
            p["s4"] = {"available": False}
            continue
        yr_on = parse_time(p["onset_time"]).year
        prior = sum(v for y, v in yrs.items() if y < yr_on)
        area = max(_bbox_area_ha(p["bbox_lonlat"]), 1e-6)
        p["s4"] = {"available": True, "loss_by_year_ha": {str(k): round(v, 3) for k, v in sorted(yrs.items())}, "prior_year_loss_ha": round(prior, 3),
                   "prior_share_of_patch_box": round(min(prior / area, 1.0), 3),
                   "note": "annual loss inside the patch's bounding box (not its exact shape)"}
    if not loss["available"] and patches:
        warnings.append(f"S4 loss year: {loss['error']}")
    hot = hotspot_cells(lab_map, patches, lead, P)
    by_id = {p["id"]: p for p in patches}
    for h in hot:
        ids = h["patch_ids"]
        ha_c = {c: sum(by_id[i]["area_ha"] for i in ids if by_id[i]["attribution"]["cause"] == c) for c in CAUSES}
        h["dominant_cause"] = max(ha_c, key=ha_c.get) if ids else None
        h.pop("_cell", None)

    # ---- decision ----------------------------------------------------------------------------------------------------
    margin = max(null_ha_max, 0.0) * P.null_margin
    if patches and total_ha > max(margin, 0.0):
        status, rule = "SUPPORTED", "loss_found"
    elif patches:
        status, rule = "INSUFFICIENT_EVIDENCE", "indistinguishable_from_null"
    elif unconf_ha >= P.min_patch_ha:
        status, rule = "INSUFFICIENT_EVIDENCE", "candidates_unconfirmed"
    else:
        status, rule = "NOT_SUPPORTED", "no_loss_found"

    # ---- score ---------------------------------------------------------------------------------------------------------
    raw_p = None
    if status == "SUPPORTED":
        area_t = 1 - math.exp(-total_ha / 5.0)
        null_t = min(1.0, total_ha / max(10 * max(null_ha_max, P.min_patch_ha), 1e-9))
        w = lambda f: sum(p["area_ha"] for p in patches if f(p)) / total_ha
        r7_t = w(lambda p: p["r7"]["label"] == "agrees") if alerts_av else 0.0
        stk_t = w(lambda p: len(p["stacks_confirming"]) >= 2) if n_stacks_ok > 1 else 0.0
        coh_t = w(lambda p: p["cues"]["coherence"].get("cue") == "supports")
        per_t = min(1.0, float(np.median([p["persistence_epochs"] for p in patches])) / 4.0)
        s = 0.30 * area_t + 0.15 * null_t + 0.20 * r7_t + 0.15 * stk_t + 0.05 * coh_t + 0.15 * per_t - 0.20 * wet
        raw_p = round(0.5 + 0.5 * min(1.0, max(0.0, s)), 4)
    elif status == "NOT_SUPPORTED":
        raw_p = round(0.3 * min(1.0, unconf_ha / (3 * P.min_patch_ha)), 4)
    elif rule == "indistinguishable_from_null":
        raw_p = None

    # ---- layers --------------------------------------------------------------------------------------------------------
    bounds = core_bounds_lonlat(lead.x, lead.y, lead.epsg, lead.pixel_m)
    cls_f = np.zeros((H, W), np.uint8)
    onset_d = np.full((H, W), np.nan, np.float32)
    hvd = np.full((H, W), np.nan, np.float32)
    hhc = np.full((H, W), np.nan, np.float32) if any(s["prep"].hh is not None for s in stacks.values()) else None
    cause_f = np.zeros((H, W), np.uint8)
    for p in patches:
        s = stacks[p["_stack"]]
        r, c = p["_rows"], p["_cols"]
        cls_f[r, c] = s["res"]["cls"][r, c]
        o = s["res"]["onset"][r, c]
        days = np.array([(t_newest - s["prep"].times[i]).total_seconds() / 86400.0 if i >= 0 else np.nan for i in o])
        onset_d[r, c] = days
        hvd[r, c] = s["res"]["hv_drop_db"][r, c]
        if hhc is not None:
            hhc[r, c] = s["res"]["hh_change_db"][r, c]
        cause_f[r, c] = CAUSES.index(p["attribution"]["cause"]) + 1
    cls_f[unconf & (cls_f == 0)] = CLASS_UNCONFIRMED
    layers = make_layers({"cls": cls_f, "onset_days": onset_d, "hv_drop": hvd, "hh_change": hhc, "density": density_layer(lab_map, lead, P), "cause": cause_f,
                          "exclusion": lead.exclusion}, bounds, rank)

    # ---- evidence ---------------------------------------------------------------------------------------------------------
    ev = []
    if patches:
        first_on = min(parse_time(p["onset_time"]) for p in patches)
        ev.append(evidence("detection.total", "detection", f"{fmt_ha(total_ha)} of forest loss in {len(patches)} patch(es) of at least {P.min_patch_ha:g} ha, "
                           f"the earliest from {first_on:%Y-%m-%d}.", {"quantity": total_ha, "unit": "ha", "n_patches": len(patches),
                           "by_cause_ha": {c: round(sum(p["area_ha"] for p in patches if p["attribution"]["cause"] == c), 3) for c in CAUSES}},
                           "decision" if status == "SUPPORTED" else "info", "stacks/*/backscatter/gamma0_db"))
    for p in patches[:8]:
        a = p["attribution"]
        r7 = p["r7"]["label"]
        ev.append(evidence(f"patch.{p['id']}", "detection",
                           f"Patch {p['id']}: {fmt_ha(p['area_ha'])}, began {p['onset_time'][:10]}, HV {p['hv_drop_db']:+.1f} dB, "
                           f"{p['stage']}-stage, cause {a['cause']}; GFW alerts {r7}.",
                           {"area_ha": p["area_ha"], "onset": p["onset_time"], "hv_change_db": p["hv_drop_db"], "hh_change_db": p["hh_change_db"],
                            "ratio_change_db": p["ratio_change_db"], "persistence_epochs": p["persistence_epochs"], "stage": p["stage"], "cause": a["cause"],
                            "cause_basis": a["basis"], "geometry": a["geometry"], "r7": p["r7"], "stacks_confirming": p["stacks_confirming"],
                            "centroid_lonlat": p["centroid_lonlat"], "s4": p["s4"], "ground_motion": p["cues"]["ground_motion"],
                            "coherence": p["cues"]["coherence"]}, "corroboration" if r7 == "agrees" else "info", f"patch/{p['id']}"))
        if p["cues"]["ground_motion"].get("flag"):
            ev.append(evidence(f"caveat.landslide.{p['id']}", "flag", f"Patch {p['id']} also moved ({p['cues']['ground_motion']['los_m'] * 100:+.1f} cm line of sight): "
                               "a landslide may have stripped the forest rather than a clearing.", p["cues"]["ground_motion"], "caveat"))
        if p["s4"].get("available") and p["s4"]["prior_share_of_patch_box"] >= 0.5:
            ev.append(evidence(f"caveat.prior_loss.{p['id']}", "flag", f"Patch {p['id']}'s box already shows {p['s4']['prior_year_loss_ha']} ha of earlier annual loss: "
                               "this may be an old clearing or regrowth.", p["s4"], "caveat"))
    for h in hot:
        ev.append(evidence(f"hotspot.{h['rank']}", "detection", f"Hotspot {h['rank']}: {fmt_ha(h['loss_ha'])} of loss in one {h['cell_m']:.0f} m cell "
                           f"({100 * h['share_of_total']:.0f}% of the tile's loss), mostly {h['dominant_cause']}.", {k: v for k, v in h.items() if k != "patch_ids"}, "info", "layer/loss_density_ha"))
    if alerts_av:
        ev.append(evidence("corroboration.r7", "corroboration" if patches else "null_result",
                           f"GFW integrated alerts: {r7_n} alert pixel(s) in the window; "
                           + (f"{sum(1 for p in patches if p['r7']['label'] == 'agrees')} of {len(patches)} patch(es) agree" if patches else "none compared (no patch)")
                           + (f"; {fmt_ha(unmatched_ha)} of alerted forest was not found here." if unmatched_ha is not None else "."),
                           {"alerts": r7_n, "unmatched_alert_ha": unmatched_ha}, "info", "adapter/r7_gfw_alerts"))
    if fires is not None:
        ev.append(evidence("attribution.firms", "corroboration", f"FIRMS: {len(fires)} active-fire detection(s) in the window; "
                           f"{sum(1 for p in patches if p['attribution']['cause'] == 'fire')} patch(es) attributed to fire.", {"n_fires": len(fires)}, "info", "adapter/r6_firms"))
    if tracks is not None:
        ev.append(evidence("attribution.ibtracs", "corroboration", f"IBTrACS: {len(tracks)} storm track point(s) near the tile; "
                           f"{sum(1 for p in patches if p['attribution']['cause'] == 'windthrow')} patch(es) attributed to windthrow. "
                           + ctx["tracks"]["extra"].get("lag_note", ""), {"n_points": len(tracks)}, "info", "adapter/r10_ibtracs"))
    if n_stacks_ok > 1 and patches:
        both = sum(1 for p in patches if len(p["stacks_confirming"]) >= 2)
        ev.append(evidence("corroboration.cross_stack", "corroboration" if both else "info", f"{both} of {len(patches)} patch(es) were confirmed by two or more look "
                           f"directions / tracks ({', '.join(stacks)}).", {"stacks": list(stacks), "confirmed_by_two_or_more": both}, "info", "stacks/*"))
    nl = stacks[lead_key]["null"]
    ev.append(evidence("null_result.null_screen", "null_result", (f"Null screen: the same rule on noise-only series confirmed at most {nl.get('ha_max', 0):.2f} ha "
                       f"({nl.get('draws', 0)} draws); this tile's {fmt_ha(total_ha)} is {'above' if total_ha > margin else 'not above'} {P.null_margin:g} x that."),
                       {k: v for k, v in nl.items() if k != "note"}, "decision" if status == "SUPPORTED" else "caveat", "model/null_screen"))
    hist = max(s["prep"].diag["bundle_baseline"]["history_days"] for s in stacks.values() if s["prep"].diag["bundle_baseline"]) if any(s["prep"].diag["bundle_baseline"] for s in stacks.values()) else None
    ev.append(evidence("caveat.history", "flag", "Only " + (f"{hist:.0f}" if hist is not None else "a few") + " days of NISAR history are in the bundle (calibrated L-band begins 2026-06-17): "
                       "seasonal canopy change cannot be separated from loss, and nothing here is an annual loss figure.", {"history_days": hist}, "caveat", "depth"))
    ev.append(evidence("caveat.maturity", "flag", "The bundle does not record NISAR product maturity (beta / provisional / validated); ASF advises not mixing them in one "
                       "time series, so check the granule list.", None, "caveat", "stacks/*/backscatter/epochs"))
    if wet > 0:
        ev.append(evidence("caveat.moisture", "flag", f"{100 * wet:.0f}% of the passes were flagged for tile-wide moisture or rain; they were corrected or kept neutral, "
                           "never counted as evidence of loss.", {"wet_epoch_fraction": wet}, "caveat"))
    fp = max(s["prep"].diag["flood_prone_fraction_of_evaluated"] for s in stacks.values())
    if fp > 0.05:
        ev.append(evidence("caveat.flood_prone", "flag", f"{100 * fp:.0f}% of the tested forest is flood-prone (low HAND): early-stage calls there need HV to agree.", {"fraction": fp}, "caveat"))
    if status == "INSUFFICIENT_EVIDENCE":
        ev.insert(0, evidence(f"insufficient.{rule}", "insufficient", _meaning(status, rule), None, "decision"))
    for nm, src in sources.items():
        if not src["available"]:
            ev.append(evidence(f"source.{nm}", "insufficient", f"{nm} was not available ({src['error']}); what it would have checked is said as 'not excluded' in the patches.", None, "caveat"))
    for f in bundle.flags:
        if f.code in RELEVANT_FLAGS:
            warnings.append(f"[{f.step}/{f.code}] {f.message}")
    for k, why in skipped.items():
        warnings.append(f"stack {k} not analysed: {why}")

    # ---- wording --------------------------------------------------------------------------------------------------------------
    if status == "SUPPORTED":
        top = patches[0]
        head = (f"Forest loss found: {fmt_ha(total_ha)} in {len(patches)} patch(es); the largest is {fmt_ha(top['area_ha'])} "
                f"(cause: {top['attribution']['cause']}), starting {top['onset_time'][:10]}."
                + (f" Strongest hotspot: {fmt_ha(hot[0]['loss_ha'])} in a {hot[0]['cell_m']:.0f} m cell." if hot else ""))
    elif status == "NOT_SUPPORTED":
        head = "No forest loss of the minimum size was found in the tested forest."
    else:
        head = _meaning(status, rule)
    reliability = ("Operational L-band alert systems validate at roughly 50-75% user's accuracy against optical imagery (JJ-FAST); treat a detection as a lead to inspect, "
                   "not a verified loss. History here is short and moisture-corrected, not seasonally corrected.")
    detections = []
    for h in hot:
        detections.append({"id": f"deforestation:{bundle.tile.id}:hotspot:{h['rank']}", "label": f"hotspot {h['rank']}: {fmt_ha(h['loss_ha'])} ({h['dominant_cause']})",
                           "kind": "hotspot", "layer": "loss_density_ha", "centroid_lonlat": h["centroid_lonlat"], "bbox_lonlat": h["bbox_lonlat"],
                           "area_km2": round(h["loss_ha"] / 100.0, 5), "metrics": {"share_of_total": {"value": round(h["share_of_total"], 3)}}})
    for p in patches[: P.patches_max]:
        detections.append({"id": f"deforestation:{bundle.tile.id}:patch:{p['id']}", "label": f"patch {p['id']}: {fmt_ha(p['area_ha'])}, {p['attribution']['cause']}, from {p['onset_time'][:10]}",
                           "kind": "patch", "layer": "loss_class", "centroid_lonlat": p["centroid_lonlat"], "bbox_lonlat": p["bbox_lonlat"], "area_km2": round(p["area_ha"] / 100.0, 5),
                           "metrics": {"hv_change_db": {"value": round(p["hv_drop_db"], 2), "units": "dB"}}})
    out_patches = [{k: v for k, v in p.items() if not k.startswith("_")} for p in patches[: P.patches_max]]
    detail = {**common, "narrative": {"headline": head, "reliability": reliability}, "detections": detections, "hotspots": hot, "patches": out_patches,
              "totals": {"loss_ha": total_ha, "n_patches": len(patches), "unconfirmed_candidate_ha": unconf_ha,
                         "by_cause_ha": {c: round(sum(p["area_ha"] for p in patches if p["attribution"]["cause"] == c), 3) for c in CAUSES},
                         "newest_pass": iso(t_newest)},
              "layers": layers, "bundle_usage": usage_ledger(used), "loss_year_source": {k: v for k, v in loss.items() if k != "results"},
              "inputs": {"mode": "event" if bundle.request.event_window else "scan", "n_stacks_analysed": n_stacks_ok, "window": {"t0": bundle.request.t0, "t1": bundle.request.t1}},
              "alerts_unmatched_ha": unmatched_ha}
    data_used = [f"M2 GCOV gamma0 {', '.join(sorted({s['prep'].diag['cross_pol'] + (('/' + s['prep'].diag['co_pol']) if s['prep'].diag['co_pol'] else '') for s in stacks.values()}))} "
                 f"on {n_stacks_ok} stack(s)", "bundle baseline (contamination check), n_looks, masks, z_prev, db_diff_prev, geometry, stable-mask components",
                 "ancillary: land cover / tree cover, slope, HAND, water occurrence, built-up (where present)"]
    for k, lab_ in (("alerts", "R7 GFW integrated alerts"), ("fires", "R6 FIRMS active fires"), ("rain", "R4 IMERG rainfall"), ("tracks", "R10 IBTrACS")):
        if sources.get(k, {}).get("available"):
            data_used.append(lab_)
    if loss["available"]:
        data_used.append("S4 UMD tree-cover loss year")
    return PipelineResult(pipeline="deforestation", tile=bundle.tile.id, epoch=bundle.epoch, status=status, summary=head, raw_p=raw_p, confidence=None, evidence=ev,
                          layers=[LayerRef(name=n, kind="raster", crs=f"EPSG:{lead.epsg}", bounds_lonlat=tuple(bounds)) for n in layers], provenance=provenance,
                          data_used=data_used, references_used=REFERENCES_USED,
                          diagnostics={"stacks": {k: {"n_ref": v["n_ref"], "evaluated_fraction": v["evaluated_fraction"], "wet_epoch_fraction": v["wet_epoch_fraction"]}
                                                  for k, v in stack_diag.items()}, "null": {k: s["null"] for k, s in stacks.items()}, "rule": rule},
                          versions={"pipeline": PIPELINE_VERSION}, warnings=list(dict.fromkeys(warnings)), min_epochs_met=True, bundle_id=bundle.bundle_id,
                          detail={**detail, "decision": {"rule": rule, "null_ha_max": null_ha_max, "null_margin": P.null_margin, "total_ha": total_ha},
                                  "status_meaning": _meaning(status, rule),
                                  "raw_p_meaning": "raw_p is a within-tier rank score between 0 and 1. It is NOT a probability and is not calibrated."})

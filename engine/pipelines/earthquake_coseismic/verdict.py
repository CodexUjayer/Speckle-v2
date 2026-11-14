"""3.01 earthquake_coseismic — registry entry point.

The registry calls exactly this: run(bundle: SceneBundle, providers=None) -> PipelineResult.
The pipeline sees ONLY the bundle (no retriever, no other pipeline's output); anything beyond the
bundle arrives through THIS pipeline's fetch.py, which resolves providers in a documented order
(injected -> module seam -> real adapter). Flow and status table: docs/IMPLEMENTATION_PLAN.md 4.2
and 8.4; typed result contract: engine/common/result.py.
"""
from __future__ import annotations

import dataclasses
import hashlib
import math

import numpy as np

from engine.common.result import EvidenceItem, LayerRef, PipelineResult, Source

from . import alternatives
from . import detection as det
from . import inputs
from . import merge as geom_merge
from . import model
from . import prep
from . import uncatalogued
from .fetch import fetch_events, fetch_shakemap_note
from .lib_local import core_bounds_lonlat, encode_layer
from .types import EqParams

REFERENCES_USED = [
    "Okada (1985, 1992) DC3D elastic dislocation — engine/lib/okada.py",
    "Hanks & Kanamori (1979) moment–magnitude relation",
    "Wells & Coppersmith (1994) rupture-area scaling (all slip types)",
    "Rodriguez & Martin (1992) coherence–phase Cramér-Rao sigma (via P06 sigma_m)",
]
PIPELINE_VERSION = "1.4.0"          # 1.3.0 final-prompt fixes (events_unscreenable split, dip-90 okada fix, stable evidence ids,
#                                   # layer bounds_lonlat, R2 coverage check); 1.4.0 EQ_AUDIT hardening (robust same-pixel peaks,
#                                   # predicted-signal gate, spatial-null correlation, symmetric detrend, missing-geometry guard)


def _bundle_seed(bundle) -> int:
    """Determinism rule: seeds come from the bundle's content hash (same bundle -> same result)."""
    try:
        return int(hashlib.sha256(str(bundle.bundle_id).encode("utf-8")).hexdigest()[:8], 16)
    except Exception:
        return 0


def _evidence(eid: str, kind: str, claim: str, *, support: dict | None = None,
              level: str = "info", source_ref: str | None = None) -> EvidenceItem:
    return EvidenceItem(id=eid, kind=kind, claim=claim, support=support, level=level, source_ref=source_ref)


def _insufficient(reasons: list[str], warnings: list[str] | None = None, tile: str = "",
                  epoch: str | None = None, bundle_id: str | None = None,
                  params: "EqParams | None" = None) -> PipelineResult:
    return PipelineResult(
        pipeline="earthquake_coseismic", tile=tile, epoch=epoch, status="INSUFFICIENT_EVIDENCE",
        summary="Not enough usable data to evaluate coseismic deformation on this tile.",
        raw_p=None, confidence=None,
        evidence=[_evidence(f"insufficient.{i}", "insufficient", r, level="caveat")
                  for i, r in enumerate(reasons)],
        layers=[], provenance=[], data_used=[], references_used=REFERENCES_USED,
        diagnostics={"decision": {"rule": "insufficient_evidence"}, "pairs_analysed": []},
        versions=_versions(), warnings=warnings or [], bundle_id=bundle_id,
        detail={"decision": {"rule": "insufficient_evidence"}, "pairs_analysed": [],
                "params": params.to_dict() if params is not None else {}},
    )


def _versions() -> dict:
    return {"pipeline": PIPELINE_VERSION, "lib.okada": "1.0", "lib.los": "1.0",
            "lib.detect": "1.0", "lib.geo": "1.0", "result_contract": "1.0"}


def run(bundle, providers: dict | None = None) -> PipelineResult:
    params = EqParams.from_triggers(getattr(bundle.request, "triggers", None))
    providers = providers or {}
    warnings: list[str] = []

    # engine flags that matter for LOS honesty (surfaced into evidence)
    flag_notes = [
        f"{f.code}: {f.message}" for f in bundle.flags
        if f.code in ("los_convention_suspect", "pairs_flipped", "fetch_error")
    ]
    # A4: a short / failed ASF listing means "the newest pair" may not be the newest one that exists
    listing = inputs.completeness(bundle.flags)
    flag_notes += listing["notes"]
    scan_mode = not bundle.request.event_window

    if not bundle.stack_keys_by_quality():
        return _insufficient(["no usable NISAR data (M1 interferograms) for this tile/window"],
                             flag_notes, bundle.tile.id, bundle.epoch, bundle.bundle_id, params=params)

    # ---- 1. pair selection -------------------------------------------------
    indices, reasons = prep.select_pairs(bundle, params)
    if not indices:
        return _insufficient(reasons, flag_notes, bundle.tile.id, bundle.epoch, bundle.bundle_id,
                             params=params)

    # ---- 2-3. per-pair prep + detection -------------------------------------
    analyses = []
    pair_records = []
    for key, idx in indices:
        stack = bundle.stacks[key]
        analysis, reason = prep.analyse_pair(bundle, stack, idx, params)
        if analysis is None:
            pair_records.append({"stack_key": key, "pair_index": idx, "skipped": True, "reason": reason})
            continue
        summary, grids = det.detection_pass(
            analysis.disp, analysis.sigma_eff, analysis.mask,
            np.asarray(stack.interferometric.coherence[idx][bundle.grids.g80.core_slices()], dtype=np.float64),
            getattr(analysis, "iono_floor_m", None),
            analysis.pixel_size,
            k=params.significance_k, floor_m=params.detection_floor_m,
            cluster_min_pixels=params.cluster_min_pixels,
        )
        summary.null_screen = det.run_null_scene_screen(
            analysis.sigma_eff, analysis.mask, analysis.pixel_size,
            k=params.significance_k, floor_m=params.detection_floor_m,
        )
        analysis.summary = summary          # type: ignore[attr-defined]
        analysis.grids = grids              # type: ignore[attr-defined]
        # A8: referencing removes the median of the tile's edge ring. If the ring itself holds detected movement, the
        # real signal is bigger than the tile and the reference removed part of it.
        edge_touch = _edge_touch(analysis, grids, params)
        analysis.edge_touch = edge_touch    # type: ignore[attr-defined]
        if edge_touch is not None and edge_touch > params.edge_touch_max_fraction:
            analysis.warnings.append(
                f"stack {key}: {edge_touch:.0%} of the reference ring is itself detected as movement (limit "
                f"{params.edge_touch_max_fraction:.0%}) — the signal touches the tile edge, so far-field referencing "
                f"({params.far_field_margin:.0%} margin, median {analysis.ref_offset_m * 1000:.1f} mm removed) may have "
                "removed real signal. Try reference_strategy=fullFrameMedian or a larger area.")
        analyses.append(analysis)
        warnings.extend(analysis.warnings)
        pair_records.append({
            "stack_key": key, "pair_index": idx,
            "reference_strategy": params.reference_strategy, "edge_touch_fraction": edge_touch,
            "granule_ids": list(analysis.granule_ids),
            "ref_time": analysis.ref_time, "sec_time": analysis.sec_time,
            "valid_pixels": summary.valid_pixels,
            "ref_offset_m": analysis.ref_offset_m, "ref_sigma_m": analysis.ref_sigma_m,
            "detected_pixels": summary.detected_pixels,
            "affected_area_km2": summary.affected_area_km2,
            "clusters": summary.clusters, "null_screen": summary.null_screen,
            "flags": analysis.flags,
            "selected": False,
        })

    if not analyses:
        return _insufficient(
            [r.get("reason", "pair analysis failed") for r in pair_records] or ["no pair produced a usable analysis"],
            flag_notes + warnings, bundle.tile.id, bundle.epoch, bundle.bundle_id, params=params)

    # best pair = largest affected area (tie-break: more valid pixels), deterministic
    analyses.sort(key=lambda a: (a.stack_key, a.pair_index))        # max() keeps the first maximum: stable across runs
    best = max(analyses, key=lambda a: (a.summary.affected_area_km2, a.summary.valid_pixels))
    for rec in pair_records:
        rec["selected"] = (rec.get("granule_ids") == list(best.granule_ids))
    window = inputs.window_summary(pair_records, bundle.request)
    stacks_info = inputs.stack_summary(bundle, {a.stack_key for a in analyses}, best.stack_key)

    # ---- 4. events (fetch failure => INSUFFICIENT_EVIDENCE, never "no event")
    bbox = tuple(bundle.tile.bbox_lonlat)  # (W, S, E, N)
    q_ref, q_sec = best.ref_time, best.sec_time
    if scan_mode and len(analyses) > 1:                    # "no event" must hold for every analysed window
        q_ref = min(a.ref_time for a in analyses if a.ref_time)
        q_sec = max(a.sec_time for a in analyses if a.sec_time)
    events_res = fetch_events(bbox, q_ref, q_sec, params, providers=providers)
    provenance: list[Source] = list(getattr(events_res, "provenance", ()) or ())
    if events_res.error or events_res.degraded:
        reason = events_res.error or "event provider reported degraded results"
        out = _insufficient([f"catalog events could not be retrieved: {reason}"],
                            flag_notes + warnings + pair_note_lines(pair_records),
                            bundle.tile.id, bundle.epoch, bundle.bundle_id, params=params)
        out.provenance = provenance
        return out
    events = list(events_res.events)

    # ---- 5. forward-model screens (top-N ranked events, ALL their planes) ---
    selection = model.rank_events(events, best.ref_time, best.sec_time,
                                  tuple(bundle.tile.center_lonlat), params)
    screens: list[dict] = []
    # determinism: the correlation null is seeded from the bundle content hash (same bundle -> same p). Kept out of
    # `params` so detail.params still reports exactly the parameters that were requested.
    screen_params = dataclasses.replace(params, surrogate_seed=_bundle_seed(bundle))
    for ev, dist in selection.ranked[: params.forward_top_events]:
        for plane in range(max(1, len(ev.nodal_planes)) if ev.nodal_planes else 1):
            screens.append(model.forward_screen(best, ev, bundle.tile.epsg, screen_params, plane_index=plane))
    for item in selection.excluded[:20]:
        warnings.append(f"event {item['id']} not considered: {item['reason']}")
    n_events_for_decision = len(selection.ranked)
    if best.summary.detected_pixels == 0 and (q_ref, q_sec) != (best.ref_time, best.sec_time):
        wide = model.rank_events(events, q_ref, q_sec, tuple(bundle.tile.center_lonlat), params)
        n_events_for_decision = max(n_events_for_decision, len(wide.ranked))

    # ---- 5b. uncatalogued branch: detection present, GENUINELY no catalog event
    # (an in-window event without a mechanism is a data gap -> events_unscreenable,
    #  NOT an uncatalogued candidate — final-prompt fix 1). The fit itself lives in
    # uncatalogued.py: strike scan + least-squares refinement, analytic slip with a
    # stress-drop cap; seed derives from the bundle content hash (determinism rule).
    uncatalogued_fit: dict | None = None
    if not selection.ranked and best.summary.detected_pixels > 0:
        fit_params = dataclasses.replace(params, uncat_seed=_bundle_seed(bundle))
        uncatalogued_fit = uncatalogued.fit_uncatalogued(best, best.summary, bundle.tile.epsg, fit_params)
        if not uncatalogued_fit.get("attempted"):
            warnings.append(f"uncatalogued-source fit not attempted: {uncatalogued_fit.get('reason')}")
            uncatalogued_fit = None

    # ---- 6. decision ---------------------------------------------------------
    status, raw_p, rule, extra = model.decide(
        best.summary, screens, events_known=True, params=params,
        uncatalogued=uncatalogued_fit, n_events_in_window=n_events_for_decision
        if best.summary.detected_pixels == 0 else len(selection.ranked))
    # A4: a quiet / negative answer built on a short listing is not an answer
    if not listing["complete"] and status in ("NO_SIGNAL", "NOT_SUPPORTED"):
        extra = {**extra, "downgraded_from": status, "downgraded_because": "search_incomplete"}
        status, raw_p, rule = "INSUFFICIENT_EVIDENCE", None, "search_incomplete"
    # EQ_AUDIT P7: SUPPORTED vs NOT_SUPPORTED flips with the sign of the line of sight, so when the geometry layer says the
    # LOS convention of the ANALYSED stack is probably wrong, neither answer is trustworthy.
    suspect = [f for f in bundle.flags if f.code == "los_convention_suspect"
               and f.detail.get("stack") in (None, best.stack_key)]
    if suspect and status in ("SUPPORTED", "NOT_SUPPORTED"):
        extra = {**extra, "downgraded_from": status, "downgraded_because": "los_convention_suspect",
                 "los_flag": suspect[0].message}
        status, raw_p, rule = "INSUFFICIENT_EVIDENCE", None, "los_convention_suspect"
    # EQ_AUDIT P5: the decisive event/plane must also explain every OTHER stack that spans the event (independent LOS).
    # Only an informative, failing second stack counts as a contradiction; a contradiction blocks SUPPORTED, it never
    # upgrades anything (a second stack that agrees is shown, not rewarded).
    cross_checks: list[dict] = []
    decisive = model.best_screen(screens)
    if status in ("SUPPORTED", "NOT_SUPPORTED") and decisive is not None:
        dec_event = next((ev for ev, _ in selection.ranked if ev.id == decisive["event_id"]), None)
        if dec_event is not None:
            for key in sorted({a.stack_key for a in analyses} - {best.stack_key}):
                spanning = [a for a in analyses if a.stack_key == key and model.rank_events(
                    [dec_event], a.ref_time, a.sec_time, tuple(bundle.tile.center_lonlat), params).ranked]
                if not spanning:
                    cross_checks.append({"stack_key": key, "event_id": dec_event.id, "verdict": "unavailable",
                                         "reason": "no analysed pair of this stack spans the event time"})
                    continue
                other = max(spanning, key=lambda a: (a.summary.affected_area_km2, a.summary.valid_pixels))
                cross_checks.append(model.cross_check(other, dec_event, bundle.tile.epsg, screen_params,
                                                      plane_index=decisive.get("nodal_plane", 0)))
    if status == "SUPPORTED" and any(c["verdict"] == "contradicts" for c in cross_checks):
        bad = next(c for c in cross_checks if c["verdict"] == "contradicts")
        extra = {**extra, "downgraded_from": status, "downgraded_because": "stacks_disagree", "contradicting_stack": bad["stack_key"]}
        status, raw_p, rule = "INSUFFICIENT_EVIDENCE", None, "stacks_disagree"
    # ---- what ELSE could explain this tile? (only when the answer is negative or undecided; never changes the status)
    alt_result: dict | None = None
    if params.explore_alternatives and status in ("NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"):
        stable_core = None
        try:
            sm = getattr(getattr(bundle.stacks[best.stack_key], "stable", None), "mask", None)
            sm = getattr(sm, "g80", None)
            if sm is not None:
                stable_core = np.asarray(sm)[prep._core(bundle)[0]].astype(bool)
        except Exception:  # noqa: BLE001 - absence of a stable mask is reported by the item itself
            stable_core = None
        alt_result = alternatives.explore(
            status=status, rule=rule, extra=extra, best=best, screens=screens, selection=selection, events=events,
            epsg=bundle.tile.epsg, params=screen_params, stable_mask_core=stable_core,
            n_stacks_analysed=len({a.stack_key for a in analyses}), n_stacks_bundle=len(bundle.stacks),
            uncatalogued_ok=params.explore_uncatalogued)
    skip_reasons = sorted({str(sc.get("skip_reason")) for sc in screens if sc.get("skipped") and sc.get("skip_reason")})
    if rule == "events_unscreenable":
        in_window = ", ".join(ev.id for ev, _ in selection.ranked[:3])
        warnings.append(
            f"catalogued event(s) in the acquisition window ({in_window}) could not be screened "
            f"({'; '.join(skip_reasons) or 'no usable moment tensor'}) — the coseismic screen cannot run (events_unscreenable)")

    # ---- 7. evidence + layers ------------------------------------------------
    layers: dict[str, dict] = {}
    best_screen = model.best_screen(screens)
    if best_screen is not None and status in ("SUPPORTED", "NOT_SUPPORTED"):
        from .model import prediction_field
        best_event = next((ev for ev, _ in selection.ranked if ev.id == best_screen["event_id"]), None)
        if best_event is not None:
            pred, _ = prediction_field(best, best_event, bundle.tile.epsg,
                                       plane_index=best_screen.get("nodal_plane", 0))
            if pred is not None:
                residual = np.where(best.mask, best.disp - pred, np.nan)
                layers["residual"] = encode_layer(
                    "residual", residual,
                    units="m (LOS, + = toward sensor; measurement minus Okada prediction)",
                    colormap="diverging_teal_terracotta",
                    note=f"measurement minus predicted field for event {best_event.id} "
                         f"(nodal plane {best_screen.get('nodal_plane', 0)})")

    layers["displacement"] = encode_layer(
        "displacement", best.disp, units="m (LOS, + = toward sensor)",
        colormap="diverging_teal_terracotta",
        note=f"referenced to the far-field median ({best.ref_offset_m * 1000:.1f} mm removed)")
    layers["threshold"] = encode_layer(
        "threshold", best.grids["thresholds"],
        units="m — per-pixel detection threshold max(k·σ, floor, iono)",
        colormap="sequential")
    layers["detected"] = encode_layer(
        "detected", best.grids["detected"],
        units="1 = toward sensor, 2 = away, 0 = not detected",
        colormap="binary", note="detection rule |d| > max(k·σ, 10 mm, iono floor)")
    # §5.1 item 1: the UI renders categorical swatches from the engine's labels — the value
    # meanings come from this layer's own units text (1 = toward, 2 = away; verified above).
    layers["detected"]["categories"] = [
        {"value": 1, "label": "toward sensor", "tone": "positive"},
        {"value": 2, "label": "away from sensor", "tone": "negative"},
    ]

    # residual against the v1 uncatalogued-source fit, when one was attempted — shown
    # for inspection even when the fit did NOT converge (never presented as a candidate)
    if uncatalogued_fit is not None and uncatalogued_fit.get("_prediction") is not None:
        residual = np.where(best.mask, best.disp - uncatalogued_fit["_prediction"], np.nan)
        layers["residual"] = encode_layer(
            "residual", residual,
            units="m (LOS, + = toward sensor; measurement minus fitted-source prediction)",
            colormap="diverging_teal_terracotta",
            note=("residual against the v1 uncatalogued-source fit (vertical strike-slip patch)"
                  + ("" if uncatalogued_fit.get("converged") else " — fit did NOT converge; shown for inspection only")))

    # ---- 7b. ascending + descending merge (merge.py) -------------------------------------------------------
    # One geometry sees only part of the ground; the merged layers add the other side. Purely additive: the verdict
    # above keeps using the single best pair. A failure here is reported, never allowed to take the verdict down.
    merged: dict = {"ok": False, "reason": "switched off (earthquake.merge_geometries = false)"}
    if params.merge_geometries:
        try:
            directions = {k: geom_merge.direction_of(st) for k, st in bundle.stacks.items()}
            merged = geom_merge.merge(analyses, directions, event_mode=not scan_mode,
                                      decompose=params.merge_decompose,
                                      min_geometry_det=params.merge_min_geometry_det)
            if merged["ok"]:
                layers.update(geom_merge.encode_layers(merged))
        except Exception as exc:                      # noqa: BLE001 — reported in warnings + detail, verdict unaffected
            merged = {"ok": False, "reason": f"merge failed: {type(exc).__name__}: {exc}"}
            warnings.append(f"ascending/descending merge failed ({type(exc).__name__}: {exc}); showing the single best pair only")

    data_used = [
        f"M1 GUNW los/sigma/coherence/conn_comp/iono_floor — pair {best.ref_time}..{best.sec_time} "
        f"(stack {best.stack_key}, granules {', '.join(best.granule_ids)})",
        f"R1 ComCat events ({len(events)} in query window, source {events_res.source})",
    ]
    if best.los_enu is not None:
        data_used.append("geometry los_enu (radarGrid) — P05")

    # ---- R2 ShakeMap: corroboration note, absence is a note never a failure --
    shakemap = fetch_shakemap_note(extra.get("best_event_id"), providers=providers,
                                   tile_bbox=tuple(bundle.tile.bbox_lonlat))
    if shakemap:
        cov = shakemap.get("coverage") or {}
        if cov.get("covers_tile"):
            cov_text = "tile inside the expected extent"
        elif cov.get("overlaps_tile"):
            cov_text = "tile partially overlaps the expected extent"
        elif cov:
            cov_text = "tile outside the expected extent"
        else:
            cov_text = "no tile-coverage check available"
        data_used.append(f"R2 ShakeMap extent for {shakemap.get('event_id')} "
                         f"(corroboration only; {cov_text})")
        provenance.append(Source(**shakemap["provenance"]) if isinstance(shakemap.get("provenance"), dict)
                          else Source(adapter="r2_shakemap", url_or_id=str(shakemap.get("url") or shakemap.get("event_id")),
                                      retrieved_at=""))

    evidence: list[EvidenceItem] = []
    s = best.summary
    credible = extra.get("credible_area_km2")
    if s.detected_pixels == 0:
        evidence.append(_evidence(
            "detection.null", "null_result",
            (f"No pixel crossed the detection threshold (median threshold "
             f"{s.threshold_median_m * 1000:.1f} mm, largest signal "
             f"{max(abs(s.max_toward_m), abs(s.max_away_m)) * 1000:.1f} mm). This means "
             f"'no detection above threshold' — NOT that the ground did not move."),
            support={"threshold_median_m": round(s.threshold_median_m, 5), "valid_pixels": s.valid_pixels},
            level="decision", source_ref=f"bundle:{best.stack_key}"))
    else:
        evidence.append(_evidence(
            "detection.summary", "detection",
            (f"{s.detected_pixels} pixels above threshold across "
             f"{s.affected_area_km2:.1f} km² (credible area {credible:.2f} km²); largest toward-signal "
             f"{s.max_toward_m * 1000:.1f} mm, away {abs(s.max_away_m) * 1000:.1f} mm; "
             f"{s.clusters['count']} cluster(s) >= {s.clusters['min_pixels']} px."),
            support={"affected_area_km2": round(s.affected_area_km2, 2),
                     "credible_area_km2": credible,
                     "max_toward_mm": round(s.max_toward_m * 1000, 1),
                     "max_away_mm": round(abs(s.max_away_m) * 1000, 1),
                     "clusters": s.clusters["count"]},
            level="decision", source_ref=f"bundle:{best.stack_key}"))
        if s.affected_area_km2 < credible:
            evidence.append(_evidence(
                "detection.sub_credible", "credible_area",
                f"The affected area is below the credible area ({credible:.2f} km² = max(1, 4 pixels)) — "
                "isolated stray pixels are not evidence of deformation.",
                level="caveat"))
    if s.null_screen:
        evidence.append(_evidence("detection.null_screen", "null_screen", s.null_screen.get("note", ""),
                                  support={k: v for k, v in s.null_screen.items() if k != "note"},
                                  level="caveat"))
    for scr in screens:
        if scr.get("skipped"):
            evidence.append(_evidence(f"forward_model.{scr['event_id']}.{scr.get('nodal_plane')}",
                                      "forward_model_skip",
                                      f"event {scr['event_id']} (plane {scr.get('nodal_plane')}): {scr['note']}",
                                      level="caveat"))
        else:
            evidence.append(_evidence(
                f"forward_model.{scr['event_id']}.{scr.get('nodal_plane')}", "forward_model",
                (f"event {scr['event_id']} (plane {scr.get('nodal_plane')}): predicted peak "
                 f"{scr['predicted_peak_m'] * 1000:.1f} mm vs measured "
                 f"{scr['measured_peak_m'] * 1000:.1f} mm (ratio {scr['amplitude_ratio']:.2f}; "
                 f"{scr.get('peak_quantile', 1.0):.0%} quantile of |value| over the same valid pixels), "
                 f"pattern correlation {scr['pattern_correlation']:.2f}"
                 + (f" (spatial-null p = {scr['correlation_p']:.3f})" if scr.get("correlation_p") is not None else "")
                 + ". "
                 + ("Consistent with the model — correlation is not causation."
                    if status == "SUPPORTED" else "Consistency screen did not pass.")),
                support={"amplitude_ratio": round(scr["amplitude_ratio"], 3),
                         "pattern_correlation": round(scr["pattern_correlation"], 3),
                         "correlation_p": (round(scr["correlation_p"], 4) if scr.get("correlation_p") is not None else None),
                         "predicted_peak_m": round(scr["predicted_peak_m"], 5),
                         "measured_peak_m": round(scr["measured_peak_m"], 5)},
                level="corroboration" if status == "SUPPORTED" else "info",
                source_ref=f"r1_comcat:{scr['event_id']}"))
    if status == "NO_SIGNAL":
        evidence.append(_evidence(
            "signal.none", "null_result",
            (f"No catalog event (M >= 4, within {params.max_event_distance_km:.0f} km) inside the analysed "
             f"interferogram window(s) and no coherent cluster above the detection threshold. Window actually "
             f"analysed: {window['text']}. Nothing is claimed about the rest of the lookback, nor about slow "
             "movement below the detection floor. This is a quiet outcome, NOT a tested-and-rejected quake."),
            level="decision", source_ref=f"bundle:{best.stack_key}"))
    if rule == "events_unscreenable":
        in_window = ", ".join(f"{ev.id} (M{ev.magnitude if ev.magnitude is not None else '?'})"
                              for ev, _ in selection.ranked[:3])
        evidence.append(_evidence(
            "events.unscreenable", "insufficient",
            (f"{len(selection.ranked)} catalogued event(s) inside the acquisition window "
             f"({in_window}) but none could be screened ({'; '.join(skip_reasons) or 'no usable moment tensor'}) "
             "— the Okada forward screen cannot run. This is a data gap, NOT evidence about "
             "whether an earthquake occurred; the detection itself is reported as measured."),
            support={"n_events_in_window": len(selection.ranked),
                     "event_ids": [ev.id for ev, _ in selection.ranked[:5]],
                     "skip_reasons": skip_reasons},
            level="caveat", source_ref="r1_comcat"))
    if rule == "weak_prediction_no_match":
        evidence.append(_evidence(
            "decision.weak_prediction_no_match", "insufficient",
            (f"The best-matching event predicts only {extra.get('predicted_peak_m', 0.0) * 1000:.1f} mm over this tile and the "
             f"measured signal peaks at {extra.get('measured_peak_m', 0.0) * 1000:.1f} mm; a test needs at least "
             f"{extra.get('required_predicted_peak_m', 0.0) * 1000:.1f} mm = {params.predicted_signal_min_factor:g} x the "
             f"{extra.get('noise_scale_m', 0.0) * 1000:.1f} mm detection threshold. The screens did not match "
             f"({'; '.join(extra.get('failed_criteria') or [])}), but at this size both sides are at the noise scale, so the "
             "mismatch neither supports nor contradicts the event."),
            support={"predicted_peak_m": round(extra.get("predicted_peak_m", 0.0), 5),
                     "measured_peak_m": round(extra.get("measured_peak_m", 0.0), 5),
                     "required_predicted_peak_m": round(extra.get("required_predicted_peak_m", 0.0), 5),
                     "failed_criteria": extra.get("failed_criteria") or [], "best_event_id": extra.get("best_event_id")},
            level="decision", source_ref=f"r1_comcat:{extra.get('best_event_id')}"))
    if rule == "predicted_signal_below_noise":
        evidence.append(_evidence(
            "decision.predicted_signal_below_noise", "insufficient",
            (f"The best-matching event predicts only {extra.get('predicted_peak_m', 0.0) * 1000:.1f} mm over this tile "
             f"(a pass needs at least {extra.get('required_predicted_peak_m', 0.0) * 1000:.1f} mm = "
             f"{params.predicted_signal_min_factor:g} x the {extra.get('noise_scale_m', 0.0) * 1000:.1f} mm detection "
             "threshold). The amplitude and correlation screens passed, but at this signal size atmosphere or orbit ramps "
             "pass them about as often as a real earthquake, so the tile cannot support or reject the event."),
            support={"predicted_peak_m": round(extra.get("predicted_peak_m", 0.0), 5),
                     "required_predicted_peak_m": round(extra.get("required_predicted_peak_m", 0.0), 5),
                     "noise_scale_m": round(extra.get("noise_scale_m", 0.0), 5),
                     "best_event_id": extra.get("best_event_id")},
            level="decision", source_ref=f"r1_comcat:{extra.get('best_event_id')}"))
    if status == "UNCATALOGUED_CANDIDATE" and uncatalogued_fit:
        pr = uncatalogued_fit.get("parameters") or {}
        evidence.append(_evidence(
            "uncatalogued.fit", "uncatalogued",
            (f"No catalog event within {params.max_event_distance_km:.0f} km in the window, yet a coherent "
             f"{s.affected_area_km2:.1f} km² signal (credible area {credible:.2f} km²) is explained by a vertical "
             f"{pr.get('sense', '?')} source: strike {pr.get('strike_deg', float('nan')):.0f}°, "
             f"{pr.get('length_m', float('nan')) / 1000:.1f} x {pr.get('width_m', float('nan')) / 1000:.1f} km, centroid depth "
             f"{pr.get('centroid_depth_m', float('nan')) / 1000:.1f} km, slip {abs(pr.get('slip_m', float('nan'))):.2f} m; "
             f"residual RMS {uncatalogued_fit.get('rms_m', float('nan')) * 1000:.1f} mm = "
             f"{uncatalogued_fit.get('rms_ratio', float('nan')):.2f} x field RMS. A candidate, not a detection of an "
             "earthquake: atmosphere, unwrapping errors or non-tectonic deformation can produce the same pattern."),
            support={**{k: pr.get(k) for k in ("strike_deg", "dip_deg", "length_m", "width_m",
                                               "centroid_depth_m", "slip_m", "sense")},
                     "rms_ratio": uncatalogued_fit.get("rms_ratio"),
                     "pattern_correlation": uncatalogued_fit.get("pattern_correlation"),
                     "pinned_parameters": uncatalogued_fit.get("pinned_parameters")},
            level="info"))
        evidence.append(_evidence(
            "uncatalogued.simplifications", "uncatalogued",
            "v1 simplifications: " + "; ".join(uncatalogued_fit.get("simplifications", [])) + ". "
            + "Weakly constrained: " + ", ".join(uncatalogued_fit.get("weakly_constrained", [])) + ".",
            level="caveat"))
    elif rule in ("uncatalogued_fit_not_converged", "no_catalog_event_fit_not_run"):
        reason = uncatalogued_fit.get("reason") if uncatalogued_fit else "the fit was not attempted"
        evidence.append(_evidence(
            "uncatalogued.not_converged", "uncatalogued",
            (f"No catalog event within {params.max_event_distance_km:.0f} km in the window and the "
             f"uncatalogued-source fit did not converge ({reason}). No source candidate is claimed. "
             "The v1 fit only represents a vertical strike-slip patch, so non-strike-slip "
             "deformation also lands here."),
            level="caveat"))
    elif rule == "sub_credible_no_catalog_event":
        evidence.append(_evidence(
            "uncatalogued.sub_credible", "uncatalogued",
            (f"Isolated or sub-credible signal; no catalog event within "
             f"{params.max_event_distance_km:.0f} km in the window."),
            level="caveat"))
    # ---- what the verdict really used (A1/A2/A3/B9), the floor (A7), assumptions (A10), listing (A4), edge (A8)
    sel_days = None
    a_, b_ = inputs.parse_iso(best.ref_time), inputs.parse_iso(best.sec_time)
    if a_ and b_:
        sel_days = round((b_ - a_).total_seconds() / 86400.0, 1)
    others = [f"{r.get('stack_key')} {str(r.get('ref_time'))[:10]}..{str(r.get('sec_time'))[:10]}"
              for r in pair_records if not r.get("skipped") and not r.get("selected")]
    evidence.append(_evidence(
        "inputs.used", "inputs",
        (f"The verdict is based on stack {best.stack_key}, pair {str(best.ref_time)[:10]}..{str(best.sec_time)[:10]}"
         f"{f' ({sel_days:g} days)' if sel_days else ''}. Analysed: {window['text']}"
         + (f"; the other analysed pairs were {', '.join(others[:6])}" if others else "") + ". "
         f"Only these interferograms enter the verdict: gaps shown between acquisitions on a timeline are display "
         f"values, not inputs. " + stacks_info["note"]),
        support={"selected": {"stack": best.stack_key, "ref_time": best.ref_time, "sec_time": best.sec_time,
                              "days": sel_days, "granule_ids": list(best.granule_ids)},
                 "analysed_stacks": stacks_info["analysed"], "n_pairs": window["n_pairs"],
                 "covered_days": window["covered_days"], "search_days": window["search_days"],
                 "scan_pairs_per_stack": params.scan_pairs_per_stack if scan_mode else None},
        level="info", source_ref=f"bundle:{best.stack_key}"))
    if merged.get("ok"):
        evidence.append(_evidence("merge.summary", "merge", geom_merge.evidence_claim(merged["summary"]),
                                  support=merged["summary"], level="info", source_ref=f"bundle:{best.stack_key}"))
    elif params.merge_geometries and merged.get("available") is not None:
        evidence.append(_evidence(
            "merge.unavailable", "merge",
            (f"Ascending and descending were not merged: {merged['reason']}. A single geometry sees part of the terrain: "
             "slopes facing away from the radar can be missed or distorted, so a quiet area here is weaker evidence."),
            level="caveat"))
    floor_claim, floor_support = inputs.floor_statement(s, params, best.ref_time, best.sec_time)
    evidence.append(_evidence("detection.floor", "detection_floor", floor_claim, support=floor_support, level="caveat"))
    from engine.common.config import load_common_config
    radar_claim, radar_support = inputs.radar_assumptions(bundle, load_common_config().radar)
    evidence.append(_evidence("assumptions.radar", "assumptions", radar_claim, support=radar_support, level="caveat"))
    if not listing["complete"]:
        evidence.append(_evidence("input.listing_incomplete", "insufficient", inputs.incomplete_claim(listing, scan_mode),
                                  support={"listing_flags": listing["listing_flags"]}, level="caveat"))
    edge = getattr(best, "edge_touch", None)
    if edge is not None and edge > params.edge_touch_max_fraction:
        evidence.append(_evidence(
            "reference.edge_signal", "reference",
            (f"{edge:.0%} of the reference ring (the {params.far_field_margin:.0%} edge margin whose median was "
             f"subtracted, {best.ref_offset_m * 1000:.1f} mm) is itself detected as movement. The signal is larger "
             "than this tile, so referencing may have removed part of it: treat amplitudes as lower bounds."),
            support={"edge_touch_fraction": round(edge, 3), "limit": params.edge_touch_max_fraction,
                     "reference_strategy": params.reference_strategy, "ref_offset_mm": round(best.ref_offset_m * 1000, 2)},
            level="caveat"))
    if rule == "search_incomplete":
        evidence.append(_evidence(
            "decision.search_incomplete", "insufficient",
            (f"Without the listing problem this tile would read {extra.get('downgraded_from')}: nothing was detected in "
             "the pairs that were found, but pairs that were not listed may contain the movement."),
            level="decision"))
    for i, cc in enumerate(cross_checks):
        if cc["verdict"] in ("agrees", "contradicts", "uninformative"):
            txt = (f"Second look direction (stack {cc['stack_key']}, {cc.get('ref_time')} to {cc.get('sec_time')}): event "
                   f"{cc['event_id']} predicts {cc['predicted_peak_m'] * 1000:.1f} mm, measured {cc['measured_peak_m'] * 1000:.1f} mm "
                   f"(ratio {cc['amplitude_ratio']:.2f}), pattern correlation {cc['pattern_correlation']:.2f}"
                   + (f" (spatial-null p = {cc['correlation_p']:.3f})" if cc.get("correlation_p") is not None else "") + ". ")
            txt += {"agrees": "The same source explains this independent line of sight.",
                    "contradicts": "The same source does NOT explain this independent line of sight.",
                    "uninformative": f"The prediction is below the {cc['required_predicted_peak_m'] * 1000:.1f} mm this stack can test, so it neither confirms nor contradicts."}[cc["verdict"]]
        else:
            txt = f"Second look direction (stack {cc['stack_key']}) could not be used: {cc.get('reason')}."
        evidence.append(_evidence(f"cross_stack.{cc['stack_key']}.{i}", "cross_check", txt, support={k: v for k, v in cc.items()
                         if isinstance(v, (str, int, float, bool)) or v is None}, level={"contradicts": "decision", "agrees": "corroboration"}.get(cc["verdict"], "caveat")))
    if rule == "stacks_disagree":
        evidence.append(_evidence(
            "decision.stacks_disagree", "insufficient",
            (f"Without the second look direction this tile would read SUPPORTED. Stack {extra.get('contradicting_stack')} has an "
             "informative prediction for the same event and plane and does not match it, so the single-stack agreement is not "
             "treated as evidence."), level="decision"))
    if alt_result:
        if alt_result.get("next_step"):
            evidence.append(_evidence("next_step.rule", "next_step", alt_result["next_step"], level="caveat"))
        for alt in alt_result["alternatives"]:
            evidence.append(_evidence(
                f"alternative.{alt['id']}", "alternative",
                f"{alt['title']} — {alt['indication'].replace('_', ' ')}: {alt['reading']} Next: {alt['next_step']}",
                support=alt.get("measured") or None, level="caveat"))
    if rule == "los_convention_suspect":
        evidence.append(_evidence(
            "decision.los_convention_suspect", "insufficient",
            (f"Without the geometry problem this tile would read {extra.get('downgraded_from')}. The forward screen compares "
             "signed line-of-sight displacement, so a wrong LOS convention turns a match into a mismatch and the reverse: "
             f"{extra.get('los_flag')}"),
            level="decision"))
    for note in flag_notes:
        # Stable content-derived id (final-prompt fix): Python hash() is salted per
        # process, so ids would differ between runs of the same bundle.
        flag_id = hashlib.sha1(note.encode("utf-8")).hexdigest()[:8]
        evidence.append(_evidence(f"flag.{flag_id}", "flag", note, level="caveat"))

    bounds = core_bounds_lonlat(best.grid_x, best.grid_y, bundle.tile.epsg,
                                fallback=tuple(bundle.tile.bbox_lonlat))
    for layer in layers.values():            # plan §6.4: every layer payload carries its own bounds
        layer["bounds_lonlat"] = bounds

    # ---- §5.4 per-detection geometry (D8) -----------------------------------
    # Same clusters the summary counts (same rule, same min_pixels — pinned by test), each with
    # its own geographic geometry: pyproj path identical to core_bounds_lonlat. Capped at the
    # 50 largest; detections_truncated says so. Uses the SELECTED pair's grids only.
    detections: list[dict] = []
    detections_truncated = False
    try:
        from engine.lib.detect import detected_clusters
        from engine.lib.geo import epsg_is_utm

        gx = np.asarray(best.grid_x, dtype=np.float64)
        gy = np.asarray(best.grid_y, dtype=np.float64)
        clusters = detected_clusters(best.grids["detected"], best.disp,
                                     s.pixel_area_km2, s.clusters["min_pixels"], max_clusters=51)
        detections_truncated = len(clusters) > 50
        if epsg_is_utm(bundle.tile.epsg) and gx.size >= 2 and gy.size >= 2:
            from pyproj import Transformer
            tr = Transformer.from_crs(bundle.tile.epsg, 4326, always_xy=True)

            def _xy(ci: float, cj: float) -> tuple[float, float]:
                x = float(np.interp(cj, np.arange(gx.size), gx))
                y = float(np.interp(ci, np.arange(gy.size), gy))
                return tr.transform(x, y)

            for k, c in enumerate(clusters[:50]):
                i0, j0, i1, j1 = c["bbox_px"]
                lon_w, lat_s = _xy(i0, j0)
                lon_e, lat_n = _xy(i1, j1)
                lon_c, lat_c = _xy(*c["centroid_px"])
                pair_key = f"{best.stack_key}#{best.pair_index}"
                detections.append({
                    "id": f"earthquake_coseismic:{pair_key}:{k}",
                    "label": (f"cluster {k + 1}: {c['size']} px ({c['area_km2']:.2f} km², "
                              f"{c['polarity']})"),
                    "kind": "cluster",
                    "layer": "detected",
                    "centroid_lonlat": [float(lon_c), float(lat_c)],
                    "bbox_lonlat": [float(min(lon_w, lon_e)), float(min(lat_s, lat_n)),
                                    float(max(lon_w, lon_e)), float(max(lat_s, lat_n))],
                    "area_km2": round(c["area_km2"], 4),
                    "polarity": c["polarity"],
                    "metrics": ({"peak_abs_los_m": {"value": round(c["peak_abs_m"], 6), "units": "m"}}
                                if c["peak_abs_m"] is not None else {}),
                })
        else:
            warnings.append("detection geometry unavailable (non-UTM grid or degenerate axes); "
                            "cluster counts and areas are still reported in the evidence")
    except Exception as ex:  # noqa: BLE001 — geometry is additive; counts/areas already reported
        warnings.append(f"per-detection geometry could not be computed: {type(ex).__name__}: {ex}")

    detail = {
        "params": params.to_dict(),
        "alternatives": alt_result,
        "pairs_analysed": pair_records,
        "cross_stack_checks": cross_checks,
        "events_considered": [
            {"id": ev.id, "magnitude": ev.magnitude, "distance_km": round(dist, 1),
             "time": ev.time, "place": ev.place}
            for ev, dist in selection.ranked[: params.forward_top_events]
        ],
        "events_excluded": selection.excluded[:20],
        "forward_screens": [
            {k: v for k, v in scr.items() if k != "_pred_sub"} for scr in screens
        ],
        "decision": {"rule": rule, **extra},
        "uncatalogued": ({k: v for k, v in uncatalogued_fit.items() if k != "_prediction"}
                         if uncatalogued_fit is not None else None),
        "layers": {name: layer for name, layer in layers.items()},
        "merged": ({"ok": True, **merged["summary"]} if merged.get("ok")
                   else {"ok": False, "reason": merged.get("reason")}),
        "narrative": _narrative(status, s, extra, best_screen, params, rule=rule, window=window["text"]),
        "detections": detections,
        "detections_truncated": detections_truncated,
        # what the verdict really used, in one place the UI can show next to the verdict card (B9, A1-A4, A7, A10, A11)
        "inputs": {
            "mode": "scan" if scan_mode else "event",
            "selected_pair": {"stack": best.stack_key, "pair_index": best.pair_index, "ref_time": best.ref_time,
                              "sec_time": best.sec_time, "granule_ids": list(best.granule_ids)},
            "window": window, "stacks": stacks_info, "listing": listing,
            "assumptions": radar_support, "floor": floor_support,
            "reference": {"strategy": params.reference_strategy, "far_field_margin": params.far_field_margin,
                          "edge_touch_fraction": edge, "edge_touch_limit": params.edge_touch_max_fraction},
        },
        "status_meaning": _status_meaning(status, rule),
        "raw_p_meaning": "raw_p is a within-tier rank score between 0 and 1. It is NOT a probability and is not calibrated.",
    }

    layer_refs = [LayerRef(name=name, kind="raster", crs=f"EPSG:{bundle.tile.epsg}",
                           bounds_lonlat=tuple(bounds)) for name in layers]

    return PipelineResult(
        pipeline="earthquake_coseismic", tile=bundle.tile.id, epoch=bundle.epoch,
        status=status, summary=(_headline(status, s, extra, params.detection_floor_m * 1000.0, rule=rule,
                                          window=window["text"])
                                + ((" " + alternatives.summary_sentence(alt_result))
                                   if alt_result and alternatives.summary_sentence(alt_result) else "")),
        raw_p=raw_p, confidence=None,
        evidence=evidence, layers=layer_refs, provenance=provenance,
        data_used=data_used, references_used=REFERENCES_USED,
        diagnostics={"pairs_analysed": pair_records, "null_screen": s.null_screen,
                     "events_considered": detail["events_considered"]},
        versions=_versions(),
        warnings=_dedupe(flag_notes + warnings),
        min_epochs_met=True, bundle_id=bundle.bundle_id, detail=detail,
    )


def _edge_touch(analysis, grids, params) -> float | None:
    """Share of the far-field reference ring that is itself 'detected' (None when no ring was used)."""
    if params.reference_strategy not in ("farField", "stableFarField"):
        return None
    ref, hit = getattr(analysis, "reference_mask", None), grids.get("detected")
    if ref is None or hit is None or not np.asarray(ref).any():
        return None
    return float((np.asarray(hit)[np.asarray(ref)] != 0).mean())


_WEAK_UNMATCHED_HEADLINE = ("Event {ev} predicts less than this tile can test and the measured signal is at the noise scale, so the "
                            "mismatch does not count against it — this tile cannot support or reject it (detection reported as measured).")
_BELOW_NOISE_HEADLINE = ("Event {ev} passes the screens but predicts less than the tile's noise scale — "
                         "this tile cannot support or reject it (detection reported as measured).")


def _status_meaning(status: str, rule: str | None) -> str:
    """What a status MEANS here, in words (A11). Thresholds come from the constants the screen really uses."""
    from .types import AMPLITUDE_RATIO_FACTOR, PATTERN_CORRELATION_MIN
    return {
        "SUPPORTED": (f"Screens passed, nothing more: the predicted and measured robust peak amplitudes agree within a factor of "
                      f"{AMPLITUDE_RATIO_FACTOR:g}, the pattern correlation is at least {PATTERN_CORRELATION_MIN} and beats a "
                      "spatially-aware null (phase-randomised copies of the measurement), and the event predicts more than the "
                      "tile's noise scale. It is not a probability that an earthquake caused the signal."),
        "UNCATALOGUED_CANDIDATE": "A coherent signal with no catalogued event and a converged source fit. A candidate, not a detection.",
        "NOT_SUPPORTED": "A signal or an event exists but the consistency screens did not pass; the earthquake hypothesis is not supported.",
        "NO_SIGNAL": "Nothing crossed the detection threshold in the analysed window(s) and no catalogued event fell inside them.",
        "INSUFFICIENT_EVIDENCE": ("The data could not decide (rule: %s)." % (rule or "insufficient_evidence")),
    }.get(status, status)


_DISAGREE_HEADLINE = ("The best-matching event fits one look direction but not another that could test it, so the single-stack "
                      "match is not treated as evidence (it would have read SUPPORTED).")
_LOS_HEADLINE = ("The line-of-sight convention of this stack looks wrong, so the signed comparison with the event cannot be "
                 "trusted (it would have read {was}).")


def _headline(status: str, s, extra: dict, floor_mm: float = 10.0, rule: str | None = None,
              window: str | None = None) -> str:
    if status == "INSUFFICIENT_EVIDENCE" and rule == "los_convention_suspect":
        return _LOS_HEADLINE.format(was=extra.get("downgraded_from"))
    if status == "INSUFFICIENT_EVIDENCE" and rule == "stacks_disagree":
        return _DISAGREE_HEADLINE
    if status == "INSUFFICIENT_EVIDENCE" and rule == "search_incomplete":
        return ("The ASF granule listing was incomplete, so a quiet result cannot be trusted "
                f"(it would have read {extra.get('downgraded_from')}).")
    largest = max(abs(s.max_toward_m), abs(s.max_away_m)) * 1000.0
    if status == "SUPPORTED":
        return (f"Possible coseismic signal — up to {largest:.0f} mm across {s.affected_area_km2:.1f} km², "
                f"consistent with event {extra.get('best_event_id')}.")
    if status == "UNCATALOGUED_CANDIDATE":
        return (f"Coherent {largest:.0f} mm signal over {s.affected_area_km2:.1f} km² with no catalog "
                "event in the acquisition window — candidate uncatalogued source.")
    if status == "NO_SIGNAL":
        return ("Nothing above threshold in the analysed window"
                + (f" ({window})" if window else "") + ": no catalog event in it and no coherent signal.")
    if status == "INSUFFICIENT_EVIDENCE":
        if rule == "events_unscreenable":
            n = extra.get("n_events_in_window") or 0
            return (f"{n} catalogued event(s) in the acquisition window but none publishes a usable "
                    "moment tensor — the coseismic screen cannot run (detection reported as measured).")
        if rule == "predicted_signal_below_noise":
            return _BELOW_NOISE_HEADLINE.format(ev=extra.get("best_event_id"))
        if rule == "weak_prediction_no_match":
            return _WEAK_UNMATCHED_HEADLINE.format(ev=extra.get("best_event_id"))
        return "Not enough usable data to evaluate coseismic deformation on this tile."
    if s.detected_pixels == 0:
        return (f"No change detected above the {floor_mm:.0f} mm threshold "
                f"(largest signal {largest:.1f} mm).")
    return (f"{s.detected_pixels} pixels above threshold ({largest:.0f} mm max) but the evidence "
            "does not support a coseismic cause.")


def _narrative(status: str, s, extra: dict, best_screen, params: EqParams, rule: str | None = None,
               window: str | None = None) -> dict:
    floor_mm = params.detection_floor_m * 1000.0
    largest = max(abs(s.max_toward_m), abs(s.max_away_m)) * 1000.0
    if status == "SUPPORTED":
        headline = (f"Possible coseismic signal — up to {largest:.0f} mm across "
                    f"{s.affected_area_km2:.1f} km², consistent with event {extra.get('best_event_id')}.")
    elif status == "UNCATALOGUED_CANDIDATE":
        headline = (f"Coherent {largest:.0f} mm signal over {s.affected_area_km2:.1f} km² with no "
                    "catalog event in the acquisition window — candidate uncatalogued source.")
    elif status == "NO_SIGNAL":
        headline = ("Nothing above threshold in the analysed window" + (f" ({window})" if window else "")
                    + ": no catalog event in it and no coherent signal.")
    elif status == "INSUFFICIENT_EVIDENCE" and rule == "los_convention_suspect":
        headline = _LOS_HEADLINE.format(was=extra.get("downgraded_from"))
    elif status == "INSUFFICIENT_EVIDENCE" and rule == "stacks_disagree":
        headline = _DISAGREE_HEADLINE
    elif status == "INSUFFICIENT_EVIDENCE" and rule == "search_incomplete":
        headline = ("The ASF granule listing was incomplete, so a quiet result cannot be trusted "
                    f"(it would have read {extra.get('downgraded_from')}).")
    elif status == "INSUFFICIENT_EVIDENCE":
        if rule == "events_unscreenable":
            n = extra.get("n_events_in_window") or 0
            headline = (f"{n} catalogued event(s) in the acquisition window but none publishes a usable "
                        "moment tensor — the coseismic screen cannot run (detection reported as measured).")
        elif rule == "predicted_signal_below_noise":
            headline = _BELOW_NOISE_HEADLINE.format(ev=extra.get("best_event_id"))
        elif rule == "weak_prediction_no_match":
            headline = _WEAK_UNMATCHED_HEADLINE.format(ev=extra.get("best_event_id"))
        else:
            headline = "Not enough usable data to evaluate coseismic deformation on this tile."
    elif s.detected_pixels == 0:
        headline = f"No change detected above the {floor_mm:.0f} mm threshold (largest signal {largest:.1f} mm)."
    else:
        headline = (f"{s.detected_pixels} pixels above threshold ({largest:.0f} mm max) but the "
                    "evidence does not support a coseismic cause.")
    null_mean = s.null_screen.get("detected_fraction_mean", float("nan"))
    reliability = (
        f"Threshold max(k·σ, {floor_mm:.0f} mm, iono floor) over {s.valid_pixels} valid pixels "
        f"(valid fraction {s.valid_fraction:.2f}); null screen: "
        f"{s.null_screen.get('scenes', 0)} scenes, mean false-detection fraction {null_mean:.4f} (exploratory)."
    )
    return {
        "headline": headline,
        "reliability": reliability,
        "note": "raw_p is a within-tier rank score, not a probability. SUPPORTED means the amplitude, pattern-correlation (against a spatial null) and predicted-signal screens passed.",
    }


def pair_note_lines(pair_records: list) -> list[str]:
    return [f"pair {r.get('ref_time')}..{r.get('sec_time')}: detected {r.get('detected_pixels', 0)} px"
            for r in pair_records if not r.get("skipped")]


def _dedupe(items: list) -> list:
    seen, out = set(), []
    for it in items:
        if it and it not in seen:
            seen.add(it)
            out.append(it)
    return out

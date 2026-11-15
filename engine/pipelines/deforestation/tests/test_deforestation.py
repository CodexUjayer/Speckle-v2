"""3.08 deforestation against a REAL P01..P13 bundle with known truth (tests/deforestation_scene.py; see its docstring for the nine
features, the two rain epochs and the injected FIRMS / IBTrACS / R7 sources). No network."""
from __future__ import annotations

import json
import tempfile

import numpy as np
import pytest

pytest.importorskip("pyproj")

import deforestation_scene as S                                   # noqa: E402  (tests/ on sys.path via conftest)
from engine.common.result import plain                            # noqa: E402
from engine.lib.geo import lonlat_to_utm                          # noqa: E402
from engine.pipelines.deforestation import fetch as F             # noqa: E402
from engine.pipelines.deforestation import model as M             # noqa: E402
from engine.pipelines.deforestation.prep import prepare_stack     # noqa: E402
from engine.pipelines.deforestation.report import CATALOGUE       # noqa: E402
from engine.pipelines.deforestation.types import load_params      # noqa: E402
from engine.pipelines.deforestation.verdict import run            # noqa: E402
from engine.registry import Registry                              # noqa: E402


def _where(patch):
    """Which truth feature the patch centroid sits in (tile-relative metres, 60 m tolerance)."""
    tile = S.default_tile()
    x, y = lonlat_to_utm(patch["centroid_lonlat"][0], patch["centroid_lonlat"][1], tile.epsg)
    xr, yr = float(x) - tile.e0, float(y) - tile.n0
    for k, (a, b, c, d) in S.RECTS.items():
        if a - 60 <= xr <= b + 60 and c - 60 <= yr <= d + 60:
            return k
    cx, cy, r = S.BLOB
    return "P7" if np.hypot(xr - cx, yr - cy) <= r + 120 else None


def _by_feature(result):
    out = {}
    for p in result.detail["patches"]:
        out.setdefault(_where(p), []).append(p)
    return out


def _quiet(**kw):
    with tempfile.TemporaryDirectory() as d:
        b = S.build_forest_bundle(d, active_codes={"M2"}, **kw)
    return b, run(b, providers=S.providers(b))


# --------------------------------------------------------------------------------------------- contract
def test_contract_fields_and_json(result):
    assert result.pipeline == "deforestation" and result.status == "SUPPORTED" and result.min_epochs_met is True
    assert 0.5 <= result.raw_p <= 1.0 and result.confidence is None
    json.dumps(plain(result.to_dict()))                                           # NaN / numpy never leak
    ids = [e["id"] for e in result.evidence]
    assert len(ids) == len(set(ids)) and "detection.total" in ids and "null_result.null_screen" in ids
    assert {l.name for l in result.layers} == set(result.detail["layers"]) and all(l.kind == "raster" and l.bounds_lonlat for l in result.layers)
    for d in result.detail["detections"]:                                         # the shape the UI draws without changes
        assert {"id", "label", "layer", "bbox_lonlat", "area_km2"} <= set(d) and d["bbox_lonlat"][0] < d["bbox_lonlat"][2]
    assert result.detail["narrative"]["headline"] and "lead to inspect" in result.detail["narrative"]["reliability"]
    assert "NOT a probability" in result.detail["raw_p_meaning"] and result.detail["decision"]["rule"] == "loss_found"
    assert result.detail["detections"][0]["kind"] == "hotspot"


def test_layers_are_valid_canonical_payloads(result):
    from engine.lib.layer_payload import validate_layer_payload
    for name, payload in result.detail["layers"].items():
        assert validate_layer_payload(payload) == [], name
    assert result.detail["layers"]["loss_class"]["shape"] == [500, 500]


# --------------------------------------------------------------------------------------------- recovery of the truth
def test_every_real_clearing_is_recovered_with_the_right_area_and_nothing_else(result, scene):
    b, _ = scene
    tm = S.truth_masks_on(b)
    px_ha = 20.0 * 20.0 / 1e4
    found = _by_feature(result)
    assert None not in found, "a patch outside every truth feature = a false alarm"
    for name in ("P1", "P2", "P4", "P6", "P7"):
        assert len(found.get(name, [])) == 1, name
        ratio = found[name][0]["area_ha"] / (tm[name].sum() * px_ha)
        assert 0.8 <= ratio <= 1.4, (name, ratio)
    assert "P3" in found and 0.15 <= found["P3"][0]["area_ha"] / (tm["P3"].sum() * px_ha) <= 1.2      # a 30 m road: partly seen (documented)


def test_features_that_must_not_be_reported_are_not(result):
    found = _by_feature(result)
    assert "P5" not in found and "P8" not in found and "P9" not in found                 # tiny / one-epoch / already cleared
    total = result.detail["totals"]
    assert total["unconfirmed_candidate_ha"] > 1.5                                       # P8 is visible as an unconfirmed candidate
    stack = result.detail["stack_diagnostics"]["A005"]
    assert stack["excluded_px"]["prior_nonforest"] >= 450 and stack["excluded_px"]["water"] > 0 and stack["excluded_px"]["steep"] > 0


def test_onsets_and_stages_follow_the_truth(result):
    f = {k: v[0] for k, v in _by_feature(result).items()}
    assert f["P1"]["onset_time"].startswith("2026-08-30") and f["P1"]["stage"] == "late"
    assert f["P4"]["onset_time"].startswith("2026-08-18")                                # first testable epoch
    assert f["P6"]["onset_time"].startswith("2026-09-11")
    assert f["P2"]["stage"] == "early_then_late" and f["P2"]["early_onset_time"].startswith("2026-08-30") and f["P2"]["hv_onset_time"].startswith("2026-10-05")
    assert f["P2"]["hh_change_db"] is not None
    # P7 began on the rain-flagged pass: the first usable shifted pass is the next one, and the window says so
    assert f["P7"]["loss_window"][0].startswith("2026-09-11") and f["P7"]["loss_window"][1].startswith("2026-10-05")
    for p in f.values():
        assert p["persistence_epochs"] >= 2 and p["hv_drop_db"] <= -1.0


def test_cause_attribution_uses_fire_storm_and_geometry(result):
    f = {k: v[0] for k, v in _by_feature(result).items()}
    assert f["P6"]["attribution"]["cause"] == "fire" and f["P6"]["attribution"]["fire"]["hits"] == 3
    assert f["P7"]["attribution"]["cause"] == "windthrow" and f["P7"]["attribution"]["storm"]["evidence"][0]["wind_kt"] == 80.0
    for k in ("P1", "P2", "P4"):
        assert f[k]["attribution"]["cause"] == "clearing" and f[k]["attribution"]["geometry"] == "rectilinear"


def test_hotspots_are_ranked_by_loss_density_and_localised(result):
    hot = result.detail["hotspots"]
    assert [h["rank"] for h in hot] == list(range(1, len(hot) + 1))
    has = [h["loss_ha"] for h in hot]
    assert has == sorted(has, reverse=True) and sum(has) <= result.detail["totals"]["loss_ha"] + 1e-6
    p1 = next(p for p in result.detail["patches"] if _where(p) == "P1")
    lon, lat = p1["centroid_lonlat"]
    w, s, e, n = hot[0]["bbox_lonlat"]
    assert w <= lon <= e and s <= lat <= n and hot[0]["dominant_cause"] == "clearing"
    assert abs(sum(h["share_of_total"] for h in hot) - 1.0) < 0.8 and hot[0]["share_of_total"] > 0.25


def test_r7_agreement_and_unmatched_alerts(result):
    f = {k: v[0] for k, v in _by_feature(result).items()}
    for k in ("P1", "P2", "P6"):
        assert f[k]["r7"]["label"] == "agrees" and f[k]["r7"]["overlap_fraction"] >= 0.3
    assert f["P7"]["r7"]["label"] == "none" and f["P4"]["r7"]["label"] == "none"
    assert result.detail["alerts_unmatched_ha"] > 0                                      # alerts where this pipeline sees nothing are reported
    assert "r7_alerts" in result.detail["layers"]


# --------------------------------------------------------------------------------------------- moisture
def test_rain_epochs_are_flagged_corrected_and_never_counted_as_evidence(result, scene):
    flags = result.detail["stack_diagnostics"]["A005"]["epoch_flags"]
    assert [f["flagged"] for f in flags] == [False, False, False, True, False, False, False, True, False, False]
    assert flags[3]["hv_offset_db"] - np.median([f["hv_offset_db"] for f in flags if not f["flagged"]]) == pytest.approx(1.2, abs=0.35)
    assert flags[7]["hv_offset_db"] - np.median([f["hv_offset_db"] for f in flags if not f["flagged"]]) == pytest.approx(1.8, abs=0.35)
    assert "tile-wide moisture offset" in flags[3]["reasons"]
    assert any(e["id"] == "caveat.moisture" for e in result.evidence)


@pytest.mark.parametrize("moist", [S.MOISTURE, {8: (2.2, 0.8), 9: (2.0, 0.7)}, {5: (1.5, 0.5), 6: (1.5, 0.5), 7: (1.8, 0.7), 8: (1.6, 0.6), 9: (1.4, 0.5)}])
def test_rain_alone_is_never_forest_loss(moist):
    b, r = _quiet(features=False, moisture=moist)
    assert r.status == "NOT_SUPPORTED" and r.detail["decision"]["rule"] == "no_loss_found" and not r.detail["patches"]


def test_imerg_rain_flags_an_epoch_even_when_the_sar_offset_is_small():
    b, _ = _quiet(features=False, moisture={})
    wet = "2026-08-04", "2026-08-05", "2026-08-06"                                        # the three days up to the 2026-08-06 pass
    rain = lambda lat, lon, days: {"source": "t", "daily_mm": {d: (15.0 if d in wet else 0.0) for d in days}, "degraded": False, "error": None}
    r = run(b, providers={**S.providers(b), "rain": rain})
    flags = r.detail["stack_diagnostics"]["A005"]["epoch_flags"]
    assert flags[3]["flagged"] and "rain 45 mm in 48 h before the pass" in flags[3]["reasons"] and not flags[2]["flagged"]


# --------------------------------------------------------------------------------------------- honesty on missing input
def test_short_series_no_hv_no_forest_map_and_empty_bundle_are_insufficient_not_negative():
    for kw, rule in (({"n_epochs": 4}, "no_analysable_stack"), ({"hide_pol": "HVHV"}, "no_analysable_stack"),
                     ({"landcover": False, "context": False}, "no_analysable_stack")):
        _, r = _quiet(**kw)
        assert r.status == "INSUFFICIENT_EVIDENCE" and r.detail["decision"]["rule"] == rule and r.raw_p is None, kw
        assert r.evidence[0]["kind"] == "insufficient" and r.detail["skipped_stacks"]
    from common_fixtures import FakeRetriever, default_tile
    from engine.common import build_scene_bundle
    empty = build_scene_bundle(default_tile(), FakeRetriever([]), as_of="2026-10-20T00:00:00Z")
    r = run(empty, providers={})
    assert empty.status == "empty" and r.status == "INSUFFICIENT_EVIDENCE" and r.detail["decision"]["rule"] == "no_data" and r.min_epochs_met is False


def test_without_hh_the_late_stage_channel_still_works():
    _, r = _quiet(hide_pol="HHHH")
    assert r.status == "SUPPORTED" and r.detail["totals"]["loss_ha"] > 25 and all(p["stage"] == "late" for p in r.detail["patches"])
    assert "hh_change_db" not in r.detail["layers"]


def test_missing_or_failing_sources_degrade_with_a_reason_and_never_fire_or_storm_by_default(scene):
    b, _ = scene
    r = run(b, providers={"alerts": lambda *a: (_ for _ in ()).throw(RuntimeError("boom")),
                          "fires": lambda *a: {"source": "f", "fires": [], "degraded": True, "error": "no MAP_KEY"}})
    assert r.status == "SUPPORTED"
    assert r.detail["sources"]["alerts"]["available"] is False and "RuntimeError: boom" in r.detail["sources"]["alerts"]["error"]
    assert any("no MAP_KEY" in w for w in r.warnings)
    p = r.detail["patches"][0]
    assert "FIRMS was unavailable: fire loss is not excluded" in p["attribution"]["caveats"] and p["r7"]["label"] == "unavailable"
    assert not any(e["id"] == "corroboration.r7" for e in r.evidence) and any(e["id"] == "source.alerts" for e in r.evidence)
    assert all(q["attribution"]["cause"] != "fire" for q in r.detail["patches"])                # failure is not "no fire" and not "fire"


def test_s4_prior_loss_is_a_caveat_not_a_gate(scene):
    b, prov = scene
    loss = lambda polys: {"source": "t", "results": {pid: {2023: 50.0} for pid, _ in polys}, "degraded": False, "error": None}
    r = run(b, providers={**prov, "loss": loss})
    assert r.status == "SUPPORTED" and r.detail["patches"][0]["s4"]["available"]
    assert any(e["id"].startswith("caveat.prior_loss") for e in r.evidence)


def test_module_seam_and_offline_semantics(scene):
    b, _ = scene
    F.reset_providers()
    try:
        F.set_provider("fires", lambda bbox, t0, t1: {"source": "seam", "fires": [], "degraded": False, "error": None})
        r = run(b)                                                                               # seam set => offline: nothing else is fetched
        assert r.detail["sources"]["fires"]["available"] and r.detail["sources"]["alerts"]["error"] == "not provided (offline run)"
    finally:
        F.reset_providers()


# --------------------------------------------------------------------------------------------- stats guards
def test_the_null_screen_can_fire_and_is_deterministic(scene):
    b, _ = scene
    P = load_params({})
    prep, _ = prepare_stack(b, "A005", P)
    n1 = M.null_screen(prep, P, seed=1)
    assert n1["ha_max"] == M.null_screen(prep, P, seed=1)["ha_max"] and n1["draws"] == 8
    loose = load_params({"deforestation_params": {"cusum_h": 1.0, "z_shift": 0.5, "min_patch_ha": 0.04}})
    import dataclasses
    loose = dataclasses.replace(loose, shift_floor_db=0.1, min_sigma_db=0.1)
    assert M.null_screen(prep, loose, seed=1)["ha_max"] > 0                                     # the screen is not trivially blind


def test_runs_are_deterministic(scene, result):
    b, prov = scene
    r2 = run(b, providers=prov)
    assert [p["area_ha"] for p in r2.detail["patches"]] == [p["area_ha"] for p in result.detail["patches"]] and r2.raw_p == result.raw_p


def test_parameters_can_be_overridden_per_request_and_are_clamped():
    p = load_params({"deforestation_params": {"min_patch_ha": 1e9, "persist_epochs": 0, "bogus": 1, "min_drop_db": "x"}})
    assert p.min_patch_ha == 1000.0 and p.persist_epochs == 1 and p.min_drop_db == 1.5
    b, r = _quiet(triggers={"deforestation_params": {"min_patch_ha": 15.0}})
    assert r.detail["params"]["min_patch_ha"] == 15.0 and not r.detail["patches"] and r.status != "SUPPORTED"


def test_two_look_directions_corroborate_each_other_and_late_patches_stay_unconfirmed_where_the_series_is_short():
    b, r = _quiet(second_stack=True)
    assert set(r.detail["stacks"]) == {"A005", "D006"} and r.status == "SUPPORTED"
    both = {_where(p): p["stacks_confirming"] for p in r.detail["patches"]}
    assert both["P1"] == ["A005", "D006"] and both["P6"] == ["A005", "D006"]
    assert both["P7"] == ["A005"]                                                                # D006 has one post-change pass: unconfirmed there
    assert any(e["id"] == "corroboration.cross_stack" for e in r.evidence)


# --------------------------------------------------------------------------------------------- bundle usage ledger
def test_every_scenebundle_field_is_accounted_for(result, scene):
    rows = result.detail["bundle_usage"]
    assert [r["field"] for r in rows] == [c[0] for c in CATALOGUE]
    by = {r["field"]: r for r in rows}
    for must in ("stacks[*].backscatter.gamma0_db", "stacks[*].backscatter.n_looks", "stacks[*].backscatter.z_prev", "stacks[*].backscatter.db_diff_prev",
                 "stacks[*].backscatter.baseline.median_db", "stacks[*].backscatter.masks.layover", "stacks[*].geometry.local_incidence_deg",
                 "stacks[*].stable.components", "ancillary.landcover", "ancillary.context[tree_cover]", "ancillary.slope_deg",
                 "ancillary.water_occurrence_pct", "request.event_window", "routing.decisions", "grids.g20"):
        assert by[must]["status"] == "used", must
    for r in rows:
        assert r["status"] in ("used", "not_used", "not_reached")
        assert r["how"] if r["status"] == "used" else r["why"]                                # every use says how, every non-use says why
    assert by["stacks[*].backscatter.sigma0_db"]["status"] == "not_used" and "fixed factor" in by["stacks[*].backscatter.sigma0_db"]["why"]
    assert by["stacks[*].backscatter.current_index"]["status"] == "not_used" and "EVERY epoch" in by["stacks[*].backscatter.current_index"]["why"]
    assert by["stacks[*].interferometric.coherence"]["status"] == "not_reached"            # M2-only bundle: said so, not silently skipped


def test_the_bundle_baseline_contamination_is_measured(result):
    chk = result.detail["stack_diagnostics"]["A005"]["bundle_baseline"]
    assert chk["n_prior_epochs"] == 9 and chk["seasonal_ok"] is False and chk["history_days"] > 90
    assert chk["fraction_gt_1db"] is not None and chk["reading"]


# --------------------------------------------------------------------------------------------- registry
def test_registry_discovers_it_as_modelled_and_gates_on_gcov_epochs():
    reg = Registry()
    assert reg.is_modelled("deforestation")
    m = next(m for m in reg.manifests if m.name == "deforestation")
    assert m.min_epochs == 6 and set(m.status_values) >= {"SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"}
    from engine.common.config import load_common_config
    assert load_common_config().registry.min_epochs_metric["deforestation"] == "gcov_epochs"

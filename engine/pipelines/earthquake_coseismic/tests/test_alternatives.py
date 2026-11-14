"""alternatives.py: what else could explain a NOT_SUPPORTED / INSUFFICIENT_EVIDENCE tile (hand-built scenes with known truth)."""
from __future__ import annotations

import dataclasses
import math
from types import SimpleNamespace

import numpy as np

from engine.pipelines.earthquake_coseismic import alternatives as alt
from engine.pipelines.earthquake_coseismic import detection as det
from engine.pipelines.earthquake_coseismic import model
from engine.pipelines.earthquake_coseismic.tests import test_audit_fixes as taf
from engine.pipelines.earthquake_coseismic.tests.test_audit_fixes import EPSG, N, PARAMS, _analysis, _atmosphere, _event, _truth

CATALOGUE = ((60.0, 40.0, 90.0),)
OTHER_MECH = (150.0, 70.0, 0.0)            # on the search grid, and very different from the catalogue


def _best(disp, mask=None, edge=0.0):
    an = _analysis(disp, mask)
    s, grids = det.detection_pass(an.disp, an.sigma_eff, an.mask, np.full((N, N), 0.9), None, an.pixel_size,
                                  k=3.0, floor_m=0.01, cluster_min_pixels=4)
    an.summary, an.grids, an.edge_touch = s, grids, edge
    return an


def _sel(ev, excluded=()):
    return SimpleNamespace(ranked=[(ev, 0)], excluded=list(excluded))


def _by_id(res):
    return {a["id"]: a for a in res["alternatives"]}


def _explore(best, ev, screens=(), status="NOT_SUPPORTED", rule="screen_fail", events=None, stable=None, n_an=1, n_bundle=1, **kw):
    return alt.explore(status=status, rule=rule, extra=kw.pop("extra", {}), best=best, screens=list(screens), selection=_sel(ev, kw.pop("excluded", ())),
                       events=events if events is not None else [ev], epsg=EPSG, params=PARAMS, stable_mask_core=stable,
                       n_stacks_analysed=n_an, n_stacks_bundle=n_bundle, uncatalogued_ok=False)


def test_ramp_is_indicated_for_a_pure_plane_and_not_for_a_localised_bowl():
    ramp = ((taf.XX - taf.CX) + (taf.YY - taf.CY)) / (2 * taf.N * taf.PX) * 0.12
    r = alt.ramp_alternative(_best(ramp))
    assert r["indication"] == "indicated" and r["measured"]["fraction_removed"] >= alt.RAMP_INDICATED_FRACTION
    bowl = -0.05 * np.exp(-(((taf.XX - taf.CX) ** 2 + (taf.YY - taf.CY) ** 2) / (2 * 1500.0 ** 2)))
    assert alt.ramp_alternative(_best(bowl))["indication"] == "not_indicated"


def test_nothing_detected_means_no_ramp_item():
    assert alt.ramp_alternative(_best(np.zeros((N, N)))) is None


def test_mechanism_search_finds_a_wrong_published_mechanism():
    ev_true = _event(planes=(OTHER_MECH,), mag=6.5)
    best = _best(_truth(ev_true) + _atmosphere(7, ramp_mm=5.0))
    ev_cat = dataclasses.replace(ev_true, nodal_planes=CATALOGUE)
    r = alt.mechanism_alternative(best, ev_cat, EPSG, PARAMS, n_surrogates=199)
    assert r["indication"] == "indicated", r
    m = r["measured"]
    assert m["search_adjusted_p"] <= alt.SEARCH_ALPHA and m["n_mechanisms_searched"] == 180
    assert (m["best_strike"], m["best_dip"], m["best_rake"]) == OTHER_MECH                 # the search recovers the planted mechanism


def test_mechanism_search_is_not_fooled_by_atmosphere_alone():
    ev = _event()
    verdicts = [alt.mechanism_alternative(_best(_atmosphere(300 + i)), ev, EPSG, PARAMS, n_surrogates=99)["indication"] for i in range(6)]
    assert verdicts.count("indicated") <= 1                      # a search-adjusted p at 0.05 may fire by chance now and then


def test_mechanism_search_does_not_crash_on_a_flat_field():
    r = alt.mechanism_alternative(_best(np.zeros((N, N))), _event(), EPSG, PARAMS, n_surrogates=9)
    assert r["indication"] in ("not_indicated", "not_run")


def test_surface_change_indicated_only_when_detections_follow_unstable_ground():
    bowl = -0.05 * np.exp(-(((taf.XX - taf.CX) ** 2 + (taf.YY - taf.CY) ** 2) / (2 * 1500.0 ** 2)))
    best = _best(bowl)
    det_mask = np.asarray(best.grids["detected"]) != 0
    stable_on_signal = ~det_mask                                  # every detection sits on unstable ground
    assert alt.surface_alternative(best, stable_on_signal)["indication"] == "indicated"
    assert alt.surface_alternative(best, np.ones((N, N), bool))["indication"] == "not_indicated"
    assert alt.surface_alternative(best, None)["indication"] == "cannot_tell"


def test_tile_size_indicated_when_the_reference_ring_is_detected():
    best = _best(np.zeros((N, N)), edge=0.6)
    assert alt.edge_alternative(best, PARAMS)["indication"] == "indicated"
    best.edge_touch = 0.0
    assert alt.edge_alternative(best, PARAMS)["indication"] == "not_indicated"
    best.edge_touch = None
    assert alt.edge_alternative(best, PARAMS) is None


def test_undetected_distinguishes_weak_prediction_from_contradiction():
    best = _best(np.zeros((N, N)))
    best.summary.threshold_median_m = 0.01
    weak = [{"event_id": "e", "predicted_peak_m": 0.004, "pattern_correlation": 0.0, "amplitude_ratio": 0.1}]
    strong = [{"event_id": "e", "predicted_peak_m": 0.05, "pattern_correlation": 0.0, "amplitude_ratio": 0.1}]
    assert alt.undetected_alternative(best, weak, best.summary)["indication"] == "indicated"
    assert alt.undetected_alternative(best, strong, best.summary)["indication"] == "not_indicated"
    best.mask = np.zeros((N, N), bool)
    assert alt.undetected_alternative(best, strong, best.summary)["indication"] == "indicated"        # decorrelated tile
    best.summary.detected_pixels = 5
    assert alt.undetected_alternative(best, strong, best.summary) is None


def test_other_events_beyond_the_distance_limit_are_screened():
    ev_near = _event(dx_m=3000.0, mag=4.5)
    far = _event(mag=6.5)
    far = dataclasses.replace(far, id="far")
    best = _best(_truth(far) + _atmosphere(11, ramp_mm=5.0))
    sel = SimpleNamespace(ranked=[(ev_near, 0)], excluded=[{"id": "far", "reason": "612 km from the footprint (limit 300 km)"}])
    r = alt.other_events_alternative(best, [ev_near, far], sel, EPSG, PARAMS, best.summary)
    assert r["indication"] == "indicated" and r["measured"]["events"][0]["event_id"] == "far"
    sel_none = SimpleNamespace(ranked=[(ev_near, 0)], excluded=[])
    assert alt.other_events_alternative(best, [ev_near], sel_none, EPSG, PARAMS, best.summary) is None
    nomech = dataclasses.replace(far, nodal_planes=())
    r2 = alt.other_events_alternative(best, [ev_near, nomech], sel, EPSG, PARAMS, best.summary)
    assert r2["indication"] == "cannot_tell"


def test_too_weak_and_second_stack_items():
    w = alt.weak_alternative("predicted_signal_below_noise", {"best_event_id": "e", "predicted_peak_m": 0.004, "required_predicted_peak_m": 0.02})
    assert w["indication"] == "indicated" and w["measured"]["testable_above_mm"] == 20.0
    assert alt.weak_alternative("screen_fail", {}) is None
    assert alt.single_stack_alternative(2, 2) is None
    assert alt.single_stack_alternative(1, 1)["indication"] == "cannot_tell"
    assert "failed" in alt.single_stack_alternative(1, 2)["next_step"]


def test_explore_orders_items_and_adds_the_elimination_lead_for_a_localised_signal():
    bowl = -0.05 * np.exp(-(((taf.XX - taf.CX) ** 2 + (taf.YY - taf.CY) ** 2) / (2 * 1500.0 ** 2)))
    best = _best(bowl + 0.002 * _atmosphere(3, ramp_mm=0.0))
    ev = _event(dx_m=20000.0, mag=4.9)
    res = _explore(best, ev, stable=np.ones((N, N), bool))
    ids = [a["id"] for a in res["alternatives"]]
    assert ids[0] == "localised_source" and _by_id(res)["localised_source"]["indication"] == "indicated"
    order = {"indicated": 0, "cannot_tell": 1, "not_run": 2, "not_indicated": 3}
    assert [order[a["indication"]] for a in res["alternatives"]] == sorted(order[a["indication"]] for a in res["alternatives"])
    assert all({"id", "title", "indication", "reading", "next_step", "measured"} <= set(a) for a in res["alternatives"])
    assert "localised" in alt.summary_sentence(res)


def test_a_ramp_scene_does_not_get_the_localised_source_lead():
    ramp = ((taf.XX - taf.CX) + (taf.YY - taf.CY)) / (2 * taf.N * taf.PX) * 0.12
    res = _explore(_best(ramp), _event(dx_m=20000.0, mag=4.9), stable=np.ones((N, N), bool))
    assert "localised_source" not in _by_id(res) and _by_id(res)["ramp"]["indication"] == "indicated"


def test_a_failing_check_degrades_to_not_run_and_does_not_raise(monkeypatch):
    def boom(*a, **k):
        raise ValueError("boom")
    monkeypatch.setattr(alt, "ramp_alternative", boom)
    best = _best(np.zeros((N, N)))
    res = _explore(best, _event())
    r = _by_id(res)["ramp"]
    assert r["indication"] == "not_run" and "boom" in r["reading"]


def test_summary_sentence_variants():
    assert alt.summary_sentence({"alternatives": []}) is None
    only_no = {"alternatives": [{"indication": "not_indicated", "title": "x"}, {"indication": "not_indicated", "title": "y"}]}
    assert "2 checked and not indicated" in alt.summary_sentence(only_no)
    tell = {"alternatives": [{"indication": "cannot_tell", "title": "A second look direction"}]}
    assert "a second look direction" in alt.summary_sentence(tell)


# ---- end to end through verdict.run ---------------------------------------------------------------------------------
def _scene_run(tmp_path, extra_event, dlos=0.05, explore=True):
    from engine.pipelines.earthquake_coseismic import fetch as eq_fetch
    from engine.pipelines.earthquake_coseismic.verdict import run as eq_run
    from engine.pipelines.earthquake_coseismic.tests import test_pipeline as tp
    from engine.pipelines.earthquake_coseismic.tests.fixtures_eq import make_event, make_provider
    from tests.common_fixtures import default_tile, make_scene
    from pyproj import Transformer
    tile = default_tile()
    bundle = tp._build_bundle(tmp_path, tile, make_scene(tile, n_epochs=4, pairs=((0, 1), (1, 2), (2, 3)), dlos=dlos))
    lon, lat = Transformer.from_crs(tile.epsg, 4326, always_xy=True).transform(tile.e0 + 4000 + extra_event["dx"], tile.n0 + 5500)
    ev = make_event(event_id="far-small", magnitude=extra_event["mag"], lat=lat, lon=lon, time="2026-08-01T00:00:00Z")
    eq_fetch.set_event_provider(make_provider([ev]))
    try:
        if not explore:
            bundle = dataclasses.replace(bundle, request=dataclasses.replace(
                bundle.request, triggers={"eq_params": {"explore_alternatives": False}}))
        return eq_run(bundle).to_dict()
    finally:
        eq_fetch.reset_event_provider()


def test_unexplained_bowl_reports_a_lead_without_changing_the_status(tmp_path):
    out = _scene_run(tmp_path, {"dx": 25000.0, "mag": 4.9})
    assert out["status"] == "NOT_SUPPORTED"
    alts = out["detail"]["alternatives"]["alternatives"]
    assert alts and alts[0]["id"] == "localised_source"
    assert any(e["id"] == "alternative.localised_source" and e["kind"] == "alternative" for e in out["evidence"])
    assert "Other explanations the data point to" in out["summary"]
    assert not any(a["id"] == "uncatalogued" for a in alts)            # opt-in: slow


def test_alternatives_can_be_switched_off_and_never_change_the_status(tmp_path):
    on = _scene_run(tmp_path / "a", {"dx": 25000.0, "mag": 4.9})
    off = _scene_run(tmp_path / "b", {"dx": 25000.0, "mag": 4.9}, explore=False)
    assert on["status"] == off["status"]
    assert "alternatives" not in off["detail"] or not off["detail"]["alternatives"]
    assert "Other explanations" not in off["summary"]

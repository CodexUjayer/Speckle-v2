"""Regression tests for the EQ_AUDIT hardening (P1/P2/P3/P4/P8/P9): synthetic scenes with known truth."""
from __future__ import annotations

import dataclasses
import math
from types import SimpleNamespace

import numpy as np
import pytest

from engine.pipelines.earthquake_coseismic import model
from engine.pipelines.earthquake_coseismic import detection as det
from engine.pipelines.earthquake_coseismic.types import EqParams, EventRecord, PairAnalysis

EPSG, N, PX = 32611, 125, 80.0
X0, Y0 = 500000.0, 3900000.0
GX = X0 + PX * (np.arange(N) + 0.5)
GY = Y0 + PX * (N - 1 - np.arange(N) + 0.5)
XX, YY = np.meshgrid(GX, GY)
CX, CY = float(GX.mean()), float(GY.mean())
EDGE = np.zeros((N, N), bool)
EDGE[:15] = EDGE[-15:] = True
EDGE[:, :15] = EDGE[:, -15:] = True
PARAMS = EqParams()


def _los():
    inc, az = math.radians(40.0), math.radians(80.0)
    return np.array([math.sin(inc) * math.sin(az), math.sin(inc) * math.cos(az), math.cos(inc)])


def _event(dx_m: float = 0.0, dy_m: float = 0.0, mag: float = 6.0, planes=((60.0, 40.0, 90.0),)) -> EventRecord:
    from pyproj import Transformer
    lon, lat = Transformer.from_crs(EPSG, 4326, always_xy=True).transform(CX + dx_m, CY + dy_m)
    return EventRecord(id="ev", magnitude=mag, place="", time="2026-07-11T00:00:00Z", lat=lat, lon=lon,
                       depth_km=8.0, nodal_planes=tuple(planes))


def _analysis(disp, mask=None, los=True, detrended=False) -> PairAnalysis:
    mask = np.ones((N, N), bool) if mask is None else mask
    an = PairAnalysis(stack_key="A", pair_index=0, granule_ids=("g",), ref_time="2026-07-01", sec_time="2026-07-20")
    d = np.asarray(disp, dtype=np.float64) - np.median(np.asarray(disp)[EDGE & mask])
    d[~mask] = np.nan
    an.disp = d.astype(np.float32)
    an.mask = mask
    an.sigma_eff = np.where(mask, 0.003, np.nan).astype(np.float32)
    an.pixel_size = (PX, PX)
    an.grid_x, an.grid_y = GX, GY
    an.reference_mask = EDGE & mask
    an.detrended = detrended
    an.los_enu = np.broadcast_to(_los()[:, None, None], (3, N, N)).copy() if los else None
    return an


def _truth(ev, plane=0):
    pred, _ = model.prediction_field(_analysis(np.zeros((N, N))), ev, EPSG, plane)
    return np.nan_to_num(pred)


def _summary(an):
    s, _ = det.detection_pass(an.disp, an.sigma_eff, an.mask, np.full((N, N), 0.9), None, an.pixel_size,
                              k=3.0, floor_m=0.01, cluster_min_pixels=4)
    s.null_screen = {"detected_fraction_mean": 0.0}
    return s


# ---- P9: missing geometry is a data gap, not an exception ---------------------------------------
def test_missing_los_geometry_is_a_skipped_screen_and_insufficient_evidence():
    an = _analysis(np.zeros((N, N)), los=False)
    scr = model.forward_screen(an, _event(), EPSG, PARAMS, 0)
    assert scr["skipped"] and "los_enu" in scr["skip_reason"]
    assert model.prediction_field(an, _event(), EPSG, 0) == (None, None)
    summ = SimpleNamespace(affected_area_km2=5.0, pixel_area_km2=0.0064, detected_pixels=50, null_screen={})
    status, raw_p, rule, _ = model.decide(summ, [scr], True, PARAMS, None, 1)
    assert (status, rule) == ("INSUFFICIENT_EVIDENCE", "events_unscreenable")


# ---- P3: robust amplitudes over the same pixels ---------------------------------------------------
def test_one_outlier_pixel_does_not_move_the_amplitude_ratio():
    ev = _event()
    base = 0.2 * _truth(ev) + np.random.default_rng(1).normal(0, 0.002, (N, N))
    spiked = base.copy()
    spiked[40, 70] += 0.040
    r0 = model.forward_screen(_analysis(base), ev, EPSG, PARAMS, 0)["amplitude_ratio"]
    r1 = model.forward_screen(_analysis(spiked), ev, EPSG, PARAMS, 0)["amplitude_ratio"]
    assert abs(r1 - r0) / r0 < 0.10
    old = dataclasses.replace(PARAMS, peak_quantile=1.0)             # the legacy single-pixel maximum
    r_old = model.forward_screen(_analysis(spiked), ev, EPSG, old, 0)["amplitude_ratio"]
    assert r_old > 1.5 * r0                                          # the legacy rule is spike-driven


def test_prediction_peak_uses_the_same_pixels_as_the_measurement():
    ev = _event()
    truth = _truth(ev)
    mask = np.hypot(XX - CX, YY - CY) > 1500.0                       # decorrelated core
    scr = model.forward_screen(_analysis(truth, mask=mask), ev, EPSG, PARAMS, 0)
    assert scr["predicted_peak_m"] <= scr["predicted_peak_all_m"] + 1e-12
    assert 0.8 < scr["amplitude_ratio"] < 1.25                       # same pixel set => ratio ~ 1 for a noise-free truth


# ---- P2: symmetric detrend ----------------------------------------------------------------------------
def test_detrend_is_applied_to_the_prediction_with_the_same_operator():
    ev = _event()
    plane = 3e-5 * (np.arange(N)[:, None] * 0.8 + np.arange(N)[None, :])
    an_plain = _analysis(np.zeros((N, N)))
    an_det = _analysis(np.zeros((N, N)), detrended=True)
    p_plain, _ = model.prediction_field(an_plain, ev, EPSG, 0)
    p_det, _ = model.prediction_field(an_det, ev, EPSG, 0)
    assert not np.allclose(np.nan_to_num(p_plain), np.nan_to_num(p_det))
    ii, jj = np.nonzero(EDGE)
    A = np.c_[ii, jj, np.ones(ii.size)]
    coef, *_ = np.linalg.lstsq(A, np.nan_to_num(p_det)[EDGE], rcond=None)
    assert np.abs(A @ coef).max() < 1e-6                              # no plane AND no offset left on the reference ring
    # a pure plane added to the prediction vanishes under the detrending operator
    base = np.nan_to_num(p_plain) - np.median(np.nan_to_num(p_plain)[EDGE])
    tilted = base + plane - np.median(plane[EDGE])
    assert np.allclose(model._remove_reference_plane(tilted, EDGE, None, None),
                       model._remove_reference_plane(base, EDGE, None, None), atol=1e-9)


# ---- P1/P2: spatially-aware null for the pattern correlation -------------------------------------------
def _atmosphere(seed, ramp_mm=20.0):
    from scipy.ndimage import gaussian_filter
    rng = np.random.default_rng(seed)
    t = gaussian_filter(rng.normal(size=(N, N)), 18.0, mode="wrap")
    t = t / t.std() * 0.008
    ramp = (XX - CX) * math.cos(0.7) + (YY - CY) * math.sin(0.7)
    return t + ramp / (ramp.max() - ramp.min()) * ramp_mm / 1000 + rng.normal(0, 0.003, (N, N))


def test_true_signal_beats_the_spatial_null_and_atmosphere_usually_does_not():
    ev = _event()
    sig = model.forward_screen(_analysis(_truth(ev) + _atmosphere(2)), ev, EPSG, PARAMS, 0)
    assert sig["correlation_p"] is not None and sig["correlation_p"] <= 0.01
    ps = [model.forward_screen(_analysis(_atmosphere(100 + i)), ev, EPSG, PARAMS, 0)["correlation_p"] for i in range(12)]
    # a calibrated null: well under half of pure-atmosphere scenes may look "significant" at 5 % (single plane)
    assert sum(p <= 0.05 for p in ps) <= 3


def test_correlation_null_is_deterministic_and_switchable():
    ev = _event()
    an = _analysis(_truth(ev) + _atmosphere(3))
    a = model.forward_screen(an, ev, EPSG, PARAMS, 0)["correlation_p"]
    b = model.forward_screen(an, ev, EPSG, PARAMS, 0)["correlation_p"]
    assert a == b
    off = model.forward_screen(an, ev, EPSG, dataclasses.replace(PARAMS, null_surrogates=0), 0)
    assert off["correlation_p"] is None


# ---- decision table: null p, multiplicity, predicted-signal gate ------------------------------------------------
def _scr(ratio=1.0, corr=0.9, p=0.005, pred=0.05, eid="a", plane=0):
    return {"event_id": eid, "nodal_plane": plane, "skipped": False, "amplitude_ratio": ratio,
            "pattern_correlation": corr, "correlation_p": p, "predicted_peak_m": pred, "measured_peak_m": pred * ratio}


def _summ(threshold=0.01):
    return SimpleNamespace(affected_area_km2=5.0, pixel_area_km2=0.0064, detected_pixels=50,
                           threshold_median_m=threshold, null_screen={})


def test_decide_requires_the_spatial_null_adjusted_for_the_number_of_screens():
    assert model.decide(_summ(), [_scr(p=0.01)], True, PARAMS, None, 1)[0] == "SUPPORTED"
    two = [_scr(p=0.03), _scr(p=0.5, corr=0.3, plane=1)]               # 0.03 x 2 screens = 0.06 > alpha
    status, _, rule, extra = model.decide(_summ(), two, True, PARAMS, None, 1)
    assert (status, rule) == ("NOT_SUPPORTED", "screen_fail")
    assert any("spatial null" in f for f in extra["failed_criteria"])
    assert extra["correlation_p_adjusted"] == pytest.approx(0.06)


def test_decide_without_a_p_value_keeps_the_legacy_behaviour():
    assert model.decide(_summ(), [_scr(p=None)], True, PARAMS, None, 1)[0] == "SUPPORTED"


def test_predicted_signal_gate_turns_a_pass_into_insufficient_evidence():
    status, raw_p, rule, extra = model.decide(_summ(0.01), [_scr(pred=0.012)], True, PARAMS, None, 1)
    assert (status, raw_p, rule) == ("INSUFFICIENT_EVIDENCE", None, "predicted_signal_below_noise")
    assert extra["required_predicted_peak_m"] == pytest.approx(0.02) and extra["best_event_id"] == "a"
    assert model.decide(_summ(0.01), [_scr(pred=0.05)], True, PARAMS, None, 1)[0] == "SUPPORTED"


def test_gate_never_hides_a_real_failure():
    # a far event that predicts ~nothing while 30 mm was measured: still NOT_SUPPORTED, not INSUFFICIENT
    far = _scr(ratio=150.0, corr=0.1, pred=0.0002)
    assert model.decide(_summ(), [far], True, PARAMS, None, 1)[0] == "NOT_SUPPORTED"


def test_weak_event_that_does_not_match_a_noise_level_signal_is_insufficient_not_a_contradiction():
    # predicts 6 mm (needs 20), measured 9 mm, pattern does not match: neither side is sizeable
    weak = _scr(ratio=1.5, corr=0.05, p=0.6, pred=0.006)
    status, raw_p, rule, extra = model.decide(_summ(0.01), [weak], True, PARAMS, None, 1)
    assert (status, raw_p, rule) == ("INSUFFICIENT_EVIDENCE", None, "weak_prediction_no_match")
    assert extra["best_event_id"] == "a" and extra["failed_criteria"] and extra["required_predicted_peak_m"] == pytest.approx(0.02)
    off = dataclasses.replace(PARAMS, weak_unmatched_is_insufficient=False)
    assert model.decide(_summ(0.01), [weak], True, off, None, 1)[0] == "NOT_SUPPORTED"


def test_weak_prediction_does_not_hide_a_sizeable_unexplained_signal_or_a_strong_mismatch():
    big_signal = _scr(ratio=10.0, corr=0.05, p=0.6, pred=0.006)          # 60 mm measured, event predicts 6 mm
    assert model.decide(_summ(0.01), [big_signal], True, PARAMS, None, 1)[0] == "NOT_SUPPORTED"
    strong_event = _scr(ratio=0.05, corr=0.05, p=0.6, pred=0.05)          # event predicts 50 mm, 2.5 mm seen
    assert model.decide(_summ(0.01), [strong_event], True, PARAMS, None, 1)[0] == "NOT_SUPPORTED"


def test_gate_can_be_disabled():
    off = dataclasses.replace(PARAMS, predicted_signal_min_factor=0.0)
    assert model.decide(_summ(), [_scr(pred=0.001)], True, off, None, 1)[0] == "SUPPORTED"


def test_default_null_can_be_passed_by_a_real_event_with_the_maximum_number_of_screens():
    # smallest attainable p is 1/(K+1); Bonferroni multiplies it by the number of usable screens
    # (forward_top_events x two nodal planes). If this fails, a perfect match could never be SUPPORTED.
    n_screens = PARAMS.forward_top_events * 2
    assert n_screens / (PARAMS.null_surrogates + 1) <= PARAMS.correlation_alpha


def test_from_triggers_bounds_the_new_overrides():
    p = EqParams.from_triggers({"eq_params": {"peak_quantile": 5, "null_surrogates": 10**6,
                                              "correlation_alpha": 0.0, "predicted_signal_min_factor": -3}})
    assert (p.peak_quantile, p.null_surrogates, p.correlation_alpha, p.predicted_signal_min_factor) == (1.0, 2000, 0.001, 0.0)


# ---- P2: prep.analyse_pair detrend must not take the reference level out twice -------------------------------------------
def _bundle_with(los):
    from engine.pipelines.earthquake_coseismic import prep  # noqa: F401
    g80 = SimpleNamespace(core_slices=lambda: (slice(0, N), slice(0, N)), dx=PX, dy=-PX, x=GX, y=GY)
    pair = SimpleNamespace(granule_ids=("g1", "g2"), ref_time="2026-07-01T00:00:00Z", sec_time="2026-07-20T00:00:00Z")
    ifg = SimpleNamespace(pairs=[pair], los_m=[los], coherence=[np.full((N, N), 0.9)], sigma_m=[np.full((N, N), 0.003)],
                          conn_comp=[np.ones((N, N), int)], iono_floor_m=None)
    stack = SimpleNamespace(key="A", interferometric=ifg, geometry=None)
    return SimpleNamespace(grids=SimpleNamespace(g80=g80)), stack


def test_prep_detrend_leaves_a_zero_baseline_on_the_reference_ring():
    from engine.pipelines.earthquake_coseismic import prep
    ramp = 4e-5 * np.arange(N)[None, :] + 2e-5 * np.arange(N)[:, None]
    los = 0.012 + ramp + np.random.default_rng(0).normal(0, 0.001, (N, N))        # 12 mm offset + a ramp
    bundle, stack = _bundle_with(los)
    for detrend in (False, True):
        an, err = prep.analyse_pair(bundle, stack, 0, dataclasses.replace(PARAMS, detrend=detrend))
        assert err is None and an.detrended is detrend
        ring = np.asarray(an.disp, dtype=float)[an.reference_mask]
        assert abs(np.median(ring)) < 5e-4                                          # old code left about -12 mm when detrending
    flat = np.asarray(an.disp, dtype=float)
    assert np.abs(np.nanmean(flat[:, -10:]) - np.nanmean(flat[:, :10])) < 5e-4       # the ramp is gone too


# ---- P7: a suspect LOS convention must not yield a signed verdict ---------------------------------------------------
def _run_with_flags(tmp_path, extra_flags):
    from engine.common.frozen import FrozenDict
    from engine.common.scene_bundle import Flag
    from engine.pipelines.earthquake_coseismic import fetch as eq_fetch
    from engine.pipelines.earthquake_coseismic.verdict import run as eq_run
    from engine.pipelines.earthquake_coseismic.tests import test_pipeline as tp
    from engine.pipelines.earthquake_coseismic.tests.fixtures_eq import make_event, make_provider
    from tests.common_fixtures import default_tile, make_scene
    tile = default_tile()
    specs = make_scene(tile, n_epochs=4, pairs=((0, 1), (1, 2), (2, 3)), dlos=0.05)
    bundle = tp._build_bundle(tmp_path, tile, specs)
    flags = tuple(Flag("los_convention_suspect", "error", "P05", "look side mismatch", FrozenDict(d)) for d in extra_flags)
    bundle = dataclasses.replace(bundle, flags=tuple(bundle.flags) + flags)
    lat, lon = tp._event_lonlat(tile)
    eq_fetch.set_event_provider(make_provider([make_event(lat=lat, lon=lon, time="2026-08-01T00:00:00Z")]))
    try:
        return eq_run(bundle).to_dict()
    finally:
        eq_fetch.reset_event_provider()


def test_suspect_los_convention_downgrades_a_signed_verdict(tmp_path):
    res = _run_with_flags(tmp_path, [{}])                       # a flag without a stack applies to every stack
    assert res["status"] == "INSUFFICIENT_EVIDENCE"
    assert res["detail"]["decision"]["rule"] == "los_convention_suspect"
    assert res["detail"]["decision"]["downgraded_from"] == "SUPPORTED"
    assert "line-of-sight convention" in res["summary"] and "would have read SUPPORTED" in res["summary"]
    assert any(e["id"] == "decision.los_convention_suspect" for e in res["evidence"])


def test_los_flag_on_another_stack_does_not_downgrade(tmp_path):
    res = _run_with_flags(tmp_path, [{"stack": "some-other-stack"}])
    assert res["status"] == "SUPPORTED"


# ---- P5: independent second look direction ---------------------------------------------------------------------------
def _other_stack(disp, key="B", los=None, threshold=0.01, valid=N * N):
    an = _analysis(disp, los=True)
    an.stack_key = key
    if los is not None:
        an.los_enu = np.broadcast_to(np.asarray(los)[:, None, None], (3, N, N)).copy()
    an.summary = SimpleNamespace(valid_pixels=valid, threshold_median_m=threshold)
    return an


def test_cross_check_agrees_contradicts_uninformative_unavailable():
    ev = _event()
    truth = _truth(ev)
    atm = _atmosphere(4)
    agree = model.cross_check(_other_stack(truth + 0.3 * atm), ev, EPSG, PARAMS)
    assert agree["verdict"] == "agrees" and agree["correlation_p"] <= 0.01
    contra = model.cross_check(_other_stack(atm), ev, EPSG, PARAMS)               # informative prediction, nothing measured
    assert contra["verdict"] == "contradicts"
    weak = model.cross_check(_other_stack(atm, threshold=0.05), ev, EPSG, PARAMS)  # prediction below 2 x 50 mm
    assert weak["verdict"] == "uninformative"
    assert model.cross_check(_other_stack(atm, valid=10), ev, EPSG, PARAMS)["verdict"] == "unavailable"
    nogeo = _other_stack(atm)
    nogeo.los_enu = None
    assert model.cross_check(nogeo, ev, EPSG, PARAMS)["verdict"] == "unavailable"


def _two_stack_run(tmp_path, dlos_second):
    from engine.common.scene_bundle import SceneBundle  # noqa: F401
    from engine.pipelines.earthquake_coseismic import fetch as eq_fetch
    from engine.pipelines.earthquake_coseismic.verdict import run as eq_run
    from engine.pipelines.earthquake_coseismic.tests import test_pipeline as tp
    from engine.pipelines.earthquake_coseismic.tests.fixtures_eq import make_event, make_provider
    from tests.common_fixtures import default_tile, make_scene
    tile = default_tile()
    pairs = ((0, 1), (1, 2), (2, 3))
    specs = make_scene(tile, n_epochs=4, pairs=pairs, dlos=0.05)
    specs += make_scene(tile, n_epochs=4, pairs=pairs, dlos=dlos_second, track=6, direction="D")
    bundle = tp._build_bundle(tmp_path, tile, specs)
    assert len(bundle.stack_keys_by_quality()) == 2
    lat, lon = tp._event_lonlat(tile)
    eq_fetch.set_event_provider(make_provider([make_event(lat=lat, lon=lon, time="2026-08-01T00:00:00Z")]))
    try:
        return eq_run(bundle).to_dict()
    finally:
        eq_fetch.reset_event_provider()


def test_second_stack_that_agrees_keeps_supported_and_is_shown(tmp_path):
    res = _two_stack_run(tmp_path, 0.05)
    assert res["status"] == "SUPPORTED"
    checks = res["detail"]["cross_stack_checks"]
    assert [c["verdict"] for c in checks] == ["agrees"]
    assert any(e["id"].startswith("cross_stack.") and e["level"] == "corroboration" for e in res["evidence"])


def test_second_stack_that_contradicts_blocks_supported(tmp_path):
    res = _two_stack_run(tmp_path, 0.0)
    assert [c["verdict"] for c in res["detail"]["cross_stack_checks"]] == ["contradicts"]
    assert res["status"] == "INSUFFICIENT_EVIDENCE" and res["detail"]["decision"]["rule"] == "stacks_disagree"
    assert res["detail"]["decision"]["downgraded_from"] == "SUPPORTED"
    assert "one look direction but not another" in res["summary"]
    assert any(e["id"] == "decision.stacks_disagree" for e in res["evidence"])


# ---- P6: far-field reference restricted to stable ground -----------------------------------------------------------------
def test_stable_far_field_reference_ignores_unstable_ring_pixels():
    from engine.pipelines.earthquake_coseismic import prep
    rng = np.random.default_rng(1)
    los = rng.normal(0, 0.001, (N, N))
    unstable = np.zeros((N, N), bool)
    unstable[:, :15] = unstable[:15, :] = True                       # left + top ring bands (about 60 % of the ring) changed
    los[unstable] += 0.030                                           # e.g. vegetation / water surface change, not tectonics
    bundle, stack = _bundle_with(los)
    stack.stable = SimpleNamespace(mask=SimpleNamespace(g80=~unstable))
    ring = dataclasses.replace(PARAMS, reference_strategy="farField")
    stab = dataclasses.replace(PARAMS, reference_strategy="stableFarField")
    a_ring, _ = prep.analyse_pair(bundle, stack, 0, ring)
    a_stab, _ = prep.analyse_pair(bundle, stack, 0, stab)
    assert a_ring.ref_offset_m > 0.02                                # the plain ring is contaminated: it removes ~30 mm
    assert abs(a_stab.ref_offset_m) < 0.002                          # the stable ring is not
    assert not any("stableFarField" in w for w in a_stab.warnings)


def test_stable_far_field_falls_back_to_the_ring_with_a_warning():
    from engine.pipelines.earthquake_coseismic import prep
    los = np.random.default_rng(2).normal(0, 0.001, (N, N))
    bundle, stack = _bundle_with(los)                                # no .stable on the stack
    a, _ = prep.analyse_pair(bundle, stack, 0, dataclasses.replace(PARAMS, reference_strategy="stableFarField"))
    assert any("no stable-ground mask" in w and "plain far-field ring" in w for w in a.warnings)
    stack.stable = SimpleNamespace(mask=SimpleNamespace(g80=np.zeros((N, N), bool)))   # nothing stable
    b, _ = prep.analyse_pair(bundle, stack, 0, dataclasses.replace(PARAMS, reference_strategy="stableFarField"))
    assert any("leaves only 0 pixels" in w for w in b.warnings)

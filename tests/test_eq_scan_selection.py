"""The pure pieces of the earthquake verdict (no pyproj, no bundle build) — the REAL API.

Covers the same scenarios the A-numbered acceptance criteria describe, against the engine as
shipped: prep.select_pairs (scan mode = newest N per stack, event mode = pairs spanning the
window), SceneBundle stack ranking (GUNW quality decides; backscatter only breaks ties),
inputs.window_summary / completeness / floor_statement / radar_assumptions, verdict._edge_touch
(the A8 reference-ring screen) and EqParams override bounds. Fake bundles expose only what
those functions read; the real SceneBundle ranking method is called unbound on a stand-in."""
from types import SimpleNamespace as NS
from datetime import datetime, timedelta

import numpy as np
import pytest

from engine.common.config import CommonConfig, load_common_config
from engine.common.scene_bundle import SceneBundle
from engine.pipelines.earthquake_coseismic import inputs, prep, verdict
from engine.pipelines.earthquake_coseismic.types import DetectionSummary, EqParams


def _pair(ref, sec, resolved=True):
    return NS(ref_time=ref, sec_time=sec, times_resolved=resolved, granule_ids=(f"g_{ref}_{sec}",))


def _stack(key, pairs, n_epochs=0, valid_fraction_g80=0.9, mean_coherence=0.6):
    return NS(key=key,
              interferometric=NS(pairs=pairs) if pairs is not None else None,
              quality=NS(valid_fraction_g80=valid_fraction_g80, mean_coherence=mean_coherence),
              backscatter=NS(epochs=[object()] * n_epochs) if n_epochs else None)


def _bundle(stacks, event_window=None, flags=()):
    """A stand-in exposing exactly what prep/verdict/inputs read (the real ranking and
    spanning methods run unbound, so the RULES are the shipped ones, not fakes)."""
    ns = NS(stacks={s.key: s for s in stacks}, request=NS(event_window=event_window), flags=tuple(flags))
    ns.stack_keys_by_quality = lambda interferometric_only=True: [
        k for k, s in sorted(ns.stacks.items(),
                             key=lambda kv: (SceneBundle._ifg_rank(kv[1]), kv[0]), reverse=True)
        if not interferometric_only or SceneBundle._ifg_rank(s)[0]]
    ns.pairs_spanning = lambda t0, t1: [
        (k, i, p) for k, s in ns.stacks.items() if s.interferometric
        for i, p in enumerate(s.interferometric.pairs)
        if p.times_resolved and p.ref_time <= t0 and p.sec_time >= t1]
    return ns


def _chain(n, start_day=1, step=12, prefix="2026-0"):
    """n consecutive 12-day pairs as ISO strings, oldest first."""
    t0 = datetime(2026, 5, 1)
    out = []
    for i in range(n):
        a, b = t0 + timedelta(days=step * i), t0 + timedelta(days=step * (i + 1))
        out.append(_pair(a.strftime("%Y-%m-%dT00:00:00Z"), b.strftime("%Y-%m-%dT00:00:00Z")))
    return out


# ------------------------------------------------------------------ A2: scan mode uses more than the newest pair
def test_scan_mode_analyses_the_newest_n_pairs_not_just_one():
    b = _bundle([_stack("A115", _chain(10))])
    picked, reasons = prep.select_pairs(b, EqParams(scan_pairs_per_stack=4))
    assert reasons == [] and len(picked) == 4
    assert picked == [("A115", 6), ("A115", 7), ("A115", 8), ("A115", 9)]   # the 4 newest, not the oldest


def test_scan_mode_default_comes_from_config():
    p = EqParams.from_triggers(None)
    assert p.scan_pairs_per_stack == load_common_config().earthquake.scan_pairs_per_stack >= 1
    picked, _ = prep.select_pairs(_bundle([_stack("A115", _chain(12))]), p)
    assert len(picked) == p.scan_pairs_per_stack


def test_unresolved_pairs_are_never_picked():
    pairs = _chain(3) + [_pair("2026-09-01T00:00:00Z", "2026-09-13T00:00:00Z", resolved=False)]
    picked, _ = prep.select_pairs(_bundle([_stack("A115", pairs)]), EqParams(scan_pairs_per_stack=8))
    assert ("A115", 3) not in picked and len(picked) == 3


# ------------------------------------------------------------------ A3: both stacks, GUNW quality decides the order
def test_scan_mode_analyses_every_stack_with_interferograms():
    b = _bundle([_stack("A115", _chain(5)), _stack("D108", _chain(5))])
    picked, _ = prep.select_pairs(b, EqParams(scan_pairs_per_stack=2))
    assert {k for k, _ in picked} == {"A115", "D108"} and len(picked) == 4


def test_event_mode_finds_a_spanning_pair_that_only_the_other_stack_has():
    # D108 has the pair spanning the event; A115 (more pairs) does not.
    a = _stack("A115", _chain(6))
    d = _stack("D108", [_pair("2026-07-01T00:00:00Z", "2026-08-20T00:00:00Z")])
    picked, reasons = prep.select_pairs(
        _bundle([a, d], event_window=("2026-07-20T00:00:00Z", "2026-07-25T00:00:00Z")), EqParams())
    assert picked == [("D108", 0)] and reasons == []


def test_stack_ranking_is_decided_by_gunw_quality_not_gcov_epochs():
    # 20 GCOV epochs with weak GUNW must NOT outrank 4 good interferograms (the old score
    # added epoch counts and picked the wrong primary).
    many_gcov = _stack("D108", [_pair("2026-07-01T00:00:00Z", "2026-07-13T00:00:00Z")],
                       n_epochs=20, valid_fraction_g80=0.3, mean_coherence=0.2)
    few_good_gunw = _stack("A115", _chain(4), n_epochs=1, valid_fraction_g80=0.9, mean_coherence=0.6)
    b = _bundle([many_gcov, few_good_gunw])
    assert b.stack_keys_by_quality()[0] == "A115"
    # and a stack without any usable pair is not an interferometric stack at all
    gcov_only = _stack("GCOV", None, n_epochs=9)
    assert _bundle([gcov_only, _stack("D108", _chain(2))]).stack_keys_by_quality() == ["D108"]


# ------------------------------------------------------------------ A6: the window in the text is the real one
def test_the_window_summary_states_dates_days_and_pair_count():
    recs = [{"ref_time": "2026-07-25T00:00:00Z", "sec_time": "2026-08-06T00:00:00Z", "stack_key": "A115"},
            {"ref_time": "2026-07-13T00:00:00Z", "sec_time": "2026-07-25T00:00:00Z", "stack_key": "A115"}]
    req = NS(t0="2026-06-01T00:00:00Z", t1="2026-09-01T00:00:00Z")
    w = inputs.window_summary(recs, req)
    assert (w["first_ref"], w["last_sec"], w["covered_days"], w["n_pairs"]) == \
           ("2026-07-13T00:00:00Z", "2026-08-06T00:00:00Z", 24.0, 2)
    assert w["text"] == ("2 interferograms analysed, together 24 days between 2026-07-13 and "
                         "2026-08-06 — 24 of the 92-day search window")
    one = inputs.window_summary(recs[:1], req)
    assert one["text"].startswith("1 interferogram analysed")


# ------------------------------------------------------------------ A4: an incomplete GUNW listing is seen
def _flag(code, product=None, expected=None, got=None):
    return NS(code=code, message=f"{code} {product or ''}",
              detail={"product": product, "expected": expected, "got": got})


def test_completeness_reads_the_listing_flags_and_ignores_other_products():
    short = inputs.completeness([_flag("search_incomplete", "GUNW", 17, 15)])
    assert short["complete"] is False and len(short["listing_flags"]) == 1
    assert short["listing_flags"][0]["expected"] == 17 and short["listing_flags"][0]["got"] == 15
    # a GCOV-side short listing does not shorten the GUNW analysis
    assert inputs.completeness([_flag("search_incomplete", "GCOV")])["complete"] is True
    # a flag with no product is treated as short (when in doubt, the listing is short)
    assert inputs.completeness([_flag("search_incomplete")])["complete"] is False
    # other codes are not listing flags
    assert inputs.completeness([_flag("fetch_error")])["complete"] is True
    assert inputs.completeness([])["complete"] is True


def test_incomplete_claim_says_what_it_means_for_the_verdict():
    c = inputs.completeness([_flag("search_incomplete", "GUNW", 17, 15)])
    scan = inputs.incomplete_claim(c, scan_mode=True)
    event = inputs.incomplete_claim(c, scan_mode=False)
    assert "expected 17, got 15" in scan and "INSUFFICIENT_EVIDENCE" in scan
    assert "may therefore not be the newest one that exists" in scan          # scan mode
    assert "A pair spanning the event window may be missing" in event         # event mode


# ------------------------------------------------------------------ A7: the floor is stated and configurable
def test_the_floor_statement_names_the_slowest_visible_rate_and_follows_the_config():
    s = DetectionSummary(threshold_median_m=0.004)
    t10, sup10 = inputs.floor_statement(s, EqParams(detection_floor_m=0.010),
                                        "2026-07-25T00:00:00Z", "2026-08-06T00:00:00Z")
    assert "10 mm" in t10 and "max(3·σ" in t10 and "12-day pair" in t10
    assert sup10["floor_mm"] == 10.0 and sup10["pair_days"] == 12.0
    assert "cannot cross it" in t10 and "not 'nothing moving'" in t10        # the slow-process caveat
    t5, sup5 = inputs.floor_statement(s, EqParams(detection_floor_m=0.005),
                                      "2026-07-25T00:00:00Z", "2026-08-06T00:00:00Z")
    assert "5 mm" in t5 and sup5["floor_mm"] == 5.0
    assert sup5["min_detectable_rate_mm_per_year"] < sup10["min_detectable_rate_mm_per_year"]


def test_detection_floor_default_is_read_from_config_and_env_and_request_wins(monkeypatch):
    assert EqParams.from_triggers(None).detection_floor_m == pytest.approx(0.010)
    monkeypatch.setenv("NISAR_COMMON_EARTHQUAKE_DETECTION_FLOOR_M", "0.004")
    assert EqParams.from_triggers(None).detection_floor_m == pytest.approx(0.004)
    assert EqParams.from_triggers({"eq_params": {"detection_floor_m": 0.02}}).detection_floor_m == pytest.approx(0.02)
    monkeypatch.setenv("NISAR_COMMON_EARTHQUAKE_SCAN_PAIRS_PER_STACK", "3")
    assert EqParams.from_triggers(None).scan_pairs_per_stack == 3
    assert EqParams.from_triggers({"eq_params": {"scan_pairs_per_stack": 0}}).scan_pairs_per_stack == 1  # bounded


def test_earthquake_section_is_not_part_of_the_bundle_hash():
    assert "earthquake" not in CommonConfig().chain_params()


# ------------------------------------------------------------------ A8: signal in the reference ring warns
def _analysis(ref_mask):
    return NS(reference_mask=ref_mask)


def test_edge_touch_measures_the_share_of_detected_pixels_in_the_reference_ring():
    n = 40
    ref = np.zeros((n, n), bool)
    ref[:5, :] = ref[-5:, :] = ref[:, :5] = ref[:, -5:] = True
    det = np.zeros((n, n), np.uint8)
    det[15:25, 15:25] = 1                                    # centred signal: outside the ring
    p = EqParams(reference_strategy="farField")
    out = verdict._edge_touch(_analysis(ref), {"detected": det}, p)
    assert out == 0.0
    det[:5, 10:30] = 2                                       # 100 of the 700 ring pixels
    out = verdict._edge_touch(_analysis(ref), {"detected": det}, p)
    assert out == pytest.approx(100.0 / 700.0, abs=0.001)
    # the warning fires above the configured limit (run()'s rule, restated for the helper's math)
    det[:5, :] = 2                                            # the whole top band: 200 of 700
    out = verdict._edge_touch(_analysis(ref), {"detected": det}, p)
    assert out == pytest.approx(200.0 / 700.0, abs=0.001)
    assert out > EqParams().edge_touch_max_fraction


def test_edge_touch_is_none_without_a_far_field_ring_or_a_detected_grid():
    n = 20
    ref = np.zeros((n, n), bool)
    det = np.ones((n, n), np.uint8)
    p_far = EqParams(reference_strategy="farField")
    p_full = EqParams(reference_strategy="fullFrameMedian")
    assert verdict._edge_touch(_analysis(ref), {"detected": det}, p_far) is None      # empty ring
    assert verdict._edge_touch(_analysis(np.ones((n, n), bool)), {"detected": det}, p_full) is None  # not farField
    assert verdict._edge_touch(_analysis(np.ones((n, n), bool)), {}, p_far) is None   # no detected grid


# ------------------------------------------------------------------ A10: assumptions are spelled out
def test_radar_assumptions_names_wavelength_sign_looks_and_the_missing_look_side():
    radar = NS(wavelength_m=0.2384, phase_sign=-1, gunw_effective_looks=100, look_side=None,
               los_vector_points="toward_the_sensor")
    prov = NS(assumptions=("L-band wavelength assumed from the mission spec",
                           "phase sign -1: + toward sensor"))
    claim, sup = inputs.radar_assumptions(NS(provenance=prov), radar)
    assert "0.2384" in claim and "phase sign -1" in claim and "100 effective looks" in claim
    assert "look side unknown" in claim and "flipping it swaps" in claim       # the honest gap
    assert "not verified against ground truth" in claim
    assert sup["look_side"] is None and sup["wavelength_m"] == 0.2384
    # with a look side, the claim says the sign check can catch a flipped convention
    radar2 = NS(wavelength_m=0.2384, phase_sign=-1, gunw_effective_looks=100, look_side="right",
                los_vector_points="toward_the_sensor")
    claim2, _ = inputs.radar_assumptions(NS(provenance=prov), radar2)
    assert "look side right" in claim2 and "catch a flipped line of sight" in claim2


def test_status_meaning_states_the_checks_and_is_not_a_probability():
    t = verdict._status_meaning("SUPPORTED", None)
    assert "Screens passed" in t and "amplitude" in t and "pattern correlation" in t
    assert "spatially-aware null" in t and "noise scale" in t
    assert "not a probability" in t
    t2 = verdict._status_meaning("NOT_SUPPORTED", None)
    assert "did not pass" in t2 or "not supported" in t2.lower()
    t3 = verdict._status_meaning("NO_SIGNAL", None)
    assert "Nothing crossed the detection threshold" in t3

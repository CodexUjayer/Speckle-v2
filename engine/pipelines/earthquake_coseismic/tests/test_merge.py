"""Ascending + descending merge (merge.py): known truth in, known answer out.

A synthetic ground motion with a KNOWN east and up component is seen through the two real look geometries of the
engine's own fixture (left-looking, ascending heading -10, descending heading 190). Each geometry then loses a
different strip of the tile (the slopes it cannot see), exactly the failure the merge exists for. No pyproj, no
network: the module under test only reads analyses.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np

from engine.pipelines.earthquake_coseismic import detection as det
from engine.pipelines.earthquake_coseismic import merge as M
from engine.pipelines.earthquake_coseismic.types import EqParams

from .fixtures_eq import fixture_los_unit

N, PX = 100, 80.0
K, FLOOR = 3.0, 0.01


def _truth():
    """East 15 mm and up 60 mm Gaussian bump (no north motion) on an N x N grid. East is kept small so both look
    directions see most of the bump (with a large east term the descending line of sight cancels the up motion)."""
    yy, xx = np.mgrid[0:N, 0:N].astype(float)
    g = np.exp(-(((xx - N / 2) ** 2 + (yy - N / 2) ** 2) / (2 * 12.0 ** 2)))
    return 0.015 * g, 0.0 * g, 0.060 * g          # E, N, U (m)


def _analysis(stack, heading, hidden_cols, *, ref="2026-07-25T00:00:00Z", sec="2026-08-06T00:00:00Z",
              noise_m=0.001, seed=1, los=None):
    los_v = fixture_los_unit(40.0, heading) if los is None else np.asarray(los, float)
    e, n, u = _truth()
    meas = e * los_v[0] + n * los_v[1] + u * los_v[2]
    meas = meas + np.random.default_rng(seed).normal(0.0, noise_m, meas.shape)
    mask = np.ones((N, N), bool)
    mask[:, hidden_cols] = False                  # the strip this geometry cannot see (layover / shadow)
    disp = np.where(mask, meas, np.nan).astype(np.float32)
    sigma = np.where(mask, 0.002, np.nan).astype(np.float32)
    summary, grids = det.detection_pass(disp, sigma, mask, np.full((N, N), 0.9), None, (PX, PX),
                                        k=K, floor_m=FLOOR, cluster_min_pixels=4)
    return SimpleNamespace(
        stack_key=stack, pair_index=0, granule_ids=(f"g-{stack}",), ref_time=ref, sec_time=sec, mask=mask, disp=disp,
        sigma_eff=sigma, los_enu=np.broadcast_to(los_v[:, None, None], (3, N, N)).copy(), pixel_size=(PX, -PX),
        summary=summary, grids=grids)


def _pair(hide_a=slice(0, 40), hide_d=slice(60, 100), **kw):
    a = _analysis("A034", -10.0, hide_a, seed=1, **kw)
    d = _analysis("D071", 190.0, hide_d, seed=2, **kw)
    return a, d, {"A034": "A", "D071": "D"}


def test_each_geometry_alone_misses_part_of_the_bump_and_merging_adds_it():
    """The screenshot's problem in numbers: each geometry loses a different strip of the bump, the union does not."""
    a, d, dirs = _pair()
    assert a.summary.detected_pixels > 0 and d.summary.detected_pixels > 0
    r = M.merge([a, d], dirs, event_mode=True)
    union = r["summary"]["detected_pixels"]["union"]
    assert union > a.summary.detected_pixels and union > d.summary.detected_pixels
    assert r["summary"]["detected_km2"]["gained_by_merging"] > 0


def test_coverage_and_detection_union():
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=True)
    assert r["ok"], r
    cov = r["arrays"]["geometry_coverage"]
    assert cov.dtype == np.uint8
    assert set(np.unique(cov)) <= {0, 1, 2, 3}
    assert (cov[:, :40] == 2).all()               # hidden from ascending -> descending only
    assert (cov[:, 60:] == 1).all()               # hidden from descending -> ascending only
    assert (cov[:, 40:60] == 3).all()
    det_m = r["arrays"]["detected_merged"]
    union = int((det_m > 0).sum())
    assert union >= max(a.summary.detected_pixels, d.summary.detected_pixels)
    s = r["summary"]
    assert s["detected_pixels"]["union"] == union
    assert s["detected_pixels"]["best_single_geometry"] == max(a.summary.detected_pixels, d.summary.detected_pixels)
    assert abs(s["detected_km2"]["union"] - union * PX * PX / 1e6) < 1e-9


def test_a_pixel_seen_by_one_geometry_is_never_counted_as_quiet_for_the_other():
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=True)
    det_m, cov = r["arrays"]["detected_merged"], r["arrays"]["geometry_coverage"]
    assert not ((det_m == 2) & (cov == 1)).any()  # "descending detected" can only sit where descending looked
    assert not ((det_m == 1) & (cov == 2)).any()
    assert not ((det_m > 0) & (cov == 0)).any()


def test_east_up_recovered_where_both_geometries_saw_the_pixel():
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=True)
    dec = r["summary"]["decomposition"]
    assert dec["attempted"] and dec["reason"] is None and dec["n_pixels"] == int((r["arrays"]["geometry_coverage"] == 3).sum())
    e_t, _, u_t = _truth()
    both = r["arrays"]["geometry_coverage"] == 3
    east, up = r["arrays"]["displacement_east"], r["arrays"]["displacement_up"]
    assert np.isfinite(east[both]).all() and np.isfinite(up[both]).all()
    assert np.isnan(east[~both]).all() and np.isnan(up[~both]).all()   # never extrapolated outside the overlap
    assert np.abs(east[both] - e_t[both]).max() < 0.008                # 1 mm noise, amplified by the solve
    assert np.abs(up[both] - u_t[both]).max() < 0.008
    # the peak is recovered, not merely the shape
    c = (N // 2, N // 2)
    assert abs(east[c] - e_t[c]) < 0.005 and abs(up[c] - u_t[c]) < 0.005


def test_line_of_sight_is_not_averaged():
    """The mean of the two LOS fields is NOT the up motion; the solved up is far closer to the truth."""
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=True)
    both = r["arrays"]["geometry_coverage"] == 3
    _, _, u_t = _truth()
    naive = 0.5 * (a.disp + d.disp)
    solved = r["arrays"]["displacement_up"]
    assert np.abs(solved[both] - u_t[both]).max() < 0.25 * np.abs(naive[both] - u_t[both]).max()


def test_scan_mode_merges_detection_but_never_decomposes():
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=False)
    assert r["ok"]
    assert "displacement_up" not in r["arrays"] and "displacement_east" not in r["arrays"]
    assert r["summary"]["decomposition"]["attempted"] is False
    assert "no event window" in r["summary"]["decomposition"]["reason"]


def test_decomposition_can_be_switched_off():
    a, d, dirs = _pair()
    r = M.merge([a, d], dirs, event_mode=True, decompose=False)
    assert r["ok"] and "displacement_up" not in r["arrays"]
    assert "merge_decompose" in r["summary"]["decomposition"]["reason"]


def test_same_look_direction_is_refused_not_solved():
    """Two stacks with the same look vector cannot separate east from up: no layer, a stated reason."""
    same = fixture_los_unit(40.0, -10.0)
    a = _analysis("A034", -10.0, slice(0, 0), seed=1, los=same)
    d = _analysis("D071", 190.0, slice(0, 0), seed=2, los=same)
    r = M.merge([a, d], {"A034": "A", "D071": "D"}, event_mode=True)
    assert r["ok"] and "displacement_up" not in r["arrays"]
    assert r["summary"]["decomposition"]["reason"] and "determinant" in r["summary"]["decomposition"]["reason"]


def test_only_one_direction_is_reported_not_faked():
    a, _, _ = _pair()
    r = M.merge([a], {"A034": "A"}, event_mode=True)
    assert r["ok"] is False and r["available"] == ["A"] and "BOTH" in r["reason"]


def test_best_pair_of_each_direction_wins_and_unknown_direction_is_ignored():
    a1 = _analysis("A034", -10.0, slice(0, 0), seed=1)
    a2 = _analysis("A034", -10.0, slice(0, 60), seed=3)          # sees less -> smaller affected area
    d = _analysis("D071", 190.0, slice(0, 0), seed=2)
    x = _analysis("X999", 190.0, slice(0, 0), seed=4)
    best = M.best_per_direction([a2, a1, d, x], {"A034": "A", "D071": "D", "X999": None})
    assert best["A"] is a1 and best["D"] is d and set(best) == {"A", "D"}


def test_direction_names():
    assert M.direction_of(SimpleNamespace(direction="A")) == "A"
    assert M.direction_of(SimpleNamespace(direction="descending")) == "D"
    assert M.direction_of(SimpleNamespace(direction="DESCENDING")) == "D"
    assert M.direction_of(SimpleNamespace(direction=None)) is None
    assert M.direction_of(SimpleNamespace(direction="?")) is None


def test_different_grids_are_not_resampled():
    a, d, dirs = _pair()
    d.mask = d.mask[:50, :50]
    d.disp = d.disp[:50, :50]
    r = M.merge([a, d], dirs, event_mode=True)
    assert r["ok"] is False and "different grids" in r["reason"]


def test_layers_encode_and_summary_is_json():
    a, d, dirs = _pair(ref="2026-07-25T00:00:00Z", sec="2026-08-06T00:00:00Z")
    r = M.merge([a, d], dirs, event_mode=True)
    layers = M.encode_layers(r)
    assert {"geometry_coverage", "detected_merged", "threshold_merged", "displacement_east", "displacement_up"} <= set(layers)
    for name in ("geometry_coverage", "detected_merged"):
        assert layers[name]["dtype"] == "<u1" and layers[name]["shape"] == [N, N]
        assert [c["value"] for c in layers[name]["categories"]] == [1, 2, 3]
    assert layers["displacement_up"]["dtype"] == "<f4" and "north" in layers["displacement_up"]["note"]
    json.dumps(r["summary"])                                          # plain numbers only
    claim = M.evidence_claim(r["summary"])
    assert "Ascending (A034)" in claim and "descending (D071)" in claim and "East and up" in claim


def test_each_geometry_alone_is_encoded_for_the_ui_switch():
    a, d, dirs = _pair(ref="2026-07-25T00:00:00Z", sec="2026-08-06T00:00:00Z")
    r = M.merge([a, d], dirs, event_mode=True)
    layers = M.encode_layers(r)
    for tag in ("ascending", "descending"):
        assert {f"detected_{tag}", f"threshold_{tag}", f"displacement_los_{tag}"} <= set(layers)
        assert layers[f"detected_{tag}"]["dtype"] == "<u1"
        assert [c["value"] for c in layers[f"detected_{tag}"]["categories"]] == [1, 2]
    arr = r["arrays"]
    seen_a, seen_d = np.asarray(a.mask, bool), np.asarray(d.mask, bool)
    # outside a geometry's own coverage: no threshold, no value, nothing detected (blank, never a made-up number)
    assert np.isnan(arr["threshold_ascending"][~seen_a]).all() and np.isnan(arr["displacement_los_ascending"][~seen_a]).all()
    assert (arr["detected_descending"][~seen_d] == 0).all()
    # each geometry alone is a subset of what the merge says was detected
    assert ((arr["detected_ascending"] > 0) <= (arr["detected_merged"] > 0)).all()
    assert ((arr["detected_descending"] > 0) <= (arr["detected_merged"] > 0)).all()
    # the line-of-sight values are the geometry's own, untouched
    assert np.allclose(arr["displacement_los_ascending"][seen_a], np.asarray(a.disp)[seen_a])


def test_different_windows_are_stated():
    a = _analysis("A034", -10.0, slice(0, 30), ref="2026-07-01T00:00:00Z", sec="2026-07-13T00:00:00Z")
    d = _analysis("D071", 190.0, slice(70, 100), ref="2026-07-04T00:00:00Z", sec="2026-07-16T00:00:00Z")
    r = M.merge([a, d], {"A034": "A", "D071": "D"}, event_mode=False)
    assert r["summary"]["windows_differ"] is True
    assert "different dates" in M.evidence_claim(r["summary"])


def test_settings_live_in_config_and_are_bounded():
    p = EqParams.defaults()
    assert p.merge_geometries is True and p.merge_decompose is True and p.merge_min_geometry_det == 0.3
    q = EqParams.from_triggers({"eq_params": {"merge_min_geometry_det": 9, "merge_geometries": False}})
    assert q.merge_min_geometry_det == 1.0 and q.merge_geometries is False


if __name__ == "__main__":                      # runnable without pytest:  python -m engine.pipelines.earthquake_coseismic.tests.test_merge
    import traceback
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("PASS", name)
            except Exception:                    # noqa: BLE001
                failed += 1
                print("FAIL", name)
                traceback.print_exc()
    raise SystemExit(1 if failed else 0)

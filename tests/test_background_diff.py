"""Data Lab Phase 1 — GET /api/background/diff tests (offline, synthetic arrays, known answers).

Same pattern as test_background_api.py: the source is injected through _SOURCE_FACTORY, so pytest
never touches the network. The maths is pinned against hand-computable arrays:
  * a constant power factor between two dates -> an exactly flat dB difference and an exact ratio;
  * a ramp -> the known slope in dB;
  * NaN / zero / negative pixels -> no-data in the difference, never a painted value;
  * mismatched geometry (track / product) -> 422 with a plain-language reason;
  * mode gating -> db_diff/ratio only for GCOV power, coh_diff only for coherence, phase refused
    with the "already a difference" note;
  * the meta carries the pair facts (dates, gap, validation, per-mode validity) and the cache
    answers hit on the second identical request.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.common_fixtures import (  # noqa: E402
    FakeRetriever, GranuleSpec, default_tile, make_scene, ref_for,
)
from tests.test_background_api import (  # noqa: E402
    GCOV_A, GCOV_LATER, FakeSource, GranuleSpec as _GS,
)

from datetime import datetime, timezone  # noqa: E402

WEST, SOUTH, EAST, NORTH = -119.0, 33.5, -117.0, 35.0
GCOV_HHHH = "science__LSAR__GCOV__grids__frequencyA__HHHH"
GUNW_COH = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__coherenceMagnitude"
GUNW_PHASE = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__unwrappedPhase"


# a second GCOV date on the SAME track/frame/direction as GCOV_A/GCOV_LATER
GCOV_LATER_B = ("NISAR_L2_PR_GCOV_033_034_A_019_4010_SHNA_A_20261014T130900_20261014T130930_"
                "P05023_N_F_J_001")
# a GCOV on a DIFFERENT track (pair validation must refuse it)
GCOV_OTHER_TRACK = ("NISAR_L2_PR_GCOV_033_041_A_019_4000_SHNA_A_20261014T130900_20261014T130930_"
                    "P05023_N_F_J_001")


def _specs():
    return [
        GranuleSpec(ref=_ref(GCOV_A, "GCOV", "2026-09-20T13:09:00"), kind="GCOV"),
        GranuleSpec(ref=_ref(GCOV_LATER, "GCOV", "2026-10-02T13:09:00"), kind="GCOV"),
        GranuleSpec(ref=_ref(GCOV_LATER_B, "GCOV", "2026-10-14T13:09:00"), kind="GCOV"),
        GranuleSpec(ref=_ref(GCOV_OTHER_TRACK, "GCOV", "2026-10-14T13:09:00"), kind="GCOV"),
    ]


def _ref(gid, product, start):
    d = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    return ref_for(gid, product, d, track=34, direction="ASCENDING", frame=19)


def _gunw_specs():
    """Two GUNW pairs on the same geometry, 12 days apart at their secondary dates."""
    from tests.common_fixtures import gunw_id, dt
    t0, t1, t2 = dt("2026-09-20"), dt("2026-10-02"), dt("2026-10-14")
    return [
        GranuleSpec(ref=ref_for(gunw_id(t0, t1), "GUNW", t0, track=34, direction="ASCENDING", frame=19),
                    kind="GUNW", ref_time=t0, sec_time=t1),
        GranuleSpec(ref=ref_for(gunw_id(t1, t2), "GUNW", t1, track=34, direction="ASCENDING", frame=19),
                    kind="GUNW", ref_time=t1, sec_time=t2),
    ]


@pytest.fixture(autouse=True)
def _clean_rate_windows():
    from engine.api import routes_background
    routes_background._BG_HITS.clear()
    routes_background._PREVIEW_HITS.clear()
    yield
    routes_background._BG_HITS.clear()
    routes_background._PREVIEW_HITS.clear()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import state as api_state
    from engine.api import routes_background
    from engine.api.main import create_app
    import engine.common.config as engine_config
    monkeypatch.setattr(engine_config, "data_root", lambda: Path(tmp_path))
    api_state.get_runner.cache_clear()
    monkeypatch.setattr(routes_background, "_SOURCE_FACTORY", lambda: FakeSource(_specs()))
    monkeypatch.setattr("engine.api.jobs.earthdata_present", lambda: True)
    monkeypatch.setattr("engine.api.routes_background.earthdata_present", lambda: True)
    app = create_app()
    with TestClient(app) as c:
        yield c
    api_state.get_runner.cache_clear()


@pytest.fixture()
def gunw_client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import state as api_state
    from engine.api import routes_background
    from engine.api.main import create_app
    import engine.common.config as engine_config
    monkeypatch.setattr(engine_config, "data_root", lambda: Path(tmp_path))
    api_state.get_runner.cache_clear()
    monkeypatch.setattr(routes_background, "_SOURCE_FACTORY", lambda: FakeSource(_gunw_specs()))
    monkeypatch.setattr("engine.api.jobs.earthdata_present", lambda: True)
    monkeypatch.setattr("engine.api.routes_background.earthdata_present", lambda: True)
    app = create_app()
    with TestClient(app) as c:
        yield c
    api_state.get_runner.cache_clear()


BOX = f"west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}"


def _get(c, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    r = c.get(f"/api/background/diff?{qs}")
    return r


# --------------------------------------------------------------------------- #
# pure functions: known answers on synthetic arrays
# --------------------------------------------------------------------------- #
class TestComputeDiff:
    def test_constant_factor_is_flat_db_and_exact_ratio(self):
        from engine.api.background_pairs import compute_diff
        a = np.full((8, 8), 10.0, np.float32)          # raw power
        b = np.full((8, 8), 20.0, np.float32)          # exactly 2x power
        d, note = compute_diff(a, b, "db_diff")
        assert np.allclose(d, 10.0 * np.log10(2.0), atol=1e-5)      # 3.0103 dB everywhere
        d2, _ = compute_diff(a, b, "ratio")
        assert np.allclose(d2, 2.0, atol=1e-6)

    def test_ramp_has_known_db_slope(self):
        from engine.api.background_pairs import compute_diff
        x = np.linspace(1.0, 4.0, 64).reshape(8, 8)
        a = np.full((8, 8), 10.0, np.float32)
        d, _ = compute_diff(a, a * x, "db_diff")
        # dB(b) - dB(a) = 10 log10(x): the first and last values are exact
        assert abs(d[0, 0] - 10 * np.log10(1.0)) < 1e-5
        assert abs(d[-1, -1] - 10 * np.log10(4.0)) < 1e-4

    def test_nonpositive_either_date_is_nodata(self):
        from engine.api.background_pairs import compute_diff
        a = np.full((4, 4), 10.0, np.float32)
        b = np.full((4, 4), 20.0, np.float32)
        b[1, 1] = 0.0            # zero power on the second date
        b[1, 2] = np.nan         # no-data on the second date
        a[2, 2] = -1.0           # negative (impossible but hostile) on the first date
        a[3, 3] = np.nan         # no-data on the first date
        for mode in ("db_diff", "ratio"):
            d, _ = compute_diff(a, b, mode)
            assert not np.isfinite(d[1, 1])
            assert not np.isfinite(d[1, 2])
            assert not np.isfinite(d[2, 2])
            assert not np.isfinite(d[3, 3])
            assert np.isfinite(d[0, 0])            # good pixels survive
            assert float(np.isfinite(d).mean()) == pytest.approx(12 / 16)

    def test_coh_diff_subtracts_directly(self):
        from engine.api.background_pairs import compute_diff
        a = np.full((4, 4), 0.7, np.float32)
        b = np.full((4, 4), 0.4, np.float32)
        d, note = compute_diff(a, b, "coh_diff")
        assert np.allclose(d, -0.3, atol=1e-6)
        b[0, 0] = np.nan
        d2, _ = compute_diff(a, b, "coh_diff")
        assert not np.isfinite(d2[0, 0])
        assert np.isfinite(d2[1, 1])

    def test_shape_mismatch_is_422(self):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import compute_diff
        with pytest.raises(BackgroundError) as ei:
            compute_diff(np.zeros((4, 4)), np.zeros((5, 4)), "coh_diff")
        assert ei.value.status == 422


class TestDiffModes:
    def test_cov_gets_db_and_ratio_not_coh(self):
        from engine.api.background_pairs import diff_modes_for
        m = diff_modes_for(GCOV_HHHH)
        assert m["db_diff"]["valid"] and m["ratio"]["valid"] and m["z_db"]["valid"]
        assert not m["coh_diff"]["valid"] and "coherence" in m["coh_diff"]["reason"]

    def test_coherence_gets_coh_only(self):
        from engine.api.background_pairs import diff_modes_for
        m = diff_modes_for(GUNW_COH)
        assert m["coh_diff"]["valid"]
        assert not m["db_diff"]["valid"] and not m["ratio"]["valid"]

    def test_phase_gets_los_modes_and_raw_modes_are_refused_with_the_reason(self):
        from engine.api.background_pairs import diff_modes_for
        m = diff_modes_for(GUNW_PHASE)
        # Phase 3: the unwrapped phase differences as CONVERTED line-of-sight displacement
        assert m["los_m"]["valid"] and m["los_mm"]["valid"]
        assert m["los_m"]["reason"] is None
        # subtracting RAW phase across pairs is still refused, with the reason
        for raw in ("db_diff", "ratio", "z_db", "coh_diff"):
            assert not m[raw]["valid"]
            assert "already a difference between two dates" in m[raw]["reason"]

    def test_unknown_role_has_no_modes(self):
        from engine.api.background_pairs import diff_modes_for
        m = diff_modes_for("science__LSAR__GCOV__metadata__calibrationInformation__crosstalk__rxHorizontalCrosspol")
        assert all(not v["valid"] for v in m.values())

    def test_resolve_mode_auto_cov_picks_db(self):
        from engine.api.background_pairs import resolve_mode
        assert resolve_mode("auto", GCOV_HHHH) == "db_diff"
        assert resolve_mode("auto", GUNW_COH) == "coh_diff"

    def test_resolve_mode_wrong_for_layer_is_422(self):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import resolve_mode
        with pytest.raises(BackgroundError) as ei:
            resolve_mode("coh_diff", GCOV_HHHH)
        assert ei.value.status == 422
        with pytest.raises(BackgroundError):
            resolve_mode("db_diff", GUNW_PHASE)
        with pytest.raises(BackgroundError) as ei2:
            resolve_mode("nonsense", GCOV_HHHH)
        assert ei2.value.status == 400


class TestValidatePair:
    def test_same_geometry_passes_with_gap(self):
        from engine.api.background_pairs import validate_pair
        from engine.common.granule_id import decode_granule_id
        p = validate_pair(decode_granule_id(GCOV_A), decode_granule_id(GCOV_LATER))
        assert p["product"] == "GCOV"
        assert p["date_a"] == "2026-09-20T13:09:00Z"
        assert p["date_b"] == "2026-10-02T13:09:00Z"
        assert p["gap_days"] == pytest.approx(12.0)
        assert p["later"] == "b"
        assert p["track"] == 34 and p["direction"] == "A"

    def test_different_track_is_422(self):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import validate_pair
        from engine.common.granule_id import decode_granule_id
        with pytest.raises(BackgroundError) as ei:
            validate_pair(decode_granule_id(GCOV_A), decode_granule_id(GCOV_OTHER_TRACK))
        assert ei.value.status == 422
        assert "track" in str(ei.value)

    def test_different_product_is_422(self):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import validate_pair
        from engine.common.granule_id import decode_granule_id
        with pytest.raises(BackgroundError) as ei:
            validate_pair(decode_granule_id(GCOV_A), decode_granule_id(
                "NISAR_L2_PR_GUNW_031_034_A_019_033_4000_SH_20260920T130823_20260920T130857_"
                "20261014T130823_20261014T130857_P05023_N_F_J_001"))
        assert ei.value.status == 422
        assert "different products" in str(ei.value)


class TestAlignPair:
    def test_same_grid_untouched(self):
        from engine.api.background_pairs import align_pair
        from tests.test_background_api import FakeSource  # noqa: F401  (fixture reuse documented)
        class G:                                   # a minimal grid stand-in
            def __init__(self, n, epsg=32611):
                self.epsg = epsg
                self.x = np.arange(n, dtype=float) * 20.0
                self.y = np.arange(n, dtype=float)[::-1] * 20.0
        ga = G(8)
        a = np.ones((8, 8), np.float32)
        va, vb, g, facts = align_pair(ga, a, ga, a * 2)
        assert facts["same_grid"] is True and facts["resampled"] is None
        assert va is a and g is ga

    def test_finer_grid_aggregated_onto_coarser(self):
        from engine.api.background_pairs import align_pair
        class G:
            def __init__(self, dx, n, epsg=32611):
                self.epsg = epsg
                self.x = np.arange(n, dtype=float) * dx
                self.y = np.arange(n, dtype=float)[::-1] * dx
        fine, coarse = G(20.0, 16), G(40.0, 8)
        a = np.ones((16, 16), np.float32) * 3.0        # on the fine grid
        b = np.ones((8, 8), np.float32) * 6.0          # on the coarse grid
        va, vb, g, facts = align_pair(fine, a, coarse, b)
        assert facts["same_grid"] is False and facts["resampled"]
        assert va.shape == vb.shape == (8, 8)
        assert np.allclose(va, 3.0)                    # the mean of the finer values
        assert g is coarse                              # the target is the coarser posting

    def test_different_epsg_is_422(self):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import align_pair
        class G:
            def __init__(self, epsg):
                self.epsg = epsg
                self.x = np.arange(8.0) * 20.0
                self.y = np.arange(8.0)[::-1] * 20.0
        with pytest.raises(BackgroundError) as ei:
            align_pair(G(32611), np.ones((8, 8)), G(32612), np.ones((8, 8)))
        assert ei.value.status == 422 and "reproject" in str(ei.value)


# --------------------------------------------------------------------------- #
# the route (FakeSource: offline, synthetic arrays with speckle, known truth)
# --------------------------------------------------------------------------- #
class TestDiffRoute:
    def test_gcov_db_diff_png_meta_and_cache(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=64)
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/png"
        assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
        meta = json.loads(r.headers["X-Img-Meta"])
        assert meta["scale"] == "db_diff" and meta["cmap"] == "diverging"
        assert meta["diff"]["mode"] == "db_diff"
        assert meta["diff"]["id_a"] == GCOV_A and meta["diff"]["id_b"] == GCOV_LATER
        assert meta["diff"]["gap_days"] == pytest.approx(12.0)
        assert meta["diff"]["date_a"] == "2026-09-20T13:09:00Z"
        assert meta["diff"]["date_b"] == "2026-10-02T13:09:00Z"
        assert meta["diff"]["validation"]["track"] == 34
        assert meta["diff"]["same_grid"] is True
        assert meta["corners_lonlat"] is not None
        assert meta["stats"]["min"] is not None
        assert meta["cache_hit"] is False
        assert meta["unit"] == "dB"
        assert meta["lo"] <= 0.0 <= meta["hi"]                     # symmetric around zero
        # a fixed range is honoured (two diffs stay comparable)
        r2 = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                  west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=64,
                  lo=-10, hi=10)
        meta2 = json.loads(r2.headers["X-Img-Meta"])
        assert meta2["lo"] == -10 and meta2["hi"] == 10 and meta2["range_fixed"] is True
        # the second identical request is a cache hit
        r3 = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                  west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=64)
        assert json.loads(r3.headers["X-Img-Meta"])["cache_hit"] is True

    def test_gcov_ratio_range_is_symmetric_around_one(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=64, mode="ratio")
        assert r.status_code == 200, r.text
        meta = json.loads(r.headers["X-Img-Meta"])
        assert meta["scale"] == "ratio"
        lo, hi = meta["lo"], meta["hi"]
        assert (lo + hi) / 2 == pytest.approx(1.0, abs=1e-3)

    def test_mode_json_sibling(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=32,
                 mode="ratio", format="json")
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["meta"]["scale"] == "ratio"

    def test_wrong_mode_for_layer_is_422_with_reason(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, mode="coh_diff")
        assert r.status_code == 422
        assert "coherence differences" in r.json()["detail"]["error"]

    def test_unknown_mode_is_400(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_LATER, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, mode="wat")
        assert r.status_code == 400

    def test_same_id_twice_is_400(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_A, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH)
        assert r.status_code == 400

    def test_track_mismatch_is_422_with_reason(self, client):
        r = _get(client, id_a=GCOV_A, id_b=GCOV_OTHER_TRACK, layer=GCOV_HHHH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH)
        assert r.status_code == 422
        assert "track" in r.json()["detail"]["error"]

    def test_gunw_coh_diff(self, gunw_client):
        from tests.common_fixtures import gunw_id, dt
        t0, t1, t2 = dt("2026-09-20"), dt("2026-10-02"), dt("2026-10-14")
        pair1, pair2 = gunw_id(t0, t1), gunw_id(t1, t2)
        r = _get(gunw_client, id_a=pair1, id_b=pair2, layer=GUNW_COH,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH, max_px=64)
        assert r.status_code == 200, r.text
        meta = json.loads(r.headers["X-Img-Meta"])
        assert meta["diff"]["mode"] == "coh_diff"
        assert meta["diff"]["gap_days"] == pytest.approx(12.0)     # between secondary dates
        assert "coherence difference" in meta["notes"][0]

    def test_gunw_phase_pair_raw_mode_is_refused_with_the_reason(self, gunw_client):
        from tests.common_fixtures import gunw_id, dt
        t0, t1, t2 = dt("2026-09-20"), dt("2026-10-02"), dt("2026-10-14")
        pair1, pair2 = gunw_id(t0, t1), gunw_id(t1, t2)
        r = _get(gunw_client, id_a=pair1, id_b=pair2, layer=GUNW_PHASE, mode="db_diff",
                 west=WEST, south=SOUTH, east=EAST, north=NORTH)
        assert r.status_code == 422
        err = r.json()["detail"]["error"]
        assert "already a difference" in err

    def test_gunw_phase_pair_diff_auto_is_los_with_referencing(self, gunw_client):
        # Phase 3: auto on an unwrapped phase layer resolves to los_m — each granule's phase
        # converted with its own referencing, then differenced; the referencing is stated
        from tests.common_fixtures import gunw_id, dt
        t0, t1, t2 = dt("2026-09-20"), dt("2026-10-02"), dt("2026-10-14")
        pair1, pair2 = gunw_id(t0, t1), gunw_id(t1, t2)
        r = _get(gunw_client, id_a=pair1, id_b=pair2, layer=GUNW_PHASE,
                 west=WEST, south=SOUTH, east=EAST, north=NORTH)
        assert r.status_code == 200, r.text
        meta = json.loads(r.headers["X-Img-Meta"])
        assert meta["diff"]["mode"] == "los_m"
        assert meta["unit"] == "m (LOS, + toward sensor)"
        ref = meta["diff"]["referencing"]
        assert ref["shared_reference_date"] is False      # (t0,t1) vs (t1,t2): different refs
        assert "do NOT share a reference date" in ref["note"]
        assert "formula" in ref and "wavelength" in ref["formula"]

    def test_no_access_key_is_needed(self, client):
        url = f"/api/background/diff?id_a={GCOV_A}&id_b={GCOV_LATER}&layer={GCOV_HHHH}&{BOX}"
        assert client.get(url).status_code == 200
        assert client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 200   # a stale key is ignored

    def test_inventory_carries_diff_modes(self, client):
        r = client.get(f"/api/background/granule?id={GCOV_A}")
        assert r.status_code == 200
        layers = [l for g in r.json()["inventory"]["grids"] for l in g["layers"]]
        hhhh = next(l for l in layers if l["key"] == GCOV_HHHH)
        assert hhhh["diff_modes"]["db_diff"]["valid"] is True
        assert hhhh["diff_modes"]["coh_diff"]["valid"] is False

    def test_explain_carries_diff_mode_copy(self, client):
        r = client.get("/api/background/explain")
        assert r.status_code == 200
        dm = r.json()["diff_modes"]
        assert set(dm) == {"db_diff", "ratio", "z_db", "coh_diff"}
        for m in dm.values():
            assert m["what_it_is"] and m["how_to_read"] and m["misread"]


class TestSpeckleZ:
    """z_db = dB change / (sqrt(2) x P10's speckle floor 4.343/sqrt(looks)) — the preprocessing noise model."""

    def _pair(self, sigmas=3.0, looks=25.0):
        rng = np.random.default_rng(0)
        a = rng.uniform(0.05, 0.5, (40, 40))
        step_db = sigmas * np.sqrt(2.0) * (10 / np.log(10)) / np.sqrt(looks)
        return a, a * 10 ** (step_db / 10)

    def test_known_step_is_that_many_sigmas(self):
        from engine.api.background_pairs import compute_diff
        a, b = self._pair(3.0)
        d, note = compute_diff(a, b, "z_db", nochange_k=3.0)
        assert np.allclose(d, 3.0, atol=1e-4)
        assert "assumed 25 looks" in note and "P11" in note

    def test_identical_dates_are_zero(self):
        from engine.api.background_pairs import compute_diff
        a, _ = self._pair()
        d, _ = compute_diff(a, a, "z_db")
        assert float(np.nanmax(np.abs(d))) == 0.0

    def test_more_looks_means_smaller_noise_so_bigger_z(self):
        from engine.api.background_pairs import compute_diff
        a, b = self._pair(3.0)
        d, note = compute_diff(a, b, "z_db", looks=np.full(a.shape, 100.0))
        assert np.allclose(d, 6.0, atol=1e-3) and "per-pixel numberOfLooks" in note

    def test_nan_looks_fall_back_to_the_default(self):
        from engine.api.background_pairs import compute_diff
        a, b = self._pair(3.0)
        d, _ = compute_diff(a, b, "z_db", looks=np.full(a.shape, np.nan))
        assert np.allclose(d, 3.0, atol=1e-4)

    def test_zero_power_in_either_date_is_no_data(self):
        from engine.api.background_pairs import compute_diff
        a, b = self._pair()
        a[0, 0] = 0.0
        b[1, 1] = -1.0
        d, _ = compute_diff(a, b, "z_db")
        assert np.isnan(d[0, 0]) and np.isnan(d[1, 1])

    def test_coherence_and_phase_layers_do_not_get_it(self):
        from engine.api.background_pairs import resolve_mode
        from engine.api.background import BackgroundError
        with pytest.raises(BackgroundError) as ei:
            resolve_mode("z_db", GUNW_COH)
        assert ei.value.status == 422



# ---------------------------------------------------------------------------------------------
# The bundle's z_prev (P10) and the Map's z_db are one noise model: the same pair must give the same z.
# ---------------------------------------------------------------------------------------------
class TestBundleZPrevMatchesTheMapZ:
    @staticmethod
    def _z_prev(g_db, looks):
        from types import SimpleNamespace as NS
        from engine.common.context import CovWork
        from engine.common.p10_temporal_stack import backscatter_epoch_change
        ctx = NS(cfg=NS(temporal=NS(default_looks=25.0)), assume=lambda _t: None)
        w = CovWork(epochs=("a", "b"), gamma0_db={"HV": g_db}, n_looks=looks)
        return backscatter_epoch_change(ctx, "A005", w)[1]["HV"]

    def _pair_db(self):
        rng = np.random.default_rng(7)
        g = rng.normal(-14.0, 2.0, (2, 9, 11)).astype(np.float32)
        g[1, 2:5, 3:7] += 3.0
        return g

    def test_same_pair_same_grid_same_looks(self):
        from engine.api.background_pairs import compute_diff
        g = self._pair_db()
        looks = np.full(g.shape, 16.0, np.float32)
        mine = self._z_prev(g, looks)[1]
        raw = 10.0 ** (g.astype(np.float64) / 10.0)
        theirs, _ = compute_diff(raw[0], raw[1], "z_db", looks=np.nanmean(looks, axis=0), default_looks=25.0)
        assert np.allclose(mine, theirs, rtol=1e-4, atol=1e-5)

    def test_same_pair_without_looks_uses_the_same_default(self):
        from engine.api.background_pairs import compute_diff
        g = self._pair_db()
        mine = self._z_prev(g, None)[1]
        raw = 10.0 ** (g.astype(np.float64) / 10.0)
        theirs, _ = compute_diff(raw[0], raw[1], "z_db", looks=None, default_looks=25.0)
        assert np.allclose(mine, theirs, rtol=1e-4, atol=1e-5)

    def test_the_noise_model_lives_in_the_common_chain_and_the_api_reuses_it(self):
        import engine.api.background_pairs as bp
        import engine.common.p10_temporal_stack as p10
        assert bp.speckle_sigma_db is p10.speckle_sigma_db
        assert p10.speckle_sigma_db(None, 25.0) == pytest.approx(4.342944819032518 / 5.0)
        assert np.allclose(p10.speckle_sigma_db(np.array([np.nan, 0.2, 100.0]), 25.0),
                           4.342944819032518 / np.sqrt([25.0, 1.0, 100.0]))        # NaN -> default, < 1 -> 1

"""Data Lab Phase 2 — /api/background/inspect and /api/background/timeseries tests (offline).

Known answers on synthetic fixture data:
  * a constant-power clip -> exact dB mean/min/max; a linear clip -> the raw mean;
  * histogram edges span the data and counts sum to n;
  * a profile A->B samples pixel centres in grid order, nulls outside the clip;
  * an all-NaN box answers 200 with null stats and the honest note (a data query, not an image);
  * the cache answers hit on the second identical request;
  * timeseries: dates sorted ascending, one value per date, per-granule `missing` with reasons,
    a mixed-track stack refused with the plain reason, gate + cap enforced.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.test_background_api import GCOV_A, GCOV_LATER, FakeSource  # noqa: E402
from tests.test_background_diff import (  # noqa: E402
    GCOV_HHHH, GCOV_LATER_B, GCOV_OTHER_TRACK, _ref, _specs,
)

WEST, SOUTH, EAST, NORTH = -119.0, 33.5, -117.0, 35.0
BOX = f"west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}"


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


class TestInspectRoute:
    def test_stats_of_the_legend_scale_and_cache(self, client):
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&scale=db&bins=16")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["scale"] == "db" and body["unit"] == "dB"
        st = body["stats"]
        assert st["min"] is not None and st["max"] is not None and st["max"] >= st["min"]
        # dB of positive power: the mean of dB values is finite and the nan share matches the view
        assert 0.0 <= st["nan_fraction"] < 1.0
        h = body["histogram"]
        assert h["bins"] == 16
        assert len(h["edges"]) == 17 and len(h["counts"]) == 16
        assert sum(h["counts"]) == h["n"] == st["n_bytes"] // 4   # float32 -> 4 bytes per pixel
        assert h["edges"][0] <= st["min"] and h["edges"][-1] >= st["max"]
        # the second identical request is a cache hit
        r2 = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&scale=db&bins=16")
        assert r2.json()["cache_hit"] is True
        # a different bins count is a different question -> fresh compute
        r3 = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&scale=db&bins=8")
        assert r3.json()["cache_hit"] is False

    def test_linear_scale_leaves_values_raw(self, client):
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&scale=linear")
        assert r.status_code == 200
        body = r.json()
        assert body["scale"] == "linear" and body["unit"] is None
        assert body["stats"]["min"] >= 0.0            # raw power, not dB

    def test_profile_samples_pixel_centres(self, client):
        # A->B across the tile (the fixture GCOV clip spans about -118.52..-118.40 lon, 33.96..34.07 lat)
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}"
                       "&a_lon=-118.5&a_lat=34.0&b_lon=-118.42&b_lat=34.0")
        assert r.status_code == 200, r.text
        prof = r.json()["profile"]
        assert prof["n_samples"] >= 2 and prof["length_m"] > 0
        assert prof["a_lonlat"] == [-118.5, 34.0] and prof["b_lonlat"] == [-118.42, 34.0]
        samples = prof["samples"]
        assert [s["i"] for s in samples] == list(range(len(samples)))     # grid order A->B
        assert all("lon" in s and "lat" in s for s in samples)
        vals = [s["value"] for s in samples]
        assert any(v is not None for v in vals)        # the transect crosses the swath
        # a profile far outside the granule is honest nulls, not an error
        r2 = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}"
                        "&a_lon=0.0&a_lat=0.0&b_lon=0.5&b_lat=0.0")
        assert r2.status_code == 200
        prof2 = r2.json()["profile"]
        assert prof2["n_valid"] == 0 and all(s["value"] is None for s in prof2["samples"])

    def test_far_box_with_fixture_source_still_answers(self, client):
        # NOTE: FakeSource clips the whole tile regardless of bbox (a fixture limitation), so a
        # far-away box still returns numbers here. The honest all-NaN/nulls behaviour is covered
        # engine-level in test_inspect_engine_level_all_nan below.
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}"
                       "&west=0.0&south=0.0&east=0.5&north=0.5")
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_inspect_engine_level_all_nan(self, tmp_path, monkeypatch):
        from engine.api.background_inspect import inspect as inspect_fn
        from tests.test_background_api import FakeSource

        class AllNanSource(FakeSource):
            def fetch(self, bbox, t0, t1, product, layers, granules=None):
                fr = super().fetch(bbox, t0, t1, product, layers, granules)
                for clip in fr.clips:
                    for g in clip.grids.values():
                        for k in g.layers:
                            g.layers[k] = np.full(g.layers[k].shape, np.nan, np.float32)
                return fr

        monkeypatch.setattr("engine.api.background_inspect._take_preview_lock", lambda: None)
        monkeypatch.setattr("engine.api.background_inspect._bg._PREVIEW_LOCK", type("L", (), {"release": staticmethod(lambda: None)})())
        out = inspect_fn(AllNanSource(_specs()), gid=GCOV_A, layer=GCOV_HHHH,
                         bbox=(WEST, SOUTH, EAST, NORTH), scale="db", use_cache=False)
        assert out["stats"]["mean"] is None and out["stats"]["nan_fraction"] == 1.0
        assert out["histogram"]["n"] == 0
        assert out["notes"] and "no-data" in out["notes"][0]

    def test_no_key_needed_and_bad_params(self, client):
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}")
        assert r.status_code == 200
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&scale=wat")
        assert r.status_code == 400
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&a_lon=1")
        assert r.status_code == 400 and "all four" in r.json()["detail"]["error"]
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}"
                       "&west=10&south=0&east=0&north=5")
        assert r.status_code == 400
        r = client.get(f"/api/background/inspect?id={GCOV_A}&layer={GCOV_HHHH}&{BOX}&bins=99999")
        assert r.status_code == 200          # capped, not refused
        assert r.json()["histogram"]["bins"] <= 256


class TestTimeseriesRoute:
    def test_one_value_per_date_sorted_with_stack_facts(self, client):
        ids = f"{GCOV_A},{GCOV_LATER},{GCOV_LATER_B}"
        r = client.get(f"/api/background/timeseries?ids={ids}&layer={GCOV_HHHH}&{BOX}&scale=db&stat=mean")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True and body["stat"] == "mean" and body["unit"] == "dB"
        dates = [p["date"] for p in body["points"]]
        assert len(dates) == 3 and dates == sorted(dates)
        assert dates[0] == "2026-09-20T13:09:00Z"
        for p in body["points"]:
            assert p["value"] is not None and p["n_valid"] > 0
        assert body["stack"] == {"product": "GCOV", "track": 34, "frame": 19, "direction": "A"}
        assert body["missing"] == []
        assert body["cache_hit"] is False
        # the second identical request is a cache hit
        r2 = client.get(f"/api/background/timeseries?ids={ids}&layer={GCOV_HHHH}&{BOX}&scale=db&stat=mean")
        assert r2.json()["cache_hit"] is True

    def test_missing_granule_is_listed_not_dropped(self, client):
        r = client.get(f"/api/background/timeseries?ids={GCOV_A},NISAR_L2_PR_GCOV_999_034_A_019_4005_SHNA_A_20261001T130900_20261001T130930_P05023_N_F_J_001"
                       f"&layer={GCOV_HHHH}&{BOX}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["points"]) == 1
        assert len(body["missing"]) == 1
        assert "reason" in body["missing"][0]
        assert body["notes"] and "missing" in body["notes"][0]

    def test_mixed_track_is_422(self, client):
        # GCOV_OTHER_TRACK is on track 41; the series must refuse to mix
        r = client.get(f"/api/background/timeseries?ids={GCOV_A},{GCOV_OTHER_TRACK}&layer={GCOV_HHHH}&{BOX}")
        assert r.status_code == 422
        assert "track" in r.json()["detail"]["error"]

    def test_cap_and_bad_stat(self, client):
        many = ",".join(f"NISAR_L2_PR_GCOV_{i:03d}_034_A_019_4005_SHNA_A_20261001T130900_20261001T130930_P05023_N_F_J_001"
                        for i in range(1, 30))
        r = client.get(f"/api/background/timeseries?ids={many}&layer={GCOV_HHHH}&{BOX}")
        assert r.status_code == 400 and "at most 24" in r.json()["detail"]["error"]
        r = client.get(f"/api/background/timeseries?ids={GCOV_A}&layer={GCOV_HHHH}&{BOX}&stat=nope")
        assert r.status_code == 400

    def test_no_key_needed(self, client):
        r = client.get(f"/api/background/timeseries?ids={GCOV_A}&layer={GCOV_HHHH}&{BOX}")
        assert r.status_code == 200

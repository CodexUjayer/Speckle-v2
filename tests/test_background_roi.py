"""Data Lab Phase 4 — drawn-ROI statistics tests (offline, known answers on synthetic fixtures).

GET /api/background/roi: the person draws a box or polygon; the ENGINE masks the layer's pixel
centres against the projected ring and computes stats + histogram on the legend's values (the
same scale resolution, the same LOS / corr / cc-gate rules as the preview). Verified here:
  * the mask against a brute-force count and against the analytic area / pixel pitch;
  * the values against the scene's +50 mm truth bowl (max inside the ROI);
  * the cc gate (the garbage region's pixels are no-data, not painted);
  * LOS and corr parity with Phase 3;
  * shape validation (2-vertex polygon, antimeridian, bad kind, vertex caps, non-numbers);
  * no access key needed, 400 on a bad ring and the cache.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.test_background_api import FakeSource  # noqa: E402
from tests.common_fixtures import selftest_scene  # noqa: E402

WEST, SOUTH, EAST, NORTH = -118.5, 33.98, -118.42, 34.05      # inside the fixture tile
BOX = f"west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}"
GUNW_PHASE = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__unwrappedPhase"
GUNW_COH = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__coherenceMagnitude"
LAMBDA = 0.2384
K = -1 * LAMBDA / (4 * math.pi)

# shapes inside the fixture tile (the tile spans roughly -118.52..-118.40 / 33.97..34.07)
BOX_SHAPE = {"kind": "box", "ring": [[-118.50, 33.98], [-118.42, 34.05]]}
TRI_SHAPE = {"kind": "polygon", "ring": [[-118.50, 33.98], [-118.43, 33.98], [-118.46, 34.05]]}
CONCAVE_SHAPE = {"kind": "polygon",
                 "ring": [[-118.50, 33.98], [-118.43, 33.98], [-118.43, 34.02],
                          [-118.465, 34.02], [-118.465, 34.05], [-118.50, 34.05]]}


def _scene():
    specs = selftest_scene()
    return specs, next(s for s in specs if s.kind == "GUNW" and s.dlos != 0.0)


# --------------------------------------------------------------------------- #
# shape validation
# --------------------------------------------------------------------------- #
class TestValidateShape:
    def test_accepts_box_and_polygon_and_normalizes(self):
        from engine.api.background_roi import validate_shape
        b = validate_shape({"kind": "box", "ring": [[-118.5, 33.98], [-118.42, 34.05]]})
        assert b["kind"] == "box" and len(b["ring"]) == 4
        # a 4-corner box and a doubled closing polygon both normalise honestly
        p = validate_shape({"kind": "polygon",
                            "ring": [[-118.5, 33.98], [-118.43, 33.98], [-118.46, 34.05],
                                     [-118.46, 34.05]]})
        assert len(p["ring"]) == 3

    @pytest.mark.parametrize("bad,why", [
        ({"kind": "polygon", "ring": [[-118.5, 33.98], [-118.43, 33.98]]}, "at least 3"),
        ({"kind": "box", "ring": [[-179.9, 33.9], [179.9, 34.1]]}, "antimeridian"),
        ({"kind": "hexagon", "ring": [[-118.5, 33.98], [-118.43, 33.98], [-118.46, 34.05]]}, "kind must be"),
        ({"kind": "box", "ring": [[-118.42, 33.98], [-118.42, 34.05]]}, "west < east"),
        ({"kind": "polygon", "ring": [[-118.5, 33.98], [-118.43, 33.98], [91.0, 91.0]]}, "outside"),
        ({"kind": "polygon", "ring": [[-118.5, 33.98], ["x", 33.98], [-118.43, 34.05]]}, "numbers"),
        ({"kind": "polygon", "ring": [[-118.5, 33.98], [-118.43, 33.98], [-118.46, 34.05], [-118.5, 33.98]] + [[-118.5, 33.98]] * 64}, "at most"),
    ])
    def test_refuses_with_the_reason(self, bad, why):
        from engine.api.background import BackgroundError
        from engine.api.background_roi import validate_shape
        with pytest.raises(BackgroundError) as ei:
            validate_shape(bad)
        assert ei.value.status == 400
        assert why in str(ei.value)


# --------------------------------------------------------------------------- #
# the mask and the numbers
# --------------------------------------------------------------------------- #
class TestRoiMaskAndStats:
    @pytest.fixture(autouse=True)
    def _isolated_cache(self, tmp_path, monkeypatch):
        import engine.common.config as engine_config
        monkeypatch.setattr(engine_config, "data_root", lambda root=None: tmp_path)

    @pytest.fixture()
    def src(self):
        specs, _ = _scene()
        return FakeSource(specs)

    def test_box_mask_matches_analytic_and_brute_force(self, src):
        from engine.api.background_roi import _polygon_mask
        from engine.api.background import find_granule
        from engine.common._geo import transform_xy
        from shapely import contains_xy
        from shapely.geometry import Polygon
        specs, gunw = _scene()
        ref, dec = find_granule(src, gunw.ref.granule_id, (WEST, SOUTH, EAST, NORTH))
        fr = src.fetch((WEST, SOUTH, EAST, NORTH), None, None, None, GUNW_PHASE.replace("__", "/"),
                       granules=[ref])
        grid = next(g for g in fr.clips[0].grids.values() if GUNW_PHASE in g.layers)
        ring = [(-118.50, 33.98), (-118.42, 33.98), (-118.42, 34.05), (-118.50, 34.05)]
        px, py = transform_xy(np.array([p[0] for p in ring]), np.array([p[1] for p in ring]),
                              "EPSG:4326", f"EPSG:{grid.epsg}")
        m = _polygon_mask(grid, px, py)
        X, Y = np.meshgrid(np.asarray(grid.x, float), np.asarray(grid.y, float))
        brute = int(contains_xy(Polygon(np.column_stack([px, py])), X, Y).sum())
        assert int(m.sum()) == brute
        # analytic: area / pixel pitch, within pixel-centre rounding (a few per mille)
        area_m2 = Polygon(np.column_stack([px, py])).area
        pitch = 80.0 * 80.0
        assert abs(m.sum() - area_m2 / pitch) / m.sum() < 0.02

    def test_polygon_and_concave_shapes(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        for shape in (TRI_SHAPE, CONCAVE_SHAPE):
            out = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=shape,
                      scale="los_mm", use_cache=False)
            r = out["roi"]
            assert 0 < r["n_pixels"] < 9000
            assert r["n_valid"] <= r["n_pixels"]
            assert r["area_km2"] > 0

    def test_los_values_carry_the_truth_bowl_and_the_cc_gate(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        out = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=BOX_SHAPE,
                  scale="los_mm", use_cache=False)
        r = out["roi"]
        assert r["stats"]["unit"] == "mm (LOS, + toward sensor)"
        assert r["stats"]["max"] == pytest.approx(50.0, abs=1.0)     # the +50 mm bowl
        assert r["n_valid"] < r["n_pixels"]                          # the cc-gate bit
        assert out["los"]["cc_gate"] and "connectedComponents" in out["los"]["cc_gate"]
        # an empty gate would paint garbage: the ungated max on this box is ~30 rad * |K| * 1e3
        assert r["stats"]["max"] < 100.0

    def test_coherence_roi_on_linear_scale(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        out = roi(src, gid=gunw.ref.granule_id, layer=GUNW_COH, shape=BOX_SHAPE,
                  scale="auto", use_cache=False)
        r = out["roi"]
        assert r["stats"]["unit"] is None                             # linear = unknown, dash
        assert 0.0 < r["stats"]["mean"] < 1.0
        assert r["n_valid"] == r["n_pixels"]                          # no cc gate off the phase path

    def test_corr_diagnostic_parity(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        out = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=BOX_SHAPE,
                  scale="los_m", corr="iono", use_cache=False)
        assert out["los"]["correction"]["applied_by_product"] is False
        # the iono screen is 0.3*sin(X/3000) rad: bounded by the analytic extreme
        assert 0.0 <= out["roi"]["stats"]["max"] <= 0.3 * abs(K) * (1 + 1e-6)

    def test_empty_roi_says_null_not_zero(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        # a thin sliver at the tile's very edge can hold pixel centres but only no-data ones:
        # use a degenerate-ish polygon far from any valid pixel — the north-east corner strip
        sliver = {"kind": "polygon", "ring": [[-118.401, 34.062], [-118.399, 34.062],
                                              [-118.400, 34.064]]}
        out = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=sliver,
                  scale="los_mm", use_cache=False)
        r = out["roi"]
        assert r["stats"]["mean"] is None or r["n_valid"] > 0         # either honest answer
        assert out["notes"] and isinstance(out["notes"], list)

    def test_cache_and_shape_key(self, src):
        from engine.api.background_roi import roi
        specs, gunw = _scene()
        first = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=BOX_SHAPE, scale="los_mm")
        assert first["cache_hit"] is False                            # first call, cold cache
        again = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=BOX_SHAPE, scale="los_mm")
        assert again["cache_hit"] is True
        # a DIFFERENT shape must not hit the same entry
        other = roi(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE, shape=TRI_SHAPE, scale="los_mm")
        assert other["cache_hit"] is False


# --------------------------------------------------------------------------- #
# the route
# --------------------------------------------------------------------------- #
class TestRoiRoute:
    def test_validation(self, client):
        specs, gunw = _scene()
        gid = gunw.ref.granule_id
        ring = ";".join(f"{p[0]},{p[1]}" for p in BOX_SHAPE["ring"])
        # no access key is needed
        assert client.get(f"/api/background/roi?id={gid}&layer={GUNW_PHASE}&kind=box&ring={ring}"
                          f"&{BOX}").status_code == 200
        # a malformed ring -> 400 with the reason
        assert client.get(f"/api/background/roi?id={gid}&layer={GUNW_PHASE}&kind=box&ring=oops"
                          f"&{BOX}").status_code == 400
        # a 2-vertex polygon -> 400 (the engine's own validation)
        assert client.get(f"/api/background/roi?id={gid}&layer={GUNW_PHASE}&kind=polygon"
                          f"&ring=-118.5,33.98;-118.43,33.98&{BOX}").status_code == 400

    def test_round_trip_box_and_los(self, client):
        specs, gunw = _scene()
        gid = gunw.ref.granule_id
        ring = ";".join(f"{p[0]},{p[1]}" for p in BOX_SHAPE["ring"])
        r = client.get(f"/api/background/roi?id={gid}&layer={GUNW_PHASE}&kind=box&ring={ring}"
                       f"&scale=los_mm&bins=24&{BOX}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        roi_body = body["roi"]
        assert roi_body["kind"] == "box" and roi_body["n_vertices"] == 4
        assert roi_body["stats"]["max"] == pytest.approx(50.0, abs=1.0)
        assert roi_body["histogram"]["bins"] == 24
        assert sum(roi_body["histogram"]["counts"]) == roi_body["n_valid"]
        assert roi_body["pixel_pitch_m"] == [80.0, 80.0]
        assert "centre falls inside" in roi_body["mask_rule"]


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import state as api_state
    from engine.api import routes_background
    from engine.api.main import create_app
    import engine.common.config as engine_config
    monkeypatch.setattr(engine_config, "data_root", lambda: Path(tmp_path))
    api_state.get_runner.cache_clear()
    specs, _ = _scene()
    monkeypatch.setattr(routes_background, "_SOURCE_FACTORY", lambda: FakeSource(specs))
    monkeypatch.setattr("engine.api.jobs.earthdata_present", lambda: True)
    monkeypatch.setattr("engine.api.routes_background.earthdata_present", lambda: True)
    app = create_app()
    with TestClient(app) as c:
        yield c
    api_state.get_runner.cache_clear()

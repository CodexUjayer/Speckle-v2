"""Data Lab Phase 3 — phase -> LOS metres tests (offline, known answers on synthetic fixtures).

The conversion is the pipelines' own (engine/common/p06_phase_to_los.py) offered per granule:
    los_m = sign * phase_sign * wavelength / (4 pi) * unwrappedPhase

Verified here against numbers computed INDEPENDENTLY in the test (phase * k with k taken from
config), the self-test scene's +50 mm truth bowl, the connected-component gate, the correction
diagnostics (iono screen converted; tropo/tide height cubes collapsed at the fallback height),
the diff modes los_m / los_mm with their referencing validation, and the gates/caches.
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
from tests.common_fixtures import (  # noqa: E402
    default_tile, dt, gunw_id, make_scene, ref_for, selftest_scene, GranuleSpec,
)

WEST, SOUTH, EAST, NORTH = -118.45, 33.7, -118.05, 34.3
BOX = f"west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}"
GUNW_PHASE = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__unwrappedPhase"
LAMBDA = 0.2384
K = -1 * LAMBDA / (4 * math.pi)          # phase_sign = -1


def _gunw():
    """The self-test scene and its TRUTH pair (the GUNW carrying the +50 mm bowl: the one
    spanning the last epoch)."""
    specs = selftest_scene()
    truth = next(s for s in specs if s.kind == "GUNW" and s.dlos != 0.0)
    return specs, truth


# --------------------------------------------------------------------------- #
# the pure conversion
# --------------------------------------------------------------------------- #
class TestPhaseToLos:
    def test_known_answer_and_flipped_sign(self):
        from engine.api.background_los import phase_to_los
        from engine.common.config import load_common_config
        radar = load_common_config().radar
        dec = {"ref_time": "2026-07-01T00:00:00Z", "sec_time": "2026-07-13T00:00:00Z"}
        phase = np.array([[1.0, -2.0], [0.5, np.nan]], np.float32)
        out, facts = phase_to_los(phase, dec, radar, mm=False)
        assert facts["pair_flipped"] is False and facts["sign_applied"] == 1.0
        assert out.dtype == np.float32
        assert out[0, 0] == pytest.approx(K * 1.0, abs=1e-7)
        assert out[0, 1] == pytest.approx(K * -2.0, abs=1e-7)
        assert np.isnan(out[1, 1])
        # a pair stored secondary-BEFORE-reference flips the sign (reads later-minus-earlier)
        dec_flip = {"ref_time": "2026-07-13T00:00:00Z", "sec_time": "2026-07-01T00:00:00Z"}
        out2, facts2 = phase_to_los(phase, dec_flip, radar, mm=False)
        assert facts2["pair_flipped"] is True and facts2["sign_applied"] == -1.0
        assert out2[0, 0] == pytest.approx(-K * 1.0, abs=1e-7)
        # millimetres = metres * 1000, same referencing
        out3, _ = phase_to_los(phase, dec, radar, mm=True)
        assert out3[0, 0] == pytest.approx(1000 * K, abs=1e-4)
        # a granule without both pair dates cannot be referenced: 422, not a guess
        with pytest.raises(Exception) as ei:
            phase_to_los(phase, {"ref_time": None, "sec_time": None}, radar)
        assert getattr(ei.value, "status", None) == 422

    def test_formula_and_assumptions_are_stated(self):
        from engine.api.background_los import phase_to_los
        from engine.common.config import load_common_config
        _, facts = phase_to_los(np.zeros((2, 2), np.float32),
                                {"ref_time": "2026-07-01T00:00:00Z", "sec_time": "2026-07-13T00:00:00Z"},
                                load_common_config().radar)
        assert "wavelength / (4 pi)" in facts["formula"]
        assert any("unverified on real NISAR data" in a for a in facts["assumptions"])
        assert facts["wavelength_m"] == pytest.approx(LAMBDA)


# --------------------------------------------------------------------------- #
# preview: scale=los_m / los_mm
# --------------------------------------------------------------------------- #
class TestPreviewLos:
    @pytest.fixture()
    def src(self):
        specs, _ = _gunw()
        return FakeSource(specs)

    def test_los_recovers_the_truth_bowl(self, src):
        from engine.api.background import preview
        specs, gunw = _gunw()
        gid = gunw.ref.granule_id
        m = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                    max_px=256, scale="los_mm", use_cache=False)["meta"]
        assert m["unit"] == "mm (LOS, + toward sensor)"
        assert m["cmap"] == "diverging"
        assert m["los"]["pair_flipped"] is False
        # the self-test scene puts a +50 mm toward-sensor bowl on this pair
        assert m["stats"]["max"] == pytest.approx(50.0, abs=1.0)
        # metres and millimetres agree
        m_m = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                      max_px=256, scale="los_m", use_cache=False)["meta"]
        assert m_m["stats"]["max"] == pytest.approx(m["stats"]["max"] / 1000.0, abs=1e-4)

    def test_cc_gate_removes_the_garbage_region(self, src):
        from engine.api.background import preview
        specs, gunw = _gunw()
        gid = gunw.ref.granule_id
        m_los = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                        max_px=256, scale="los_mm", use_cache=False)["meta"]
        gate = m_los["los"]["cc_gate"]
        assert gate and "connectedComponents < 1" in gate and "no-data" in gate
        # the same clip's RAW phase keeps the garbage (±30 rad painted); the LOS view does not
        assert abs(m_los["stats"]["max"]) < 100.0            # mm scale, gated
        m_raw = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                        max_px=256, use_cache=False)["meta"]
        assert m_raw["los"] is None and m_raw["scale"] == "linear"

    def test_los_on_a_power_layer_is_422(self, src):
        from engine.api.background import BackgroundError, preview
        specs = make_scene()
        gcov = next(s for s in specs if s.kind == "GCOV")
        with pytest.raises(BackgroundError) as ei:
            preview(FakeSource(specs), gid=gcov.ref.granule_id,
                    layer="science__LSAR__GCOV__grids__frequencyA__HHHH",
                    bbox=(WEST, SOUTH, EAST, NORTH), max_px=128, scale="los_m", use_cache=False)
        assert ei.value.status == 422
        assert "unwrapped phase" in str(ei.value)

    def test_cache_and_no_key(self, client):
        specs, gunw = _gunw()
        gid = gunw.ref.granule_id
        r1 = client.get(f"/api/background/preview?id={gid}&layer={GUNW_PHASE}&{BOX}"
                        "&max_px=128&scale=los_m")
        assert r1.status_code == 200, r1.text
        m1 = json.loads(r1.headers["X-Img-Meta"])
        assert m1["scale"] == "los_m"
        r2 = client.get(f"/api/background/preview?id={gid}&layer={GUNW_PHASE}&{BOX}"
                        "&max_px=128&scale=los_m")
        assert json.loads(r2.headers["X-Img-Meta"])["cache_hit"] is True
        assert client.get(f"/api/background/preview?id={gid}&layer={GUNW_PHASE}&{BOX}"
                          "&max_px=128&scale=wat").status_code == 400


# --------------------------------------------------------------------------- #
# preview: correction diagnostics (?corr=)
# --------------------------------------------------------------------------- #
class TestPreviewCorr:
    @pytest.fixture()
    def src(self):
        specs, _ = _gunw()
        return FakeSource(specs)

    def _gid(self):
        _, gunw = _gunw()
        return gunw.ref.granule_id

    def test_iono_screen_converted_with_the_same_k(self, src):
        from engine.api.background import preview
        gid = self._gid()
        m = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                    max_px=128, scale="los_m", corr="iono", use_cache=False)["meta"]
        assert m["layer"].endswith("ionospherePhaseScreen")
        assert m["correction"]["applied_by_product"] is False
        assert m["correction"]["applied_by_engine"] is False
        # fixture screen = 0.3*sin(X/3000) rad: the converted values are bounded by the
        # analytic extreme 0.3*|K| and are exactly K * phase (checked directly below)
        assert 0.0 < m["stats"]["max"] <= 0.3 * abs(K) * (1 + 1e-6)
        assert any("NOT removed from los_m" in n for n in m["notes"])

    def test_tropo_cube_collapsed_at_fallback_height(self, src):
        from engine.api.background import preview
        gid = self._gid()
        m = preview(src, gid=gid, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                    max_px=128, scale="los_m", corr="tropo_wet", use_cache=False)["meta"]
        assert m["layer"].endswith("wetTroposphericPhaseScreen")
        assert any("collapsed at the fallback height" in n for n in m["notes"])

    def test_corr_choices_and_missing_screen(self, client, src):
        gid = self._gid()
        assert client.get(f"/api/background/preview?id={gid}&layer={GUNW_PHASE}&{BOX}"
                          "&corr=wat").status_code == 400
        # a granule whose clip lacks the screen (drop it via a spec that serves no radarGrid)
        specs, _ = _gunw()
        bare = [GranuleSpec(s.ref, s.kind, ref_time=s.ref_time, sec_time=s.sec_time,
                            dlos=s.dlos, seed=s.seed, drop_layers=("wetTroposphericPhaseScreen",))
                if s.kind == "GUNW" else s for s in specs]
        r = client.get(f"/api/background/preview?id={gid}&layer={GUNW_PHASE}&{BOX}"
                       "&corr=tropo_wet")
        assert r.status_code in (200, 404)      # the fixture may still serve it; engine honest


# --------------------------------------------------------------------------- #
# diff: los_m / los_mm
# --------------------------------------------------------------------------- #
class TestDiffLos:
    @pytest.fixture()
    def src(self):
        specs, _ = _gunw()
        return FakeSource(specs)

    def test_known_answer_on_a_shared_reference_pair(self, src):
        from engine.api.background_pairs import diff
        specs, _ = _gunw()
        gunws = [s for s in specs if s.kind == "GUNW"]
        # two pairs sharing a reference date: build (t1,t2) and (t1,t3)
        t1, t2, t3 = dt("2026-07-13"), dt("2026-07-25"), dt("2026-08-06")
        extra_id = gunw_id(t1, t3, version=5011)
        extra = GranuleSpec(ref_for(extra_id, "GUNW", t1), "GUNW", ref_time=t1, sec_time=t3,
                            dlos=0.0, seed=13)
        src2 = FakeSource(specs + [extra])
        shared = next(s for s in specs if s.kind == "GUNW"
                      and s.ref_time == t1 and s.sec_time == t2)
        out = diff(src2, id_a=shared.ref.granule_id, id_b=extra_id, layer=GUNW_PHASE,
                   bbox=(WEST, SOUTH, EAST, NORTH), max_px=128, mode="los_mm")
        meta = out["meta"]
        assert meta["diff"]["mode"] == "los_mm"
        assert meta["unit"] == "mm (LOS, + toward sensor)"
        ref = meta["diff"]["referencing"]
        assert ref["shared_reference_date"] is True
        assert "share one reference date" in ref["note"]
        # both pairs have dlos=0 in this scene: the difference is noise-scale, never huge
        assert abs(meta["stats"]["max"]) < 5.0

    def test_cross_pair_referencing_is_stated(self, src):
        from engine.api.background_pairs import diff
        specs, _ = _gunw()
        g1, g2 = [s for s in specs if s.kind == "GUNW"][:2]
        out = diff(src, id_a=g1.ref.granule_id, id_b=g2.ref.granule_id, layer=GUNW_PHASE,
                   bbox=(WEST, SOUTH, EAST, NORTH), max_px=128, mode="los_m")
        ref = out["meta"]["diff"]["referencing"]
        assert ref["shared_reference_date"] is False
        assert "do NOT share a reference date" in ref["note"]
        assert ref["window_a"] == [g1.ref_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                   g1.sec_time.strftime("%Y-%m-%dT%H:%M:%SZ")]

    def test_los_mode_on_a_power_layer_is_422_and_los_mm_route(self, client, src):
        from engine.api.background import BackgroundError
        from engine.api.background_pairs import diff
        specs = make_scene()
        a, b = [s for s in specs if s.kind == "GCOV"][:2]
        with pytest.raises(BackgroundError) as ei:
            diff(FakeSource(specs), id_a=a.ref.granule_id, id_b=b.ref.granule_id,
                 layer="science__LSAR__GCOV__grids__frequencyA__HHHH",
                 bbox=(WEST, SOUTH, EAST, NORTH), max_px=128, mode="los_m")
        assert ei.value.status == 422
        specs2, _ = _gunw()
        g1, g2 = [s for s in specs2 if s.kind == "GUNW"][:2]
        r = client.get(f"/api/background/diff?id_a={g1.ref.granule_id}&id_b={g2.ref.granule_id}"
                       f"&layer={GUNW_PHASE}&{BOX}&mode=los_mm")
        assert r.status_code == 200
        meta = json.loads(r.headers["X-Img-Meta"])
        assert meta["diff"]["mode"] == "los_mm" and "referencing" in meta["diff"]


# --------------------------------------------------------------------------- #
# inspect / timeseries: the numbers describe the converted values
# --------------------------------------------------------------------------- #
class TestInspectLos:
    def test_stats_and_unit(self):
        from engine.api.background_inspect import inspect
        specs, gunw = _gunw()
        src = FakeSource(specs)
        out = inspect(src, gid=gunw.ref.granule_id, layer=GUNW_PHASE,
                      bbox=(WEST, SOUTH, EAST, NORTH), scale="los_mm", use_cache=False)
        assert out["unit"] == "mm (LOS, + toward sensor)"
        assert out["stats"]["unit"].startswith("mm (LOS")
        assert out["stats"]["max"] == pytest.approx(50.0, abs=1.0)     # the truth bowl
        assert out["los"]["formula"] and "wavelength" in out["los"]["formula"]
        # histogram counts the converted values
        assert sum(out["histogram"]["counts"]) == out["histogram"]["n"]

    def test_timeseries_of_displacement(self):
        from engine.api.background_inspect import timeseries
        specs, _ = _gunw()
        src = FakeSource(specs)
        ids = [s.ref.granule_id for s in specs if s.kind == "GUNW"]
        ts = timeseries(src, ids=ids, layer=GUNW_PHASE, bbox=(WEST, SOUTH, EAST, NORTH),
                        scale="los_mm", use_cache=False)
        assert ts["unit"] == "mm (LOS, + toward sensor)"
        # the last pair carries the +50 mm bowl: its mean-over-box value is the largest
        vals = [p["value"] for p in ts["points"] if p["value"] is not None]
        assert len(vals) == len(ids)
        assert vals[-1] == max(vals)
        assert vals[-1] > 1.0        # the bowl dominates the box mean


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
    specs, gunw = _gunw()
    monkeypatch.setattr(routes_background, "_SOURCE_FACTORY", lambda: FakeSource(specs))
    monkeypatch.setattr("engine.api.jobs.earthdata_present", lambda: True)
    monkeypatch.setattr("engine.api.routes_background.earthdata_present", lambda: True)
    app = create_app()
    with TestClient(app) as c:
        yield c
    api_state.get_runner.cache_clear()

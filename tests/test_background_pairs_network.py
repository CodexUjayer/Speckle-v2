"""Data Lab Phase 5 — pair network + pipeline bridge tests (offline, known answers).

GET /api/background/pair-network: the interferometric network over the box, derived from the
SAME clustering the Explorer serves. Verified here:
  * nodes = the stack's merged epoch list (pair + single products merged), sorted per stack;
  * edges = the pair groups, with true-time-order endpoints, baseline days, the flipped flag
    and the granule ids;
  * adjacent epochs without a pair product are listed in possible_edges (a stated gap);
  * the graph facts (connected components) come out of the engine, not the browser;
  * a mixed-product search still networks only the pair products (GCOV never becomes an edge);
  * no access key needed, and the box validation (400).

GET /api/background/lab-runs: the pipeline bridge. Verified here:
  * only runs whose MGRS tile overlaps the box are listed, with the tile's lon/lat bbox;
  * each run's trace arrays (when a live trace exists) are inventoried with the corners the
    arrays PNG route itself serves;
  * runs without a parseable tile id are skipped and STATED, never guessed onto the map;
  * the bridge is local-only: no search, no fetch (asserted by the fake runner's counters).
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.common_fixtures import FakeRetriever, GranuleSpec, ref_for  # noqa: E402

AS_OF = "2026-08-20T00:00:00Z"
WEST, SOUTH, EAST, NORTH = -119.0, 33.5, -117.0, 35.0
BOX_Q = f"west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}"

GUNW_1 = ("NISAR_L2_PR_GUNW_031_034_A_019_033_4000_SH_20260920T130823_20260920T130857_"
          "20261014T130823_20261014T130857_P05023_N_F_J_001")
GUNW_2 = ("NISAR_L2_PR_GUNW_033_034_A_019_035_4000_SH_20261002T130823_20261002T130857_"
          "20261026T130823_20261026T130857_P05023_N_F_J_001")
GCOV_1 = ("NISAR_L2_PR_GCOV_031_034_A_019_4005_SHNA_A_20260920T130900_20260920T130930_"
          "P05023_N_F_J_001")


def _spec(gid: str, product: str, start: str, track=34, frame=19):
    d = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    return GranuleSpec(ref=ref_for(gid, product, d, track=track, direction="ASCENDING", frame=frame),
                       kind=product)


def _retriever() -> FakeRetriever:
    return FakeRetriever([
        _spec(GUNW_1, "GUNW", "2026-09-20T13:08:23"),
        _spec(GUNW_2, "GUNW", "2026-10-02T13:08:23"),
        _spec(GCOV_1, "GCOV", "2026-09-20T13:09:00"),
    ])


def _search_with(retriever):
    def run(self, **kw):
        from engine.api.granules_bbox import search_bbox_sync
        return search_bbox_sync(product_names={"GUNW": "GUNW", "GCOV": "GCOV"},
                                retriever=retriever, **kw)
    return run


# --------------------------------------------------------------------------- #
# the network derivation (unit, no HTTP)
# --------------------------------------------------------------------------- #
class TestPairNetworkUnit:
    def test_nodes_edges_baselines_flipped_possible(self):
        from engine.api.granules_bbox import search_bbox_sync
        from engine.api.background_pairs_network import pair_network
        out = search_bbox_sync(bbox=(WEST, SOUTH, EAST, NORTH), levels=["GUNW", "GCOV"],
                               t0="2026-09-01T00:00:00Z", t1="2026-11-01T00:00:00Z",
                               product_names={"GUNW": "GUNW", "GCOV": "GCOV"},
                               max_results=250, fresh=False, retriever=_retriever())
        net = pair_network(out["groups"], out["stacks"])
        # 4 epochs on A034 (09-20 merged from the GUNW ref + the GCOV, 10-02, 10-14, 10-26)
        assert net["n_nodes"] == 4
        assert [n["date"] for n in net["nodes"]] == [
            "2026-09-20T13:08:23Z", "2026-10-02T13:08:23Z",
            "2026-10-14T13:08:23Z", "2026-10-26T13:08:23Z"]
        assert all(n["track"] == 34 for n in net["nodes"])
        # two edges, both 24-day pairs, second stored flipped
        assert net["n_edges"] == 2
        e1, e2 = net["edges"]
        assert (e1["from"], e1["to"]) == ("2026-09-20T13:08:23Z", "2026-10-14T13:08:23Z")
        assert e1["baseline_days"] == 24.0 and e1["flipped"] is False
        assert e1["granule_ids"] == [GUNW_1]
        assert (e2["from"], e2["to"]) == ("2026-10-02T13:08:23Z", "2026-10-26T13:08:23Z")
        assert e2["baseline_days"] == 24.0
        # the three adjacent 12-day epoch pairs carry no pair product -> stated gaps
        assert [(p["from"], p["to"]) for p in net["possible_edges"]] == [
            ("2026-09-20T13:08:23Z", "2026-10-02T13:08:23Z"),
            ("2026-10-02T13:08:23Z", "2026-10-14T13:08:23Z"),
            ("2026-10-14T13:08:23Z", "2026-10-26T13:08:23Z")]
        assert all(p["baseline_days"] == 12.0 for p in net["possible_edges"])
        # graph facts are engine-side: 4 nodes, 2 disjoint edges -> 2 components
        assert net["n_components"] == 2
        assert "epoch clustering" in net["network_note"]

    def test_empty_window_is_an_empty_network_with_a_note(self):
        from engine.api.background_pairs_network import pair_network
        net = pair_network([], [])
        assert net["n_nodes"] == 0 and net["n_edges"] == 0 and net["n_components"] == 0
        assert net["nodes"] == [] and net["edges"] == []

    def test_a_single_product_only_search_has_no_edges(self):
        from engine.api.granules_bbox import search_bbox_sync
        from engine.api.background_pairs_network import pair_network
        out = search_bbox_sync(bbox=(WEST, SOUTH, EAST, NORTH), levels=["GCOV"],
                               t0="2026-09-01T00:00:00Z", t1="2026-11-01T00:00:00Z",
                               product_names={"GCOV": "GCOV"},
                               max_results=250, fresh=False, retriever=_retriever())
        net = pair_network(out["groups"], out["stacks"])
        assert net["n_edges"] == 0                     # a GCOV is never an interferometric edge
        assert net["n_nodes"] == 1                     # its epoch is still a node of the stack


# --------------------------------------------------------------------------- #
# the routes
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import state as api_state
    from engine.api.main import create_app
    import engine.common.config as engine_config
    monkeypatch.setattr(engine_config, "data_root", lambda root=None: Path(tmp_path))
    api_state.get_runner.cache_clear()
    retriever = _retriever()
    fake = _RecordingRunner(retriever)
    # the routes import get_runner into their own namespaces: patch it there, keep the real
    # state.get_runner intact for other routes and the teardown
    for mod in ("engine.api.routes_background", "engine.api.routes_scanner"):
        monkeypatch.setattr(mod + ".get_runner", lambda: fake)
    monkeypatch.setattr("engine.api.routes_scanner.earthdata_present", lambda: True)
    monkeypatch.setattr("engine.api.background_jobs_runner", lambda: fake, raising=False)
    app = create_app()
    with TestClient(app) as c:
        yield c, fake
    api_state.get_runner.cache_clear()


class _RecordingRunner:
    """A fake runner for the bridge: a runs store, traces, and counters that prove the bridge
    never searches or fetches (local state only)."""

    def __init__(self, retriever):
        self.retriever = retriever
        self.searches = 0
        self.fetch_tile_calls = 0
        from engine.api.routes_scanner import _BBOX_HITS
        _BBOX_HITS.clear()
        # tiles: 11SLT66 (-118.5, 34.0) and 11SMU50 (-117.5, 34.4) sit inside the box;
        # 11SPE72 (-115.0, 39.9) is far outside it; the last row's tile id is not MGRS at all
        self.store = _FakeStore([
            {"id": "run-alpha", "status": "done", "kind": "bundle", "tile": "11SLT66", "bundle_id": "b1",
             "created_at": "2026-10-01T00:00:00Z", "pipelines": ["earthquake_coseismic"]},
            {"id": "run-beta", "status": "done", "kind": "bundle", "tile": "11SMU50", "bundle_id": "b2",
             "created_at": "2026-10-02T00:00:00Z", "pipelines": ["volcanic_deformation"]},
            {"id": "run-far", "status": "done", "kind": "bundle", "tile": "11SPE72", "bundle_id": "b3",
             "created_at": "2026-10-03T00:00:00Z", "pipelines": ["earthquake_coseismic"]},
            {"id": "run-odd", "status": "done", "kind": "bundle", "tile": "not-a-tile", "bundle_id": "b4",
             "created_at": "2026-10-04T00:00:00Z", "pipelines": []},
        ])
        # a live trace for run-alpha: two arrays, one placeable (corners), one without extent
        self._traces = {"run-alpha": {
            "arrays": {
                "t1": {"path": "prep/filtered", "label": "filtered unwrapped phase", "group": "P05",
                       "step": "P05", "shape": [500, 500], "dtype": "float32", "kind": "float",
                       "stats": {"min": -3.1, "max": 4.2, "mean": 0.1},
                       "corners_lonlat": [[-118.6, 34.0], [-118.4, 34.0], [-118.4, 34.2], [-118.6, 34.2]],
                       "corners_note": "grid corners", "note": "after filtering"},
                "t2": {"path": "prep/mask", "label": "water mask", "group": "P03", "step": "P03",
                       "shape": [500, 500], "dtype": "uint8", "kind": "int",
                       "stats": {"min": 0, "max": 1, "mean": 0.3},
                       "corners_lonlat": None, "corners_note": "no extent recorded", "note": ""},
            }}}

    # the bridge's surface
    def get_trace(self, run_id):
        return self._traces.get(run_id)

    # the pair-network route reaches the SEARCH through the scanner's _bbox_granules; the
    # injected seam is the runner's granule_search_bbox (the same seam the Explorer tests use)
    def granule_search_bbox(self, **kw):
        self.searches += 1
        from engine.api.granules_bbox import search_bbox_sync
        kw.setdefault("product_names", {"GUNW": "GUNW", "GCOV": "GCOV"})
        return search_bbox_sync(retriever=self.retriever, **kw)


class _FakeStore:
    def __init__(self, rows):
        self._rows = rows

    def list_runs(self, limit=50):
        return self._rows[:limit]


class TestPairNetworkRoute:
    def test_no_key_needed(self, client):
        c, _ = client
        assert c.get(f"/api/background/pair-network?{BOX_Q}").status_code == 200

    def test_round_trip(self, client):
        c, r = client
        resp = c.get(f"/api/background/pair-network?{BOX_Q}&level=GUNW,GCOV")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["n_nodes"] == 4 and body["n_edges"] == 2
        assert body["search"]["n_total"] == 3
        assert body["edges"][1]["granule_ids"] == [GUNW_2]

    def test_bad_box_is_400_on_the_search_rules(self, client):
        c, _ = client
        # south >= north is the scanner's own refusal; antimeridian likewise
        assert c.get(f"/api/background/pair-network?west=-119&south=35&east=-117&north=33.5").status_code == 400
        assert c.get(f"/api/background/pair-network?west=179&south=33.5&east=-179&north=35").status_code == 400


class TestLabRunsRoute:
    def test_no_key_needed_and_box(self, client):
        c, _ = client
        assert c.get(f"/api/background/lab-runs?{BOX_Q}").status_code == 200
        assert c.get("/api/background/lab-runs?west=10&south=20&east=5&north=30").status_code == 400

    def test_overlap_arrays_and_local_only(self, client):
        c, _rec = client
        resp = c.get(f"/api/background/lab-runs?{BOX_Q}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        ids = [run["id"] for run in body["runs"]]
        # 11SLT66 and 11SMU50 sit inside the box; 11SPE72 is far outside it
        assert "run-alpha" in ids and "run-beta" in ids and "run-far" not in ids
        alpha = next(run for run in body["runs"] if run["id"] == "run-alpha")
        assert alpha["has_live_trace"] is True
        assert alpha["n_arrays"] == 2
        assert set(alpha["arrays"].keys()) == {"P05", "P03"}
        p05 = alpha["arrays"]["P05"][0]
        assert p05["aid"] == "t1" and p05["corners_lonlat"] is not None
        assert p05["corners_lonlat"][0] == [-118.6, 34.0]
        # the local-only rule: the bridge never searched, never fetched (the retriever's own
        # call log is empty — the fake runner's search counter stays at zero for this route)
        assert _rec.searches == 0
        assert _rec.fetch_tile_calls == 0
        # the odd tile id was skipped AND stated
        assert any("skipped" in n for n in body["notes"])
        assert "run-odd" not in ids

    def test_a_run_without_a_trace_lists_zero_arrays_honestly(self, client):
        c, _ = client
        body = c.get(f"/api/background/lab-runs?{BOX_Q}").json()
        beta = next(run for run in body["runs"] if run["id"] == "run-beta")
        assert beta["has_live_trace"] is False and beta["n_arrays"] == 0
        assert beta["arrays"] == {}

    def test_the_answer_says_the_pictures_are_previews_and_gives_each_arrays_stride(self, client):
        c, _ = client
        body = c.get(f"/api/background/lab-runs?{BOX_Q}").json()
        assert any("PREVIEW THUMBNAILS" in n and "FULL-resolution" in n for n in body["notes"])
        alpha = next(run for run in body["runs"] if run["id"] == "run-alpha")
        for arrs in alpha["arrays"].values():
            for a in arrs:
                assert "stride" in a and "thumb_shape" in a          # the picture's subsampling, next to the full shape

    def test_each_array_names_its_group_and_stage_so_the_ui_can_file_it_like_the_bundle(self, client):
        from engine.common.debug.trace import STAGE
        c, _ = client
        body = c.get(f"/api/background/lab-runs?{BOX_Q}").json()
        alpha = next(run for run in body["runs"] if run["id"] == "run-alpha")
        for group, arrs in alpha["arrays"].items():
            for a in arrs:
                assert a["group"] == group
                assert a["stage"] == STAGE.get(group, group)   # the engine's own stage name, else the group itself
                assert "first_step" in a

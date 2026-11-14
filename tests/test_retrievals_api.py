"""Stage 3 routes. Offline: FakeClient is a labelled TEST FIXTURE that mimics the retrieval
client's shipped interface (search -> refs, fetch_tile -> FetchResult of GranuleClips,
progress_snapshot, cancel_event); no network, no real data. The granule_hook records the
per-granule progress states the monitor thread would see on a real client."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_granules_bbox import _clean_bbox_rate_window, client, data_dir  # noqa: F401,E402

from engine.retrieval.clients.types import FetchResult, GranuleClip  # noqa: E402


class FakeClient:
    """The shipped retriever contract: search / fetch_tile / progress_snapshot / cancel_event.
    `gate` holds the FIRST granule's fetch so a test can observe mid-flight states."""

    def __init__(self, n=6, gate=None, fail=()):
        self.refs = [type("R", (), {"granule_id": f"G{i}", "product": "GCOV",
                                    "start": f"2026-09-{10 + i:02d}T00:00:00",
                                    "stop": f"2026-09-{10 + i:02d}T00:00:30",
                                    "track": 5, "direction": "ASCENDING", "frame": 1,
                                    "url": f"https://example.invalid/G{i}.h5",
                                    "size_bytes": None, "footprint": None, "extra": {}})()
                     for i in range(n)]
        self.gate, self.fail = gate, set(fail)
        self.granule_hook = None
        self.fetch_calls = 0
        self.cancel_event = threading.Event()
        self._states: dict[str, dict] = {}
        self.clips = type("K", (), {"key": staticmethod(lambda gid, bbox, layers: f"key-{gid}")})()

    # ---- the retriever interface -------------------------------------------------------
    def search(self, bbox, t0=None, t1=None, product=None, maturity=None, fresh=False, max_results=None):
        return list(self.refs), False

    def fetch_tile(self, tile, t0=None, t1=None, product=None, layers=None, maturity=None,
                   granules=None, margin_m=None):
        self.fetch_calls += 1
        errors, clips = {}, []
        for g in granules or []:
            if self.cancel_event.is_set():
                self._states[g.granule_id] = {"state": "cancelled", "error": "cancelled before it started"}
                if self.granule_hook:
                    self.granule_hook(g.granule_id, "cancelled", 0.0, "cancelled before it started")
                continue
            self._states[g.granule_id] = {"state": "fetching"}
            if self.granule_hook:
                self.granule_hook(g.granule_id, "fetching", 0.0, "")
            if self.gate is not None:
                self.gate.wait(10)
                self.gate = None                     # only the first granule is gated
            if g.granule_id in self.fail:
                errors[g.granule_id] = "OSError: boom"
                self._states[g.granule_id] = {"state": "failed", "error": "OSError: boom"}
                if self.granule_hook:
                    self.granule_hook(g.granule_id, "failed", 0.1, "OSError: boom")
            else:
                clips.append(GranuleClip(granule=g, bbox=(0, 0, 1, 1), grids={}, source="network"))
                self._states[g.granule_id] = {"state": "stored", "seconds": 0.1, "source": "network"}
                if self.granule_hook:
                    self.granule_hook(g.granule_id, "net", 0.1, "")
        return FetchResult(clips=clips, errors=errors, skipped={})

    def progress_snapshot(self) -> dict:
        return {"granules": {"states": dict(self._states)},
                "network_requests": self.fetch_calls}

    def close(self):
        pass


@pytest.fixture()
def ctl(client, monkeypatch):
    c, d = client
    monkeypatch.setenv("EARTHDATA_TOKEN", "test-token-present")
    monkeypatch.setenv("NISAR_ENABLE_SCANS", "1")
    from engine.api import jobs as api_jobs
    from engine.api import state as api_state
    api_state.get_runner.cache_clear()          # the runner singleton (and its RetrievalManager)
    box = {}
    monkeypatch.setattr(api_jobs, "_default_retriever_factory", lambda: (lambda: box["fake"]))
    yield c, box, d
    api_state.get_runner.cache_clear()


def _wait(c, rid, pred, t=10):
    end = time.time() + t
    while time.time() < end:
        j = c.get(f"/api/retrievals/{rid}").json()
        if pred(j):
            return j
        time.sleep(0.05)
    raise AssertionError(f"timeout; last={j}")


BODY = {"lon": -118.5, "lat": 34.0, "products": ["GCOV"], "lookback_days": 60}


def test_retrieval_runs_to_done_and_writes_a_manifest(ctl):
    c, box, d = ctl
    box["fake"] = FakeClient(n=4, fail={"G2"})
    r = c.post("/api/retrievals", json=BODY)
    assert r.status_code == 202, r.text
    rid = r.json()["id"]
    j = _wait(c, rid, lambda j: j["status"] == "done")
    assert j["totals"]["stored"] == 3 and j["totals"]["failed"] == 1 and j["totals"]["granules"] == 4
    bad = next(g for g in j["granules"] if g["state"] == "failed")
    assert bad["error"] == "OSError: boom"
    assert all(g["clip_key"] for g in j["granules"])
    assert (Path(d) / "retrievals" / rid / "manifest.json").is_file()


def test_caps_keep_the_newest_and_say_so(ctl):
    c, box, _ = ctl
    # the shipped cap for GCOV epochs is max_gcov_epochs; the fake's refs all share one stack,
    # so the cap keeps the NEWEST 2 epochs and flags the cut
    box["fake"] = FakeClient(n=6)
    rid = c.post("/api/retrievals", json={**BODY, "max_gcov_epochs": 2}).json()["id"]
    j = _wait(c, rid, lambda j: j["status"] == "done")
    kept = sorted(g["granule_id"] for g in j["granules"] if g["state"] == "stored")
    assert kept == ["G4", "G5"]                       # exactly the newest two survive the cap
    assert any("epochs_truncated" in f["code"] for f in j["flags"]) or \
           any("newest" in f["message"].lower() for f in j["flags"])


def test_cancel_keeps_finished_and_health_shows_the_retrieval(ctl):
    c, box, _ = ctl
    gate = threading.Event()
    box["fake"] = FakeClient(n=5, gate=gate)
    rid = c.post("/api/retrievals", json=BODY).json()["id"]
    _wait(c, rid, lambda j: j["stage"] == "download")
    busy = c.get("/api/health").json()["busy"]
    assert busy["kind"] == "retrieval" and busy["run_id"] == rid
    assert c.post("/api/retrievals", json=BODY).status_code == 409        # one at a time
    assert c.post(f"/api/retrievals/{rid}/cancel").status_code == 200
    gate.set()                                     # release the in-flight granule
    j = _wait(c, rid, lambda j: j["status"] == "cancelled")
    assert j["totals"]["stored"] == 1 and j["totals"]["skipped"] == 4     # the in-flight one finished + stayed
    assert c.post(f"/api/retrievals/{rid}/cancel").status_code == 409


def test_second_retrieval_gets_a_new_id_and_unknown_ids_404(ctl):
    c, box, _ = ctl
    box["fake"] = FakeClient(n=2)
    a = c.post("/api/retrievals", json=BODY).json()["id"]
    _wait(c, a, lambda j: j["status"] == "done")
    b = c.post("/api/retrievals", json=BODY).json()["id"]
    assert a != b
    # a well-formed but unknown id is a 404; a malformed id is refused with a 400
    assert c.get("/api/retrievals/ret-000000000000").status_code == 404
    assert c.get("/api/retrievals/ret-nope").status_code == 400


def test_bad_input_is_a_400_with_the_reason(ctl):
    c, box, _ = ctl
    box["fake"] = FakeClient()
    assert c.post("/api/retrievals", json={**BODY, "products": ["XYZ"]}).status_code == 400
    assert c.post("/api/retrievals", json={"products": ["GCOV"]}).status_code == 422   # lon/lat required
    assert c.post("/api/retrievals", json={**BODY, "lookback_days": 9999}).status_code == 422  # le=3650

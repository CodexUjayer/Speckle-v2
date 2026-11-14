"""Phase 2 — metadata never queues behind a retrieval; health answers while the worker is busy.

Offline: a FAKE slow job blocks the retrieval worker (a labelled test fixture, not data). The bbox
search runs through the REAL JobRunner.granule_search_bbox (meta lane) with an injected FakeRetriever.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.common_fixtures import FakeRetriever  # noqa: E402
from tests.test_granules_bbox import (  # noqa: E402
    EAST, NORTH, SOUTH, TEST_VECTOR, WEST, _clean_bbox_rate_window, _spec, client, data_dir)  # noqa: F401


@pytest.fixture()
def blocked_worker(client, monkeypatch):
    c, _ = client
    monkeypatch.setenv("EARTHDATA_TOKEN", "test-token-present")
    from engine.api import jobs as api_jobs
    started, release = threading.Event(), threading.Event()

    def blocking_execute(self, *a, **k):          # FIXTURE: a retrieval that blocks for up to 30 s
        started.set()
        release.wait(30)

    monkeypatch.setattr(api_jobs.JobRunner, "_execute", blocking_execute)
    fake = FakeRetriever([_spec(TEST_VECTOR, "GUNW", "2026-09-20T13:08:23", track=34,
                                direction="ASCENDING", frame=19)])
    monkeypatch.setattr(api_jobs, "_default_retriever_factory", lambda: (lambda: fake))
    bundles = c.get("/api/bundles").json()["bundles"]
    r = c.post("/api/runs", json={"bundle_id": bundles[0]["bundle_id"],
                                  "pipelines": ["earthquake_coseismic"], "params": {}})
    assert r.status_code == 200
    assert started.wait(10)
    yield c, r.json()["run_id"]
    release.set()


def test_bbox_search_is_not_queued_behind_a_blocking_retrieval(blocked_worker):
    c, _ = blocked_worker
    t = time.perf_counter()
    r = c.get(f"/api/granules?west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}&level=GUNW")
    dt = time.perf_counter() - t
    assert r.status_code == 200, r.text
    assert dt < 3.0, f"bbox search took {dt:.2f}s while the retrieval worker was blocked"


def test_health_answers_fast_and_names_what_is_busy(blocked_worker):
    c, run_id = blocked_worker
    t = time.perf_counter()
    r = c.get("/api/health")
    dt = time.perf_counter() - t
    assert r.status_code == 200
    assert dt < 0.2, f"/api/health took {dt:.3f}s during a retrieval"
    busy = r.json()["busy"]
    assert busy is not None and busy["run_id"] == run_id
    assert set(busy) == {"kind", "run_id", "step", "started_at"}


def test_health_busy_is_null_when_idle(client):
    c, _ = client
    assert c.get("/api/health").json()["busy"] is None


def test_search_timeout_is_a_json_504_not_a_dropped_connection(client, monkeypatch):
    monkeypatch.setenv("EARTHDATA_TOKEN", "test-token-present")
    monkeypatch.setenv("NISAR_SEARCH_TIMEOUT_S", "1")
    """The shipped bound is INSIDE NisarClient.search (a daemon thread + search.timeout_s), so
    the test drives a real NisarClient whose asf_search import hangs: a 1 s bound raises
    TimeoutError, the meta lane surfaces it, and the route answers a JSON 504 — never a hang and
    never a dropped connection. (The old test injected a sleeping FakeRetriever, which bypasses
    the bound entirely.)"""
    import types

    release = threading.Event()

    class Hang:                      # a fake asf_search module whose search() never answers
        @staticmethod
        def search(**k):
            release.wait(30)

    hang_mod = types.ModuleType("asf_search")
    hang_mod.search = Hang.search
    monkeypatch.setitem(sys.modules, "asf_search", hang_mod)

    from engine.retrieval.clients.nisar_client import NisarClient
    from engine.retrieval.settings import load_settings
    settings = load_settings()
    settings.search["timeout_s"] = 1.0            # the env var's destination, applied directly
    monkeypatch.setattr("engine.api.jobs._default_retriever_factory",
                        lambda: (lambda: NisarClient(settings=settings)))
    c, _ = client
    t = time.perf_counter()
    r = c.get(f"/api/granules?west={WEST}&south={SOUTH}&east={EAST}&north={NORTH}&level=GUNW")
    release.set()
    assert r.status_code == 504, r.text
    assert r.json()["detail"]["ok"] is False
    assert time.perf_counter() - t < 10.0         # answered (504), not dropped

"""ComCat's event LIST has no moment tensor; the pipeline must look it up per event (config: earthquake.mechanism_lookup_max)."""
from __future__ import annotations

import dataclasses

import pytest

from engine.pipelines.earthquake_coseismic import fetch as eq_fetch
from engine.pipelines.earthquake_coseismic.fetch import enrich_mechanisms
from engine.pipelines.earthquake_coseismic.types import EqParams

from .fixtures_eq import make_event, make_provider

PLANES = [(250.0, 80.0, -5.0), (341.0, 85.0, -170.0)]


def _ev(i, mag, has_mech=True, planes=()):
    return dataclasses.replace(make_event(event_id=f"ev{i}", magnitude=mag, nodal_planes=planes), has_mechanism=has_mech)


def _detail(calls, fail=()):
    def fn(event_id):
        calls.append(event_id)
        if event_id in fail:
            return {"event": None, "degraded": True, "error": "ComCat unreachable: boom"}
        return {"event": {"nodal_planes": PLANES}, "degraded": False, "error": None}
    return fn


def test_looks_up_events_largest_first_up_to_the_cap():
    ranked = [(_ev(i, 7.0 - i), 10.0) for i in range(5)]
    calls = []
    params = dataclasses.replace(EqParams(), mechanism_lookup_max=2)
    out, ids, notes = enrich_mechanisms(ranked, params, providers={"event_detail": _detail(calls)})
    assert calls == ["ev0", "ev1"] and ids == ["ev0", "ev1"] and notes == []
    assert out[0][0].nodal_planes == tuple(PLANES) and out[2][0].nodal_planes == ()
    assert [e.id for e, _ in out] == [f"ev{i}" for i in range(5)]       # order untouched


def test_skips_events_the_list_says_have_no_mechanism_or_already_have_planes():
    ranked = [(_ev(0, 6.0, has_mech=False), 1.0), (_ev(1, 5.0, planes=((0.0, 40.0, 90.0),)), 1.0), (_ev(2, 4.5), 1.0)]
    calls = []
    enrich_mechanisms(ranked, EqParams(), providers={"event_detail": _detail(calls)})
    assert calls == ["ev2"]


def test_failed_lookup_is_a_note_not_an_exception():
    calls = []
    out, ids, notes = enrich_mechanisms([(_ev(0, 7.0), 1.0)], EqParams(),
                                        providers={"event_detail": _detail(calls, fail={"ev0"})})
    assert ids == [] and out[0][0].nodal_planes == () and "ev0" in notes[0] and "boom" in notes[0]


def test_lookup_off_with_zero_cap():
    calls = []
    params = dataclasses.replace(EqParams(), mechanism_lookup_max=0)
    enrich_mechanisms([(_ev(0, 7.0), 1.0)], params, providers={"event_detail": _detail(calls)})
    assert calls == []


def test_offline_run_with_injected_events_never_reaches_for_the_network(monkeypatch):
    from engine.retrieval.clients.adapters import r1_comcat
    monkeypatch.setattr(r1_comcat, "fetch_event_detail", lambda *a, **k: pytest.fail("network path used"))
    out, ids, _ = enrich_mechanisms([(_ev(0, 7.0), 1.0)], EqParams(), providers={"events": lambda *a: None})
    assert ids == []
    eq_fetch.set_event_provider(make_provider([]))
    try:
        out, ids, _ = enrich_mechanisms([(_ev(0, 7.0), 1.0)], EqParams(), providers=None)
    finally:
        eq_fetch.reset_event_provider()
    assert ids == []


def test_real_path_uses_the_adapter_detail_call(monkeypatch):
    from engine.retrieval.clients.adapters import r1_comcat
    calls = []
    monkeypatch.setattr(r1_comcat, "fetch_event_detail", _detail(calls))
    out, ids, _ = enrich_mechanisms([(_ev(0, 7.0), 1.0)], EqParams(), providers=None)
    assert calls == ["ev0"] and out[0][0].nodal_planes == tuple(PLANES)


def test_mechanism_lookup_max_is_bounded_and_configurable():
    assert EqParams.from_triggers({"eq_params": {"mechanism_lookup_max": 999}}).mechanism_lookup_max == 40
    assert EqParams.from_triggers({"eq_params": {"mechanism_lookup_max": -3}}).mechanism_lookup_max == 0

"""3.01 earthquake_coseismic — own_fetch: R1 ComCat events (+ R2 ShakeMap note).

The seam (port design, decision 6): `run(bundle, providers=None)` accepts injected providers, so
tests run offline and the API can point runs at alternate sources; production always uses the REAL
adapters — there is no synthetic fallback anywhere. In a spawn-pool worker the module re-imports
fresh, so the module-level seam is None and the live adapter runs.

A failed or empty fetch is a RESULT (EventsResult.degraded / .error), never an exception, and maps
to INSUFFICIENT_EVIDENCE in verdict.py — never to "no event found". Every fetch result carries
provenance (adapter, url/id, retrieved_at, sha256) that flows into PipelineResult.provenance.
"""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from engine.common.result import Source

from .types import EventRecord, EventsResult

_provider = None   # module-level seam (tests / debug); see READINESS.md


def set_event_provider(fn) -> None:
    """Inject an event source: fn(bbox, t0, t1) -> EventsResult."""
    global _provider
    _provider = fn


def reset_event_provider() -> None:
    """Back to the real R1 adapter (also the state in a fresh worker process)."""
    global _provider
    _provider = None


def _event_window(ref_time: str | None, sec_time: str | None, buffer_days: float) -> tuple[str, str]:
    fmt = "%Y-%m-%dT%H:%M:%SZ"

    def _parse(t: str | None, default: datetime) -> datetime:
        if not t:
            return default
        try:
            return datetime.fromisoformat(str(t).replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            return default

    end_default = datetime.now(timezone.utc).replace(tzinfo=None)
    sec = _parse(sec_time, end_default)
    ref = _parse(ref_time, sec - timedelta(days=30))
    start = ref - timedelta(days=buffer_days)
    end = sec + timedelta(days=buffer_days)
    return start.strftime(fmt), end.strftime(fmt)


def _normalize_provider_out(out) -> EventsResult:
    """Providers may return an EventsResult or the adapter's plain dict — both accepted."""
    if isinstance(out, EventsResult):
        return out
    if isinstance(out, dict):
        events = tuple(EventRecord.from_mapping(e) for e in out.get("events", []))
        return EventsResult(events=events, source=out.get("source", "injected-provider"),
                            degraded=bool(out.get("degraded")), error=out.get("error"),
                            provenance=tuple(out.get("provenance") or ()))
    raise TypeError(f"injected events provider returned {type(out).__name__}, expected EventsResult or dict")


def fetch_events(bbox, ref_time: str | None, sec_time: str | None, params,
                 providers: dict | None = None) -> EventsResult:
    """bbox = (min_lon, min_lat, max_lon, max_lat).

    Provider resolution order (port design decision 6):
      1. providers["events"] passed to run()          — per-call injection (tests, API, jobs),
      2. the module-level seam (set_event_provider)   — the historical test seam,
      3. the REAL R1 ComCat adapter (network path).
    """
    from engine.retrieval.clients.adapters import r1_comcat

    t0, t1 = _event_window(ref_time, sec_time, params.event_buffer_days)
    injected = (providers or {}).get("events")
    if injected is not None:
        return _normalize_provider_out(injected(bbox, t0, t1))
    if _provider is not None:
        return _normalize_provider_out(_provider(bbox, t0, t1))

    out = r1_comcat.fetch_events(
        bbox, t0, t1,
        min_magnitude=4.0, limit=200,
    )
    events = tuple(EventRecord.from_mapping(e) for e in out.get("events", []))
    prov = out.get("provenance")
    provenance = (Source(**prov),) if isinstance(prov, dict) else tuple(
        Source(**p) if isinstance(p, dict) else p for p in (prov or ()))
    return EventsResult(events=events, source=out.get("source", "usgs-comcat"),
                        degraded=bool(out.get("degraded")), error=out.get("error"),
                        provenance=provenance)


def enrich_mechanisms(ranked, params, providers: dict | None = None):
    """Fill in the nodal planes of in-window events. -> (new ranked list, looked_up ids, notes).

    ComCat's event LIST carries no moment tensor (those live in the per-event record), so on the real path every
    event arrives without nodal planes and the forward screen cannot run. Here the ranked events (largest first) that
    lack planes, and that the list says DO have a mechanism, are looked up one by one, at most
    params.mechanism_lookup_max of them (config/common.yaml earthquake.mechanism_lookup_max).

    Resolution mirrors fetch_events: providers["event_detail"](event_id) -> fetch_event_detail-shaped dict, else the real
    adapter. When the EVENTS themselves came from an injected provider / the module seam (tests, debug) and no
    event_detail provider was injected, nothing is looked up: an offline run never reaches for the network.
    A failed lookup is a note, never an exception, and the event keeps its (empty) planes.
    """
    detail_fn = (providers or {}).get("event_detail")
    if detail_fn is None:
        if (providers or {}).get("events") is not None or _provider is not None:
            return list(ranked), [], []
        from engine.retrieval.clients.adapters import r1_comcat
        detail_fn = r1_comcat.fetch_event_detail
    budget = max(0, int(params.mechanism_lookup_max))
    out, looked_up, notes = [], [], []
    for ev, dist in ranked:
        if budget > 0 and not ev.nodal_planes and ev.has_mechanism is not False:
            budget -= 1
            try:
                res = detail_fn(ev.id) or {}
            except Exception as exc:                                   # noqa: BLE001 - reported, never raised
                res = {"error": f"{type(exc).__name__}: {exc}"}
            found = (res.get("event") or {}).get("nodal_planes") or ()
            if found:
                ev = dataclasses.replace(ev, nodal_planes=tuple(tuple(float(c) for c in p) for p in found))
                looked_up.append(ev.id)
            elif res.get("error") or res.get("degraded"):
                notes.append(f"moment-tensor lookup for event {ev.id} failed: {res.get('error') or 'provider degraded'}")
        out.append((ev, dist))
    return out, looked_up, notes


def fetch_shakemap_note(best_event_id: str | None, providers: dict | None = None,
                        tile_bbox=None) -> dict | None:
    """R2 ShakeMap extent — corroboration evidence ONLY.

    Absence of a ShakeMap product is a note, never a failure. Returns the adapter's
    NORMALISED result: {"event_id", "available", "bbox", "url", "note", "degraded",
    "error", "coverage"} (coverage present when tile_bbox is given), or None when
    there is nothing to cite. Injected providers get the same normalisation, so the
    verdict code can always render the event_id (never "R2 ShakeMap extent for None").
    """
    if best_event_id is None:
        return None
    injected = (providers or {}).get("shakemap")
    if injected is not None:
        out = injected(best_event_id)
        return _normalise_shakemap(out, best_event_id)
    from engine.retrieval.clients.adapters import r2_shakemap
    try:
        return _normalise_shakemap(
            r2_shakemap.fetch_extent(best_event_id, tile_bbox=tile_bbox), best_event_id)
    except Exception:            # R2 is optional evidence: degrade to a note, never fail the run
        return None


def _normalise_shakemap(out, best_event_id: str) -> dict | None:
    """Guarantee the normalised R2 shape regardless of provider vintage."""
    if not isinstance(out, dict):
        return None
    return {
        "event_id": str(out.get("event_id") or best_event_id),
        "available": bool(out.get("available")),
        "bbox": out.get("bbox"),
        "url": out.get("url"),
        "note": out.get("note", ""),
        "degraded": bool(out.get("degraded")),
        "error": out.get("error"),
        "coverage": out.get("coverage"),
        "provenance": out.get("provenance"),
    }

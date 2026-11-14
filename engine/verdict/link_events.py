"""4.3 link_events — event-level conclusions across tiles and pipelines (Decision 3 of the port).

Event-level conclusions are built HERE, never by one pipeline reading another. A verdict cites the
events it considered in `detail` (e.g. earthquake_coseismic's `detail.decision.best_event_id`,
tsunami_ocean_evidence's `detail.event.id`); the linker groups verdicts by those citations and
produces one record per event: which tiles said what, per pipeline, plus cross-pipeline links
(earthquake evidence + ocean evidence for the SAME event) with the correlated-evidence caveat.
"""
from __future__ import annotations

from collections import defaultdict

SUPPORTING = {"SUPPORTED", "UNCATALOGUED_CANDIDATE", "POSSIBLE"}
# A tile that actually tested the hypothesis (said yes or said no). INSUFFICIENT_EVIDENCE / NO_SIGNAL / ERROR tiles
# did not test it, so they neither support nor count against it.
DECISIVE = SUPPORTING | {"NOT_SUPPORTED"}
# An event is "supporting" for one pipeline when at least one tile supports it AND at least this share of the tiles that
# tested it do. A plain OR over tiles (EQ_AUDIT C2) turns a per-tile false-positive rate p into 1-(1-p)^n for n tiles.
# Heuristic, not calibrated: it only removes the guaranteed-True behaviour of the OR.
MIN_SUPPORT_FRACTION = 0.5


def _event_ids(row: dict) -> list:
    """The event ids a verdict cites (best-event style citations, by name)."""
    detail = row.get("detail") or {}
    ids: list = []
    dec = detail.get("decision") or {}
    if dec.get("best_event_id"):
        ids.append(str(dec["best_event_id"]))
    ev = detail.get("event") or {}
    if isinstance(ev, dict) and ev.get("id"):
        ids.append(str(ev["id"]))
    # forward_screens[] is deliberately NOT cited: it lists every event that was merely screened (EQ_AUDIT C1), so a tile
    # that passed on event A would otherwise make B and C "supporting" too. Only the decision's own event counts.
    seen, out = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def link(rows: list) -> dict:
    """Verdict rows (collected + calibrated) -> {"events": [...], "unlinked": [...]}.

    Each event record: {event_id, pipelines: {name: [{tile, status, tier, raw_p}]}, tiles: [...],
    supporting: bool, any_tile_supporting: bool, tile_counts: {...}, cross_pipeline: [...]}. A tile-level conclusion is NEVER upgraded here: the
    link record aggregates what pipelines said, it does not re-decide.
    """
    by_event: dict = defaultdict(lambda: defaultdict(list))
    tiles_per_event: dict = defaultdict(set)
    unlinked: list = []
    for row in rows:
        ids = _event_ids(row)
        if not ids:
            unlinked.append({"pipeline": row.get("pipeline"), "tile": row.get("tile"),
                             "status": row.get("status")})
            continue
        for eid in ids:
            by_event[eid][row.get("pipeline")].append(
                {"tile": row.get("tile"), "status": row.get("status"),
                 "tier": row.get("tier") or "unknown", "raw_p": row.get("raw_p"),
                 "summary": row.get("summary") or ""})
            tiles_per_event[eid].add(row.get("tile"))

    events = []
    for eid in sorted(by_event):
        pipelines = {name: items for name, items in sorted(by_event[eid].items())}
        counts = {}
        for name, items in pipelines.items():
            n_sup = sum(1 for it in items if it["status"] in SUPPORTING)
            n_dec = sum(1 for it in items if it["status"] in DECISIVE)
            counts[name] = {"tiles_total": len(items), "tiles_tested": n_dec, "tiles_supporting": n_sup,
                            "supports": n_sup >= 1 and n_sup / max(1, n_dec) >= MIN_SUPPORT_FRACTION}
        supporting = any(c["supports"] for c in counts.values())
        any_tile = any(c["tiles_supporting"] >= 1 for c in counts.values())
        names = sorted(pipelines)
        cross = []
        if len(names) > 1:
            cross.append({
                "event_id": eid,
                "pipelines": names,
                "note": ("independent pipelines answered the same event; their agreement is corroboration, "
                         "not independent confirmation when they share the same sensor (e.g. SAR tiles)"),
            })
        events.append({
            "event_id": eid,
            "pipelines": pipelines,
            "tiles": sorted(t for t in tiles_per_event[eid] if t),
            "supporting": supporting,
            "any_tile_supporting": any_tile,          # the old OR, kept visible
            "tile_counts": counts,
            "cross_pipeline": cross,
        })
    return {"events": events, "unlinked": unlinked}


__all__ = ["link", "_event_ids", "SUPPORTING", "DECISIVE", "MIN_SUPPORT_FRACTION"]

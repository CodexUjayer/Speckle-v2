"""Data Lab Phase 5 — the pair network + the pipeline bridge (GET /api/background/pair-network,
GET /api/background/lab-runs).

The Data Lab's last roadmap item: "pair network, pipeline bridge, run arrays as layers".
Both routes are ENGINE-side answers; the UI only draws.

pair-network  Which interferometric pairs exist over the box, as a graph: one node per
              ACQUISITION EPOCH of a stack, one edge per pair product (GUNW/GOFF) that
              connects two epochs. Nodes and edges carry the facts the person needs to choose
              a pair: dates, the temporal baseline, whether the pair is stored flipped, the
              group key and the granule ids. The network is computed from the SAME
              group_acquisitions clustering the Explorer uses (engine/api/granules_bbox) —
              one answer everywhere, no second grouping rule to drift. Missing pairs are
              stated: `possible_edges` lists epoch pairs that exist in the stack's epoch list
              but carry no pair product (a gap in the network, never silently skipped).
              Single-acquisition products (GCOV/GSLC/RSLC) are NOT nodes of the interferometric
              network; their epochs already merged into the stack's epoch list (P01's
              epoch_merge_minutes rule), and each node states which single products cover it.

lab-runs      The pipeline bridge: which hazard-pipeline RUNS overlap this box, and which
              trace ARRAYS they can put on the map. Local state only (the runs store +
              in-memory traces), no Earthdata, no provider bytes — same rule as
              /api/background/overview. Each run's tile (an MGRS id) is turned into its
              lon/lat bbox engine-side (engine/tiling/mgrs) and tested for overlap with the
              asked box; each array entry is the register_trace meta (aid, label, group, step,
              shape, stats, corners) the /runs/{id}/arrays/{aid} PNG route already serves —
              the UI places the image with the engine's corners, exactly like a preview.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .background import BackgroundError

MAX_NODES = 512


def _parse(iso: str | None):
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _days_between(a: str, b: str) -> float | None:
    da, db = _parse(a), _parse(b)
    if da is None or db is None:
        return None
    return round((db - da).total_seconds() / 86400.0, 3)


# --------------------------------------------------------------------------- #
# the pair network
# --------------------------------------------------------------------------- #
def pair_network(groups: list[dict], stacks: list[dict]) -> dict:
    """groups + stacks (the Explorer's own answer for the box) -> the network. Pure engine-side
    derivation: nodes are stack epochs (merged across pair and single products), edges are pair
    groups. Deterministic: nodes sorted by (stack, date); edges sorted by (stack, from, to)."""
    stack_of_key = {s["key"]: s for s in stacks}

    # one node per (stack, epoch) — the epoch list is already the P01-merged list
    nodes: list[dict] = []
    node_of: dict[tuple[str, str], int] = {}
    for s in stacks:
        for epoch in (s.get("epochs") or []):
            if len(nodes) >= MAX_NODES:
                break                      # stated, never a silent truncation
            node_of[(s["key"], epoch)] = len(nodes)
            nodes.append({"stack": s["key"], "date": epoch,
                          "direction": s.get("direction"), "track": s.get("track")})

    edges: list[dict] = []
    seen_edge: set[tuple[str, str, str]] = set()
    unplaced: list[dict] = []
    for g in groups:
        if g.get("kind") != "pair":
            continue
        ref, sec = g.get("ref_time"), g.get("sec_time")
        if not ref or not sec:
            unplaced.append({"group": g.get("key"), "reason": "the group's pair times could not be verified"})
            continue
        a, b = min(ref, sec), max(ref, sec)          # true time order (the flag carries storage order)
        ia = node_of.get((g["stack"], a))
        ib = node_of.get((g["stack"], b))
        if ia is None or ib is None:
            # a pair whose epochs are not in the stack's epoch list cannot happen unless the
            # stack answer and the group answer disagree — stated loudly, never guessed onto a node
            unplaced.append({"group": g.get("key"),
                             "reason": "the pair's epochs are not in the stack's epoch list "
                                       "(group/stack disagreement — reported, not resolved)"})
            continue
        key = (g["stack"], a, b)
        if key in seen_edge:
            continue
        seen_edge.add(key)
        edges.append({
            "stack": g["stack"], "from": a, "to": b,
            "from_node": ia, "to_node": ib,
            "baseline_days": _days_between(a, b),
            "flipped": any("flipped" in f for f in (g.get("flags") or [])),
            "group_key": g.get("key"),
            "granule_ids": list(g.get("granule_ids") or []),
            "n_variants": g.get("n_variants") or 1,
        })

    # which epoch-to-epoch pairs of a stack's OWN epoch list carry no pair product: a gap in
    # the network, stated as possible edges (adjacent epochs only — the network's convention)
    possible: list[dict] = []
    for s in stacks:
        epochs = s.get("epochs") or []
        for a, b in zip(epochs, epochs[1:]):
            if (s["key"], a, b) not in seen_edge:
                possible.append({"stack": s["key"], "from": a, "to": b,
                                 "baseline_days": _days_between(a, b),
                                 "note": "no pair product connects these adjacent epochs in this window"})

    covered = {(e["stack"], e["from"], e["to"]) for e in edges}
    n_components = _count_components(len(nodes), edges)
    return {
        "n_nodes": len(nodes),
        "n_edges": len(edges),
        "nodes": nodes,
        "edges": edges,
        "possible_edges": possible,
        "unplaced": unplaced,
        "n_components": n_components,
        "network_note": ("nodes are stack acquisition epochs (pair and single products merged by "
                         f"the engine's epoch clustering); edges are the pair products over this box; "
                         f"{n_components} connected component(s); adjacent epochs without a pair "
                         "product are listed in possible_edges"),
        "truncated_nodes": len(nodes) >= MAX_NODES,
    }


def _count_components(n_nodes: int, edges: list[dict]) -> int:
    """Union-find over the edge list — presentation-level graph facts stay engine-side too."""
    parent = list(range(n_nodes))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in edges:
        ra, rb = find(e["from_node"]), find(e["to_node"])
        if ra != rb:
            parent[ra] = rb
    return len({find(i) for i in range(n_nodes)}) if n_nodes else 0


# --------------------------------------------------------------------------- #
# the pipeline bridge (local state only)
# --------------------------------------------------------------------------- #
PREVIEW_NOTE = ("these pictures are PREVIEW THUMBNAILS: a plain subsample (every `stride`-th pixel, longest side at most "
                "400 px, never averaged) of each array. The shape and the statistics are those of the FULL-resolution "
                "array. Do not analyse from a picture: load the full-resolution arrays from the bundle "
                "(engine.common.bundle_io.load_bundle) or the live context.")


def lab_runs(runner, bbox: tuple, limit: int = 25) -> dict:
    """The runs whose tile overlaps the box + the trace arrays each can place on the map.
    Local-only: the runs store + in-memory traces; no Earthdata, no provider bytes."""
    from engine.common.debug.trace import STAGE
    from engine.tiling.mgrs import tile_from_id
    west, south, east, north = (float(v) for v in bbox)
    runs_out: list[dict] = []
    skipped_tiles = 0
    for row in runner.store.list_runs(limit):
        tile_id = (row.get("tile") or "").strip()
        try:
            tb = tile_from_id(tile_id).bbox() if tile_id else None
        except Exception:
            tb = None                      # a non-MGRS tile id never breaks the bridge
        if tb is not None and not (tb[0] > east or tb[2] < west or tb[1] > north or tb[3] < south):
            arrays: dict[str, list[dict]] = {}
            trace = runner.get_trace(row["id"])
            if trace:
                for aid, m in (trace.get("arrays") or {}).items():
                    arrays.setdefault(m.get("group") or "ungrouped", []).append({
                        "aid": aid, "path": m.get("path"), "label": m.get("label"),
                        "group": m.get("group"), "stage": STAGE.get(m.get("group") or "", m.get("group")),
                        "step": m.get("step"), "first_step": m.get("first_step"),
                        "shape": m.get("shape"), "dtype": m.get("dtype"),
                        "kind": m.get("kind"), "stats": m.get("stats"),
                        "stride": m.get("stride"), "thumb_shape": m.get("thumb_shape"),
                        "corners_lonlat": m.get("corners_lonlat"),
                        "corners_note": m.get("corners_note"),
                        "note": m.get("note"),
                    })
            runs_out.append({
                "id": row["id"], "status": row.get("status"), "kind": row.get("kind") or "bundle",
                "tile": tile_id, "bundle_id": row.get("bundle_id") or "",
                "created_at": row.get("created_at"),
                "pipelines": list(row.get("pipelines") or []),
                "tile_bbox_lonlat": list(tb) if tb else None,
                "has_live_trace": bool(trace),
                "n_arrays": sum(len(v) for v in arrays.values()),
                "arrays": arrays,
            })
        elif tb is None and tile_id:
            skipped_tiles += 1
    return {
        "ok": True,
        "bbox": [west, south, east, north],
        "runs": runs_out,
        "n_runs": len(runs_out),
        "notes": ([f"runs without a parseable tile id were skipped ({skipped_tiles}) — their place on the map "
                   "is unknown, not guessed"] if skipped_tiles else []) + [
            "trace arrays live in memory and are evicted with the run; arrays listed here carry the "
            "/runs/{id}/arrays/{aid} PNG route's own corners when placed on the map",
            PREVIEW_NOTE],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def validate_box(bbox) -> tuple:
    try:
        west, south, east, north = (float(v) for v in bbox)
    except (TypeError, ValueError):
        raise BackgroundError(400, "the box must be four numbers: west, south, east, north")
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        raise BackgroundError(400, "box corners outside lon [-180,180] / lat [-90,90]")
    if west >= east or south >= north:
        raise BackgroundError(400, "the box needs west < east and south < north "
                                   "(antimeridian boxes must be split)")
    return (west, south, east, north)

"""5 — GET /api/tiles, GET /api/tiles/{id}/verdicts (canonical verdicts from 4.5 + 4.6).

Read order: the Supabase verdict cache FIRST (it survives engine restarts and hosts, and
holds the preset verdicts), then the local verdicts.db — rows present in the cache override
their local twins (same (tile, pipeline, bundle_id) key), local-only rows are kept. If the
cache is unreachable or not configured the endpoints answer from verdicts.db alone: a
Supabase problem never fails a read. The pipeline/compute side is untouched — this is only
where finished verdicts are READ from."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from .state import get_runner

router = APIRouter()

_log = logging.getLogger("engine.api.tiles")


def _cache():
    from engine.verdict.cloud_cache import CloudCache
    cache = CloudCache.from_env()
    return cache if cache.enabled else None


def _cloud_rows(tile: str | None, limit: int) -> list:
    """Cache rows mapped onto the verdicts.db row shape; [] when off/unreachable."""
    cache = _cache()
    if cache is None:
        return []
    try:
        raw = cache.tile_rows(tile) if tile else cache.latest_rows(limit)
    except Exception as ex:  # noqa: BLE001 — best-effort read: fall back to local rows
        _log.warning("supabase cache read failed (%s) — serving verdicts.db only", ex)
        return []
    out = []
    for r in raw:
        row = dict(r)
        # computed_at is the cache's write time; the local store calls it written_at
        row.setdefault("written_at", row.get("computed_at"))
        out.append(row)
    return out


def _merged_rows(tile: str | None, limit: int) -> list:
    """Cloud rows + local rows, deduped on (tile, pipeline, bundle_id) — cloud wins."""
    local: list = []
    runner = get_runner()
    try:
        local = (runner.verdicts.verdicts_for_tile(tile) if tile
                 else runner.verdicts.latest_verdicts(limit=limit * 10))
    except Exception:  # noqa: BLE001 — an empty local store is not an error
        local = []

    def key(r):
        return (r.get("tile") or "?", r.get("pipeline") or "?", r.get("bundle_id") or "")

    merged: dict = {}
    for r in local:
        merged[key(r)] = r
    for r in _cloud_rows(tile, limit):
        merged[key(r)] = r        # a cached verdict IS the finished verdict — it wins
    return list(merged.values())


@router.get("/api/tiles")
def list_tiles(limit: int = 100):
    """Tiles known to the verdict store, with their latest verdict summary."""
    rows = _merged_rows(None, limit)
    by_tile: dict = {}
    for r in rows:
        by_tile.setdefault(r.get("tile") or "?", []).append(r)
    out = []
    for tile in sorted(by_tile):
        verdicts = by_tile[tile]
        out.append({
            "tile": tile,
            "n_verdicts": len(verdicts),
            "latest": [{"pipeline": v.get("pipeline"), "status": v.get("status"),
                        "tier": v.get("tier"), "raw_p": v.get("raw_p"),
                        "written_at": v.get("written_at") or v.get("computed_at")}
                       for v in verdicts[:5]],
        })
    return {"ok": True, "tiles": out[:limit],
            "note": "verdicts served from the Supabase cache (4.6) over verdicts.db (4.5)"}


@router.get("/api/tiles/{tile_id}/verdicts")
def tile_verdicts(tile_id: str):
    """Every stored verdict for one tile (all pipelines, latest write per pipeline/bundle)."""
    verdicts = _merged_rows(tile_id, 1000)
    if not verdicts:
        raise HTTPException(status_code=404, detail=f"no verdicts stored for tile {tile_id!r}")
    return {"ok": True, "tile": tile_id, "verdicts": verdicts}

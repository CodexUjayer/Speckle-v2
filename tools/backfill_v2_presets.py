#!/usr/bin/env python3
"""One-off: push the retired engine-v2 preview's stored verdicts (the preset runs) into the
Supabase verdict cache.

    python tools/backfill_v2_presets.py --dry-run      # list what would be pushed
    python tools/backfill_v2_presets.py                # push (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)

Source is the old preview engine's <data>/verdicts.db (engine-v2's own schema: tables
`verdicts` + `runs`), NOT the repo engine's runs store — that one is backfilled by
tools/backfill_supabase.py. Each old row is mapped onto the repo cache record shape
(engine/verdict/cloud_cache.to_record) and upserted with the engine's own CloudCache,
keeping the same honesty rules: ERROR/PENDING rows are never cached, statuses and numbers
are stored verbatim, the original run time is kept as computed_at, and nothing is recomputed.

Locations (center_lon/... — the 0002 columns) are left null: the old bundles are gone with
the retired engine, and the cache treats a missing location as "listable, not pinnable".
The repo engine's live mirror writes locations for every NEW run.

Default --db points at the sandbox's retired engine-v2 data dir; pass --db explicitly for
any other copy of that database.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.verdict.cloud_cache import CloudCache  # noqa: E402

DEFAULT_DB = Path("/home/z/my-project/mini-services/engine/data/verdicts.db")

# statuses that are not verdicts (same rule as the live mirror's NOT_CACHED)
SKIP_STATUS = {"ERROR", "PENDING", "FAILED", "RUNNING"}


def load_rows(db_path: Path) -> list[dict]:
    """Old `verdicts` rows -> repo verdict-row shape, grouped per old run_id."""
    if not db_path.exists():
        raise SystemExit(f"no engine-v2 verdicts.db at {db_path}")
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    groups: dict[str, list[dict]] = {}
    meta: dict[str, str | None] = {}
    for v in db.execute("SELECT * FROM verdicts ORDER BY written_at"):
        status = (v["status"] or "").upper()
        if status in SKIP_STATUS:
            continue
        detail = json.loads(v["detail_json"] or "{}")
        detail.setdefault("evidence", json.loads(v["evidence_json"] or "[]"))
        detail.setdefault("warnings", json.loads(v["warnings_json"] or "[]"))
        detail["layers"] = json.loads(v["layers_json"] or "{}")
        # the old engine carried the quake context in flat columns; keep it inside detail
        # (provenance) so the cached `result` stays self-describing.
        detail.setdefault("quake", {
            "event_key": v["event_key"], "label": v["quake_label"], "source": v["quake_source"],
            "time": v["quake_time"], "lat": v["quake_lat"], "lon": v["quake_lon"],
            "magnitude": v["quake_magnitude"],
        })
        row = {
            "tile": v["tile"],
            "pipeline": v["pipeline"],
            "bundle_id": v["bundle_id"],
            "epoch": v["epoch"],
            "status": v["status"],
            "tier": v["tier"],
            "raw_p": v["raw_p"],
            "summary": v["summary"] or "",
            "detail": detail,
            # extra context the live rows also carry inside detail
            "as_of": v["as_of"],
            "lookback_days": v["lookback_days"],
        }
        key = v["run_id"] or "legacy"
        when = v["written_at"]
        groups.setdefault(key, []).append(row)
        if when and (key not in meta or (meta[key] or "") < when):
            meta[key] = when
    db.close()
    return [dict(run_id=k, rows=rows, written_at=meta.get(k)) for k, rows in groups.items()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="engine-v2 verdicts.db path")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cache = CloudCache.from_env()
    if not cache.enabled:
        print(f"cache disabled: {cache.disabled_reason}")
        return 1

    groups = load_rows(a.db)
    total = sum(len(g["rows"]) for g in groups)
    print(f"{len(groups)} runs / {total} verdict rows in {a.db}")
    for g in groups:
        for r in g["rows"]:
            print(f"  {r['tile']:>10} {r['pipeline']:<24} {r['status']:<22} tier={r['tier']}")
    if a.dry_run:
        print("dry run — nothing pushed")
        return 0

    written = 0
    failures: list[str] = []
    for g in groups:
        first = g["rows"][0]
        report = cache.write_run(g["rows"], run_id=g["run_id"], bundle_id=first["bundle_id"],
                                 tile=first["tile"], params=None,
                                 computed_at=g.get("written_at"))  # keep the original run time
        written += report.get("written", 0)
        failures.extend(report.get("failed", []))
        if report.get("skipped"):
            for s in report["skipped"]:
                print(f"  skipped: {s}")
    if failures:
        for f in failures:
            print(f"FAILED: {f}")
        return 1
    print(f"pushed {written} verdict rows to {cache.url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

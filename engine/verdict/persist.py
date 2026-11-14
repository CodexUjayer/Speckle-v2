"""4.5 persist — verdicts.db: the ONE store (Decision 1 of the port; Prisma dropped).

Rows: tiles, verdicts (one per pipeline x tile x bundle), events (the 4.3 links). SQLite (rollback journal; WAL opt-in via
NISAR_SQLITE_WAL=1). DB write failures never block the science: callers treat persist as best-effort audit, and
`write_run` reports failures in its return value instead of raising.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from engine.common.sqlite_util import connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tiles(
  tile TEXT PRIMARY KEY,
  last_seen TEXT,
  n_verdicts INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verdicts(
  pipeline TEXT NOT NULL,
  tile TEXT NOT NULL,
  epoch TEXT,
  bundle_id TEXT,
  status TEXT NOT NULL,
  tier TEXT,
  raw_p REAL,
  confidence REAL,
  summary TEXT,
  evidence TEXT,                      -- JSON list
  layers TEXT,                        -- JSON list
  provenance TEXT,                    -- JSON list
  warnings TEXT,                      -- JSON list
  detail TEXT,                        -- JSON object (incl. layer payloads)
  run_id TEXT,
  written_at TEXT,
  PRIMARY KEY(pipeline, tile, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_verdicts_tile ON verdicts(tile);
CREATE INDEX IF NOT EXISTS idx_verdicts_status ON verdicts(status);
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT NOT NULL,
  link TEXT NOT NULL,                 -- JSON object (4.3 record)
  written_at TEXT,
  PRIMARY KEY(event_id)
);
"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class VerdictStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = connect(self.path, check_same_thread=False)
        self._db.executescript(_SCHEMA)
        self._db.commit()

    # ------------------------------------------------------------------ writes
    def write_run(self, rows: list, run_id: str | None = None, links: list | None = None) -> dict:
        """Persist calibrated verdict rows (+ optional 4.3 event links). Best-effort: each row and
        link is committed on its own, so one bad row neither rolls back the others nor stops the
        rest of the batch from being tried; failures are counted and returned, never raised.

        `written` only counts rows that actually landed in the database (previously it was
        incremented before the commit, so a later failure in the same batch rolled everything
        back via one shared transaction while `written` still reported the earlier rows)."""
        written, failed = 0, []
        for row in rows:
            # NULL never equals NULL for SQLite's uniqueness/ON CONFLICT matching, so a NULL
            # bundle_id defeats the (pipeline, tile, bundle_id) primary key: repeated writes of
            # the same "no bundle" row would never match an existing one and would each insert a
            # new row instead of upserting it. Use "" as the no-bundle sentinel so they match.
            bundle_id = row.get("bundle_id")
            bundle_id = bundle_id if bundle_id is not None else ""
            tile = row.get("tile")
            try:
                self._db.execute(
                    "INSERT INTO verdicts(pipeline, tile, epoch, bundle_id, status, tier, raw_p, confidence,"
                    " summary, evidence, layers, provenance, warnings, detail, run_id, written_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(pipeline, tile, bundle_id) DO UPDATE SET"
                    " status=excluded.status, tier=excluded.tier, raw_p=excluded.raw_p,"
                    " confidence=excluded.confidence, summary=excluded.summary, evidence=excluded.evidence,"
                    " layers=excluded.layers, provenance=excluded.provenance, warnings=excluded.warnings,"
                    " detail=excluded.detail, run_id=excluded.run_id, written_at=excluded.written_at",
                    (row.get("pipeline"), tile, row.get("epoch"), bundle_id,
                     row.get("status"), row.get("tier"), row.get("raw_p"), row.get("confidence"),
                     row.get("summary"), json.dumps(row.get("evidence") or []),
                     json.dumps(row.get("layers") or []), json.dumps(row.get("provenance") or []),
                     json.dumps(row.get("warnings") or []), json.dumps(row.get("detail") or {}),
                     run_id, _utcnow()))
                # n_verdicts is re-derived from an actual count rather than incremented, so
                # re-running the same (pipeline, tile, bundle_id) verdict (an upsert, not a new
                # row) does not inflate it.
                n = self._db.execute(
                    "SELECT COUNT(*) FROM verdicts WHERE tile=?", (tile,)).fetchone()[0]
                self._db.execute(
                    "INSERT INTO tiles(tile, last_seen, n_verdicts) VALUES(?,?,?)"
                    " ON CONFLICT(tile) DO UPDATE SET last_seen=excluded.last_seen,"
                    " n_verdicts=excluded.n_verdicts",
                    (tile, _utcnow(), n))
                self._db.commit()
                written += 1
            except Exception as ex:
                failed.append(f"{type(ex).__name__}: {ex}")
                try:
                    self._db.rollback()
                except Exception:
                    pass
        for link in links or []:
            try:
                self._db.execute(
                    "INSERT INTO events(event_id, link, written_at) VALUES(?,?,?)"
                    " ON CONFLICT(event_id) DO UPDATE SET link=excluded.link, written_at=excluded.written_at",
                    (link.get("event_id"), json.dumps(link), _utcnow()))
                self._db.commit()
            except Exception as ex:
                failed.append(f"{type(ex).__name__}: {ex}")
                try:
                    self._db.rollback()
                except Exception:
                    pass
        return {"written": written, "failed": failed}

    # ------------------------------------------------------------------ reads
    def verdicts_for_tile(self, tile: str) -> list:
        cur = self._db.execute(
            "SELECT pipeline, tile, status, tier, raw_p, confidence, summary, evidence, warnings, detail,"
            " run_id, written_at FROM verdicts WHERE tile=? ORDER BY written_at DESC", (tile,))
        return [self._row_dict(c) for c in cur.fetchall()]

    def latest_verdicts(self, limit: int = 100) -> list:
        cur = self._db.execute(
            "SELECT pipeline, tile, status, tier, raw_p, confidence, summary, evidence, warnings, detail,"
            " run_id, written_at FROM verdicts ORDER BY written_at DESC LIMIT ?", (int(limit),))
        return [self._row_dict(c) for c in cur.fetchall()]

    def events(self) -> list:
        cur = self._db.execute("SELECT event_id, link, written_at FROM events ORDER BY written_at DESC")
        out = []
        for eid, link, written in cur.fetchall():
            try:
                out.append({"event_id": eid, "link": json.loads(link), "written_at": written})
            except ValueError:
                continue
        return out

    @staticmethod
    def _row_dict(c) -> dict:
        def _j(v, default):
            try:
                return json.loads(v) if v else default
            except ValueError:
                return default
        return {"pipeline": c[0], "tile": c[1], "status": c[2], "tier": c[3], "raw_p": c[4],
                "confidence": c[5], "summary": c[6], "evidence": _j(c[7], []),
                "warnings": _j(c[8], []), "detail": _j(c[9], {}), "run_id": c[10],
                "written_at": c[11]}

    def close(self):
        self._db.close()


__all__ = ["VerdictStore"]

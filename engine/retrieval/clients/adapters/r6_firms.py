"""R6 - NASA FIRMS active fires (VIIRS 375 m), area API: /api/area/csv/{MAP_KEY}/{SOURCE}/{w,s,e,n}/{DAY_RANGE}/{DATE}.

Used to separate fire loss from clearing. DAY_RANGE is capped at 5 per request (the area page's current limit), so a
window is split into 5-day requests. Recent days come from the *_NRT product, older days from *_SP (standard
processing); days in the overlap are asked of both and de-duplicated. Key: FIRMS_MAP_KEY (free, e-mail only).
STATUS: URL shape and CSV columns follow the published API; parser tested on a documented-shape CSV; the live path
was not exercised in the authoring sandbox. A non-CSV reply (invalid key, quota) is a degraded result with the text.

    fetch_fires(bbox, t0, t1) -> {"source", "fires": [{lat, lon, date, time, confidence, frp, satellite, daynight}],
                                   "degraded", "error", "provenance"}
"""
from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timedelta, timezone

from . import _http

BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
NRT, SP = "VIIRS_SNPP_NRT", "VIIRS_SNPP_SP"
CHUNK_DAYS = 5
CACHE_TTL_S = 3600.0


def parse_csv(text: str) -> list:
    rdr = csv.DictReader(io.StringIO(text))
    if not rdr.fieldnames or "latitude" not in rdr.fieldnames:
        raise ValueError(text.strip().splitlines()[0][:160] if text.strip() else "empty reply")
    out = []
    for r in rdr:
        try:
            out.append({"lat": float(r["latitude"]), "lon": float(r["longitude"]), "date": r["acq_date"],
                        "time": str(r.get("acq_time") or "").zfill(4), "confidence": (r.get("confidence") or "").strip(),
                        "frp": float(r["frp"]) if r.get("frp") not in (None, "") else None,
                        "satellite": r.get("satellite") or "", "daynight": r.get("daynight") or ""})
        except (KeyError, ValueError):
            continue
    return out


def _sources(chunk_end: datetime, now: datetime) -> tuple:
    age = (now - chunk_end).days
    if age < 45:
        return (NRT,)
    if age < 100:
        return (NRT, SP)
    return (SP,)


def fetch_fires(bbox, t0: str, t1: str, *, map_key: str | None = None, timeout_s: float | None = None,
                now: datetime | None = None) -> dict:
    key = map_key or os.environ.get("FIRMS_MAP_KEY")
    src = "nasa-firms-viirs-snpp"
    if not key:
        return {"source": src, "fires": [], "degraded": True,
                "error": "no FIRMS MAP_KEY (set FIRMS_MAP_KEY; free at firms.modaps.eosdis.nasa.gov/api/map_key)", "provenance": None}
    now = now or datetime.now(timezone.utc)
    start = datetime.strptime(t0[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = datetime.strptime(t1[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    w, s, e, n = (float(v) for v in bbox)
    area = f"{w:.4f},{s:.4f},{e:.4f},{n:.4f}"
    seen, fires, errors, n_req, sha = set(), [], [], 0, None
    d = start
    while d <= end:
        days = min(CHUNK_DAYS, (end - d).days + 1)
        for source in _sources(d + timedelta(days=days - 1), now):
            url = f"{BASE}/{key}/{source}/{area}/{days}/{d:%Y-%m-%d}"
            ck = _http.key_of("r6", source, area, d.date(), days)
            hit = _http.cache_get("r6_firms", ck, CACHE_TTL_S)
            n_req += 1
            try:
                if hit is not None:
                    rows = hit
                else:
                    raw, sha = _http.request(url, timeout_s=timeout_s or 30.0)
                    rows = parse_csv(raw.decode("utf-8", "replace"))
                    _http.cache_put("r6_firms", ck, rows)
            except (_http.FetchError, ValueError) as ex:
                errors.append(f"{source} {d:%Y-%m-%d}: {str(ex).replace(key, '***')}")
                continue
            for r in rows:
                k = (round(r["lat"], 4), round(r["lon"], 4), r["date"], r["time"])
                if k not in seen:
                    seen.add(k)
                    fires.append(r)
        d += timedelta(days=days)
    failed_all = bool(errors) and not fires and len(errors) >= n_req
    return {"source": src, "fires": fires, "degraded": failed_all,
            "error": ("; ".join(errors[:3]) + (f" (+{len(errors) - 3} more)" if len(errors) > 3 else "")) if errors else None,
            "partial": bool(errors) and not failed_all, "provenance": _http.provenance("r6_firms", f"{BASE}/<MAP_KEY>/*/{area}", sha)}

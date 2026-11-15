"""R7 - Global Forest Watch integrated deforestation alerts (GLAD-L + GLAD-S2 + RADD), via the GFW Data API.

STATUS: written from the published API contract (https://data-api.globalforestwatch.org, POST
/dataset/gfw_integrated_alerts/latest/query/json with header x-api-key and body {"sql", "geometry"}; confidence is
"low" | "nominal" | "high" (| "highest"), fields gfw_integrated_alerts__date / __confidence / __intensity). The parser is
tested on payloads shaped like the documented response; the LIVE network path was NOT exercised where this was written
(no network). A key is required: create one at globalforestwatch.org and set GFW_API_KEY.

    fetch_alerts(bbox, t0, t1) -> {"source", "alerts": [{lon, lat, date, confidence, rank, intensity}], "degraded", "error",
                                    "provenance"}
Failures are results (degraded=True + error), never exceptions and never an empty "no alerts".
"""
from __future__ import annotations

import json
import os

from . import _http

API = "https://data-api.globalforestwatch.org"
DATASET = "gfw_integrated_alerts"
CONF_RANK = {"low": 0, "nominal": 1, "high": 2, "highest": 3}
CACHE_TTL_S = 3600.0
MAX_ROWS = 50_000


def _polygon(bbox) -> dict:
    w, s, e, n = (float(v) for v in bbox)
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def _sql(table: str, t0: str, t1: str) -> str:
    return ("SELECT longitude, latitude, gfw_integrated_alerts__date, gfw_integrated_alerts__intensity, "
            f"gfw_integrated_alerts__confidence FROM {table} WHERE gfw_integrated_alerts__date >= '{t0[:10]}' "
            f"AND gfw_integrated_alerts__date <= '{t1[:10]}'")


def parse_rows(payload: dict) -> list:
    """Documented response -> alert dicts. Rows that miss a coordinate or a date are dropped (and counted by the caller)."""
    out = []
    for r in (payload or {}).get("data") or []:
        try:
            lon, lat = float(r["longitude"]), float(r["latitude"])
            date = str(r["gfw_integrated_alerts__date"])[:10]
        except (KeyError, TypeError, ValueError):
            continue
        conf = str(r.get("gfw_integrated_alerts__confidence") or "").lower()
        inten = r.get("gfw_integrated_alerts__intensity")
        out.append({"lon": lon, "lat": lat, "date": date, "confidence": conf or "unknown",
                    "rank": CONF_RANK.get(conf, -1), "intensity": float(inten) if inten is not None else None})
    return out


def fetch_alerts(bbox, t0: str, t1: str, *, api_key: str | None = None, timeout_s: float | None = None) -> dict:
    key = api_key or os.environ.get("GFW_API_KEY")
    src = "gfw-integrated-alerts"
    if not key:
        return {"source": src, "alerts": [], "degraded": True,
                "error": "no GFW API key (set GFW_API_KEY; free at globalforestwatch.org)", "provenance": None}
    url = f"{API}/dataset/{DATASET}/latest/query/json"
    ck = _http.key_of("r7", tuple(round(float(v), 5) for v in bbox), t0[:10], t1[:10])
    hit = _http.cache_get("r7_gfw_alerts", ck, CACHE_TTL_S)
    if hit is not None:
        return {**hit, "source": src + " (cache)"}
    last_err = None
    for table in ("results", "data"):        # the docs show both table names; the first that the API accepts wins
        body = json.dumps({"sql": _sql(table, t0, t1), "geometry": _polygon(bbox)}).encode()
        try:
            raw, sha = _http.request(url, method="POST", body=body, timeout_s=timeout_s or 30.0,
                                     headers={"x-api-key": key, "Content-Type": "application/json"})
            payload = json.loads(raw.decode("utf-8"))
        except _http.FetchError as ex:
            last_err = str(ex)
            if ex.status in (400, 422):
                continue
            break
        except json.JSONDecodeError as ex:
            last_err = f"GFW returned malformed JSON: {ex}"
            break
        if payload.get("status") not in (None, "success"):
            last_err = f"GFW status {payload.get('status')!r}"
            break
        rows = parse_rows(payload)
        out = {"source": src, "alerts": rows[:MAX_ROWS], "degraded": False, "error": None,
               "truncated": len(rows) > MAX_ROWS, "provenance": _http.provenance("r7_gfw_alerts", url, sha)}
        _http.cache_put("r7_gfw_alerts", ck, out)
        return out
    return {"source": src, "alerts": [], "degraded": True, "error": last_err or "GFW query failed",
            "provenance": _http.provenance("r7_gfw_alerts", url)}

"""S4 - Hansen / UMD annual tree-cover loss (loss year), via the GFW Data API (dataset umd_tree_cover_loss).

Used for ONE question: was this patch already cleared in an earlier year (an old clearing re-detected, regrowth, or a
mapped-forest error) rather than lost during the SAR window? Per-polygon loss area by year.
STATUS: written from the published API contract (field umd_tree_cover_loss__year, area__ha); parser tested on a
documented-shape payload; live path not exercised in the authoring sandbox. Key: GFW_API_KEY.

    fetch_loss_by_year(polygons) -> {"source", "results": {id: {year: ha}}, "degraded", "error", "provenance"}
polygons = [(id, (w, s, e, n)), ...]; at most `max_queries` are asked (one request each).
"""
from __future__ import annotations

import json
import os

from . import _http

API = "https://data-api.globalforestwatch.org"
DATASET = "umd_tree_cover_loss"
SQL = ("SELECT umd_tree_cover_loss__year, SUM(area__ha) AS loss_ha FROM data WHERE umd_tree_cover_loss__year > 0 "
       "GROUP BY umd_tree_cover_loss__year")


def parse_rows(payload: dict) -> dict:
    out: dict = {}
    for r in (payload or {}).get("data") or []:
        try:
            out[int(r["umd_tree_cover_loss__year"])] = float(r["loss_ha"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def fetch_loss_by_year(polygons, *, api_key: str | None = None, max_queries: int = 5, timeout_s: float | None = None) -> dict:
    key = api_key or os.environ.get("GFW_API_KEY")
    src = "umd-tree-cover-loss"
    if not key:
        return {"source": src, "results": {}, "degraded": True,
                "error": "no GFW API key (set GFW_API_KEY; free at globalforestwatch.org)", "provenance": None}
    url = f"{API}/dataset/{DATASET}/latest/query/json"
    results, errors, sha = {}, [], None
    for pid, bbox in list(polygons)[: max(0, int(max_queries))]:
        w, s, e, n = (float(v) for v in bbox)
        geom = {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}
        ck = _http.key_of("s4", round(w, 5), round(s, 5), round(e, 5), round(n, 5))
        hit = _http.cache_get("s4_tree_loss", ck, 7 * 86400.0)
        if hit is not None:
            results[pid] = {int(k): v for k, v in hit.items()}
            continue
        try:
            raw, sha = _http.request(url, method="POST", body=json.dumps({"sql": SQL, "geometry": geom}).encode(),
                                     timeout_s=timeout_s or 30.0,
                                     headers={"x-api-key": key, "Content-Type": "application/json"})
            parsed = parse_rows(json.loads(raw.decode("utf-8")))
        except (_http.FetchError, json.JSONDecodeError) as ex:
            errors.append(f"{pid}: {ex}")
            continue
        results[pid] = parsed
        _http.cache_put("s4_tree_loss", ck, {str(k): v for k, v in parsed.items()})
    return {"source": src, "results": results, "degraded": bool(errors) and not results,
            "error": "; ".join(errors) or None, "provenance": _http.provenance("s4_tree_loss", url, sha)}

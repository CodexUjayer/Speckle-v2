"""R10 - NOAA IBTrACS v04r01 best tracks (last 3 years list CSV) near a point, for storm / windthrow attribution.

File: https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/
      ibtracs.last3years.list.v04r01.csv   (row 2 holds units; ISO_TIME 'YYYY-MM-DD HH:MM:SS'; LAT, LON; WMO_WIND, USA_WIND kt;
      USA_R34_* nmi). Best-track data lags real time by weeks to months: a very recent storm may be missing, which the
      result says (`lag_note`) - absence here is NOT proof that no storm passed.
STATUS: columns follow the v04r01 column documentation; parser tested on a documented-shape CSV; live download not
exercised in the authoring sandbox. The file is tens of MB: it is streamed once, filtered, and the filtered result cached.

    fetch_tracks(lat, lon, t0, t1, max_distance_km) -> {"source", "points": [{sid, name, time, lat, lon, wind_kt, r34_nmi}],
                                                         "degraded", "error", "lag_note", "provenance"}
"""
from __future__ import annotations

import csv
import io
import math

from . import _http

URL = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/"
       "ibtracs.last3years.list.v04r01.csv")
LAG_NOTE = "IBTrACS best tracks lag real time; a storm in the last weeks may be missing."


def _f(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def _hav(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def parse_csv(text: str, lat: float, lon: float, t0: str, t1: str, max_distance_km: float) -> list:
    rdr = csv.DictReader(io.StringIO(text))
    out = []
    for r in rdr:
        t = (r.get("ISO_TIME") or "").strip()
        if not t or t.startswith("ISO") or not t[:4].isdigit():       # the units row
            continue
        iso = t.replace(" ", "T")[:19]
        if not (t0[:10] <= iso[:10] <= t1[:10]):
            continue
        la, lo = _f(r.get("LAT")), _f(r.get("LON"))
        if la is None or lo is None or _hav(lat, lon, la, lo) > max_distance_km:
            continue
        wind = _f(r.get("USA_WIND")) or _f(r.get("WMO_WIND"))
        r34 = [v for v in (_f(r.get(f"USA_R34_{q}")) for q in ("NE", "SE", "SW", "NW")) if v is not None]
        out.append({"sid": r.get("SID", ""), "name": (r.get("NAME") or "").strip(), "time": iso + "Z", "lat": la, "lon": lo,
                    "wind_kt": wind, "r34_nmi": max(r34) if r34 else None,
                    "distance_km": round(_hav(lat, lon, la, lo), 1)})
    return out


def fetch_tracks(lat: float, lon: float, t0: str, t1: str, max_distance_km: float = 300.0, *,
                 timeout_s: float | None = None) -> dict:
    src = "noaa-ibtracs-v04r01-last3years"
    ck = _http.key_of("r10", round(lat, 2), round(lon, 2), t0[:10], t1[:10], max_distance_km)
    hit = _http.cache_get("r10_ibtracs", ck, 12 * 3600.0)
    if hit is not None:
        return {**hit, "source": src + " (cache)"}
    try:
        raw, sha = _http.request(URL, timeout_s=timeout_s or 120.0)
        pts = parse_csv(raw.decode("utf-8", "replace"), lat, lon, t0, t1, max_distance_km)
    except _http.FetchError as ex:
        return {"source": src, "points": [], "degraded": True, "error": str(ex), "lag_note": LAG_NOTE,
                "provenance": _http.provenance("r10_ibtracs", URL)}
    out = {"source": src, "points": pts, "degraded": False, "error": None, "lag_note": LAG_NOTE,
           "provenance": _http.provenance("r10_ibtracs", URL, sha)}
    _http.cache_put("r10_ibtracs", ck, out)
    return out

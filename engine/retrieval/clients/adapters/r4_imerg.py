"""R4 - GPM IMERG daily rainfall (Late Run, V07B, 0.1 deg) from NASA GES DISC OPeNDAP, for the grid cell under a point.

Used to flag SAR epochs that follow rain (L-band HV of dense forest can rise by more than 2 dB after heavy rain).
Per day: one DDS request (to read the dimension order) and one ASCII request for a single cell:
  https://gpm1.gesdisc.eosdis.nasa.gov/opendap/GPM_L3/GPM_3IMERGDL.07/{YYYY}/{MM}/3B-DAY-L.MS.MRG.3IMERG.{YYYYMMDD}-S000000-E235959.V07B.nc4
Auth: Earthdata token as a Bearer header (EARTHDATA_TOKEN, the same one the NISAR client uses).
STATUS: URL/file naming and the `precipitation` (mm/day) variable are verified against the GES DISC catalogue; the DDS parse
and ASCII parse are tested on documented-shape text; the live path was NOT exercised in the authoring sandbox.

    fetch_daily(lat, lon, days=["YYYY-MM-DD", ...]) -> {"source", "daily_mm": {date: mm or None}, "degraded", "error", "provenance"}
A day that cannot be read is None (unknown), never 0 mm.
"""
from __future__ import annotations

import math
import os
import re

from . import _http

BASE = "https://gpm1.gesdisc.eosdis.nasa.gov/opendap/GPM_L3/GPM_3IMERGDL.07"
RES = 0.1
FILL_BELOW = -999.0
_DIM = re.compile(r"precipitation\s*\[([^\]]+)\]")


def day_url(day: str) -> str:
    y, m, d = day[:4], day[5:7], day[8:10]
    return f"{BASE}/{y}/{m}/3B-DAY-L.MS.MRG.3IMERG.{y}{m}{d}-S000000-E235959.V07B.nc4"


def parse_dds_order(dds: str):
    """'Float32 precipitation[time = 1][lon = 3600][lat = 1800]' -> ['time', 'lon', 'lat'] (None if not found)."""
    m = re.search(r"precipitation((?:\s*\[[^\]]+\])+)", dds)
    if not m:
        return None
    return [re.sub(r"\s*=.*", "", part).strip() for part in re.findall(r"\[([^\]]+)\]", m.group(1))]


def cell_index(lat: float, lon: float) -> tuple:
    return int(math.floor((lon + 180.0) / RES)), int(math.floor((lat + 90.0) / RES))


def parse_ascii_value(text: str):
    """Last numeric token of the data line(s); fill values (< -999) -> None."""
    vals = []
    for line in text.splitlines():
        if line.lower().startswith(("dataset", "<", "error")) or not line.strip():
            continue
        tok = line.split(",")[-1].strip()
        try:
            vals.append(float(tok))
        except ValueError:
            continue
    if not vals:
        return None
    v = vals[-1]
    return None if (not math.isfinite(v) or v < FILL_BELOW) else v


def fetch_daily(lat: float, lon: float, days, *, token: str | None = None, timeout_s: float | None = None) -> dict:
    tok = token or os.environ.get("EARTHDATA_TOKEN")
    src = "gpm-imerg-late-daily-v07"
    days = sorted({str(d)[:10] for d in days})
    if not tok:
        return {"source": src, "daily_mm": {d: None for d in days}, "degraded": True,
                "error": "no Earthdata token (set EARTHDATA_TOKEN)", "provenance": None}
    ix, iy = cell_index(lat, lon)
    hdr = {"Authorization": f"Bearer {tok}"}
    out, errors, sha, order = {}, [], None, None
    for d in days:
        ck = _http.key_of("r4", d, ix, iy)
        hit = _http.cache_get("r4_imerg", ck, 6 * 3600.0)
        if hit is not None:
            out[d] = hit.get("mm")
            continue
        url = day_url(d)
        try:
            if order is None:
                raw, _ = _http.request(url + ".dds", headers=hdr, timeout_s=timeout_s or 30.0)
                order = parse_dds_order(raw.decode("utf-8", "replace"))
                if not order or sorted(order) != ["lat", "lon", "time"]:
                    raise _http.FetchError(f"unexpected IMERG dimensions {order}")
            idx = {"time": "[0:0]", "lon": f"[{ix}:{ix}]", "lat": f"[{iy}:{iy}]"}
            q = "precipitation" + "".join(idx[n] for n in order)
            raw, sha = _http.request(f"{url}.ascii?{q}", headers=hdr, timeout_s=timeout_s or 30.0)
            mm = parse_ascii_value(raw.decode("utf-8", "replace"))
        except _http.FetchError as ex:
            errors.append(f"{d}: {ex}")
            out[d] = None
            continue
        out[d] = mm
        if mm is not None:
            _http.cache_put("r4_imerg", ck, {"mm": mm})
    known = sum(v is not None for v in out.values())
    return {"source": src, "daily_mm": out, "degraded": bool(days) and known == 0,
            "error": "; ".join(errors[:3]) or None, "provenance": _http.provenance("r4_imerg", BASE, sha)}

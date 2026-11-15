"""Shared geography helpers: epicentre projection into a tile's CRS, great-circle distances.

pyproj replaces the app's Snyder-series utm.ts (already a retrieval dependency). Two behaviours are
kept from the port spec and are honesty guards, not conveniences:
  * epicentres near a UTM zone edge are still projected into the TILE's zone (the tile fixes the CRS);
  * a non-UTM grid EPSG (polar-stereographic granules) REFUSES the forward model with an explicit
    reason rather than misplacing it.
"""
from __future__ import annotations

import math

import numpy as np

EARTH_RADIUS_KM = 6371.0088

_UTM_RANGES = ((32601, 32660), (32701, 32760))       # WGS84 north / south zones


def epsg_is_utm(epsg: int) -> bool:
    try:
        e = int(epsg)
    except (TypeError, ValueError):
        return False
    return any(lo <= e <= hi for lo, hi in _UTM_RANGES)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km (spherical Earth, R = 6371.0088)."""
    rad = math.pi / 180.0
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = (math.sin(dlat / 2.0) ** 2
         + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlon / 2.0) ** 2)
    return 2.0 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def project_epicentre(lat: float, lon: float, epsg: int) -> tuple[float, float] | dict:
    """lat/lon (WGS84) -> the grid's projected CRS, metres.

    Returns (x, y) or {"error": reason}. A non-UTM EPSG is an explicit skip, never a wrong answer:
    the forward model would place the fault kilometres away and the consistency screen would measure
    the misplacement, not the signal.
    """
    if not epsg_is_utm(epsg):
        return {"error": (
            f"grid EPSG {epsg} is not WGS84 UTM; the forward model only supports UTM grids "
            "(polar-stereographic granules would need a different projection — refusing "
            "rather than misplacing the model)")}
    try:
        from pyproj import Transformer
        tr = Transformer.from_crs(4326, int(epsg), always_xy=True)
        x, y = tr.transform(float(lon), float(lat))
        return (float(x), float(y))
    except Exception as ex:  # pragma: no cover - projection should not fail for UTM
        return {"error": f"projection failed: {ex}"}


def en_offsets_m(ref_lat, ref_lon, lat, lon):
    """Local-metre (east, north) offsets of lat/lon point(s) relative to a reference (spherical).

    Accepts scalars or arrays (numpy-vectorized); returns matching (east, north).

    The longitude difference is wrapped to (-180, 180] so points on opposite sides of the
    antimeridian still resolve to the short way around (e.g. 179 -> -179 is +2 degrees of
    longitude, not -358)."""
    mean_lat = np.radians((np.asarray(ref_lat, dtype=np.float64) + np.asarray(lat, dtype=np.float64)) / 2.0)
    dlon_deg = np.asarray(lon, dtype=np.float64) - np.asarray(ref_lon, dtype=np.float64)
    dlon_deg = ((dlon_deg + 180.0) % 360.0) - 180.0
    east = np.radians(dlon_deg) * EARTH_RADIUS_KM * 1000.0 * np.cos(mean_lat)
    north = np.radians(np.asarray(lat, dtype=np.float64) - np.asarray(ref_lat, dtype=np.float64)) \
        * EARTH_RADIUS_KM * 1000.0
    if east.ndim == 0:
        return float(east), float(north)
    return east, north


def azimuth_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Azimuth (degrees clockwise from north) from point A to point B on the sphere."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x))


# --------------------------------------------------------------------------- #
# WGS84 <-> UTM without pyproj (Krueger n-series, Karney 2011; sub-millimetre inside a zone).
# pipelines may import engine.lib but not the chain, so the pipeline-side projection lives here. The chain's own copy
# (engine/common/_geo.py) is pinned against this one by tests/test_lib_geo_utm.py.
# --------------------------------------------------------------------------- #
_F = 1.0 / 298.257223563
_N = _F / (2.0 - _F)
_K0 = 0.9996
_AA = 6378137.0 / (1 + _N) * (1 + _N ** 2 / 4 + _N ** 4 / 64 + _N ** 6 / 256)
_ALPHA = (_N / 2 - 2 * _N ** 2 / 3 + 5 * _N ** 3 / 16 + 41 * _N ** 4 / 180,
          13 * _N ** 2 / 48 - 3 * _N ** 3 / 5 + 557 * _N ** 4 / 1440,
          61 * _N ** 3 / 240 - 103 * _N ** 4 / 140,
          49561 * _N ** 4 / 161280)
_BETA = (_N / 2 - 2 * _N ** 2 / 3 + 37 * _N ** 3 / 96 - _N ** 4 / 360,
         _N ** 2 / 48 + _N ** 3 / 15 - 437 * _N ** 4 / 1440,
         17 * _N ** 3 / 480 - 37 * _N ** 4 / 840,
         4397 * _N ** 4 / 161280)
_DELTA = (2 * _N - 2 * _N ** 2 / 3 - 2 * _N ** 3 + 116 * _N ** 4 / 45,
          7 * _N ** 2 / 3 - 8 * _N ** 3 / 5 - 227 * _N ** 4 / 45,
          56 * _N ** 3 / 15 - 136 * _N ** 4 / 35,
          4279 * _N ** 4 / 630)


def _utm_zone_north(epsg: int) -> tuple[int, bool]:
    e = int(epsg)
    if 32601 <= e <= 32660:
        return e - 32600, True
    if 32701 <= e <= 32760:
        return e - 32700, False
    raise ValueError(f"EPSG:{epsg} is not WGS84 UTM")


def utm_to_lonlat(x, y, epsg: int):
    """Projected metres (WGS84 UTM, EPSG 326xx/327xx) -> (lon, lat) degrees. Vectorised; raises ValueError for other CRSs."""
    zone, north = _utm_zone_north(epsg)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    eta_p = (x - 500000.0) / (_K0 * _AA)
    xi_p = (y - (0.0 if north else 10000000.0)) / (_K0 * _AA)
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, b in enumerate(_BETA, start=1):
        xi = xi - b * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta - b * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    chi = np.arcsin(np.sin(xi) / np.cosh(eta))
    phi = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        phi = phi + d * np.sin(2 * j * chi)
    lam = np.arctan2(np.sinh(eta), np.cos(xi))
    return np.degrees(lam) + ((zone - 1) * 6 - 180 + 3), np.degrees(phi)


def lonlat_to_utm(lon, lat, epsg: int):
    """(lon, lat) degrees -> projected metres in the WGS84 UTM zone of `epsg` (the tile fixes the zone)."""
    zone, north = _utm_zone_north(epsg)
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    phi = np.radians(lat)
    lam = (np.radians(lon) - lon0 + np.pi) % (2 * np.pi) - np.pi
    e = 2 * math.sqrt(_N) / (1 + _N)
    sp = np.sin(phi)
    t = np.sinh(np.arctanh(sp) - e * np.arctanh(e * sp))
    xi_p = np.arctan2(t, np.cos(lam))
    eta_p = np.arctanh(np.sin(lam) / np.sqrt(1 + t * t))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi = xi + a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta + a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    return 500000.0 + _K0 * _AA * eta, _K0 * _AA * xi + (0.0 if north else 10000000.0)


__all__ = ["epsg_is_utm", "haversine_km", "project_epicentre", "en_offsets_m", "azimuth_deg",
           "EARTH_RADIUS_KM", "utm_to_lonlat", "lonlat_to_utm"]

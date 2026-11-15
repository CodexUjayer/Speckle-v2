"""Synthetic L-band forest scene with KNOWN deforestation truth, pushed through the REAL P01..P13 chain.

The repo's own GCOV fixture has no time-varying truth, so this subclasses FakeRetriever and swaps in GCOV layers (HHHH, HVHV)
built from the truth below. Everything else (clip -> grids -> baselines -> masks -> bundle) is the production code path.

World (tile-relative metres, tile 10 km, 12-day epochs from 2026-07-01, 10 epochs: e0..e9):
  forest      x < 5 km (the ancillary writer makes x >= 5 km grass on a 25 deg slope); HV -14 dB, HH -8 dB, static texture
  river       x ~ 2 km (water occurrence 100: excluded)
  moisture    e3 (+1.2 HV / +0.5 HH, inside the reference window) and e7 (+1.8 / +0.7): tile-wide rain
  P1  large clearing        400x300 m  12 ha   onset e5   HV -3.0 HH -1.0
  P2  early-stage clearing  200x200 m   4 ha   onset e5   e5-e7: HH +1.5 HV -0.3 ; e8+: HV -3.0 HH +0.3
  P3  road                 1000x30 m    3 ha   onset e6   HV -3.0
  P4  small clearing        100x100 m   1 ha   onset e4   HV -3.5 (first testable epoch)
  P5  tiny                    40x40 m 0.16 ha  onset e5   (below the 0.5 ha minimum)
  P6  fire                  300x250 m 7.5 ha   onset e6   HV -2.5 HH -1.5   (FIRMS detections injected)
  P7  windthrow blob       ~ 5 ha irregular    onset e7   HV -2.2 HH -0.5   (storm track injected)
  P8  last-epoch only       200x200 m   4 ha   e9 only    HV -3.0  (cannot be confirmed: series ends)
  P9  pre-cleared          500x400 m  20 ha   whole series HV -21 (already non-forest at the start)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

import numpy as np

from common_fixtures import FakeRetriever, GeomSpec, GranuleSpec, default_tile, dt, gcov_id, make_scene, ref_for, write_ancillary
from engine.common import build_scene_bundle
from engine.common.ancillary import DirectoryAncillary
from engine.retrieval.clients.types import GridClip

START = "2026-07-01"
AS_OF = "2026-10-20T00:00:00Z"
HV0, HH0, HV_NF, HH_NF = -14.0, -8.0, -21.0, -14.0
MOISTURE = {3: (1.2, 0.5), 7: (1.8, 0.7)}

RECTS = {"P1": (600, 1000, 7000, 7300), "P2": (2600, 2800, 8000, 8200), "P3": (3000, 4000, 5000, 5030), "P4": (3300, 3400, 2000, 2100),
         "P5": (700, 740, 2000, 2040), "P6": (3500, 3800, 8500, 8750), "P8": (4000, 4200, 6500, 6700), "P9": (400, 900, 4200, 4600)}
BLOB = (1200.0, 3500.0, 140.0)


def _blob(xr, yr):
    cx, cy, r = BLOB
    ang = np.arctan2(yr - cy, xr - cx)
    rad = r * (1 + 0.35 * np.sin(3 * ang + 0.7) + 0.25 * np.sin(5 * ang + 2.0))
    return np.hypot(xr - cx, yr - cy) < rad


def masks(xr, yr) -> dict:
    out = {k: (xr >= a) & (xr < b) & (yr >= c) & (yr < d) for k, (a, b, c, d) in RECTS.items()}
    out["P7"] = _blob(xr, yr)
    return out


def _texture(xr, yr):
    return (0.35 * np.sin(xr / 410.0 + 0.3) * np.cos(yr / 530.0 + 1.1) + 0.25 * np.sin((xr + yr) / 290.0 + 2.0)
            + 0.20 * np.cos(xr / 150.0 - yr / 210.0)).astype(np.float32)


def levels(e: int, xr, yr, moisture=MOISTURE, features=True):
    m = masks(xr, yr)
    if not features:
        m = {k: np.zeros_like(v) for k, v in m.items()}
    forest = xr < 5000
    tex = _texture(xr, yr)
    hv = np.where(forest, HV0 + tex, HV_NF + 0.3 * tex).astype(np.float32)
    hh = np.where(forest, HH0 + 0.6 * tex, HH_NF + 0.3 * tex).astype(np.float32)

    def put(mask, dhv, dhh):
        nonlocal hv, hh
        hv = np.where(mask, hv + dhv, hv)
        hh = np.where(mask, hh + dhh, hh)
    if e in moisture:
        dv, dh = moisture[e]
        hv = np.where(forest, hv + dv, hv)
        hh = np.where(forest, hh + dh, hh)
    if e >= 5:
        put(m["P1"], -3.0, -1.0)
    if 5 <= e <= 7:
        put(m["P2"], -0.3, 1.5)
    if e >= 8:
        put(m["P2"], -3.0, 0.3)
    if e >= 6:
        put(m["P3"], -3.0, -0.5)
        put(m["P6"], -2.5, -1.5)
    if e >= 4:
        put(m["P4"], -3.5, -1.0)
    if e >= 5:
        put(m["P5"], -3.0, -1.0)
    if e >= 7:
        put(m["P7"], -2.2, -0.5)
    if e == 9:
        put(m["P8"], -3.0, -0.5)
    hv = np.where(m["P9"], HV_NF + 0.3 * tex + (moisture.get(e, (0, 0))[0] if e in moisture else 0) * 0.0, hv)
    hh = np.where(m["P9"], HH_NF + 0.3 * tex, hh)
    return hv, hh


class ForestRetriever(FakeRetriever):
    def __init__(self, specs, tile, start=START, moisture=MOISTURE, looks=25, hide_pol=None, features=True):
        super().__init__(specs)
        self.tile, self.t_start, self.moisture, self.looks, self.hide_pol, self.features = tile, dt(start), moisture, looks, hide_pol, features

    def fetch_tile(self, tile, t0=None, t1=None, product=None, layers=None, maturity=None, granules=None, margin_m=None):
        res = super().fetch_tile(tile, t0, t1, product, layers, maturity, granules, margin_m)
        if product != "GCOV":
            return res
        for clip in res.clips:
            spec = self.specs[clip.granule.granule_id]
            e = round((spec.time - self.t_start).days / 12)
            for gk, g in clip.grids.items():
                X, Y = np.meshgrid(np.asarray(g.x) - tile.e0, np.asarray(g.y) - tile.n0)
                hv, hh = levels(e, X, Y, self.moisture, self.features)
                rng = np.random.default_rng(5000 + 7 * e + int(spec.seed))
                new = dict(g.layers)
                for k in list(new):
                    if k.endswith("__HVHV"):
                        new[k] = (10 ** (hv / 10) * rng.gamma(self.looks, 1 / self.looks, hv.shape)).astype(np.float32)
                    elif k.endswith("__HHHH"):
                        new[k] = (10 ** (hh / 10) * rng.gamma(self.looks, 1 / self.looks, hh.shape)).astype(np.float32)
                if self.hide_pol:
                    new = {k: v for k, v in new.items() if not k.endswith(f"__{self.hide_pol}")}
                clip.grids[gk] = GridClip(g.grid, g.epsg, g.x, g.y, g.extras, new, g.units)
        return res


def epoch_time(e: int):
    return dt(START) + timedelta(days=12 * e)


def build_forest_bundle(root, *, n_epochs=10, pairs=(), moisture=MOISTURE, triggers=None, event_window=None, active_codes=None, extra_specs=None,
                        looks=25, hide_pol=None, water_frac_north=0.0, as_of=AS_OF, landcover=True, context=True, track=5, direction="A", features=True,
                        second_stack=False):
    tile = default_tile()
    specs = make_scene(tile, n_epochs=n_epochs, event=False, pairs=pairs, start=START, dlos=0.0, track=track, direction=direction) + (extra_specs or [])
    if second_stack:      # a descending track, passes 5 days after the ascending ones (its own 12-day cycle)
        specs += make_scene(tile, n_epochs=n_epochs, event=False, pairs=(), start="2026-07-06", dlos=0.0, track=track + 1, direction="D",
                               geom=GeomSpec(heading_deg=190.0, look="right"))
    anc = write_ancillary(root, tile, water_frac_north=water_frac_north, landcover=landcover, context=context)
    r = ForestRetriever(specs, tile, moisture=moisture, looks=looks, hide_pol=hide_pol, features=features)
    b = build_scene_bundle(tile, r, as_of=as_of, ancillary=DirectoryAncillary(anc), active_codes=active_codes, event_window=event_window, triggers=triggers)
    return b


def truth_masks_on(bundle) -> dict:
    g = bundle.grids.g20
    rs, cs = g.core_slices()
    tile = default_tile()
    X, Y = np.meshgrid(np.asarray(g.x)[cs] - tile.e0, np.asarray(g.y)[rs] - tile.n0)
    return masks(X, Y)


def providers(bundle, *, fires=True, tracks=True, alerts=True, rain=None, loss=None):
    """Injected R6/R10/R7/R4/S4 sources consistent with the truth. A value of None drops that provider (-> 'not provided')."""
    tile = default_tile()
    from engine.lib.geo import utm_to_lonlat

    def ll(xr, yr):
        lon, lat = utm_to_lonlat(tile.e0 + np.asarray(xr, float), tile.n0 + np.asarray(yr, float), tile.epsg)
        return [float(v) for v in np.atleast_1d(lon)], [float(v) for v in np.atleast_1d(lat)]
    out = {}
    if fires:
        pts = [(3650, 8620), (3700, 8560), (3600, 8700)]
        f_lon, f_lat = ll([p[0] for p in pts], [p[1] for p in pts])
        fire_rows = [{"lat": la, "lon": lo, "date": "2026-09-09", "time": "0530", "confidence": "n", "frp": 12.0, "satellite": "N", "daynight": "N"}
                     for lo, la in zip(f_lon, f_lat)]
        out["fires"] = lambda bbox, t0, t1, rows=fire_rows: {"source": "test-firms", "fires": rows, "degraded": False, "error": None,
                                                             "provenance": {"adapter": "test", "url_or_id": "firms"}}
    elif fires is False:
        out["fires"] = lambda bbox, t0, t1: {"source": "test-firms", "fires": [], "degraded": False, "error": None}
    if tracks:
        lon_c, lat_c = tile.e0 + 5000, tile.n0 + 5000
        la0 = float(ll([5000], [5000])[1][0])
        out["tracks"] = lambda la, lo, t0, t1, mx: {"source": "test-ibtracs", "points": [
            {"sid": "S1", "name": "TEST", "time": "2026-09-18T12:00:00Z", "lat": la0 + 1.0, "lon": lo, "wind_kt": 80.0, "r34_nmi": 120.0, "distance_km": 110.0}],
            "degraded": False, "error": None, "lag_note": "test", "provenance": {"adapter": "test", "url_or_id": "ibtracs"}}
    elif tracks is False:
        out["tracks"] = lambda la, lo, t0, t1, mx: {"source": "test-ibtracs", "points": [], "degraded": False, "error": None, "lag_note": "test"}
    if alerts:
        rng = np.random.default_rng(3)
        rows = []
        for name, date in (("P1", "2026-09-05"), ("P2", "2026-09-10"), ("P3", "2026-09-20"), ("P6", "2026-09-18")):
            a, b, c, d = RECTS[name]
            xs, ys = rng.uniform(a, b, 40), rng.uniform(c, d, 40)
            lon, lat = ll(xs, ys)
            rows += [{"lon": lo, "lat": la, "date": date, "confidence": "high", "rank": 2, "intensity": 3.0} for lo, la in zip(lon, lat)]
        xs, ys = rng.uniform(1500, 1700, 25), rng.uniform(1000, 1200, 25)         # alerts where this pipeline sees nothing
        lon, lat = ll(xs, ys)
        rows += [{"lon": lo, "lat": la, "date": "2026-09-15", "confidence": "nominal", "rank": 1, "intensity": 1.0} for lo, la in zip(lon, lat)]
        out["alerts"] = lambda bbox, t0, t1: {"source": "test-r7", "alerts": rows, "degraded": False, "error": None, "provenance": {"adapter": "test", "url_or_id": "r7"}}
    elif alerts is False:
        out["alerts"] = lambda bbox, t0, t1: {"source": "test-r7", "alerts": [], "degraded": False, "error": None}
    if rain is not None:
        out["rain"] = rain
    if loss is not None:
        out["loss"] = loss
    return out

"""3.08 deforestation - pipeline-only helpers (numpy/scipy; no chain, no other pipeline)."""
from __future__ import annotations

import base64  # noqa: F401  (kept for parity with sibling pipelines' payload helpers)
from datetime import datetime, timezone

import numpy as np
from scipy import ndimage as ndi

from engine.lib import geo as _geo
from engine.lib.layer_payload import encode_layer  # re-exported: the ONE payload contract

MAD_SIGMA = 1.4826
FOUR8 = np.ones((3, 3), dtype=bool)


def parse_time(s) -> datetime:
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    s = str(s).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def nanmedian0(a: np.ndarray, axis=0) -> np.ndarray:
    """nanmedian without the all-NaN warning."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(a, axis=axis)


def robust_sigma(a: np.ndarray, axis=0, med: np.ndarray | None = None) -> np.ndarray:
    m = nanmedian0(a, axis) if med is None else med
    return MAD_SIGMA * nanmedian0(np.abs(a - np.expand_dims(m, axis)), axis)


def label8(mask: np.ndarray) -> tuple:
    return ndi.label(mask, structure=FOUR8)


def majority(mask: np.ndarray, size: int) -> np.ndarray:
    """Keep a True pixel only when at least half of its size x size window is True (removes speckle-sized noise);
    never adds pixels."""
    if size <= 1:
        return mask.astype(bool)
    frac = ndi.uniform_filter(mask.astype(np.float32), size=size, mode="constant")
    return mask.astype(bool) & (frac >= 0.5 - 1e-6)


def patch_shape(m: np.ndarray, pixel_m: float) -> dict:
    """Shape of one patch from its boolean crop: area, rectangularity, elongation, width, compactness."""
    ys, xs = np.nonzero(m)
    n = int(ys.size)
    h, w = (int(ys.max() - ys.min() + 1), int(xs.max() - xs.min() + 1)) if n else (0, 0)
    perim = int(np.sum(m & ~ndi.binary_erosion(m, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], bool), border_value=0)))
    if n >= 3:
        c = np.cov(np.vstack([xs, ys]).astype(np.float64))
        ev = np.sort(np.clip(np.linalg.eigvalsh(c), 1e-9, None))
        elong = float(np.sqrt(ev[1] / ev[0]))
        width_m = float(4.0 * np.sqrt(ev[0]) * pixel_m)
    else:
        elong, width_m = 1.0, float(pixel_m)
    return {"area_px": n, "bbox_px": (int(ys.min()), int(xs.min()), int(ys.max()) + 1, int(xs.max()) + 1) if n else (0, 0, 0, 0),
            "rectangularity": float(n / (h * w)) if h * w else 0.0, "elongation": elong, "width_m": width_m,
            "compactness": float(4.0 * np.pi * n / (perim * perim)) if perim else 0.0}


def block_sum(a: np.ndarray, cell_px: int) -> np.ndarray:
    """Sum over cell_px x cell_px blocks (edge blocks are partial), -> (ceil(H/c), ceil(W/c))."""
    H, W = a.shape
    ph, pw = (-H) % cell_px, (-W) % cell_px
    b = np.pad(a.astype(np.float64), ((0, ph), (0, pw)))
    return b.reshape(b.shape[0] // cell_px, cell_px, b.shape[1] // cell_px, cell_px).sum(axis=(1, 3))


def expand_blocks(c: np.ndarray, cell_px: int, shape: tuple) -> np.ndarray:
    return np.kron(c, np.ones((cell_px, cell_px)))[: shape[0], : shape[1]]


def px_lonlat(rows, cols, x: np.ndarray, y: np.ndarray, epsg: int):
    """Pixel (row, col) (floats allowed, pixel-centre indices) -> (lon, lat) through the grid's own axes."""
    rows = np.asarray(rows, dtype=np.float64)
    cols = np.asarray(cols, dtype=np.float64)
    xs = np.interp(cols, np.arange(x.size), x)
    ys = np.interp(rows, np.arange(y.size), y)
    return _geo.utm_to_lonlat(xs, ys, epsg)


def core_bounds_lonlat(x: np.ndarray, y: np.ndarray, epsg: int, pixel_m: float) -> list:
    """[W, S, E, N] of the pixel EDGES of the cropped grid (what a map image source needs). Corners are projected, so
    the rectangle is the axis-aligned geographic hull of the tile."""
    xs = np.array([x[0] - pixel_m / 2, x[-1] + pixel_m / 2, x[0] - pixel_m / 2, x[-1] + pixel_m / 2])
    ys = np.array([y[0] + pixel_m / 2, y[0] + pixel_m / 2, y[-1] - pixel_m / 2, y[-1] - pixel_m / 2])
    lon, lat = _geo.utm_to_lonlat(xs, ys, epsg)
    return [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]


def points_to_pixels(lon, lat, x: np.ndarray, y: np.ndarray, epsg: int, pixel_m: float):
    """lon/lat -> (row, col, inside) on the cropped grid; `inside` False for points outside the tile proper."""
    px, py = _geo.lonlat_to_utm(lon, lat, epsg)
    col = np.floor((px - (x[0] - pixel_m / 2)) / pixel_m).astype(np.int64)
    row = np.floor(((y[0] + pixel_m / 2) - py) / pixel_m).astype(np.int64)
    inside = (row >= 0) & (row < y.size) & (col >= 0) & (col < x.size)
    return row, col, inside

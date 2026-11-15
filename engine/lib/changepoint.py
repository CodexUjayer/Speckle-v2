"""Sequential change detection kernels for (E, ...) time series — Page's CUSUM and persistence rules.

Generic and pipeline-agnostic (deforestation, land_subsidence and permafrost_thaw may all use it): plain numbers in,
plain arrays out, no bundle, no pipeline types. Everything is vectorised over the trailing axes; the only Python loop
runs over the time axis (E is small: tens of epochs).

Page's tabular CUSUM (Page 1955; Taylor 2000 for the usage in environmental series)
    S_t = max(0, S_{t-1} + d_t - k)         d_t = -z_t  (direction "down")   or   +z_t  (direction "up")
    alarm at the first t with S_t > h        onset = first epoch of the run of S > 0 that led to the alarm
z is a standardised residual (x - reference) / sigma, so k and h are in sigma units: k = half the shift you want to catch,
h the decision interval (larger h = fewer false alarms, later alarms). A NaN epoch is "no observation": S is carried
unchanged, it neither accumulates nor resets.
"""
from __future__ import annotations

import numpy as np


def page_cusum(z: np.ndarray, k: float = 0.5, h: float = 4.0, direction: str = "down") -> dict:
    """-> {"S": (E, ...) float32, "alarm": (...) int16 (-1 = none), "onset": (...) int16 (-1 = none), "peak": (...) float32}."""
    if direction not in ("down", "up"):
        raise ValueError(f"direction must be 'down' or 'up', got {direction!r}")
    z = np.asarray(z, dtype=np.float64)
    sign = -1.0 if direction == "down" else 1.0
    E = z.shape[0]
    shp = z.shape[1:]
    S = np.zeros(shp)
    run_start = np.full(shp, -1, dtype=np.int32)
    alarm = np.full(shp, -1, dtype=np.int32)
    onset = np.full(shp, -1, dtype=np.int32)
    out = np.zeros(z.shape, dtype=np.float32)
    for t in range(E):
        d = sign * z[t]
        seen = np.isfinite(d)
        new = np.where(seen, np.maximum(0.0, S + np.where(seen, d, 0.0) - k), S)
        started = seen & (S <= 0.0) & (new > 0.0)
        run_start = np.where(started, t, run_start)
        run_start = np.where(seen & (new <= 0.0), -1, run_start)
        S = new
        fire = (S > h) & (alarm < 0)
        alarm = np.where(fire, t, alarm)
        onset = np.where(fire, run_start, onset)
        out[t] = S
    return {"S": out, "alarm": alarm.astype(np.int16), "onset": onset.astype(np.int16),
            "peak": out.max(axis=0) if E else np.zeros(shp, np.float32)}


def first_true_from(mask: np.ndarray, start: np.ndarray) -> np.ndarray:
    """First epoch t >= start (per pixel) where mask[t] is True; -1 when none or start < 0. mask is (E, ...)."""
    mask = np.asarray(mask, dtype=bool)
    start = np.asarray(start)
    out = np.full(start.shape, -1, dtype=np.int32)
    for t in range(mask.shape[0] - 1, -1, -1):          # walk backwards: the earliest hit wins
        out = np.where(mask[t] & (start >= 0) & (t >= start), t, out)
    return out


def persistence(shifted: np.ndarray, usable: np.ndarray, onset: np.ndarray) -> dict:
    """Count consecutive shifted epochs from `onset` on, looking only at *usable* epochs.

    shifted (E, ...) bool   the epoch shows the post-change level
    usable  (E, ...) bool   the epoch can testify (valid data and not flagged as rain/moisture affected). An unusable
                            epoch is neutral: it neither adds to the count nor breaks the run.
    onset   (...)    int    first epoch of the change (-1 = none)

    -> {"count": consecutive usable shifted epochs from onset, "broken": a usable un-shifted epoch ended the run,
        "n_usable_after": usable epochs at or after onset}
    """
    shifted = np.asarray(shifted, dtype=bool)
    usable = np.asarray(usable, dtype=bool)
    onset = np.asarray(onset)
    shp = onset.shape
    count = np.zeros(shp, dtype=np.int16)
    broken = np.zeros(shp, dtype=bool)
    n_after = np.zeros(shp, dtype=np.int16)
    for t in range(shifted.shape[0]):
        live = (onset >= 0) & (t >= onset) & usable[t]
        n_after = n_after + live.astype(np.int16)
        hit = live & ~broken & shifted[t]
        count = count + hit.astype(np.int16)
        broken = broken | (live & ~shifted[t])
    return {"count": count, "broken": broken, "n_usable_after": n_after}


__all__ = ["page_cusum", "first_true_from", "persistence"]

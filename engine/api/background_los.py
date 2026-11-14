"""Data Lab Phase 3 — unwrapped phase -> line-of-sight metres, with explicit referencing.

The same conversion the hazard pipelines use (engine/common/p06_phase_to_los.py), offered per
granule in the Lab, on RAW phase inside the engine — the UI never converts:

    los_m = sign * phase_sign * wavelength / (4 pi) * unwrappedPhase

  * `sign` is -1 for a pair the product stores secondary-BEFORE-reference (the id's two date
    pairs are swapped; engine/common/p01_granule_resolution.py marks these `flipped`), so the
    answer always reads "displacement of the LATER date relative to the EARLIER one";
  * `phase_sign` (-1 in config) is the ref*conj(sec) convention of the NISAR ATBD (JPL D-95677);
  * the wavelength (0.2384 m, L-band) and the sign live in engine/common/config.py RadarCfg
    because the clip carries no HDF5 attributes — the preview metadata states both, every time.

Honesty rules:
  * the preview of the raw phase keeps `scale=auto` (radians, diverging map): LOS is a separate
    choice (scale=los_m | los_mm) so no one can mistake a phase picture for metres;
  * a correction diagnostic (?corr=iono|tropo_hydrostatic|tropo_wet|solid_earth_tide) renders
    the SAME conversion on the product's own correction screen: "how much apparent LOS this
    effect contributes". It is a diagnostic; los_m is never silently corrected (P07's rule);
    the metadata states whether the product already applied it (a config assumption);
  * height cubes (tropo/tide screens) are collapsed at the fallback height (config) when no DEM
    is in the clip — the metadata says so;
  * the pair difference of CONVERTED values (diff modes los_m | los_mm) is a real difference of
    displacements that share a reference (or the cross-pair window is stated): see
    background_pairs.diff where the referencing facts are validated before any math.
"""
from __future__ import annotations

from .background import BackgroundError

# the correction diagnostics and where each lives in the product
CORRECTIONS = {
    "iono": ("iono_phase", "ionosphere phase screen", False),
    "tropo_hydrostatic": ("tropo_hydro_phase", "hydrostatic troposphere screen", True),
    "tropo_wet": ("tropo_wet_phase", "wet troposphere screen", True),
    "solid_earth_tide": ("tide_phase", "solid-earth tide screen", True),
}

_LOS_SCALES = ("los_m", "los_mm")


def los_scales() -> tuple:
    return _LOS_SCALES


def is_los_scale(scale: str) -> bool:
    return scale in _LOS_SCALES


def is_correction(name: str) -> bool:
    return name in CORRECTIONS


def phase_pair_sign(dec: dict) -> tuple:
    """(sign, flipped, ref_time, sec_time) for one pair granule's decoded id.
    sign = -1 when the product stores the secondary earlier than the reference (P01's `flipped`):
    multiplying by it makes the value read later-minus-earlier."""
    ref_t, sec_t = dec.get("ref_time"), dec.get("sec_time")
    if not ref_t or not sec_t:
        raise BackgroundError(422, "this granule's id does not carry both pair dates — "
                                   "the phase cannot be referenced to a direction in time")
    flipped = str(sec_t) < str(ref_t)            # ISO Z strings compare as instants
    sign = -1.0 if flipped else 1.0
    return sign, flipped, ref_t, sec_t


def phase_to_los(phase, dec: dict, radar_cfg, mm: bool = False):
    """Raw unwrapped phase (rad) -> LOS displacement toward the sensor (m or mm).
    Pure math on the decoded pair order + RadarCfg (wavelength, phase sign). -> (array, facts)."""
    import numpy as np
    sign, flipped, ref_t, sec_t = phase_pair_sign(dec)
    k = radar_cfg.phase_sign * radar_cfg.wavelength_m / (4.0 * __import__("math").pi)
    out = (sign * k) * np.asarray(phase, np.float64)
    if mm:
        out = out * 1e3
    return out.astype(np.float32), {
        "wavelength_m": float(radar_cfg.wavelength_m),
        "phase_sign": int(radar_cfg.phase_sign),
        "pair_flipped": bool(flipped),
        "sign_applied": float(sign),
        "ref_time": ref_t, "sec_time": sec_t,
        "unit": "mm" if mm else "m",
        "formula": ("los = sign * phase_sign * wavelength / (4 pi) * phase; sign = -1 for a pair "
                    "stored secondary-before-reference, so the value reads later-minus-earlier; "
                    "+ toward the sensor"),
        "assumptions": [
            f"L-band wavelength {radar_cfg.wavelength_m:g} m (the clip carries no centerFrequency)",
            f"phase sign {radar_cfg.phase_sign:+d} for ref*conj(sec) with ref earlier "
            "(NISAR ATBD JPL D-95677; unverified on real NISAR data)",
        ],
    }


def collapse_correction_cube(arr, heights, at_h: float):
    """A (H, ny, nx) correction screen -> 2-D at `at_h` metres. Uses the engine's own
    collapse_height (linear along the height axis, clamped); a 2-D array passes through."""
    import numpy as np
    from engine.common.p05_geometry import collapse_height
    if getattr(arr, "ndim", 2) == 2:
        return arr, False
    out = collapse_height(np.asarray(arr), heights, float(at_h))
    return out, True


def correction_layer_of(clip, grid, wanted_roles: tuple):
    """Find the first of `wanted_roles` present in this clip (any grid section). The unwrapped
    phase lives in grids/frequencyA/unwrappedInterferogram/<pol>/; the screens live either beside
    it (ionospherePhaseScreen) or in metadata/radarGrid (tropo / tide). -> (grid, arr, key) or
    raises 404 with the honest reason."""
    from engine.common.layers import parse_layer_key
    for g in clip.grids.values():
        for key, arr in g.layers.items():
            info = parse_layer_key(key)
            if info.role in wanted_roles:
                return g, arr, key
    raise BackgroundError(404, "none of the correction layers "
                               + "/".join(sorted(wanted_roles)) + " is part of this granule's clip "
                               "(the provider returned no such screen for this box)")


def correction_facts(name: str, radar_cfg) -> dict:
    """The stated facts for one diagnostic: what it is, whether the product already applied it
    (config assumption — the clip carries no processing metadata)."""
    role, label, _cube = CORRECTIONS[name]
    applied = bool(radar_cfg.corrections_applied_by_product.get(name, False))
    return {
        "name": name, "role": role, "label": label,
        "applied_by_product": applied,
        "applied_by_engine": False,
        "note": ("diagnostic only: this screen is NOT removed from los_m; it shows how much "
                 "apparent LOS displacement this effect contributes"
                 + ("; the product generator is assumed to have applied it already (config "
                    "radar.corrections_applied_by_product — unverified)" if applied
                    else "; the product generator is assumed NOT to have applied it (config "
                         "radar.corrections_applied_by_product — unverified)")),
    }

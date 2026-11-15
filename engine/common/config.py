"""Configuration for the common preprocessing chain (P01-P13) and the registry.

Single source of truth for every threshold. Defaults live here as typed dataclasses; `config/common.yaml`
overrides them section by section; `NISAR_COMMON_<SECTION>_<KEY>` environment variables override both
(same convention as the retrieval layer's `NISAR_<SECTION>_<KEY>`).

`CommonConfig.chain_params()` is what gets hashed into the bundle id (P13): every field that can change
the *content* of a bundle is in there, the registry/process-pool section is not.
"""
from __future__ import annotations

import dataclasses
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------------------------
# sections
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class GridsCfg:
    g80_m: float = 80.0            # GUNW / GOFF posting
    g20_m: float = 20.0            # GCOV posting
    halo_px_g80: int = 1           # ring added around the tile, in G80 pixels (1 px = 80 m = 4 G20 px)
    max_g20_pixels: int = 4_000_000  # refuse tiles that would build absurdly large canonical grids


@dataclass(frozen=True)
class WindowCfg:
    lookback_days: float = 120.0   # search window = [as_of - lookback, as_of]
    max_gcov_epochs: int = 24      # last N backscatter epochs kept per stack
    max_gunw_pairs: int = 60       # newest N interferometric pairs kept per stack
    epoch_merge_minutes: float = 10.0  # granules of one stack closer than this are one pass (adjacent frames)


@dataclass(frozen=True)
class ProductsCfg:
    gunw: str = "GUNW"
    gcov: str = "GCOV"
    goff: str = "GOFF"
    include_goff: bool = False     # M3 offsets normally come from the GUNW pixelOffsets grid
    frequency: str = "A"           # NISAR frequency band used by the hazard pipelines
    pols: list = field(default_factory=lambda: ["HH", "HV", "VV", "VH"])
    use_noise_floor: bool = False  # also request calibrationInformation/noiseEquivalentBackscatter


@dataclass(frozen=True)
class ClipCfg:
    margin_m: float | None = None  # None -> retrieval's tiling.margin_m
    drop_empty_clips: bool = True  # clips whose requested layers are 100 % invalid are dropped (and flagged)


@dataclass(frozen=True)
class RadarCfg:
    wavelength_m: float = 0.2384   # NISAR L-band, c / 1.2575 GHz. centerFrequency is NOT carried by the clip (see data_retival_bugs.md)
    phase_sign: int = -1           # los_toward_sensor = phase_sign * wavelength / (4 pi) * phase, for ref EARLIER than sec (ref * conj(sec) convention). Consistent with NISAR ATBD JPL D-95677 phi = 4pi/lambda (R_sec - R_ref); no ground-truth displacement was available to confirm it end to end.
    los_vector_points: str = "ground_to_sensor"  # direction of losUnitVectorX/Y in the product: NISAR L2 GUNW spec (JPL D-102272) says "from target to sensor"; matched numerically on one real product (ALOS-1 via NISAR SDS, see debug/compare.py)
    look_side: str | None = None   # "left" | "right" when known (identification/lookDirection, NOT carried by the clip): enables P05's sign check
    gunw_effective_looks: float = 100.0  # independent looks per 80 m pixel (not carried by the clip). Assumption.
    max_sigma_phase_rad: float = 2.0     # cap on the Cramer-Rao phase std so near-zero coherence stays finite
    min_coherence: float = 0.02          # below this the pixel gets no sigma (and is flagged invalid for sigma)
    # Is each correction already baked into unwrappedPhase by the product generator? The clip carries no processing
    # metadata, so this is an assumption (NISAR GUNW ships the screens as separate layers). UNVERIFIED on real data.
    corrections_applied_by_product: dict = field(default_factory=lambda: {
        "iono": False, "tropo_hydrostatic": False, "tropo_wet": False, "solid_earth_tide": False})


@dataclass(frozen=True)
class DecodeCfg:
    cc_min: int = 1                # connected-component gate: keep unwrappedPhase only where cc >= cc_min
    float_sentinels: list = field(default_factory=list)  # extra float values to treat as fill (NISAR floats use NaN)
    coherence_max: float = 1.0001  # coherence above this is corrupt -> NaN


@dataclass(frozen=True)
class GeometryCfg:
    min_incidence_deg: float = 20.0   # below: near-range, unreliable radiometry
    max_incidence_deg: float = 60.0
    layover_margin_deg: float = 0.0   # local-incidence margin for the layover test
    shadow_margin_deg: float = 0.0
    fallback_height_m: float = 0.0    # height used to collapse the radarGrid cube when no DEM exists
    consistency_tol_deg: float = 1.5  # |incidence layer - acos(up component)| beyond this raises a flag
    layover_dilate_px: int = 0


@dataclass(frozen=True)
class TerrainCfg:
    hand_context_px_g80: int = 62     # extra DEM context (G80 px per side, ~5 km) so HAND sees real drainage
    hand_min_drainage_km2: float = 0.5  # upstream area that defines a stream cell
    hand_water_occurrence_pct: float = 50.0  # JRC occurrence at/above this also counts as drainage
    hand_max_m: float = 300.0
    slope_flat_deg: float = 0.1       # aspect is undefined below this slope


@dataclass(frozen=True)
class TemporalCfg:
    min_baseline_epochs: int = 3      # fewer prior epochs than this -> cold_start
    seasonal_min_history_days: float = 365.0  # harmonic fit allowed only beyond this history
    default_looks: float = 25.0       # used for the speckle floor when numberOfLooks is missing. Assumption.
    mad_scale: float = 1.4826
    coherence_baseline_min_pairs: int = 3


@dataclass(frozen=True)
class StableCfg:
    coherence_min: float = 0.5
    slope_max_deg: float = 10.0
    nochange_k: float = 3.0           # |current - baseline median| <= k * robust sigma
    water_occurrence_max_pct: float = 25.0
    min_valid_fraction_for_stats: float = 0.02


@dataclass(frozen=True)
class RoutingCfg:
    min_valid_fraction: float = 0.15       # tile counts as covered when at least this much of the core is valid
    coherence_land_min: float = 0.3
    coherent_land_min_fraction: float = 0.10
    land_min_fraction: float = 0.05
    permanent_ice_max_fraction: float = 0.5
    ice_min_fraction: float = 0.02
    slope_landslide_deg: float = 10.0
    slope_landslide_min_fraction: float = 0.01
    forest_min_fraction: float = 0.02
    tree_cover_min_pct: float = 30.0
    vegetated_min_fraction: float = 0.05
    builtup_pct_threshold: float = 10.0
    builtup_min_fraction: float = 0.02
    volcano_radius_km: float = 50.0
    high_terrain_elev_m: float = 1500.0
    high_terrain_relief_m: float = 700.0
    coast_buffer_km: float = 2.0
    coastal_elev_max_m: float = 30.0
    ocean_min_fraction: float = 0.5
    ocean_min_offshore_km: float = 5.0
    wind_min_ms: float = 2.0
    wind_max_ms: float = 10.0
    river_occurrence_pct: list = field(default_factory=lambda: [1.0, 99.0])
    river_min_fraction: float = 0.005
    coastal_min_fraction: float = 0.005    # share of the tile inside the coastal strip
    iceberg_water_min_fraction: float = 0.10
    ice_front_radius_km: float = 50.0      # facts["ice_front_distance_km"] within this also qualifies a tile
    water_proxy_gamma0_db: float = -18.0   # HH/VV below this over a whole epoch = open-water PROXY when no land cover exists


@dataclass(frozen=True)
class ProvenanceCfg:
    hash_bytes: int = 16             # length of the hex digests kept in the bundle id


@dataclass(frozen=True)
class EarthquakeCfg:
    """earthquake_coseismic parameters. These steer the PIPELINE, not the bundle, so they are not part of the bundle
    hash (see CommonConfig.chain_params). A caller can still override per request via triggers["eq_params"]."""
    coherence_threshold: float = 0.5
    reference_strategy: str = "farField"       # "farField" (edge-margin median) | "stableFarField" (that ring restricted to the
    #                                            bundle's stable-ground mask) | "fullFrameMedian" (all valid pixels)
    far_field_margin: float = 0.12             # share of the tile edge used as the reference ring
    detection_floor_m: float = 0.01            # absolute floor of the detection threshold max(k*sigma, floor, iono)
    significance_k: float = 3.0
    edge_touch_max_fraction: float = 0.05      # warn when more than this share of the reference ring is itself "detected"
    scan_pairs_per_stack: int = 4              # scan mode (no event window): newest N interferograms of EACH stack; 1 = newest only
    analyse_all_stacks: bool = True            # analyse every ascending/descending stack, not only one "primary" stack
    merge_geometries: bool = True              # also build the merged ascending + descending layers (detected_merged, geometry_coverage, ...)
    merge_decompose: bool = True               # event mode only: solve east + up motion where both geometries saw a pixel
    merge_min_geometry_det: float = 0.3        # |det| of the 2x2 look-vector matrix must reach this, else the east/up solve is ill-conditioned there


@dataclass(frozen=True)
class DeforestationCfg:
    """deforestation parameters (3.08). They steer the PIPELINE, not the bundle, so they are not part of the bundle hash
    (see CommonConfig.chain_params). A caller can override per request via triggers["deforestation_params"].
    Defaults are tied to the literature the pipeline implements (docs in engine/pipelines/deforestation/README.md)."""
    # series / reference
    pol: str = "HV"                    # cross-pol: volume scattering, the moisture-robust channel (late-stage loss)
    co_pol: str = "HH"                 # co-pol: fresh clearing with felled trees on the ground RAISES HH (L-band, Watanabe 2018)
    min_epochs: int = 6                # usable epochs per stack: ref_epochs_min + persist_epochs
    ref_epochs_min: int = 4            # early window that defines "forest as it was"
    ref_fraction: float = 0.4          # reference window = this share of the epochs, but at least ref_epochs_min
    min_ref_valid: int = 3             # valid reference epochs a pixel needs
    min_sigma_db: float = 0.5          # floor of the per-pixel reference sigma (on top of the speckle floor)
    # change statistics
    cusum_k: float = 0.5               # Page allowance in sigma
    cusum_h: float = 4.0               # Page decision interval in sigma
    min_drop_db: float = 1.5           # HV must sit this far below reference to count as lost (JJ-FAST: 1.5-3.2 dB)
    min_rise_db: float = 1.0           # HH rise of early-stage clearing (about +1.2 dB observed)
    z_shift: float = 1.5               # an epoch is "shifted" when |z| >= this AND the dB floor below is met
    shift_floor_db: float = 1.0
    persist_epochs: int = 2            # consecutive usable epochs at the new level (manifest: 2-3)
    ratio_drop_db: float = 1.0         # HV-HH ratio must fall this much for the early-stage channel (moisture raises both bands)
    hv_not_rising_db: float = 0.5      # early-stage: HV may not rise more than this (rain raises HV, clearing does not)
    # moisture
    normalize_common_mode: bool = True # remove each epoch's tile-wide median offset (rain / soil moisture), JJ-FAST "temporal normalisation"
    common_mode_flag_db: float = 0.7   # |offset| above this flags the epoch as moisture-affected
    common_mode_cap_db: float = 3.0    # offsets beyond this are not corrected (the epoch is just unusable)
    rain_flag_mm: float = 10.0         # IMERG: >= this over the 48 h up to the acquisition flags the epoch
    max_wet_epoch_fraction: float = 0.5
    # exclusions
    slope_max_deg: float = 15.0        # JJ-FAST 4.0 steep-terrain mask
    water_occurrence_max_pct: float = 25.0
    builtup_max_pct: float = 10.0
    tree_cover_min_pct: float = 30.0
    hand_flood_prone_m: float = 3.0    # low HAND = flood-prone: kept, but flagged and needs HV confirmation
    nonforest_k: float = 3.0           # pre-existing non-forest: reference HV below tile forest median - k*sigma (>= 2.5 dB)
    min_forest_fraction: float = 0.02
    min_valid_forest_fraction: float = 0.3
    # patches
    min_patch_ha: float = 0.5          # manifest
    despeckle_px: int = 1              # majority filter window on the confirmed map (1 = off; multilooking already controls noise)
    smooth_px: int = 3                 # boxcar multilook of the dB series before testing (mask-aware); 1 = off
    refine_fraction: float = 0.5       # raw-resolution edge refinement keeps pixels whose own drop is at least this share of min_drop_db
    patches_max: int = 50
    hotspot_cell_m: float = 500.0
    hotspot_top_n: int = 5
    # null screen
    null_draws: int = 8
    null_margin: float = 3.0           # observed loss area must exceed this multiple of the largest null-draw area
    # attribution
    fire_buffer_m: float = 375.0       # VIIRS footprint
    fire_window_days: float = 24.0
    storm_max_distance_km: float = 300.0
    storm_min_wind_kt: float = 34.0
    storm_window_days: float = 36.0
    abrupt_step_db: float = 2.0
    rectangularity_min: float = 0.55
    road_elongation_min: float = 4.0
    road_max_width_m: float = 60.0
    # corroboration
    coherence_delta: float = 0.10
    los_abs_min_m: float = 0.03        # ground motion that could be a landslide rather than clearing
    los_k: float = 3.0
    r7_overlap_min: float = 0.30
    s4_patch_queries: int = 5
    fetch_timeout_s: float = 30.0


@dataclass(frozen=True)
class RegistryCfg:
    max_workers: int | None = None   # None -> min(cpu_count - 1, 8), at least 1
    task_timeout_s: float = 900.0
    start_method: str = "spawn"      # never fork: the retrieval client owns threads + an event loop
    run_unknown: bool = False        # run pipelines whose applicability could not be evaluated
    gate_min_epochs: bool = True     # synthesize INSUFFICIENT_EVIDENCE instead of launching a hopeless worker
    persist_bundles: bool = True     # content-addressed copy under <data>/bundles so workers can mmap it
    max_attempts: int = 2            # re-run a task that was only collateral damage of a pool recycle
    min_epochs_metric: dict = field(default_factory=lambda: {"land_subsidence": "pairs_connected", "deforestation": "gcov_epochs"})
    fetch_for_unmodelled: bool = False  # False: only pipelines that have a run() decide which products are fetched / which steps run


_SECTIONS: dict[str, type] = {
    "grids": GridsCfg, "window": WindowCfg, "products": ProductsCfg, "clip": ClipCfg, "radar": RadarCfg,
    "decode": DecodeCfg, "geometry": GeometryCfg, "terrain": TerrainCfg, "temporal": TemporalCfg,
    "stable": StableCfg, "routing": RoutingCfg, "provenance": ProvenanceCfg, "earthquake": EarthquakeCfg,
    "deforestation": DeforestationCfg, "registry": RegistryCfg,
}


@dataclass(frozen=True)
class CommonConfig:
    grids: GridsCfg = field(default_factory=GridsCfg)
    window: WindowCfg = field(default_factory=WindowCfg)
    products: ProductsCfg = field(default_factory=ProductsCfg)
    clip: ClipCfg = field(default_factory=ClipCfg)
    radar: RadarCfg = field(default_factory=RadarCfg)
    decode: DecodeCfg = field(default_factory=DecodeCfg)
    geometry: GeometryCfg = field(default_factory=GeometryCfg)
    terrain: TerrainCfg = field(default_factory=TerrainCfg)
    temporal: TemporalCfg = field(default_factory=TemporalCfg)
    stable: StableCfg = field(default_factory=StableCfg)
    routing: RoutingCfg = field(default_factory=RoutingCfg)
    provenance: ProvenanceCfg = field(default_factory=ProvenanceCfg)
    earthquake: EarthquakeCfg = field(default_factory=EarthquakeCfg)
    deforestation: DeforestationCfg = field(default_factory=DeforestationCfg)
    registry: RegistryCfg = field(default_factory=RegistryCfg)

    def chain_params(self) -> dict:
        """Everything that can change bundle content (registry/pool settings excluded)."""
        d = dataclasses.asdict(self)
        d.pop("registry", None)
        d.pop("earthquake", None)          # pipeline parameters: they do not change what a bundle contains
        d.pop("deforestation", None)
        return d

    def chain_params_json(self) -> str:
        return json.dumps(self.chain_params(), sort_keys=True, default=str)


# ---------------------------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------------------------
def repo_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for p in [here, *here.parents]:
        if (p / "pyproject.toml").exists() or (p / "config").is_dir():
            return p
    return Path.cwd()


def _coerce(raw: str, like: Any) -> Any:
    if like is None:
        return None if raw.strip().lower() in ("", "null", "none") else raw
    if isinstance(like, bool):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(like, int):
        return int(raw)
    if isinstance(like, float):
        return float(raw)
    if isinstance(like, (list, tuple)):
        return [s.strip() for s in raw.split(",") if s.strip()]
    if isinstance(like, dict):
        return json.loads(raw)
    return raw


def _section(name: str, cls: type, yaml_values: dict, env: dict) -> Any:
    defaults = cls()
    kw: dict[str, Any] = {}
    known = {f.name for f in dataclasses.fields(cls)}
    unknown = set(yaml_values) - known
    if unknown:
        raise ValueError(f"config/common.yaml: unknown key(s) {sorted(unknown)} in section '{name}'")
    for f in dataclasses.fields(cls):
        val = yaml_values.get(f.name, getattr(defaults, f.name))
        raw = env.get(f"NISAR_COMMON_{name}_{f.name}".upper())
        if raw is not None:
            val = _coerce(raw, getattr(defaults, f.name))
        kw[f.name] = val
    return cls(**kw)


def load_common_config(path: str | os.PathLike | None = None, root: Path | None = None,
                       env: dict | None = None) -> CommonConfig:
    """Defaults <- config/common.yaml <- NISAR_COMMON_* environment."""
    root = root or repo_root()
    env = os.environ if env is None else env
    cfg_file = Path(path or env.get("NISAR_COMMON_CONFIG") or root / "config" / "common.yaml")
    raw = yaml.safe_load(cfg_file.read_text()) if cfg_file.exists() else {}
    raw = raw or {}
    extra = set(raw) - set(_SECTIONS)
    if extra:
        raise ValueError(f"{cfg_file}: unknown section(s) {sorted(extra)}")
    return CommonConfig(**{name: _section(name, cls, raw.get(name) or {}, env) for name, cls in _SECTIONS.items()})


def data_root(root: Path | None = None) -> Path:
    """Where `data/` lives. Uses the retrieval settings loader (read-only use) so there is one answer."""
    try:
        from ..retrieval.settings import load_settings
        return Path(load_settings(root=root).data_dir)
    except Exception:  # retrieval deps missing: same rule as settings.py
        return Path(os.environ.get("NISAR_DATA_DIR") or (root or repo_root()) / "data").expanduser()

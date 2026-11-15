"""3.08 deforestation - parameters and the small typed hand-offs between prep, model and verdict."""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from engine.common.config import DeforestationCfg

PIPELINE_VERSION = "1.0.0"

# per-pixel class codes (layer `loss_class`)
CLASS_NONE, CLASS_UNCONFIRMED, CLASS_HV, CLASS_EARLY, CLASS_BOTH = 0, 1, 2, 3, 4
CLASS_LABELS = {CLASS_UNCONFIRMED: "unconfirmed candidate", CLASS_HV: "confirmed: HV drop (late stage)",
                CLASS_EARLY: "confirmed: HH rise + ratio drop (early stage)", CLASS_BOTH: "confirmed: both channels"}

# exclusion codes (layer `exclusion`)
EXC_NONE, EXC_NOT_FOREST, EXC_WATER, EXC_GEOMETRY, EXC_STEEP, EXC_BUILTUP, EXC_PRIOR_NONFOREST, EXC_FEW_VALID, EXC_EARLY_CHANGE = range(9)
EXC_LABELS = {EXC_NOT_FOREST: "not forest", EXC_WATER: "water", EXC_GEOMETRY: "layover / shadow / bad incidence",
              EXC_STEEP: "steep slope", EXC_BUILTUP: "built-up", EXC_PRIOR_NONFOREST: "already non-forest at the start",
              EXC_FEW_VALID: "too few valid epochs", EXC_EARLY_CHANGE: "changed inside the reference window"}

CAUSES = ("fire", "windthrow", "clearing", "unattributed")


def load_params(triggers=None) -> DeforestationCfg:
    """class defaults <- config/common.yaml `deforestation:` (+ env) <- per-request triggers["deforestation_params"]."""
    try:
        from engine.common.config import load_common_config
        base = load_common_config().deforestation
    except Exception:                                  # config unreadable: the dataclass defaults still apply
        base = DeforestationCfg()
    try:
        raw = dict(triggers or {}).get("deforestation_params") or {}
    except TypeError:
        raw = {}
    names = {f.name: f for f in dataclasses.fields(DeforestationCfg)}
    over: dict[str, Any] = {}
    for k, v in dict(raw).items():
        if k in names and v is not None:
            like = getattr(base, k)
            try:
                over[k] = type(like)(v) if not isinstance(like, bool) else bool(v)
            except (TypeError, ValueError):
                continue
    bounds = {"min_drop_db": (0.3, 12.0), "min_rise_db": (0.3, 12.0), "persist_epochs": (1, 6), "min_patch_ha": (0.04, 1000.0),
              "cusum_h": (1.0, 20.0), "cusum_k": (0.1, 3.0), "z_shift": (0.5, 6.0), "slope_max_deg": (1.0, 60.0),
              "ref_epochs_min": (2, 20), "min_epochs": (3, 60), "hotspot_cell_m": (60.0, 5000.0), "null_draws": (0, 64)}
    for k, (lo, hi) in bounds.items():
        if k in over:
            over[k] = type(getattr(base, k))(min(hi, max(lo, over[k])))
    return dataclasses.replace(base, **over)


@dataclass
class Prepared:
    """One stack, ready for detection. Every array is cropped to the tile proper (halo removed), G20."""
    key: str
    times: list
    days: np.ndarray                      # (E,) days since the first epoch
    rows: int
    cols: int
    x: np.ndarray                         # (cols,) pixel-centre eastings
    y: np.ndarray                         # (rows,) pixel-centre northings
    epsg: int
    pixel_m: float
    hv: np.ndarray                        # (E,H,W) dB, common-mode corrected
    hh: np.ndarray | None
    ratio: np.ndarray | None              # HV - HH dB (corrected)
    hv_raw: np.ndarray                    # (E,H,W) dB corrected, NOT multilooked (edge refinement)
    hh_raw: np.ndarray | None
    ref_hv_raw: np.ndarray
    ref_hh_raw: np.ndarray | None
    z_hv: np.ndarray
    z_hh: np.ndarray | None
    z_ratio: np.ndarray | None
    ref_hv: np.ndarray                    # (H,W) reference median dB
    ref_hh: np.ndarray | None
    ref_ratio: np.ndarray | None
    sigma_hv: np.ndarray
    sigma_hh: np.ndarray | None
    sigma_ratio: np.ndarray | None
    usable: np.ndarray                    # (E,H,W) bool: valid, and the epoch is not flagged wet
    evaluate: np.ndarray                  # (H,W) bool: forest candidate that may be tested
    exclusion: np.ndarray                 # (H,W) uint8 exclusion code
    flood_prone: np.ndarray               # (H,W) bool
    n_ref: int
    epoch_flags: list                     # per epoch: {"index","time","hv_offset_db","hh_offset_db","rain_mm","flagged","reasons"}
    slope: np.ndarray | None
    hand: np.ndarray | None
    tree_cover: np.ndarray | None
    local_incidence: np.ndarray | None
    diag: dict = field(default_factory=dict)
    skip: str | None = None               # why this stack could not be analysed (None = ok)
    core: tuple = (0, 0)                  # (row0, col0) of the crop inside the full G20 grid

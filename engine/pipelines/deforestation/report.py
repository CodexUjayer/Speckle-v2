"""3.08 deforestation - result assembly helpers: layers, the SceneBundle usage ledger, evidence rows, wording."""
from __future__ import annotations

import numpy as np

from .lib_local import encode_layer
from .types import CAUSES, CLASS_LABELS, EXC_LABELS

# Every SceneBundle field a deforestation pipeline could conceivably read, with the reason when it is NOT used.
# `used` is decided at run time from what the code really touched (the `use()` tracker); nothing here claims usage.
_NU = "not_used"
CATALOGUE = [
    # identity / request
    ("status", "gate: an empty bundle ends the run as INSUFFICIENT_EVIDENCE", None),
    ("capabilities", "gate: M2 (backscatter) is required", None),
    ("tile", "bbox / centre / id / epsg for every fetch and for result geometry", None),
    ("request.as_of", "end of the fetch windows", None), ("request.t0", "recorded in the inputs block", None), ("request.t1", "recorded in the inputs block", None),
    ("request.event_window", "storm / event window for windthrow attribution", None),
    ("request.triggers", "storm trigger, per-request parameter overrides (deforestation_params)", None),
    ("request.active_codes", "which measurement codes were requested; recorded", None),
    ("epoch", "newest acquisition; recorded", None),
    # M2
    ("stacks[*].backscatter.epochs", "acquisition times: onset dates, rain windows, fire / storm windows", None),
    ("stacks[*].backscatter.gamma0_db", "HV, HH time series (the measurement)", None),
    ("stacks[*].backscatter.sigma0_db", None, "gamma0 (RTC) is used for every epoch; sigma0 differs from gamma0 by a fixed factor per pixel, which cannot change a temporal residual"),
    ("stacks[*].backscatter.hv_hh_db", "cross-checked against the HV-HH ratio rebuilt from the moisture-corrected bands", None),
    ("stacks[*].backscatter.n_looks", "per-pixel speckle floor of sigma", None),
    ("stacks[*].backscatter.valid", "epochs without coverage are dropped from the reference / test", None),
    ("stacks[*].backscatter.masks.layover", "exclusion", None), ("stacks[*].backscatter.masks.shadow", "exclusion", None),
    ("stacks[*].backscatter.masks.low_incidence", "exclusion", None), ("stacks[*].backscatter.masks.high_incidence", "exclusion", None),
    ("stacks[*].backscatter.baseline", "contamination check of the bundle baseline against the early reference", None),
    ("stacks[*].backscatter.baseline.median_db", "compared with the pipeline's own early reference", None),
    ("stacks[*].backscatter.baseline.sigma_db", "recorded with the baseline check", None),
    ("stacks[*].backscatter.baseline.speckle_floor_db", "sigma floor when numberOfLooks is missing", None),
    ("stacks[*].backscatter.baseline.history_days", "history length caveat", None),
    ("stacks[*].backscatter.baseline.n_epochs", "baseline check", None), ("stacks[*].backscatter.baseline.epoch_indices", "baseline check", None),
    ("stacks[*].backscatter.baseline.cold_start", "caveat", None), ("stacks[*].backscatter.baseline.seasonal_ok", "caveat: no seasonal separation without a year of history", None),
    ("stacks[*].backscatter.baseline.mad_db", None, "the pipeline recomputes MAD on its own early reference (the bundle MAD spans the whole prior window)"),
    ("stacks[*].backscatter.baseline.n", None, "per-pixel valid counts are recomputed on the early reference"),
    ("stacks[*].backscatter.current_index", None, "the pipeline tests EVERY epoch against the reference; 'newest vs baseline' would miss clearings older than one epoch"),
    ("stacks[*].backscatter.db_diff_prev", "abruptness (dB step at the onset epoch) of each patch, used in attribution", None),
    ("stacks[*].backscatter.z_prev", "flags a step inside the reference window; step z at onset per patch", None),
    # geometry / stable
    ("stacks[*].geometry.layover", "exclusion", None), ("stacks[*].geometry.shadow", "exclusion", None),
    ("stacks[*].geometry.local_incidence_deg", "exclusion of out-of-range incidence; patch mean reported", None),
    ("stacks[*].geometry.incidence_deg", "reported in the per-stack summary", None), ("stacks[*].geometry.heading_deg", "reported in the per-stack summary", None),
    ("stacks[*].geometry.los_enu", None, "backscatter is terrain-corrected gamma0; the LOS vector enters only the layover / shadow masks the chain already built"),
    ("stacks[*].geometry.consistency_deg", "reported in the per-stack summary (a large value would mean the geometry layers are suspect)", None),
    ("stacks[*].stable.components", "coherence + slope + not_water components select the reference set for the tile-wide moisture offset", None),
    ("stacks[*].stable.mask", None, "its `no_change` criterion is evaluated on the newest epoch and would force that epoch's moisture offset to zero; the components are used instead"),
    ("stacks[*].quality", "coverage / valid fraction reported in the per-stack summary", None),
    # M1 / M3
    ("stacks[*].interferometric.coherence", "coherence rise / drop around the loss date (supporting cue)", None),
    ("stacks[*].interferometric.coherence_baseline", "latest coherence vs baseline over the patch (supporting cue)", None),
    ("stacks[*].interferometric.pairs", "which pairs fall before / across / after the loss date", None),
    ("stacks[*].interferometric.los_m", "ground-motion check: a moving patch may be a landslide, not a clearing", None),
    ("stacks[*].interferometric.sigma_m", "noise level of that check", None), ("stacks[*].interferometric.conn_comp", "unwrapping gate of that check", None),
    ("stacks[*].interferometric.phase_rad", None, "unwrapped phase is the same measurement as los_m (used instead, in metres)"),
    ("stacks[*].interferometric.iono_floor_m", None, "ionosphere floors matter for millimetre deformation, not for a 3-cm movement flag"),
    ("stacks[*].interferometric.corrections", None, "atmospheric / tide screens are diagnostics for deformation pipelines; the ground-motion flag is deliberately coarse"),
    ("stacks[*].interferometric.network", None, "pair-network connectivity matters for SBAS inversion, not for this pipeline"),
    ("stacks[*].offsets.peak", "correlation-peak change at the loss date (reported, not scored)", None),
    ("stacks[*].offsets.range_m", None, "pixel displacement is a deformation measurement"), ("stacks[*].offsets.azimuth_m", None, "pixel displacement is a deformation measurement"),
    # ancillary
    ("ancillary.landcover", "forest mask and water exclusion", None),
    ("ancillary.context[tree_cover]", "forest mask (S4 tree cover)", None), ("ancillary.context[builtup]", "built-up exclusion", None),
    ("ancillary.slope_deg", "steep-terrain exclusion and patch mean", None), ("ancillary.hand_m", "flood-prone marking (needs HV confirmation)", None),
    ("ancillary.water_occurrence_pct", "water / seasonally-flooded exclusion", None),
    ("ancillary.elevation_m", None, "elevation is not a forest-loss discriminant (slope and HAND are used)"),
    ("ancillary.aspect_deg", None, "aspect matters for burn / snow geometry, not here"),
    ("ancillary.curvature_profile", None, "not a forest-loss discriminant"), ("ancillary.curvature_plan", None, "not a forest-loss discriminant"),
    ("ancillary.status", "recorded: which ancillary layers were really available", None), ("ancillary.facts", None, "no tile-level fact applies to forest loss"),
    ("grids.g20", "every array is read on G20, cropped to the tile proper", None), ("grids.g80", "interferometric layers reach G20 through the index map", None),
    ("grids.index_map_20_to_80", "maps patches to the G80 cells of the coherence / LOS / offset cues", None),
    # routing / depth / provenance
    ("routing.decisions", "the P12 decision for this pipeline is reported next to the verdict", None),
    ("routing.landcover_hist", "forest share cross-check", None), ("routing.quality", "water / land fractions reported", None),
    ("depth", "history length and epoch counts reported; the registry gates min_epochs on gcov_epochs", None),
    ("flags", "chain warnings relevant to this result are carried into warnings", None),
    ("provenance", "bundle id seeds the null screen; assumptions are carried; params hash recorded", None),
]


def usage_ledger(used: set) -> list:
    rows = []
    for field, how, why_not in CATALOGUE:
        if field in used:
            rows.append({"field": field, "status": "used", "how": how or "used"})
        elif why_not:
            rows.append({"field": field, "status": "not_used", "why": why_not})
        else:
            rows.append({"field": field, "status": "not_reached", "why": "absent from this bundle, or the branch that reads it did not run (" + (how or "") + ")"})
    return rows


def fmt_ha(x: float) -> str:
    return f"{x:.1f} ha" if x >= 0.95 else f"{x:.2f} ha"


def evidence(eid, kind, claim, support=None, level="info", source_ref=None) -> dict:
    return {"id": eid, "kind": kind, "claim": claim, "support": support, "level": level, "source_ref": source_ref}


def categories_class() -> list:
    tone = {1: "neutral", 2: "negative", 3: "negative", 4: "negative"}
    return [{"value": k, "label": v, "tone": tone[k]} for k, v in CLASS_LABELS.items()]


def categories_cause() -> list:
    return [{"value": i + 1, "label": c, "tone": "negative" if c != "unattributed" else "neutral"} for i, c in enumerate(CAUSES)]


def categories_exclusion() -> list:
    return [{"value": k, "label": v, "tone": "neutral"} for k, v in EXC_LABELS.items()]


def make_layers(arrays: dict, bounds, alerts_rank=None) -> dict:
    L = {}
    L["loss_class"] = encode_layer("loss_class", arrays["cls"], units="class", colormap="binary", vmin=0, vmax=4, bounds_lonlat=bounds,
                                   categories=categories_class(), note="Confirmed loss is shown only inside patches of at least the minimum area; candidates whose series ended before they could be confirmed are class 1.")
    L["days_before_newest"] = encode_layer("days_before_newest", arrays["onset_days"], units="days before the newest pass the loss began",
                                           colormap="sequential", bounds_lonlat=bounds, note="Recent loss has small values. Dates are those of the first pass at the new level.")
    L["hv_change_db"] = encode_layer("hv_change_db", arrays["hv_drop"], units="dB (HV after loss minus HV before)", colormap="diverging_teal_terracotta",
                                     bounds_lonlat=bounds, note="Moisture-corrected; negative = darker = canopy removed.")
    if arrays.get("hh_change") is not None:
        L["hh_change_db"] = encode_layer("hh_change_db", arrays["hh_change"], units="dB (HH after loss minus HH before)", colormap="diverging_teal_terracotta",
                                         bounds_lonlat=bounds, note="Early-stage clearing raises HH (felled trees act as corner reflectors).")
    L["loss_density_ha"] = encode_layer("loss_density_ha", arrays["density"], units="ha of confirmed loss per hotspot cell", colormap="sequential",
                                        bounds_lonlat=bounds, note="Where loss is concentrated; the strongest cells are the reported hotspots.")
    L["cause"] = encode_layer("cause", arrays["cause"], units="class", colormap="binary", vmin=0, vmax=4, bounds_lonlat=bounds, categories=categories_cause(),
                              note="Attributed with FIRMS fires, IBTrACS storms and patch geometry; 'unattributed' means none of them speaks.")
    L["exclusion"] = encode_layer("exclusion", arrays["exclusion"], units="class", colormap="binary", vmin=0, vmax=8, bounds_lonlat=bounds,
                                  categories=categories_exclusion(), note="Why a pixel was not tested (0 = tested).")
    if alerts_rank is not None:
        cats = [{"value": 1, "label": "R7 low", "tone": "neutral"}, {"value": 2, "label": "R7 nominal", "tone": "neutral"},
                {"value": 3, "label": "R7 high", "tone": "negative"}, {"value": 4, "label": "R7 highest", "tone": "negative"}]
        L["r7_alerts"] = encode_layer("r7_alerts", (alerts_rank + 1).clip(0, 4).astype(np.uint8), units="class", colormap="binary", vmin=0, vmax=4,
                                      bounds_lonlat=bounds, categories=cats, note="Independent GFW integrated alerts in the window (not used to find loss).")
    return L

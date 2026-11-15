# 3.08 deforestation

Finds patches of forest that were lost during the NISAR L-band record, ranks where the loss is concentrated (**hotspots**), says when each
patch began, and attributes a cause (**fire / windthrow / clearing / unattributed**). Output status: `SUPPORTED`, `NOT_SUPPORTED`,
`INSUFFICIENT_EVIDENCE`. `raw_p` is an uncalibrated within-tier **rank score**, never a probability.

## What is verified, and what is not

* **Verified (offline):** on synthetic L-band scenes with known truth pushed through the *real* P01..P13 chain
  (`tests/deforestation_scene.py`): every real clearing recovered at 95-100 % of its area, **no false patches**, rain alone (even 5 of 10 passes wet)
  never produces loss, one-epoch changes stay unconfirmed, already-cleared and tiny areas are excluded, fire and windthrow are attributed from
  injected FIRMS / IBTrACS data, and every missing input ends as `INSUFFICIENT_EVIDENCE` with its reason.
* **Not verified:** real NISAR data (none was reachable), real accuracy, and the **live network paths of the five adapters** (R4, R6, R7, R10, S4). They
  were written from the published API contracts and their parsers / request construction / failure handling are tested, but no live call was made.
  Detection power on real tiles will differ from the synthetic scenes (texture, phenology, real speckle statistics, terrain).
* Operational L-band alert systems validate at roughly 50-75 % user's accuracy against optical imagery (JJ-FAST). Treat a detection as a **lead to inspect**.

## Why it is not "HV CUSUM against the bundle baseline" (the original manifest line)

| Finding (source) | Consequence in the code |
|---|---|
| L-band clearing has two stages: felled trees left on the ground **raise HH** (~ +1.2 dB) while HV barely moves; HV falls (1.5-3.2 dB) weeks to months later (Watanabe et al. 2018; JJ-FAST) | two channels: late = HV drop; early = HV-HH ratio drop with HH rising and HV neither falling nor rising (`model.detect_core`) |
| Heavy rain raises dense-forest L-band **HV by > 2 dB**, the size of the signal (Koyama et al. 2017/2021); JJ-FAST's false alarms are dominated by rain and flooding | iterated tile-wide common-mode correction on stable forest; epochs with a tile-wide offset or IMERG rain >= 10 mm / 48 h are *neutral* for persistence; early rule needs HV not rising (rain raises HV more than HH, so the ratio goes up and cannot pass) |
| P10's baseline uses **every epoch before the newest**: a clearing in the middle of the window contaminates it | the reference is the *early window*; the bundle baseline is measured against it (`bundle_baseline` diagnostic) and the whole series is tested, not "newest vs baseline" |
| NISAR calibrated L-band begins 2026-06-17; products have beta / provisional / validated maturity and ASF advises not mixing them | ~10 epochs at most, no seasonal baseline (`seasonal_ok` false): `min_epochs 6`, a history caveat on every result, a maturity caveat (the bundle does not record maturity) |
| Burn scars and clear-cuts both lower HV and both show high coherence at L-band | radar alone cannot separate fire: FIRMS carries that, HH direction is only a weak hint |
| Single-pixel L-band speckle (sigma ~ 0.9 dB at 25 looks) swamps a 1.5 dB drop; a 4-epoch reference mean has its own error | mask-aware 3x3 multilook, noise pooled over the tile, prediction-interval z (`sqrt(1+1/n)`), raw-resolution edge refinement so multilooking cannot inflate area |

## Pipeline

`prep.py` (masks, early reference, moisture correction, multilook, z) -> `model.py` (CUSUM + persistence, edge refinement, patches with a patch-mean
timeline, exploratory null screen, attribution, R7 agreement, hotspots) -> `cues.py` (coherence / LOS / offsets, supporting only) -> `verdict.py`
(multi-stack fusion, decision table, score, evidence, layers) -> `report.py` (layers, bundle-usage ledger). `fetch.py` is the provider seam (R7 alerts,
S4 loss year, R6 FIRMS, R4 IMERG, R10 IBTrACS). The generic CUSUM kernels are in `engine/lib/changepoint.py`; UTM <-> lon/lat in `engine/lib/geo.py`.

## Status decision table (first match wins; the rule id is `detail.decision.rule`)

`no_data`, `no_analysable_stack`, `too_little_forest`, `too_few_valid`, `too_wet`, `power_low` -> INSUFFICIENT_EVIDENCE | `indistinguishable_from_null`
(confirmed area <= 3 x the largest null-draw area) -> INSUFFICIENT_EVIDENCE | `loss_found` -> SUPPORTED | `candidates_unconfirmed` ->
INSUFFICIENT_EVIDENCE | `no_loss_found` -> NOT_SUPPORTED. NOT_SUPPORTED is only ever reached with enough clean evidence.

`raw_p` (SUPPORTED): `0.5 + 0.5 * clip(0.30 area + 0.15 null margin + 0.20 R7 agreement + 0.15 cross-stack + 0.05 coherence cue + 0.15 persistence - 0.20 wet-epoch fraction)`.
Heuristic weights, not fitted to data.

## Outputs

`detail.patches` (area, onset and loss window, stage, HV / HH / ratio change, patch-mean timeline, cause + basis, R7 agreement, S4 prior loss, coherence and
ground-motion cues), `detail.hotspots` (500 m cells of confirmed loss, ranked), `detail.detections` (hotspots then patches, in the shape the map already draws),
`detail.layers` (`loss_class`, `days_before_newest`, `hv_change_db`, `hh_change_db`, `loss_density_ha`, `cause`, `exclusion`, `r7_alerts`), `detail.bundle_usage`
(every SceneBundle field: used and how, or not used and why), `detail.stack_diagnostics` (epoch table, exclusions, noise, null screen).

## Known limitations

* **Thin features** narrower than ~60 m (tracks, roads) are only partly seen: multilooking dilutes them. The synthetic 30 m road is recovered at about a third of its area.
* **Hotspot cells are grid-aligned**: a patch that straddles a 500 m cell boundary is counted in both cells (the windthrow blob in the demo appears as hotspots #4 and #5). Patch-level numbers (`detail.patches`) are never split.
* The null screen is *exploratory*: the reference window is short, so it is not a calibrated false-alarm rate (it says so).
* Flood-prone ground (low HAND) can mimic early-stage clearing (double bounce raises HH); it needs HV agreement and is flagged.
* Large clearings that cover most of the tested forest bias the tile-wide moisture offset (the iteration excludes pixels with a recent large drop; a diagnostic reports the fraction).
* Landslides can strip forest: a patch that also moved (|LOS| beyond noise) is flagged, not reclassified.
* Layer payloads are ~1 MB each (float32 grids, the repo's payload contract); most pixels are NaN so they compress extremely well if the transport gzips.

## Configuration

`config/common.yaml: deforestation:` (and `DeforestationCfg` in `engine/common/config.py`); per-request overrides in `triggers["deforestation_params"]`, clamped to sane bounds.
Credentials (all optional; missing = reported as unavailable, never as "none found"): `GFW_API_KEY` (R7, S4), `FIRMS_MAP_KEY` (R6), `EARTHDATA_TOKEN` (R4).

## Run / test

`python -m pytest engine/pipelines/deforestation/tests -q` (needs the repo's normal dependencies, including pyproj). To run on a bundle:
`from engine.pipelines.deforestation.verdict import run; run(bundle, providers=None)`.

# 3.01 earthquake_coseismic

Sensor: NISAR (M1 GUNW interferometric stack)
Model: Okada85 elastic dislocation + consistency screen

## What this pipeline does (v1)

1. **prep** — selects the pair(s) (event-window spanning, or the newest pair in
   scan mode), applies the quality mask (finite LOS, coherence ≥ threshold,
   `conn_comp != 0`), references to the far-field median (12 % margin, with the
   degenerate-MAD → std fallback), screens cycle-jump suspects, optionally
   detrends (off by default).
2. **detection** — per-pixel `|disp| > max(k·σ_eff, 10 mm, iono floor)` with
   4-neighbour clusters (≥ 4 px) and the exploratory null-scene screen.
3. **fetch** — R1 ComCat events around the tile for the pair window (real HTTP
   adapter, injectable provider for tests). R2 ShakeMap extent is evidence-only.
4. **model** — ranks events, runs the Okada85 LOS forward screen on a strided
   subgrid (all published nodal planes), applies the amplitude/consistency
   screen, decides the status and the within-tier `raw_p` score.
5. **verdict** — returns the registry mapping with evidence, layer payloads
   (displacement / threshold / detected / residual) and the machine-readable
   `detail`.

## Conventions worth remembering

- **LOS sign is the engine's**: `los_m` and the ported pipeline are
  **+ = toward the sensor, later − earlier**. Detection classes: 1 = toward,
  2 = away. (The TypeScript app used the opposite — see docs/IMPLEMENTATION_PLAN.md §3.)
- Okada U1/U2/U3 senses (kernel frame, DC3D): +U1 sinistral, +U2 **thrust/reverse**,
  +U3 opening; the kernel's +y points **up-dip** (fault dips toward −y). The geographic
  wrappers use Aki & Richards rake (`u1 = slip·cos(rake)`, `u2 = +slip·sin(rake)`; rake
  +90 = reverse, −90 = normal) and feed the kernel the negated dip-direction coordinate.
  The kernel is pinned by the 24-row DC3D benchmark; the wrapper physics (reverse ⇒
  hanging-wall uplift, rake 0 ⇒ left-lateral) by `tests/test_okada.py`.
- Event fetch failure ⇒ `INSUFFICIENT_EVIDENCE` with the provider's error —
  never "no event".

## Forward-screen hardening (v1.4.0, from EQ_AUDIT)

`SUPPORTED` now needs all of the following (each is an `EqParams` field, overridable through `triggers["eq_params"]`):

1. **Amplitude** — the robust peaks (`peak_quantile`, default the 98th percentile of |value|, taken over the SAME valid
   pixels for prediction and measurement) agree within a factor of 3. `1.0` restores the old single-pixel maximum.
2. **Pattern correlation** — r > 0.25 AND r beats a spatially-aware null: `null_surrogates` phase-randomised copies of the
   measurement (same power spectrum, so its ramps and correlated atmosphere are kept) against the same prediction; one-sided
   p, Bonferroni-adjusted over the usable event/plane screens, must be <= `correlation_alpha` (default 0.01 with 999 surrogates). `null_surrogates = 0` turns it off.
   The surrogate null is approximate for ramp-dominated tiles (EQ_AUDIT E1 re-run: a few percent of atmosphere-only scenes still pass).
3. **Predicted-signal gate** — when 1 and 2 pass but the event predicts less than `predicted_signal_min_factor` x the median
   detection threshold over the tile, the answer is `INSUFFICIENT_EVIDENCE` (rule `predicted_signal_below_noise`): the tile sees a
   far-field remnant that atmosphere reproduces as often as a real earthquake. A screen that FAILS stays `NOT_SUPPORTED`.

4. **Weak events that cannot be tested** - when the screens FAIL but the best event predicts less than
   `predicted_signal_min_factor` x the detection threshold AND the measured robust peak is also below that size, the answer is
   `INSUFFICIENT_EVIDENCE` (rule `weak_prediction_no_match`), not `NOT_SUPPORTED`: neither side is sizeable, so the mismatch is not a
   contradiction. A sizeable measured signal the event cannot explain, or a strong event that is not seen, stays `NOT_SUPPORTED`.
   `weak_unmatched_is_insufficient=false` restores the old labelling.

Other behaviour changes: missing `los_enu` is a skipped screen (`events_unscreenable`), not an exception; `detrend=True` removes the
same plane operator from the prediction as from the measurement and no longer takes the reference level out twice.
The surrogate RNG is seeded from the bundle content hash, so results stay deterministic.

Other options added by the audit: `reference_strategy="stableFarField"` takes the far-field ring restricted to the bundle's
stable-ground mask (falls back to the plain ring, with a warning, when the mask is missing or leaves too few pixels);
a decisive event is cross-checked on every other stack that spans it (`detail.cross_stack_checks`; a contradicting stack
blocks SUPPORTED); a `los_convention_suspect` flag on the analysed stack turns a signed verdict into INSUFFICIENT_EVIDENCE.

## Alternatives for a negative or undecided answer (v1.4.0, `alternatives.py`)

`NOT_SUPPORTED` and `INSUFFICIENT_EVIDENCE` now also carry `detail.alternatives` = `{next_step, alternatives[]}`, one
`alternative.<id>` evidence row each, and one extra sentence in `summary`. An item is `{id, title, indication, reading,
measured, next_step}` with indication `indicated | cannot_tell | not_run | not_indicated`. **It never changes the status**: it
is a lead to follow, computed from this tile's own numbers.

| id | question | "indicated" when |
|---|---|---|
| `ramp` | is it a smooth atmosphere/orbit ramp? | removing the tilt alone (level kept) deletes >= 70 % of the detections |
| `mechanism` | right event, wrong published mechanism? | best of 180 strike/dip/rake fits (r > 0.25, amplitude within 3x) with a search-adjusted p <= 0.05 (same search on 199 phase-scrambled copies) |
| `other_events` | a catalogued event beyond `max_event_distance_km`? | it passes the same screen (up to 3 events, Bonferroni-adjusted) |
| `surface` | water / steep or incoherent ground? | >= 50 % of detections on unstable ground and >= 20 points above the tile's own share |
| `tile_size` | signal larger than the tile? | reference ring itself detected beyond `edge_touch_max_fraction` |
| `undetected` | nothing detected: expected? | the event predicts less than the threshold, or the tile is < 50 % coherent |
| `too_weak` | tile cannot test the event | rule `predicted_signal_below_noise` |
| `second_stack` | only one look direction | always `cannot_tell` when one stack was analysed |
| `localised_source` | what is left | by elimination only: ramp and tile-size not indicated and not on unstable ground |
| `uncatalogued` | one vertical-fault fit | opt-in (`explore_uncatalogued`, about 20 s per tile) |

`explore_alternatives=false` switches the whole block off. Each item is wrapped, so a failing check degrades to `not_run`.

## Tests

`python -m pytest engine/pipelines/earthquake_coseismic/tests -q` from the repo
root. `test_pipeline.py` additionally needs the engine runtime (pyproj etc.)
and exercises the real P01–P13 chain with synthetic truth.

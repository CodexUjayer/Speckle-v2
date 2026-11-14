/** Engine API response types — mirrors the engine's FastAPI payloads only.
 *  Ported from the repository's app-ui/src/lib/types.ts (Dancing_With_SARs)
 *  plus the earthquake_coseismic detail contract from
 *  engine/pipelines/earthquake_coseismic/verdict.py.
 *  Zero science: these are transport shapes. */

/* ------------------------------------------------------------------ */
/* core envelopes                                                      */
/* ------------------------------------------------------------------ */

export interface Health {
  ok: boolean;
  data_dir: string;
  data_dir_exists: boolean;
  bundles_dir: string;
  bundles_dir_exists: boolean;
  note: string;
  busy?: { kind: string; run_id: string | null; step: string | number | null; started_at: number | null } | null;
  scans_enabled?: boolean;
  earthdata_credentials?: "present" | "absent";
  cache_write?: { status: "enabled" | "disabled"; reason: string | null };
  granule_search?: { status: "enabled" | "disabled"; reason: string | null };
}

/** §5.2: the engine's answer for the MGRS tile that contains a point. */
export interface TileInfo {
  id: string;
  epsg: number;
  size_m: number;
  bbox_lonlat: [number, number, number, number];
  center_lonlat: [number, number];
  polygon_lonlat: [number, number][];
}

/** §5.4: one detected change, with geometry the engine computed. */
export interface Detection {
  id: string;
  label: string;
  kind: string;
  layer: string | null;
  centroid_lonlat: [number, number];
  bbox_lonlat: [number, number, number, number];
  area_km2: number;
  polarity: "toward" | "away" | "mixed" | null;
  metrics: Record<string, { value: number; units: string }>;
}

export interface BundleListItem {
  bundle_id: string;
  tile: string | null;
  epsg: number | null;
  center_lonlat: [number, number] | null;
  bbox_lonlat: [number, number, number, number] | null;
  epoch: string | null;
  status: string | null;
  created_at: string | null;
}

export interface RunSummary {
  id: string;
  status: string;
  kind?: "scan" | "bundle";
  tile?: string;
  bundle_id?: string;
}

export interface EvidenceItem {
  id?: string;
  kind: string;
  /** one self-contained sentence — the engine's field is `claim` */
  claim: string;
  support?: Record<string, unknown> | null;
  level?: string;
  source_ref?: string | null;
  [k: string]: unknown;
}

export interface LayerCategory {
  value: number;
  label: string;
  tone: "positive" | "negative" | "neutral";
}

export interface LayerPayload {
  name: string;
  dtype: "<f4" | "<u1";
  shape: number[];
  data_b64: string;
  units: string;
  colormap: string;
  vmin: number | null;
  vmax: number | null;
  note: string;
  /** [W, S, E, N] core-grid corners, server-computed */
  bounds_lonlat?: [number, number, number, number] | null;
  /** categorical <u1 layers: the engine's own labels for the swatches */
  categories?: LayerCategory[] | null;
}

export interface LayerResponse {
  ok: true;
  layer: LayerPayload;
  pipeline: string;
}

export interface EventItem {
  id: string;
  magnitude: number | null;
  place: string;
  time: string;
  lat: number;
  lon: number;
  depth_km: number | null;
}

export interface LayerRefLike {
  name: string;
  kind?: string;
  crs?: string | null;
  bounds_lonlat?: [number, number, number, number] | null;
}

/** Where a piece of evidence came from — the engine's provenance entries. */
export interface Source {
  adapter: string;
  url_or_id: string;
  retrieved_at?: string;
}

export interface PipelineResult {
  pipeline: string;
  tile: string;
  epoch: string | null;
  raw_p: number | null;
  status: string;
  tier?: string;
  tier_label?: string;
  summary?: string;
  evidence: EvidenceItem[];
  layers: string[] | LayerRefLike[];
  provenance?: Source[];
  data_used: string[];
  references_used: string[];
  runtime_s: number;
  warnings: string[];
  min_epochs_met: boolean | null;
  bundle_id: string | null;
  detail: Record<string, unknown> & Partial<EqDetail>;
}

export interface CacheReport {
  enabled: boolean;
  written: number;
  skipped: { pipeline: string | null; reason: string }[];
  failed: string[];
  reason?: string;
}

export interface RunState {
  id: string;
  status: "queued" | "running" | "ok" | "error";
  progress: Record<string, unknown>;
  error: string | null;
  results: PipelineResult[];
  cache?: CacheReport;
  kind?: "scan" | "bundle";
  tile?: string;
  bundle_id?: string;
}

/* ------------------------------------------------------------------ */
/* earthquake_coseismic detail contract (verdict.py)                    */
/* ------------------------------------------------------------------ */

export interface EqParamsDict {
  coherence_threshold?: number;
  reference_strategy?: string;
  far_field_margin?: number;
  detrend?: boolean;
  detection_floor_m?: number;
  significance_k?: number;
  min_valid_pixels?: number;
  min_reference_pixels?: number;
  cluster_min_pixels?: number;
  max_event_distance_km?: number;
  event_buffer_days?: number;
  forward_subgrid_max_points?: number;
  forward_top_events?: number;
  credible_pixel_factor?: number;
  cycle_jump_fraction?: number;
  edge_touch_max_fraction?: number;
  scan_pairs_per_stack?: number;
  analyse_all_stacks?: boolean;
  [k: string]: unknown;
}

export interface PairRecord {
  stack_key: string;
  pair_index: number;
  skipped?: boolean;
  reason?: string;
  reference_strategy?: string;
  edge_touch_fraction?: number | null;
  granule_ids?: string[];
  ref_time?: string | null;
  sec_time?: string | null;
  valid_pixels?: number;
  ref_offset_m?: number;
  ref_sigma_m?: number;
  detected_pixels?: number;
  affected_area_km2?: number;
  clusters?: { count?: number; largest_km2?: number; sizes_km2?: number[]; min_pixels?: number };
  null_screen?: Record<string, unknown>;
  flags?: { code?: string; message?: string; n?: number }[];
  selected?: boolean;
}

export interface EventConsidered {
  id: string;
  magnitude: number | null;
  distance_km: number;
  time: string;
  place: string;
}

export interface EventExcluded {
  id: string;
  reason?: string;
  [k: string]: unknown;
}

export interface ForwardScreenRefLike {
  event_id?: string;
  skipped?: boolean;
  [k: string]: unknown;
}

export interface UncataloguedFit {
  attempted?: boolean;
  converged?: boolean;
  reason?: string;
  parameters?: {
    strike_deg?: number;
    dip_deg?: number;
    length_m?: number;
    width_m?: number;
    centroid_depth_m?: number;
    slip_m?: number;
    sense?: string;
    [k: string]: unknown;
  };
  rms_m?: number;
  rms_ratio?: number;
  pattern_correlation?: number;
  quality?: number;
  simplifications?: string[];
  weakly_constrained?: string[];
  pinned_parameters?: string[];
  [k: string]: unknown;
}

export interface EqDecision {
  rule?: string;
  credible_area_km2?: number;
  best_event_id?: string | null;
  n_events_in_window?: number;
  failed_criteria?: string[];
  downgraded_from?: string;
  downgraded_because?: string;
  [k: string]: unknown;
}

export interface EqNarrative {
  headline?: string;
  reliability?: string;
  note?: string;
}

export interface EqInputs {
  mode?: "scan" | "event";
  selected_pair?: {
    stack?: string;
    pair_index?: number;
    ref_time?: string | null;
    sec_time?: string | null;
    granule_ids?: string[];
  };
  window?: { text?: string; n_pairs?: number; covered_days?: number; search_days?: number } & Record<string, unknown>;
  stacks?: { analysed?: string[]; note?: string } & Record<string, unknown>;
  listing?: { complete?: boolean; notes?: string[]; listing_flags?: unknown[] } & Record<string, unknown>;
  /** newest-N retrieval provenance: what the listing had vs what was analysed */
  pair_selection?: {
    per_stack?: Record<string, {
      listed?: number;
      available?: number;
      cap?: number;
      retrieved?: string[];
      merged_duplicates?: string[];
      dropped_by_cap?: string[];
    }>;
    dropped_by_cap_total?: number;
  };
  assumptions?: Record<string, unknown> | null;
  floor?: Record<string, unknown> | null;
  reference?: {
    strategy?: string;
    far_field_margin?: number;
    edge_touch_fraction?: number | null;
    edge_touch_limit?: number;
  };
}

export interface EqDetail {
  params?: EqParamsDict;
  pairs_analysed?: PairRecord[];
  events_considered?: EventConsidered[];
  events_excluded?: EventExcluded[];
  forward_screens?: ForwardScreenRefLike[];
  decision?: EqDecision;
  uncatalogued?: UncataloguedFit | null;
  layers?: Record<string, LayerPayload>;
  narrative?: EqNarrative;
  detections?: Detection[];
  detections_truncated?: boolean;
  inputs?: EqInputs;
  status_meaning?: string;
  raw_p_meaning?: string;
  routing?: { applies?: string; reasons?: string[]; needs?: string[]; proxy?: boolean } | null;
}

/* ------------------------------------------------------------------ */
/* §5.5 granule availability — mirrors the engine's Resolved shape      */
/* ------------------------------------------------------------------ */

export interface GunwPairGroup {
  ref_time: string | null;
  sec_time: string | null;
  dt_days: number | null;
  flipped: boolean;
  resolved: boolean;
  granule_ids: string[];
  frame: number | null;
  footprint: [number, number][] | null;
}

export interface GcovEpochGroup {
  time: string | null;
  granule_ids: string[];
  frame: number | null;
  footprint: [number, number][] | null;
}

export interface GranuleStack {
  direction: string | null;
  track: number | null;
  gunw: GunwPairGroup[];
  gcov: GcovEpochGroup[];
  goff?: GunwPairGroup[];
}

export interface GranuleSearchResponse {
  ok: true;
  tile: TileInfo;
  window: { t0: string; t1: string };
  stacks: Record<string, GranuleStack>;
  search_errors: Record<string, string>;
  search_degraded: boolean;
  search_incomplete?: boolean;
  dropped_older: number;
  flags: { code: string; severity: string; step: string; message: string }[];
  /** honest availability note for GCOV backscatter epochs (display-only, never verdict input) */
  gcov_note?: string;
}

export interface PipelineInfo {
  name: string;
  code: string;
  sensor: string;
  applies: string;
  uses_codes: string[];
  fetch_codes: string[];
  min_epochs: number | null;
  status_values: string[];
  implemented: boolean;
  execution?: string;
  needs_sar?: boolean;
}

/** One cached verdict row from verdicts.db (GET /api/tiles/{id}/verdicts). */
export interface StoredVerdict {
  tile: string;
  pipeline: string;
  bundle_id?: string | null;
  epoch?: string | null;
  status: string;
  tier?: string | null;
  raw_p?: number | null;
  summary?: string | null;
  run_id?: string | null;
  written_at?: string;
  first_computed_at?: string;
  result?: PipelineResult;
  [k: string]: unknown;
}

/** Scan run progress (the heartbeat payload, a subset the engine publishes). */
export interface ScanProgress {
  stage?: string;
  step_index?: number;
  step_total?: number;
  tile?: string;
  running?: boolean;
  elapsed_s?: number;
  net?: {
    mb?: number;
    mb_useful?: number;
    requests?: number;
    inflight?: number | null;
    retries?: number;
    mbps_now?: number;
    mbps_avg?: number;
    idle_s?: number | null;
  } | null;
  granules?: {
    product?: string | null;
    done?: number;
    total?: number;
    failed?: number;
    eta_s?: number | null;
  } | null;
  steps?: { code: string; name: string; status: string; seconds?: number; message?: string }[];
}

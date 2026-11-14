/** Display-only reading of the engine's results for the map's verdict dock.
 *  Nothing here decides a tier, a hazard or a box: the engine does. This file only
 *  (1) picks which finished result to lead with, using the engine's own tier and the same
 *  display precedence the rest of the UI uses, (2) gives a pipeline's folder name a plain
 *  English name, and (3) lifts the engine's own sentence and detection boxes out of the result. */
import type { CachedSummary, PipelineResult } from "./types";
import { TIER_PRECEDENCE } from "./status";

/** plain names for pipeline folder names; an unknown name falls back to its words */
const HAZARD_NAMES: Record<string, string> = {
  coastal_erosion: "Coastal erosion",
  deforestation: "Forest loss",
  earthquake_coseismic: "Earthquake",
  flood_inundation: "Flooding",
  glacier_ice_flow: "Glacier movement",
  iceberg_calving_drift: "Iceberg calving",
  land_subsidence: "Sinking ground",
  landslide: "Landslide",
  oil_spill: "Oil spill",
  permafrost_thaw: "Thawing permafrost",
  river_erosion: "River erosion",
  tropical_cyclone: "Cyclone damage",
  tsunami_inundation: "Tsunami flooding",
  tsunami_ocean_evidence: "Tsunami at sea",
  urban_damage: "Damage to buildings",
  volcanic_deformation: "Volcano swelling",
  wildfire_burn_scar: "Wildfire burn scar",
};

export function hazardName(pipeline: string): string {
  const hit = HAZARD_NAMES[pipeline];
  if (hit) return hit;
  const words = pipeline.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/** display punctuation only: a spaced dash inside an engine sentence reads better as a comma */
export const tidy = (s: string) => s.replace(/\s[\u2014\u2013]\s/g, ", ").trim();

export interface Hotspot {
  id: string;
  label: string;
  /** the result layer the engine drew this box on; null = not tied to one layer */
  layer: string | null;
  bbox: [number, number, number, number];   // [W, S, E, N], from the engine
  areaKm2: number | null;
}

export interface VerdictView {
  pipeline: string;
  hazard: string;
  tier: string;
  tierLabel: string;
  /** the engine's own sentence (narrative headline, else its summary) */
  sentence: string;
  /** a second engine sentence when it has one (how reliable the reading is) */
  reliability: string | null;
  hotspots: Hotspot[];
  /** what the status means, in the engine's words */
  statusMeaning: string | null;
  /** the lead result itself and the others, so the player can walk through their layers and evidence (null on summary-only verdicts) */
  result: PipelineResult | null;
  others: PipelineResult[];
  bundleId: string | null;
  /** false when this came from a cached summary row (no detections, no pair facts yet) */
  full: boolean;
  /** how many other hazard checks also reported something notable */
  alsoNotable: number;
}

type WithTier = PipelineResult & { tier?: string; tier_label?: string };

const rank = (t: string) => {
  const i = (TIER_PRECEDENCE as readonly string[]).indexOf(t);
  return i < 0 ? 99 : i;
};

const TIER_WORDS: Record<string, string> = {
  supported: "Supported by evidence",
  candidate: "Possible",
  quiet: "Quiet",
  not_supported: "Not supported",
  insufficient: "Not enough data",
  pending: "Not run yet",
  not_applicable: "Did not apply",
  not_modelled: "Not built yet",
  error: "Run failed",
};
export const tierWords = (tier: string, engineLabel?: string | null) => engineLabel || TIER_WORDS[tier] || tier;

/** tiers that mean "the engine saw something worth a look" (display grouping only) */
const NOTABLE = new Set(["supported", "candidate"]);

export function pickVerdict(results: PipelineResult[]): VerdictView | null {
  if (!results.length) return null;
  const tiered = results.map((r) => ({ r: r as WithTier, tier: (r as WithTier).tier ?? "insufficient" }));
  tiered.sort((a, b) => rank(a.tier) - rank(b.tier) || (b.r.raw_p ?? -1) - (a.r.raw_p ?? -1));
  const lead = tiered[0];
  const r = lead.r;
  const detail = r.detail as {
    narrative?: { headline?: string; reliability?: string };
    detections?: { id: string; label: string; layer?: string | null; bbox_lonlat: [number, number, number, number]; area_km2?: number }[];
    status_meaning?: string;
  };
  const hotspots: Hotspot[] = (detail?.detections ?? [])
    .filter((d) => Array.isArray(d.bbox_lonlat) && d.bbox_lonlat.length === 4 && d.bbox_lonlat.every(Number.isFinite))
    .slice(0, 10)
    .map((d) => ({ id: d.id, label: tidy(d.label), layer: d.layer ?? null, bbox: d.bbox_lonlat, areaKm2: typeof d.area_km2 === "number" ? d.area_km2 : null }));
  const hazard = hazardName(r.pipeline);
  const label = tierWords(lead.tier, r.tier_label);
  return {
    pipeline: r.pipeline,
    hazard,
    tier: lead.tier,
    tierLabel: label,
    sentence: tidy(detail?.narrative?.headline || r.summary || `${hazard}: ${label.toLowerCase()}`),
    reliability: detail?.narrative?.reliability ? tidy(detail.narrative.reliability) : null,
    hotspots,
    statusMeaning: detail?.status_meaning ? tidy(detail.status_meaning) : null,
    result: r,
    others: tiered.slice(1).map((x) => x.r),
    bundleId: r.bundle_id ?? null,
    full: true,
    alsoNotable: tiered.slice(1).filter((x) => NOTABLE.has(x.tier)).length,
  };
}

/** a tile with only cached summary rows: enough for the sentence, not for boxes */
export function verdictFromSummaries(rows: CachedSummary[]): VerdictView | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => rank(a.tier ?? "insufficient") - rank(b.tier ?? "insufficient") || (b.raw_p ?? -1) - (a.raw_p ?? -1));
  const r = sorted[0];
  const tier = r.tier ?? "insufficient";
  const hazard = hazardName(r.pipeline);
  const label = tierWords(tier);
  return {
    pipeline: r.pipeline, hazard, tier, tierLabel: label,
    sentence: tidy(r.summary || `${hazard}: ${label.toLowerCase()}`),
    reliability: null, hotspots: [], statusMeaning: null, result: null, others: [], bundleId: r.bundle_id, full: false,
    alsoNotable: sorted.slice(1).filter((x) => NOTABLE.has(x.tier ?? "")).length,
  };
}

/** the tone the dock draws for a tier; the words always sit next to it */
export function tierTone(tier: string): "alert" | "watch" | "calm" | "unknown" {
  if (tier === "supported") return "alert";
  if (tier === "candidate") return "watch";
  if (tier === "quiet" || tier === "not_supported") return "calm";
  return "unknown";
}

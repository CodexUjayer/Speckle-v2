/** Shared presentation helpers for the Earthquake page.
 *  Pure formatting/colour mapping — no science is computed here. */

import type { EventItem, PipelineResult, StoredVerdict } from "@/lib/engine/types";

/* ------------------------------------------------------------------ */
/* investigation target — what the page points the engine at             */
/* ------------------------------------------------------------------ */

export interface Target {
  lon: number;
  lat: number;
  label: string;
  source: "live" | "curated" | "custom";
  /** the USGS ComCat event record, when the target came from the live feed */
  event?: EventItem | null;
  /** the repository's curated record, when the target came from the curated list */
  curated?: CuratedQuake | null;
}

/* ------------------------------------------------------------------ */
/* verdict tiers — the engine's own tiers (engine/verdict/calibrate.py)  */
/* mapped onto the landing's verdict-vocabulary tones                   */
/* ------------------------------------------------------------------ */

export type Tone = "ok" | "mid" | "off" | "quiet" | "dim";

export const TIER_TONE: Record<string, Tone> = {
  supported: "ok",
  candidate: "mid",
  not_supported: "off",
  insufficient: "dim",
  quiet: "quiet",
  pending: "dim",
  not_applicable: "dim",
  not_modelled: "dim",
  error: "off",
};

/** The engine's own tier labels (engine/verdict/calibrate.py TIER_LABEL) —
 *  used when a stored-verdict row carries a tier but no label. */
export const TIER_LABEL: Record<string, string> = {
  supported: "supported by evidence",
  candidate: "candidate / possible",
  not_supported: "not supported by evidence",
  insufficient: "not enough evidence",
  quiet: "no signal — quiet tile",
  pending: "not run (yet)",
  not_applicable: "did not apply here",
  not_modelled: "not modelled yet",
  error: "run failed",
};

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-[#3ecf9a]",
  mid: "bg-[#e8b74e]",
  off: "bg-[#ff5d55]",
  quiet: "bg-[#93a1b8]",
  dim: "bg-[#6f7e97]",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[#3ecf9a]",
  mid: "text-[#e8b74e]",
  off: "text-[#ff5d55]",
  quiet: "text-[#93a1b8]",
  dim: "text-[var(--qp-ink-3)]",
};

export const TONE_STROKE: Record<Tone, string> = {
  ok: "#3ecf9a",
  mid: "#e8b74e",
  off: "#ff5d55",
  quiet: "#93a1b8",
  dim: "rgba(165, 178, 200, 0.35)",
};

export function toneOf(result: Pick<PipelineResult, "status" | "tier">): Tone {
  return TIER_TONE[result.tier ?? ""] ?? TIER_TONE[result.status] ?? "dim";
}

/* ------------------------------------------------------------------ */
/* formatting                                                           */
/* ------------------------------------------------------------------ */

export function fmtMagnitude(m: number | null | undefined): string {
  return m === null || m === undefined || Number.isNaN(m) ? "M ?" : `M ${m.toFixed(1)}`;
}

export function fmtDepth(km: number | null | undefined): string {
  return km === null || km === undefined ? "depth unknown" : `${km.toFixed(0)} km deep`;
}

export function fmtKm(km: number | null | undefined, digits = 0): string {
  return km === null || km === undefined ? "—" : `${km.toFixed(digits)} km`;
}

/** metres → millimetres, the honest unit for coseismic LOS displacement. */
export function fmtMm(m: number | null | undefined, digits = 1): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "—";
  return `${(m * 1000).toFixed(digits)} mm`;
}

export function fmtArea(km2: number | null | undefined, digits = 1): string {
  return km2 === null || km2 === undefined ? "—" : `${km2.toFixed(digits)} km²`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits });
}

/** A display label for a run/verdict pipeline result, e.g.
 *  "SUPPORTED · supported by evidence". */
export function tierLine(result: Pick<PipelineResult, "status" | "tier_label" | "tier">): string {
  const status = result.status.replaceAll("_", " ").toLowerCase();
  const label = result.tier_label ?? (result.tier ? TIER_LABEL[result.tier] : undefined);
  return label ? `${status} · ${label}` : status;
}

/** The engine's evidence sentence for one item — the pipeline's own field
 *  is `claim`; the registry's synthesised NOT_RUN items use `reason`. */
export function evidenceText(ev: { claim?: string; reason?: string }): string {
  return String(ev.claim ?? ev.reason ?? "");
}

/** The main one-sentence result — the engine's own summary when present,
 *  otherwise an honest statement derived ONLY from the status itself. */
export function mainSentence(result: Pick<PipelineResult, "status" | "summary">): string {
  if (result.summary) return result.summary;
  switch (result.status) {
    case "NOT_RUN":
      return "This analysis could not run on the data the engine could retrieve — its own reasons are listed below.";
    case "ERROR":
      return "The analysis failed while running — the engine recorded the error.";
    default:
      return "The engine returned no summary line for this verdict.";
  }
}

/* ------------------------------------------------------------------ */
/* curated earthquakes — the repository's own curated list               */
/* (app-ui/src/lib/disasters.json, Earthquake category)                  */
/* ------------------------------------------------------------------ */

export interface CuratedQuake {
  id: string;
  event: string;
  region: string;
  dateText: string;
  lat: number;
  lon: number;
  size: string;
  sarAngle: string;
  /** ISO-8601 UTC origin time, when known — anchors the engine's scan window
   *  (as_of) to the event so the interferograms span the quake itself. */
  eventTime?: string;
}

import curatedJson from "./curated.json";

export const CURATED_QUAKES: CuratedQuake[] = curatedJson as CuratedQuake[];

/* ------------------------------------------------------------------ */
/* preset regions for the live event feed (USGS ComCat via the engine)   */
/* ------------------------------------------------------------------ */

export interface Region {
  id: string;
  label: string;
  lon: number;
  lat: number;
}

export const REGIONS: Region[] = [
  { id: "japan", label: "Japan", lon: 139.5, lat: 35.7 },
  { id: "philippines", label: "Philippines", lon: 124.0, lat: 11.0 },
  { id: "indonesia", label: "Indonesia", lon: 120.0, lat: -2.0 },
  { id: "turkiye", label: "Türkiye", lon: 32.0, lat: 39.0 },
  { id: "afghanistan", label: "Afghanistan", lon: 68.0, lat: 35.5 },
  { id: "himalaya", label: "Himalaya", lon: 88.0, lat: 28.0 },
  { id: "iran", label: "Iran", lon: 57.0, lat: 32.0 },
  { id: "chile", label: "Chile", lon: -71.0, lat: -33.0 },
  { id: "peru", label: "Peru", lon: -75.0, lat: -10.0 },
  { id: "alaska", label: "Alaska", lon: -152.0, lat: 61.0 },
  { id: "california", label: "California", lon: -119.0, lat: 36.5 },
  { id: "kamchatka", label: "Kamchatka", lon: 160.0, lat: 53.0 },
  { id: "nz", label: "New Zealand", lon: 174.0, lat: -41.0 },
  { id: "greece", label: "Greece / Aegean", lon: 24.0, lat: 38.5 },
];

/** The LOS sign convention, in the engine's words (README + layer units). */
export const LOS_CONVENTION =
  "Positive LOS displacement is movement TOWARD the satellite (later acquisition minus earlier).";

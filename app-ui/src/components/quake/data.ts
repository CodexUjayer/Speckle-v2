"use client";

/** Quake-page label helpers + the transport shape of the engine's per-event
 *  forward screens. Mirrors the repo's speckle/data.ts convention: this file
 *  NAMES the engine's own parameters (the engine computes; the UI reads and
 *  labels). Every field name matches the engine's JSON exactly.
 */

/** One row of the engine's forward-screening table: for a catalogued event
 *  (its id), which nodal plane of its moment-tensor mechanism matched, the
 *  screen's amplitudes/correlations, and its verdict note. Values are the
 *  engine's — the UI never recomputes them. */
export interface ForwardScreen {
  event_id: string;
  nodal_plane: number;
  skipped: boolean;
  skip_reason?: string | null;
  amplitude_ratio: number | null;
  pattern_correlation: number | null;
  predicted_peak_m: number | null;
  measured_peak_m: number | null;
  epicentre?: { lat: number; lon: number; projected_x: number; projected_y: number; epsg: number };
  note?: string;
}

/** Row label in the screening table: which event, which plane. */
export function crossCheckLabel(s: ForwardScreen): string {
  return `${s.event_id} · P${s.nodal_plane}`;
}

/** Compact note line: the engine's own remark for a screened event. */
export function crossCheckNote(s: ForwardScreen): string {
  return `${s.event_id}·P${s.nodal_plane}: ${s.note}`;
}

/** Short chart-series name (last 6 chars of the id + the plane). */
export function crossCheckName(s: ForwardScreen): string {
  return `${s.event_id.slice(-6)}·P${s.nodal_plane}`;
}

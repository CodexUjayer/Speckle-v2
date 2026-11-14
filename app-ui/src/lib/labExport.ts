/** labExport — serialize an engine panel answer to CSV or JSON for download (Phase 4).
 *  Pure presentation of ENGINE numbers: every value, unit, bin edge and note is copied
 *  verbatim from the engine's response; nothing is computed, rounded differently, or
 *  renamed. CSV cells are quoted when needed (units contain commas); numbers use
 *  String(n) so JS never reformats what the engine sent. */
import type { InspectResponse, RoiResponse, TimeseriesResponse } from "@/lib/types";

export interface ExportPayload {
  /** a short machine-readable name for the file, e.g. "lab-series" */
  stem: string;
  json: unknown;
  csv: () => string;
}

const q = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const row = (cells: (string | number | null | undefined)[]): string => cells.map(q).join(",");

/** the series: one row per date (id, date, value, n_valid, nan_fraction) + header. */
export function exportSeries(res: TimeseriesResponse): ExportPayload {
  return {
    stem: "lab-series",
    json: res,
    csv: () => [
      row(["id", "date", "value", "n_valid", "nan_fraction"]),
      ...res.points.map((p) => row([p.id, p.date, p.value, p.n_valid, p.nan_fraction])),
      ...(res.missing.length ? ["", row(["missing_id", "reason"]), ...res.missing.map((m) => row([m.id, m.reason]))] : []),
    ].join("\n"),
  };
}

/** the histogram: one row per bin (from, to, count) + header; stats ride along as a
 *  commented header row the same tools read. */
export function exportHistogram(res: InspectResponse): ExportPayload {
  const edges = res.histogram.edges;
  const counts = res.histogram.counts;
  return {
    stem: "lab-histogram",
    json: res,
    csv: () => [
      row(["# layer", res.layer, "scale", res.scale, "unit", res.unit ?? "", "date", res.date ?? ""]),
      row(["bin_from", "bin_to", "count"]),
      ...counts.map((c, i) => row([edges[i], edges[i + 1], c])),
      "",
      row(["# n_valid", res.histogram.n, "n_bins", res.histogram.bins]),
    ].join("\n"),
  };
}

/** the profile: one row per sample (i, lon, lat, km, value) + header. */
export function exportProfile(res: InspectResponse): ExportPayload {
  const prof = res.profile;
  if (!prof) return exportHistogram(res);
  return {
    stem: "lab-profile",
    json: res,
    csv: () => [
      row(["# a_lonlat", `${prof.a_lonlat[0]},${prof.a_lonlat[1]}`, "b_lonlat", `${prof.b_lonlat[0]},${prof.b_lonlat[1]}`,
           "length_m", prof.length_m, "n_valid", `${prof.n_valid}/${prof.n_samples}`]),
      row(["i", "lon", "lat", "value"]),
      ...prof.samples.map((sm) => row([sm.i, sm.lon, sm.lat, sm.value])),
    ].join("\n"),
  };
}

/** the ROI: stats block + one row per bin; the shape's ring rides along. */
export function exportRoi(res: RoiResponse): ExportPayload {
  const r = res.roi;
  return {
    stem: "lab-roi",
    json: res,
    csv: () => [
      row(["# layer", res.layer, "scale", res.scale, "unit", res.unit ?? "", "date", res.date ?? ""]),
      row(["# shape", r.kind, "ring", r.ring.map((p) => `${p[0]},${p[1]}`).join(" "),
           "area_km2", r.area_km2, "n_pixels", r.n_pixels, "n_valid", r.n_valid,
           "pitch_m", `${r.pixel_pitch_m[0]}x${r.pixel_pitch_m[1]}`]),
      row(["stat", "value"]),
      row(["min", r.stats.min]), row(["mean", r.stats.mean]), row(["max", r.stats.max]),
      row(["p2", r.stats.p2]), row(["p50", r.stats.p50]), row(["p98", r.stats.p98]),
      "",
      row(["bin_from", "bin_to", "count"]),
      ...r.histogram.counts.map((c, i) => row([r.histogram.edges[i], r.histogram.edges[i + 1], c])),
      ...(res.notes.length ? ["", row(["# note", res.notes.join(" | ")])] : []),
    ].join("\n"),
  };
}

/** trigger a download of the payload in the browser (Blob + object URL, revoked after). */
export function downloadExport(payload: ExportPayload, fmt: "csv" | "json"): void {
  const body = fmt === "csv" ? payload.csv() : JSON.stringify(payload.json, null, 2);
  const blob = new Blob([body], { type: fmt === "csv" ? "text/csv" : "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${payload.stem}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
  a.click();
  URL.revokeObjectURL(url);
}

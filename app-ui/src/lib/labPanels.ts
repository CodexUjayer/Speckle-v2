/** LabPanel pure helpers — chart geometry and formatting for the Data Lab's bottom panel.
 *  Presentation only: every VALUE comes from the engine (inspect / timeseries); these helpers
 *  decide where a pixel goes and how a number reads. No SAR science, no unit conversion. */

/** y range of a series with an 8% pad; null when there is nothing finite to draw. */
export function seriesYRange(values: (number | null)[]): { lo: number; hi: number } | null {
  const f = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (f.length === 0) return null;
  let lo = Math.min(...f);
  let hi = Math.max(...f);
  if (hi === lo) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

/** cumulative great-circle distance (km) along lon/lat samples, starting at 0 — the profile
 *  chart's x axis. Spherical earth is fine for a chart axis; the ENGINE states the true length. */
export function cumulativeKm(points: { lon: number; lat: number }[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const R = 6371.0088;
      const dLat = ((points[i].lat - points[i - 1].lat) * Math.PI) / 180;
      const dLon = ((points[i].lon - points[i - 1].lon) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos((points[i - 1].lat * Math.PI) / 180) * Math.cos((points[i].lat * Math.PI) / 180)
          * Math.sin(dLon / 2) ** 2;
      acc += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    out.push(acc);
  }
  return out;
}

/** bar geometry for a histogram (SVG user units). Zero-height bars still render (min 0.5 px). */
export function histogramBars(
  edges: number[], counts: number[], width: number, height: number,
): { x: number; y: number; w: number; h: number; count: number; from: number; to: number }[] {
  if (edges.length < 2 || counts.length === 0) return [];
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  const span = hi - lo || 1;
  const max = Math.max(...counts, 1);
  const bw = width / counts.length;
  return counts.map((count, i) => {
    const h = (count / max) * (height - 4);
    return {
      x: i * bw,
      y: height - h,
      w: bw,
      h: count > 0 ? Math.max(0.5, h) : 0,
      count,
      from: edges[i],
      to: edges[i + 1],
    };
  }).filter((b) => b.from >= lo && b.from <= hi);
}

/** axis tick values for a numeric range (about `n` ticks, readable decimals). */
export function numTicks(lo: number, hi: number, n = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const span = hi - lo;
  const step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = (span / n) / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(Number(v.toPrecision(6)));
  return out;
}

/** "2026-09-20T13:09:00Z" -> "Sep 20" (UTC); null-safe. */
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** a readable value for axes/titles; engine unit appended when known. */
export function fmtVal(v: number | null | undefined, unit?: string | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Number(v.toPrecision(3)));
  return unit ? `${s} ${unit}` : s;
}

/** x position of a time within [t0..t1] (ms), clamped. */
export function timeToX(tMs: number, t0Ms: number, t1Ms: number, width: number, padL: number, padR: number): number {
  if (t1Ms <= t0Ms) return padL;
  const frac = (tMs - t0Ms) / (t1Ms - t0Ms);
  return padL + Math.min(1, Math.max(0, frac)) * (width - padL - padR);
}

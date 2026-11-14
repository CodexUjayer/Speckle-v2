"use client";

/** Charts for the Advanced tab — every value is a field the engine sent.
 *  recharts renders them in the page's palette; axes/units are labelled
 *  from the engine's own unit strings. */

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ScatterChart,
  Scatter,
  ZAxis,
  ReferenceLine,
  Cell,
} from "recharts";
import type { EventConsidered, PairRecord, Detection } from "@/lib/engine/types";
import { crossCheckName, type ForwardScreen } from "../data";

/** recharts hands labelFormatter a payload ARRAY (of {payload: row} entries);
 *  every chart here labels the first row it was hovered over. */
function firstPayload<T>(items: unknown): T | undefined {
  const first = Array.isArray(items) ? items[0] : items;
  return (first as { payload?: T } | undefined)?.payload;
}

const AXIS = {
  stroke: "rgba(255,255,255,0.25)",
  tick: { fill: "rgba(255,255,255,0.5)", fontSize: 10, fontFamily: "ui-monospace, monospace" },
} as const;

const TOOLTIP = {
  contentStyle: {
    background: "#0a0f18",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    fontSize: 11,
    fontFamily: "ui-monospace, monospace",
    color: "rgba(255,255,255,0.85)",
  },
  labelStyle: { color: "rgba(255,255,255,0.6)" },
  cursor: { fill: "rgba(255,255,255,0.04)" },
} as const;

const GRID = { stroke: "rgba(255,255,255,0.06)" } as const;

/** mount gate — recharts needs a measured container; renders empty until
 *  hydrated (server snapshot false, client snapshot true — no setState) */
function useMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/* ------------------------------------------------------------------ */
/* events considered — magnitude bars, distance-coded                    */
/* ------------------------------------------------------------------ */

export function EventsChart({ events }: { events: EventConsidered[] }) {
  const mounted = useMounted();
  if (!events.length) return null;
  const data = events.map((e) => ({
    id: e.id,
    magnitude: e.magnitude ?? 0,
    distance: e.distance_km,
    place: e.place,
    time: e.time?.slice(0, 10),
  }));
  if (!mounted) return <div className="h-56" />;
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
          <XAxis dataKey="id" stroke={AXIS.stroke} tick={AXIS.tick} tickFormatter={(v: string) => v.slice(-6)} />
          <YAxis stroke={AXIS.stroke} tick={AXIS.tick} label={{ value: "Mw", angle: 0, position: "insideLeft", fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number, n: string, p: { payload?: { distance?: number; place?: string; time?: string } }) => [
              n === "magnitude" ? `${v} Mw` : v,
              n === "magnitude" ? "magnitude" : n,
            ]}
            labelFormatter={(v: unknown, items: unknown) => {
              const d = firstPayload<{ distance?: number; place?: string; time?: string }>(items);
              return `${v}${d ? ` · ${d.place ?? ""} · ${d.distance?.toFixed(0)} km from tile · ${d.time ?? ""}` : ""}`;
            }}
          />
          <Bar dataKey="magnitude" radius={[3, 3, 0, 0]} maxBarSize={44}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.distance <= 100 ? "#3ecf9a" : d.distance <= 250 ? "#e8b74e" : "#6f7e97"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* forward screens — predicted vs measured peak, and the screen plane    */
/* ------------------------------------------------------------------ */

export function ScreensChart({ screens }: { screens: ForwardScreen[] }) {
  const mounted = useMounted();
  const usable = screens.filter((s) => !s.skipped && s.predicted_peak_m !== null);
  if (!usable.length) return null;
  const data = usable.map((s) => ({
    name: crossCheckName(s),
    predicted: +((s.predicted_peak_m ?? 0) * 1000).toFixed(2),
    measured: +((s.measured_peak_m ?? 0) * 1000).toFixed(2),
    ratio: +(s.amplitude_ratio ?? 0).toFixed(2),
    corr: +(s.pattern_correlation ?? 0).toFixed(2),
  }));
  if (!mounted) return <div className="h-64" />;
  return (
    <div className="h-64">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
          <XAxis dataKey="name" stroke={AXIS.stroke} tick={AXIS.tick} />
          <YAxis stroke={AXIS.stroke} tick={AXIS.tick} label={{ value: "mm", angle: 0, position: "insideLeft", fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number, n: string) => [`${v} mm`, n === "predicted" ? "Model-predicted peak" : "measured peak"]}
            labelFormatter={(v: unknown, items: unknown) =>
              `${v} · ratio ${firstPayload<{ ratio?: number; corr?: number }>(items)?.ratio} · corr ${firstPayload<{ ratio?: number; corr?: number }>(items)?.corr}`
            }
          />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.5)" }} />
          <Bar dataKey="predicted" fill="#6f7e97" radius={[3, 3, 0, 0]} maxBarSize={26} name="predicted" />
          <Bar dataKey="measured" fill="#3ecf9a" radius={[3, 3, 0, 0]} maxBarSize={26} name="measured" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** the two screen statistics against the engine's own thresholds
 *  (ratio factor 3, correlation floor 0.25 — displayed from the values,
 *  thresholds quoted in the engine's evidence text) */
export function ScreensScatter({ screens }: { screens: ForwardScreen[] }) {
  const mounted = useMounted();
  const usable = screens.filter((s) => !s.skipped);
  if (!usable.length) return null;
  const data = usable.map((s) => ({
    x: +(s.amplitude_ratio ?? 0).toFixed(3),
    y: +(s.pattern_correlation ?? 0).toFixed(3),
    z: 60,
    name: crossCheckName(s),
  }));
  if (!mounted) return <div className="h-56" />;
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} />
          <XAxis
            type="number"
            dataKey="x"
            name="amplitude ratio"
            stroke={AXIS.stroke}
            tick={AXIS.tick}
            domain={[0, "dataMax"]}
            label={{ value: "measured / predicted amplitude ratio", position: "insideBottom", offset: -8, fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="pattern correlation"
            stroke={AXIS.stroke}
            tick={AXIS.tick}
            domain={[-0.2, 1]}
            label={{ value: "pattern correlation r", angle: -90, position: "insideLeft", fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
          />
          <ZAxis type="number" dataKey="z" range={[50, 50]} />
          {/* the engine's screen thresholds: within factor 3, above r = 0.25 */}
          <ReferenceLine x={1 / 3} stroke="rgba(227,207,154,0.5)" strokeDasharray="4 4" />
          <ReferenceLine x={3} stroke="rgba(227,207,154,0.5)" strokeDasharray="4 4" />
          <ReferenceLine y={0.25} stroke="rgba(227,207,154,0.5)" strokeDasharray="4 4" />
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number, n: string) => [v, n]}
            labelFormatter={() => ""}
          />
          <Scatter data={data} fill="#3ecf9a" />
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)]">
        dashed lines = the engine&apos;s screen bounds (ratio within ×3, r &gt; 0.25) · the
        upper-right quadrant passes
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* pairs analysed — per-pair detection weight                            */
/* ------------------------------------------------------------------ */

export function PairsChart({ pairs }: { pairs: PairRecord[] }) {
  const mounted = useMounted();
  const usable = pairs.filter((p) => !p.skipped);
  if (!usable.length) return null;
  const data = usable.map((p) => ({
    name: `${p.stack_key}#${p.pair_index}`,
    detected: p.detected_pixels ?? 0,
    area: +(p.affected_area_km2 ?? 0).toFixed(2),
    window: `${(p.ref_time ?? "").slice(0, 10)}→${(p.sec_time ?? "").slice(0, 10)}`,
    selected: p.selected,
  }));
  if (!mounted) return <div className="h-56" />;
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
          <XAxis dataKey="name" stroke={AXIS.stroke} tick={AXIS.tick} />
          <YAxis stroke={AXIS.stroke} tick={AXIS.tick} label={{ value: "px", angle: 0, position: "insideLeft", fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number) => [`${v} px above threshold`, "detected pixels"]}
            labelFormatter={(v: unknown, items: unknown) =>
              `${v} · ${firstPayload<{ window?: string; area?: number }>(items)?.window ?? ""} · ${firstPayload<{ window?: string; area?: number }>(items)?.area} km² affected`
            }
          />
          <Bar dataKey="detected" radius={[3, 3, 0, 0]} maxBarSize={40}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.selected ? "#3ecf9a" : "rgba(165,178,200,0.55)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* clusters — the engine's detection ranking                             */
/* ------------------------------------------------------------------ */

export function ClustersChart({ detections }: { detections: Detection[] }) {
  const mounted = useMounted();
  if (!detections.length) return null;
  const data = [...detections]
    .sort((a, b) => b.area_km2 - a.area_km2)
    .slice(0, 15)
    .map((d, i) => ({
      name: `#${i + 1}`,
      area: +d.area_km2.toFixed(3),
      polarity: d.polarity,
      peak: d.metrics?.peak_abs_los_m?.value,
    }));
  if (!mounted) return <div className="h-56" />;
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} horizontal={false} />
          <XAxis type="number" stroke={AXIS.stroke} tick={AXIS.tick} label={{ value: "km²", angle: 0, position: "insideBottom", fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
          <YAxis type="category" dataKey="name" stroke={AXIS.stroke} tick={AXIS.tick} width={34} />
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number, n: string, p: { payload?: { polarity?: string; peak?: number } }) => [
              `${v} km² · ${p?.payload?.polarity ?? "—"}${p?.payload?.peak !== undefined ? ` · peak ${(p.payload.peak * 1000).toFixed(1)} mm` : ""}`,
              "cluster area",
            ]}
          />
          <Bar dataKey="area" radius={[0, 3, 3, 0]} maxBarSize={18}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.polarity === "toward" ? "#3ecf9a" : d.polarity === "away" ? "#ff5d55" : "#e8b74e"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

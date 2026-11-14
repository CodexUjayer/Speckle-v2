"use client";

/** Observation-coverage timeline — a custom SVG chart drawn ONLY from the
 *  engine's own granule listing (GET /api/granules): one row per radar
 *  stack, one bar per interferometric pair (ref→sec acquisition window,
 *  engine-computed dt_days), dots for backscatter epochs. No values are
 *  invented or derived client-side beyond reading the engine's fields. */

import { useMemo, useState } from "react";
import type { GranuleSearchResponse, GranuleStack } from "@/lib/engine/types";
import { fmtDate } from "../shared";
interface Row {
  key: string;
  stack: GranuleStack;
  pairs: {
    ref: number;
    sec: number;
    dt: number | null;
    flipped: boolean;
    resolved: boolean;
    granules: number;
  }[];
  epochs: number[];
}

export default function CoverageTimeline({ data }: { data: GranuleSearchResponse }) {
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  const { rows, t0, t1 } = useMemo(() => {
    const times: number[] = [];
    const out: Row[] = [];
    for (const [key, stack] of Object.entries(data.stacks ?? {})) {
      const row: Row = { key, stack, pairs: [], epochs: [] };
      for (const g of stack.gunw ?? []) {
        const r = g.ref_time ? Date.parse(g.ref_time) : null;
        const s = g.sec_time ? Date.parse(g.sec_time) : null;
        if (r !== null && s !== null && Number.isFinite(r) && Number.isFinite(s)) {
          row.pairs.push({
            ref: Math.min(r, s),
            sec: Math.max(r, s),
            dt: g.dt_days ?? null,
            flipped: g.flipped,
            resolved: g.resolved,
            granules: g.granule_ids?.length ?? 0,
          });
          times.push(Math.min(r, s), Math.max(r, s));
        } else {
          row.pairs.push({
            ref: Date.now(),
            sec: Date.now(),
            dt: g.dt_days ?? null,
            flipped: g.flipped,
            resolved: false,
            granules: g.granule_ids?.length ?? 0,
          });
        }
      }
      for (const e of stack.gcov ?? []) {
        if (e.time) {
          const t = Date.parse(e.time);
          if (Number.isFinite(t)) {
            row.epochs.push(t);
            times.push(t);
          }
        }
      }
      if (row.pairs.length || row.epochs.length) out.push(row);
    }
    out.sort((a, b) => (a.stack.direction ?? "") .localeCompare(b.stack.direction ?? "") || a.key.localeCompare(b.key));
    const w0 = Date.parse(data.window.t0);
    const w1 = Date.parse(data.window.t1);
    const lo = Math.min(w0, ...times);
    const hi = Math.max(w1, ...times);
    return { rows: out, t0: Number.isFinite(lo) ? lo : w0, t1: Number.isFinite(hi) ? hi : w1 };
  }, [data]);

  /* month ticks — computed unconditionally (hooks order) */
  const ticks: { t: number; label: string }[] = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    const d = new Date(t0);
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    while (d.getTime() < t1) {
      out.push({ t: d.getTime(), label: d.toLocaleDateString("en-GB", { month: "short" }) });
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }, [t0, t1]);

  if (!rows.length) return null;

  /* geometry */
  const W = 1000;
  const rowH = 34;
  const headH = 26;
  const H = headH + rows.length * rowH + 8;
  const padL = 8;
  const padR = 8;
  const span = Math.max(t1 - t0, 1);
  const x = (t: number) => padL + ((t - t0) / span) * (W - padL - padR);

  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Acquisition timeline: ${rows.length} radar stacks, bars are interferometric pair windows`}
      >
        {/* month grid */}
        {ticks.map((tk) => (
          <g key={tk.t}>
            <line
              x1={x(tk.t)}
              x2={x(tk.t)}
              y1={headH - 6}
              y2={H - 6}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
            <text
              x={x(tk.t)}
              y={14}
              fill="rgba(255,255,255,0.35)"
              fontSize={11}
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
            >
              {tk.label}
            </text>
          </g>
        ))}
        {/* search window bounds */}
        <text x={padL} y={14} fill="rgba(255,255,255,0.35)" fontSize={11} fontFamily="ui-monospace, monospace">
          {fmt(t0)}
        </text>
        <text
          x={W - padR}
          y={14}
          fill="rgba(255,255,255,0.35)"
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          textAnchor="end"
        >
          {fmt(t1)}
        </text>

        {rows.map((row, i) => {
          const y = headH + i * rowH;
          return (
            <g key={row.key}>
              <text
                x={padL}
                y={y + 13}
                fill="rgba(255,255,255,0.55)"
                fontSize={11}
                fontFamily="ui-monospace, monospace"
              >
                {row.stack.direction === "A" ? "ASC" : row.stack.direction === "D" ? "DESC" : "?"} ·
                track {row.stack.track ?? "?"}
              </text>
              {/* epochs — small dots on the row baseline */}
              {row.epochs.map((t, j) => (
                <circle key={`e${j}`} cx={x(t)} cy={y + 22} r={2} fill="rgba(169,191,214,0.4)" />
              ))}
              {/* pair windows */}
              {row.pairs.map((p, j) => {
                const x1 = x(p.ref);
                const x2 = Math.max(x(p.sec), x1 + 3);
                const w = x2 - x1;
                const long = (p.dt ?? 0) > 24;
                return (
                  <g key={`p${j}`}>
                    <rect
                      x={x1}
                      y={y + 15}
                      width={w}
                      height={9}
                      rx={4.5}
                      fill={p.flipped ? "rgba(227,207,154,0.55)" : long ? "rgba(201,141,126,0.5)" : "rgba(143,216,200,0.55)"}
                      className="cursor-pointer transition-opacity hover:opacity-80"
                      onMouseEnter={(e) =>
                        setHover({
                          x: e.clientX,
                          y: e.clientY,
                          label: `${fmt(p.ref)} → ${fmt(p.sec)} · ${
                            p.dt != null ? `${p.dt.toFixed(0)}-day pair` : "unresolved dates"
                          } · ${p.granules} granule(s)${p.flipped ? " · listing was flipped (P01 corrected it)" : ""}`,
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    {p.dt !== null && w > 90 ? (
                      <text
                        x={x1 + w / 2}
                        y={y + 22.5}
                        fill="rgba(4,7,13,0.9)"
                        fontSize={7.5}
                        fontFamily="ui-monospace, monospace"
                        textAnchor="middle"
                      >
                        {p.dt.toFixed(0)}d
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {hover ? (
        <div
          className="pointer-events-none fixed z-50 max-w-xs rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[var(--qp-ink)] shadow-xl"
          style={{ left: Math.min(hover.x + 12, (typeof window !== "undefined" ? window.innerWidth : 1200) - 280), top: hover.y + 12 }}
        >
          {hover.label}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)]">
        <span className="flex items-center gap-2">
          <span className="block h-2 w-6 rounded-full bg-[#3ecf9a]" aria-hidden /> 12-day pair
        </span>
        <span className="flex items-center gap-2">
          <span className="block h-2 w-6 rounded-full bg-[#ff5d55]" aria-hidden /> longer pair
        </span>
        <span className="flex items-center gap-2">
          <span className="block h-2 w-6 rounded-full bg-[#e8b74e]" aria-hidden /> flipped listing
        </span>
        <span className="flex items-center gap-2">
          <span className="block h-1.5 w-1.5 rounded-full bg-[#a9bfd6]/70" aria-hidden /> backscatter
          epoch
        </span>
      </div>
    </div>
  );
}

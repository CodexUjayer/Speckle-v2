"use client";

/** PairPicker — pick the two acquisitions to compare by CLICKING them on a time axis: a dot per GCOV
 *  (one acquisition) and a bar per GUNW (the bar spans its own two dates). First click = A, second = B,
 *  a third click starts over. The engine then subtracts (B minus A) on raw values; this component only
 *  lays the granules out in time and reports which one was clicked. Display only: positions are plain
 *  linear time-to-pixel arithmetic, no data values are touched. */
import { useMemo } from "react";
import type { ExplorerGranule } from "@/lib/types";

const W = 1000;          // viewBox width; the SVG scales to its container
const LEFT = 84;         // lane labels
const RIGHT = 12;
const ROW = 16;
const LANE_GAP = 8;
const AXIS = 20;

interface Item { g: ExplorerGranule; t0: number; t1: number; row: number }
interface Lane { key: string; label: string; items: Item[]; rows: number; y: number }

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

function layout(cands: ExplorerGranule[]): { lanes: Lane[]; t0: number; t1: number; height: number } | null {
  const items: { g: ExplorerGranule; t0: number; t1: number }[] = [];
  for (const g of cands) {
    const s = ms(g.start);
    const a = ms(g.ref_time), b = ms(g.sec_time);
    if (g.product === "GUNW" && a !== null && b !== null) items.push({ g, t0: Math.min(a, b), t1: Math.max(a, b) });
    else if (s !== null) items.push({ g, t0: s, t1: s });
    else if (a !== null) items.push({ g, t0: a, t1: a });
  }
  if (items.length === 0) return null;
  const tMin = Math.min(...items.map((i) => i.t0));
  const tMax = Math.max(...items.map((i) => i.t1));
  const span = Math.max(tMax - tMin, 86_400_000);
  const pad = span * 0.03;
  const t0 = tMin - pad, t1 = tMax + pad;
  const minGap = (t1 - t0) * 0.012;               // keep neighbouring dots from sitting on each other
  const byStack = new Map<string, typeof items>();
  for (const it of items) {
    const k = it.g.stack || "?";
    byStack.set(k, [...(byStack.get(k) ?? []), it]);
  }
  const lanes: Lane[] = [];
  let y = AXIS;
  for (const [key, list] of [...byStack.entries()].sort(([x], [y2]) => x.localeCompare(y2))) {
    list.sort((p, q) => p.t0 - q.t0);
    const ends: number[] = [];
    const placed: Item[] = list.map((it) => {
      let row = ends.findIndex((e) => e + minGap <= it.t0);
      if (row < 0) { row = ends.length; ends.push(it.t1); } else ends[row] = it.t1;
      return { ...it, row };
    });
    const g0 = list[0].g;
    const label = `${g0.direction ?? "?"} ${g0.track != null ? `T${g0.track}` : ""}`.trim();
    lanes.push({ key, label, items: placed, rows: Math.max(1, ends.length), y });
    y += Math.max(1, ends.length) * ROW + LANE_GAP;
  }
  return { lanes, t0, t1, height: y + 4 };
}

export default function PairPicker({
  candidates, product, hasProduct, aId, bId, step, busy, diffActive,
  onProduct, onPick, onSwap, onClear,
}: {
  candidates: ExplorerGranule[];
  product: "GCOV" | "GUNW";
  /** which products the current search already holds (a toggle to the other one re-searches) */
  hasProduct: { GCOV: boolean; GUNW: boolean };
  aId: string;
  bId: string;
  /** which click comes next */
  step: "a" | "b";
  busy: boolean;
  diffActive: boolean;
  onProduct: (p: "GCOV" | "GUNW") => void;
  onPick: (id: string) => void;
  onSwap: () => void;
  onClear: () => void;
}) {
  const shown = useMemo(() => candidates.filter((g) => g.product === product), [candidates, product]);
  const lay = useMemo(() => layout(shown), [shown]);
  const gA = shown.find((g) => g.id === aId), gB = shown.find((g) => g.id === bId);
  const describe = (g: ExplorerGranule | undefined) => !g ? "—"
    : g.product === "GUNW" ? `${day(ms(g.ref_time) ?? 0)} → ${day(ms(g.sec_time) ?? 0)}` : day(ms(g.start) ?? 0);

  const plotW = W - LEFT - RIGHT;
  const x = (t: number) => lay ? LEFT + ((t - lay.t0) / (lay.t1 - lay.t0)) * plotW : 0;
  const ticks = lay ? Array.from({ length: 6 }, (_, i) => lay.t0 + ((lay.t1 - lay.t0) * i) / 5) : [];

  return (
    <section aria-label="Pick two acquisitions" className="border-b border-[#262c36] bg-[#10151b] px-4 py-2" data-testid="pair-picker">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-medium text-[#d9dee4]">Pick two to compare</span>
        <div role="group" aria-label="Product" className="flex overflow-hidden rounded border border-[#333b47] text-[10px]">
          {(["GCOV", "GUNW"] as const).map((p) => (
            <button key={p} type="button" aria-pressed={product === p} onClick={() => onProduct(p)} data-testid={`product-${p}`}
                    className={`px-2 py-0.5 ${product === p ? "bg-[#12333a] text-[#7fd8e6]" : "text-[#8b949e] hover:text-[#d9dee4]"}`}>
              {p === "GCOV" ? "GCOV · dots" : "GUNW · bars"}{!hasProduct[p] ? " (search)" : ""}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px]" data-testid="pair-readout">
          <span className="text-[#e6c977]">A {describe(gA)}</span>
          {"  "}
          <span className="text-[#3fb6c9]">B {describe(gB)}</span>
        </span>
        <button type="button" onClick={onSwap} disabled={!aId || !bId}
                className="rounded border border-[#333b47] px-1.5 py-0.5 text-[10px] text-[#aab3bd] hover:border-[#4a5462] disabled:opacity-40">swap A / B</button>
        <button type="button" onClick={onClear} disabled={!aId && !bId}
                className="rounded border border-[#333b47] px-1.5 py-0.5 text-[10px] text-[#aab3bd] hover:border-[#4a5462] disabled:opacity-40">clear</button>
        <span className="text-[10px] text-[#8b949e]" role="status">
          {busy ? "searching…" : step === "a" ? "click the first (A) acquisition" : "now click the second (B) acquisition"}
        </span>
      </div>
      {!lay ? (
        <p className="mt-1 text-[10px] text-[#8b949e]" data-testid="pair-empty">
          {busy ? "looking for granules…" : `no ${product} granule with a readable date in this box${hasProduct[product] ? "" : " yet — press the button to search for them"}`}
        </p>
      ) : (
        <div className="mt-1 max-h-44 overflow-y-auto">
          <svg viewBox={`0 0 ${W} ${lay.height}`} className="w-full" role="group" aria-label={`${product} acquisitions on a time axis`}
               style={{ height: Math.min(lay.height * 0.9, 340) }}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={x(t)} x2={x(t)} y1={AXIS - 4} y2={lay.height} stroke="#1c222b" />
                <text x={x(t)} y={11} textAnchor="middle" fontSize={10} fill="#8b949e" fontFamily="monospace">{day(t)}</text>
              </g>
            ))}
            {lay.lanes.map((ln) => (
              <g key={ln.key}>
                <text x={4} y={ln.y + 11} fontSize={10} fill="#aab3bd" fontFamily="monospace">{ln.label}</text>
                {ln.items.map((it) => {
                  const isA = it.g.id === aId, isB = it.g.id === bId;
                  const fill = isA ? "#e6c977" : isB ? "#3fb6c9" : product === "GUNW" ? "#4f6f7a" : "#7d8793";
                  const cy = ln.y + it.row * ROW + ROW / 2;
                  const label = `${product} ${describe(it.g)} ${it.g.id}`;
                  const act = () => onPick(it.g.id);
                  const common = {
                    role: "button", tabIndex: 0, "aria-pressed": isA || isB, "aria-label": `${isA ? "A: " : isB ? "B: " : ""}${label}`,
                    onClick: act, onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } },
                    style: { cursor: "pointer", outline: "none" }, "data-testid": `pick-${it.g.id}`,
                  } as const;
                  return product === "GUNW" ? (
                    <rect key={it.g.id} {...common} x={x(it.t0)} y={cy - 5} width={Math.max(6, x(it.t1) - x(it.t0))} height={10} rx={3}
                          fill={fill} stroke={isA || isB ? "#fff" : "none"} strokeWidth={1.2}><title>{label}</title></rect>
                  ) : (
                    <circle key={it.g.id} {...common} cx={x(it.t0)} cy={cy} r={isA || isB ? 6 : 4.5}
                            fill={fill} stroke={isA || isB ? "#fff" : "none"} strokeWidth={1.2}><title>{label}</title></circle>
                  );
                })}
              </g>
            ))}
          </svg>
        </div>
      )}
      <p className="mt-1 text-[10px] leading-relaxed text-[#8b949e]">
        {product === "GUNW"
          ? "A GUNW bar spans the two dates of its own interferogram. Comparing two GUNWs compares those results (coherence, or line-of-sight displacement with each pair referenced on its own); it is not a before/after image."
          : "Each dot is one acquisition."}
        {diffActive ? " The map shows B minus A per pixel, computed by the engine on the raw values; pixels with no valid value in either date stay transparent. It shows that the numbers differ between the dates, not why." : ""}
      </p>
    </section>
  );
}

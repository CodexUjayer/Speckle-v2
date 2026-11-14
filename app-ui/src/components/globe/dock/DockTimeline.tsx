"use client";

/** DockTimeline: the acquisition timeline of the verdict dock. GUNW pairs are bars, GCOV passes are dots, drawn
 *  together in one row per orbit stack (the engine's own grouping) on a true UTC time scale (lib/timescale).
 *  Drag to pan, wheel or pinch to zoom, click one mark then another to pick a before and an after.
 *  While "See why" plays, `highlight` slides a soft band between the two compared acquisitions and
 *  `focus` eases the visible range to them. Display only: no times or gaps are computed beyond placing marks. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GranuleSearchResponse, GranuleStack } from "@/lib/types";
import { clamp, pan as panScale, tToX, ticks as ticksFor, zoom as zoomScale, xToT, type TimeScale } from "@/lib/timescale";
import { directionLabel } from "@/lib/status";
import type { TimelineSelection } from "../GranuleTimeline";

const DAY_MS = 86_400_000;
const LABEL_W = 62;
const BAR_H = 10;
const LANE_H = 15;
const DOT_ROW = 20;
const PAD = 8;
const AXIS = 20;

export interface DockTimelineProps {
  data: GranuleSearchResponse;
  verdictUse?: { stack: string; ref_time: string; sec_time: string; selected: boolean }[];
  selection: TimelineSelection | null;
  selectionB: TimelineSelection | null;
  onSelect: (sel: TimelineSelection | null) => void;
  /** the two acquisitions "See why" is comparing right now */
  highlight?: { a: TimelineSelection; b: TimelineSelection } | null;
  /** ease the visible range to [from, to] ms; a new key re-fires it */
  focus?: { from: number; to: number; key: string } | null;
  reducedMotion?: boolean;
}

interface Row {
  key: string;
  stack: GranuleStack;
  bars: { start: number; end: number; index: number; lane: number }[];
  dots: { at: number; index: number }[];
  lanes: number;
  y: number;
  h: number;
}

function packLanes(bars: { start: number; end: number }[]): number[] {
  const order = bars.map((_, i) => i).sort((a, b) => bars[a].start - bars[b].start || bars[a].end - bars[b].end);
  const ends: number[] = [];
  const out: number[] = new Array(bars.length).fill(0);
  for (const i of order) {
    let lane = ends.findIndex((e) => e <= bars[i].start);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = bars[i].end;
    out[i] = lane;
  }
  return out;
}

function buildRows(stacks: Record<string, GranuleStack>): Row[] {
  const keys = Object.keys(stacks).sort((a, b) => (a[0] === "D" ? 1 : 0) - (b[0] === "D" ? 1 : 0) || a.localeCompare(b));
  const rows: Row[] = [];
  let y = AXIS;
  for (const key of keys) {
    const stack = stacks[key];
    const bars: Row["bars"] = [];
    stack.gunw.forEach((p, index) => {
      const s = Date.parse(p.ref_time ?? ""), e = Date.parse(p.sec_time ?? "");
      if (Number.isFinite(s) && Number.isFinite(e)) bars.push({ start: Math.min(s, e), end: Math.max(s, e), index, lane: 0 });
    });
    const lanes = packLanes(bars);
    bars.forEach((b, i) => { b.lane = lanes[i]; });
    const dots: Row["dots"] = [];
    stack.gcov.forEach((e, index) => { const at = Date.parse(e.time ?? ""); if (Number.isFinite(at)) dots.push({ at, index }); });
    const nLanes = bars.length ? Math.max(...lanes) + 1 : 0;
    const h = PAD * 2 + nLanes * LANE_H + (dots.length ? DOT_ROW : 0) + (nLanes === 0 && dots.length === 0 ? LANE_H : 0);
    rows.push({ key, stack, bars, dots, lanes: nLanes, y, h });
    y += h;
  }
  return rows;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sameSel = (s: TimelineSelection | null | undefined, kind: "gunw" | "gcov", key: string, index: number) =>
  !!s && s.kind === kind && s.stackKey === key && s.index === index;

export default function DockTimeline(props: DockTimelineProps) {
  const rows = useMemo(() => buildRows(props.data.stacks), [props.data.stacks]);
  const bounds = useMemo(() => ({ min: Date.parse(props.data.window.t0), max: Date.parse(props.data.window.t1) }), [props.data.window.t0, props.data.window.t1]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const plotW = Math.max(160, width - LABEL_W - 8);
  const [scale, setScale] = useState<TimeScale>({ t0: bounds.min, t1: bounds.max, widthPx: 600 });
  const sc = useMemo<TimeScale>(() => ({ ...scale, widthPx: plotW }), [scale, plotW]);
  const px = useCallback((ms: number) => tToX(sc, ms), [sc]);
  const clipId = `dtl-${useId().replace(/:/g, "")}`;
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<{ x: number; t0: number; t1: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setWidth(Math.max(320, es[0]?.contentRect.width ?? 720)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setScale((s) => clamp({ ...s }, bounds)); }, [bounds]);

  // wheel and trackpad pinch zoom: a native non-passive listener so the page never scrolls instead
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(plotW, e.clientX - rect.left - LABEL_W));
      setScale((s) => zoomScale({ ...s, widthPx: plotW }, e.deltaY < 0 ? 1.18 : 1 / 1.18, anchor, bounds));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [bounds, plotW]);

  // ease the visible range to a requested span (Why steps)
  const focusKey = props.focus?.key;
  useEffect(() => {
    const f = props.focus;
    if (!f) return;
    const span = Math.max(f.to - f.from, 6 * DAY_MS);
    const pad = span * 0.45;
    const target = clamp({ t0: f.from - pad, t1: f.to + pad, widthPx: plotW }, bounds);
    if (props.reducedMotion) { setScale(target); return; }
    const from = scaleRef.current;
    const t0 = performance.now();
    let raf = 0;
    const ease = (p: number) => 1 - Math.pow(1 - p, 3);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 420);
      const k = ease(p);
      setScale({ widthPx: plotW, t0: from.t0 + (target.t0 - from.t0) * k, t1: from.t1 + (target.t1 - from.t1) * k });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const ticks = useMemo(() => {
    const out: { ms: number; label: string; major: boolean }[] = [];
    let lastX = -Infinity;
    for (const t of ticksFor(sc)) {
      const x = tToX(sc, t.ms);
      if (x < 0 || x > plotW) continue;
      if (x - lastX < 58) { if (t.major && out.length && !out[out.length - 1].major && x - lastX < 20) out[out.length - 1] = t; continue; }
      out.push(t); lastX = x;
    }
    return out;
  }, [sc, plotW]);

  const height = (rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : AXIS + 30) + 6;
  const now = Date.now();

  const itemX = (sel: TimelineSelection): { x: number; row: Row } | null => {
    const row = rows.find((r) => r.key === sel.stackKey);
    if (!row) return null;
    if (sel.kind === "gcov") { const d = row.dots.find((q) => q.index === sel.index); return d ? { x: px(d.at), row } : null; }
    const b = row.bars.find((q) => q.index === sel.index);
    return b ? { x: px((b.start + b.end) / 2), row } : null;
  };
  const hl = props.highlight ? { a: itemX(props.highlight.a), b: itemX(props.highlight.b) } : null;
  const band = hl?.a && hl.b ? { row: hl.a.row, x1: Math.min(hl.a.x, hl.b.x), x2: Math.max(hl.a.x, hl.b.x), ax: hl.a.x, bx: hl.b.x } : null;

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, t0: scale.t0, t1: scale.t1, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    if (d.moved) setScale(panScale({ t0: d.t0, t1: d.t1, widthPx: plotW }, -dx, bounds));
  };
  const onUp = () => { drag.current = null; };

  const pick = (sel: TimelineSelection) => { if (!drag.current?.moved) props.onSelect(sel); };
  const showTip = (e: React.PointerEvent, text: string) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text });
  };

  return (
    <div ref={wrapRef} className="dock-tl" data-testid="dock-timeline">
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        role="application"
        tabIndex={0}
        aria-label="Acquisition timeline. Bars are GUNW pairs, dots are GCOV passes. Arrow keys pan, plus and minus zoom."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setTip(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setScale((s) => panScale({ ...s, widthPx: plotW }, plotW * 0.15, bounds));
          else if (e.key === "ArrowRight") setScale((s) => panScale({ ...s, widthPx: plotW }, -plotW * 0.15, bounds));
          else if (e.key === "+" || e.key === "=") setScale((s) => zoomScale({ ...s, widthPx: plotW }, 1.3, plotW / 2, bounds));
          else if (e.key === "-") setScale((s) => zoomScale({ ...s, widthPx: plotW }, 1 / 1.3, plotW / 2, bounds));
          else if (e.key === "Escape") props.onSelect(null);
          else return;
          e.preventDefault();
        }}
        style={{ display: "block", touchAction: "none", cursor: drag.current?.moved ? "grabbing" : "grab" }}
      >
        <defs><clipPath id={clipId}><rect x={LABEL_W} y={0} width={plotW} height={height} /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          <g transform={`translate(${LABEL_W},0)`}>
            {ticks.map((t) => {
              const x = px(t.ms);
              return (
                <g key={t.ms}>
                  <line x1={x} x2={x} y1={AXIS - 4} y2={height} className="dock-tl-grid" data-major={t.major ? "1" : "0"} />
                  <text x={x + 4} y={11} className="dock-tl-tick">{t.label}</text>
                </g>
              );
            })}
            {now > sc.t0 && now < sc.t1 && <line x1={px(now)} x2={px(now)} y1={AXIS - 4} y2={height} className="dock-tl-now" />}

            {band && (
              <g
                className="dock-tl-band"
                style={{ transform: `translate(${band.x1}px, ${band.row.y}px)`, transitionDuration: props.reducedMotion ? "0ms" : undefined }}
              >
                <rect x={0} y={1} width={Math.max(2, band.x2 - band.x1)} height={band.row.h - 4} rx={10}
                      style={{ transition: props.reducedMotion ? "none" : undefined }} />
              </g>
            )}

            {rows.map((row) => {
              const barsTop = row.y + PAD;
              const dotsY = row.y + PAD + row.lanes * LANE_H + (row.dots.length ? DOT_ROW / 2 : 0);
              return (
                <g key={row.key}>
                  {row.bars.length === 0 && row.dots.length === 0 && (
                    <text x={8} y={row.y + row.h / 2 + 3} className="dock-tl-empty">no dated acquisitions in this window</text>
                  )}
                  {row.bars.map((b) => {
                    const x1 = px(b.start), x2 = Math.max(px(b.end), x1 + 4);
                    const y = barsTop + b.lane * LANE_H + (LANE_H - BAR_H) / 2;
                    const use = (props.verdictUse ?? []).find((u) => u.stack === row.key
                      && u.ref_time.slice(0, 10) === isoDay(b.start) && u.sec_time.slice(0, 10) === isoDay(b.end));
                    const a = sameSel(props.selection, "gunw", row.key, b.index);
                    const bb = sameSel(props.selectionB, "gunw", row.key, b.index);
                    const text = `${row.key} pair, ${isoDay(b.start)} to ${isoDay(b.end)}, ${Math.round((b.end - b.start) / DAY_MS)} days${use?.selected ? ", the pair the verdict is based on" : ""}`;
                    return (
                      <g key={`b${b.index}`}>
                        <rect
                          x={x1} y={y} width={x2 - x1} height={BAR_H} rx={BAR_H / 2}
                          className="dock-tl-bar"
                          data-used={use ? (use.selected ? "main" : "side") : undefined}
                          data-pick={a ? "a" : bb ? "b" : undefined}
                          tabIndex={0} role="button" aria-label={text}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerEnter={(e) => showTip(e, text)}
                          onPointerMove={(e) => showTip(e, text)}
                          onPointerLeave={() => setTip(null)}
                          onClick={(e) => { e.stopPropagation(); props.onSelect({ stackKey: row.key, kind: "gunw", index: b.index }); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { props.onSelect({ stackKey: row.key, kind: "gunw", index: b.index }); e.preventDefault(); } }}
                        />
                        {(a || bb) && <text x={x1 + 4} y={y - 3} className="dock-tl-ab" data-pick={a ? "a" : "b"}>{a ? "A" : "B"}</text>}
                      </g>
                    );
                  })}
                  {row.dots.map((d) => {
                    const a = sameSel(props.selection, "gcov", row.key, d.index);
                    const bb = sameSel(props.selectionB, "gcov", row.key, d.index);
                    const text = `${row.key} pass, ${isoDay(d.at)}`;
                    const cx = px(d.at);
                    return (
                      <g key={`d${d.index}`}>
                        <circle
                          cx={cx} cy={dotsY} r={4.5}
                          className="dock-tl-dot"
                          data-pick={a ? "a" : bb ? "b" : undefined}
                          tabIndex={0} role="button" aria-label={text}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerEnter={(e) => showTip(e, text)}
                          onPointerMove={(e) => showTip(e, text)}
                          onPointerLeave={() => setTip(null)}
                          onClick={(e) => { e.stopPropagation(); props.onSelect({ stackKey: row.key, kind: "gcov", index: d.index }); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { props.onSelect({ stackKey: row.key, kind: "gcov", index: d.index }); e.preventDefault(); } }}
                        />
                        {(a || bb) && <text x={cx + 8} y={dotsY + 3} className="dock-tl-ab" data-pick={a ? "a" : "b"}>{a ? "A" : "B"}</text>}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {hl && (["a", "b"] as const).map((k) => {
              const at = hl[k];
              if (!at) return null;
              return (
                <g key={`${k}-${props.highlight && (k === "a" ? props.highlight.a.index : props.highlight.b.index)}-${focusKey}`}>
                  <line x1={at.x} x2={at.x} y1={at.row.y + 2} y2={at.row.y + at.row.h - 4} className="dock-tl-hl" data-k={k} />
                </g>
              );
            })}
          </g>
        </g>
        {rows.map((row) => (
          <g key={`l-${row.key}`}>
            <rect x={0} y={row.y} width={LABEL_W - 4} height={row.h} className="dock-tl-label-bg" />
            <text x={2} y={row.y + row.h / 2 - 1} className="dock-tl-stack">{row.key}</text>
            <text x={2} y={row.y + row.h / 2 + 11} className="dock-tl-dir">{directionLabel(row.stack.direction)}</text>
          </g>
        ))}
      </svg>
      {tip && <div className="dock-tl-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.text}</div>}
      {props.data.window.t0 && <span className="sr-only">{isoDay(xToT(sc, 0))} to {isoDay(xToT(sc, plotW))}</span>}
    </div>
  );
}

"use client";

/** BottomPanel — the Data Lab's numeric panels, engine-computed (Phase 2):
 *    series     one engine value per date over the current box (mean/median/p98 of the legend's
 *               values) for the pair's stack — gaps stay gaps, missing granules are stated.
 *    histogram  the engine's bin edges/counts for the FIRST date's image over the current box.
 *    profile    a straight A->B transect: click two points on the map (the panel arms the mode);
 *               out-of-clip samples are gaps, the engine stated the length.
 *  All three re-fetch when the box / layer / scale changes. Display only: values, units, bin
 *  edges and lengths arrive from the engine; this draws them. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, GitFork, Lasso, TrendingUp } from "lucide-react";
import { bg } from "@/lib/bg";
import { cumulativeKm, dateShort, fmtVal, histogramBars, numTicks, seriesYRange, timeToX } from "@/lib/labPanels";
import { downloadExport, exportHistogram, exportProfile, exportRoi, exportSeries } from "@/lib/labExport";
import type { InspectResponse, PairNetworkResponse, RoiResponse, TimeseriesResponse } from "@/lib/types";
import type { LabRoi } from "@/lib/urlstate";

export type PanelTab = "series" | "histogram" | "profile" | "roi" | "pairs";

export interface ProfilePoint { lon: number; lat: number }

const W = 640;
const H = 132;
const PAD_L = 44;
const PAD_B = 18;

interface Props {
  tab: PanelTab;
  box: [number, number, number, number] | null;
  /** the image the histogram/profile describe (the FIRST date of the pair) */
  id: string;
  layer: string;
  /** the legend's resolved scale (mirrored onto the engine calls so numbers match the picture) */
  scale: string | undefined;
  /** Phase 3: the active correction diagnostic (mirrored like the scale) */
  corr: string;
  unit: string | null;
  /** the stack's granule ids for the series (already same-stack, engine re-validates) */
  seriesIds: string[];
  profilePoints: ProfilePoint[];
  onArmProfile: () => void;
  /** Phase 4 — the drawn ROI + the drawing controls (the state lives in LabApp) */
  roiShape: LabRoi | null;
  drawMode: "box" | "polygon" | null;
  onArmRoi: (mode: "box" | "polygon" | null) => void;
  onClearRoi: () => void;
  /** Phase 5 — the pair network answer (engine-computed) + choosing a pair by its granule ids */
  pairNetwork: PairNetworkResponse | null;
  onPickPair: (granuleIds: string[]) => void;
  /** switch the active tab (the state lives in LabApp so the map can arm profile clicks) */
  onTab: (t: PanelTab) => void;
}

export default function BottomPanel(props: Props) {
  const { tab, box, id, layer, scale, corr, unit, seriesIds, profilePoints, onArmProfile,
          roiShape, drawMode, onArmRoi, onClearRoi, pairNetwork, onPickPair } = props;
  const [roiRes, setRoiRes] = useState<RoiResponse | null>(null);
  const roiKey = roiShape ? `${roiShape.kind}:${roiShape.ring.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(";")}` : "";
  const [series, setSeries] = useState<TimeseriesResponse | null>(null);
  const [inspectRes, setInspectRes] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- the time series (one call per box/layer/scale/stack) --------------------
  useEffect(() => {
    if (tab !== "series" || !box || seriesIds.length === 0 || !layer) return;
    const ctrl = new AbortController();
    setError(null);
    setLoading(true);
    bg.timeseries({ ids: seriesIds, layer, west: box[0], south: box[1], east: box[2], north: box[3], scale }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) { setSeries(r); setError(null); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [tab, box, layer, scale, seriesIds.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- stats + histogram + profile (one call per box/layer/scale/profile) ------
  const profileArgs = useMemo(() => {
    if (profilePoints.length < 2) return undefined;
    return { aLon: profilePoints[0].lon, aLat: profilePoints[0].lat,
             bLon: profilePoints[1].lon, bLat: profilePoints[1].lat };
  }, [profilePoints]);
  useEffect(() => {
    if (tab === "series" || !box || !id || !layer) return;
    const ctrl = new AbortController();
    setError(null);
    setLoading(true);
    bg.inspect({ id, layer, west: box[0], south: box[1], east: box[2], north: box[3],
                 scale, corr: corr !== "off" ? corr : undefined,
                 bins: tab === "histogram" ? 48 : undefined, profile: profileArgs }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) { setInspectRes(r); setError(null); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [tab, box, id, layer, scale, corr, profileArgs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the drawn-ROI stats (Phase 4): one call per shape/layer/scale --------------------------------
  useEffect(() => {
    if (tab !== "roi" || !roiShape || !id || !layer) return;
    const ctrl = new AbortController();
    setError(null);
    setLoading(true);
    bg.roi({ id, layer, kind: roiShape.kind, ring: roiShape.ring, scale,
             corr: corr !== "off" ? corr : undefined, bins: 32 }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) { setRoiRes(r); setError(null); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [tab, id, layer, scale, corr, roiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (t: PanelTab) => {
    props.onTab(t);
    if (t === "profile") onArmProfile();
  };

  return (
    <section aria-label="numeric panels (engine-computed)"
             className="flex h-[240px] shrink-0 flex-col border-t border-[#262c36] bg-[#0e1116]">
      <div className="flex items-center gap-1 border-b border-[#1c222b] px-2 py-1">
        <TabBtn active={tab === "series"} onClick={() => setTab("series")} icon={<TrendingUp size={11} aria-hidden />} label="time series" />
        <TabBtn active={tab === "histogram"} onClick={() => setTab("histogram")} icon={<BarChart3 size={11} aria-hidden />} label="histogram" />
        <TabBtn active={tab === "profile"} onClick={() => setTab("profile")} icon={<Activity size={11} aria-hidden />} label="profile A–B" />
        <TabBtn active={tab === "roi"} onClick={() => setTab("roi")} icon={<Lasso size={11} aria-hidden />} label="ROI stats" />
        <TabBtn active={tab === "pairs"} onClick={() => setTab("pairs")} icon={<GitFork size={11} aria-hidden />} label="pairs" />
        {exportFor(tab, series, inspectRes, roiRes) && (
          <span className="ml-auto flex items-center gap-1" role="group" aria-label="export this panel's numbers">
            <span className="text-[10px] text-[#5a636e]">export</span>
            <button type="button" onClick={() => { const p = exportFor(tab, series, inspectRes, roiRes); if (p) downloadExport(p, "csv"); }}
              className="rounded border border-[#262c36] px-1.5 py-0.5 font-mono text-[10px] text-[#aab3bd] hover:border-[#4a5462]">
              csv
            </button>
            <button type="button" onClick={() => { const p = exportFor(tab, series, inspectRes, roiRes); if (p) downloadExport(p, "json"); }}
              className="rounded border border-[#262c36] px-1.5 py-0.5 font-mono text-[10px] text-[#aab3bd] hover:border-[#4a5462]">
              json
            </button>
          </span>
        )}
        <span className="ml-2 text-[10px] text-[#5a636e]">
          {tab === "series" && `mean of ${unit ?? "the legend's values"} over the box, one engine call per date`}
          {tab === "histogram" && `bin edges and counts from the engine (${dateShort(inspectRes?.date)})`}
          {tab === "profile" && (profilePoints.length < 2
            ? "click two points on the map (A, then B)"
            : `A ${profilePoints[0].lat.toFixed(3)}, ${profilePoints[0].lon.toFixed(3)} → B ${profilePoints[1].lat.toFixed(3)}, ${profilePoints[1].lon.toFixed(3)}`)}
          {tab === "pairs" && (pairNetwork
            ? `${pairNetwork.n_nodes} epochs · ${pairNetwork.n_edges} pairs · ${pairNetwork.n_components} component(s) — click a pair to load it`
            : "the engine is deriving the pair network…")}
          {tab === "roi" && (drawMode
            ? (drawMode === "box" ? "click two opposite corners on the map" : "click vertices on the map; double-click closes the polygon")
            : roiShape ? "engine statistics inside the drawn shape (mask at pixel centres)" : "draw a box or a polygon on the map to get statistics inside it")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading && <p role="status" className="p-2 text-[10px] text-[#8b949e]">the engine is computing…</p>}
        {error && <p role="alert" className="p-2 text-[10px] text-[#e8a087]">{error}</p>}
        {!loading && !error && tab === "series" && <SeriesChart res={series} unit={unit} />}
        {!loading && !error && tab === "histogram" && <HistogramChart res={inspectRes} unit={unit} />}
        {!loading && !error && tab === "profile" && <ProfileChart res={inspectRes} unit={unit} />}
        {!loading && !error && tab === "roi" && (
          <RoiView res={roiRes} shape={roiShape} drawMode={drawMode}
                   onArm={onArmRoi} onClear={onClearRoi} unit={unit} />
        )}
        {!loading && !error && tab === "pairs" && <PairsNetworkView net={pairNetwork} onPick={onPickPair} />}
      </div>
    </section>
  );
}

/** which payload the export buttons serialize for the active tab (null = nothing to export yet). */
function exportFor(tab: PanelTab, series: TimeseriesResponse | null, inspectRes: InspectResponse | null,
                   roiRes: RoiResponse | null) {
  if (tab === "series" && series) return exportSeries(series);
  if (tab === "histogram" && inspectRes) return exportHistogram(inspectRes);
  if (tab === "profile" && inspectRes?.profile) return exportProfile(inspectRes);
  if (tab === "roi" && roiRes) return exportRoi(roiRes);
  return null;
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] ${
        active ? "border-[#3fb6c9] bg-[#12333a] text-[#7fd8e6]" : "border-[#262c36] text-[#8b949e] hover:border-[#4a5462]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Empty({ what }: { what: string }) {
  return <p className="p-2 text-[10px] text-[#5a636e]">{what}</p>;
}

// --------------------------------------------------------------------------- //
function SeriesChart({ res, unit }: { res: TimeseriesResponse | null; unit: string | null }) {
  const pts = res?.points ?? [];
  const finite = pts.filter((p) => p.value != null && Number.isFinite(p.value));
  if (!res) return <Empty what="no series yet — pick a box and a layer." />;
  if (finite.length === 0) {
    return <Empty what={`no computable date over this box (${res.missing.length} granule(s) listed as missing by the engine).`} />;
  }
  const t0 = Date.parse(res.dates_span.first ?? "") || Date.parse(finite[0].date ?? "");
  const t1 = Date.parse(res.dates_span.last ?? "") || t0 + 86_400_000;
  const yr = seriesYRange(finite.map((p) => p.value));
  if (!yr) return <Empty what="no finite values." />;
  const x = (iso: string | null) => timeToX(Date.parse(iso ?? ""), t0, t1, W, PAD_L, 12);
  const y = (v: number) => H - PAD_B - ((v - yr.lo) / (yr.hi - yr.lo)) * (H - PAD_B - 8);
  const yTicks = numTicks(yr.lo, yr.hi, 3);
  return (
    <div>
      <svg role="img" aria-label={`time series of ${res.stat} ${unit ?? ""} per date, engine-computed`}
           viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[860px]">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 12} y1={y(t)} y2={y(t)} stroke="#1c222b" strokeWidth={1} />
            <text x={PAD_L - 4} y={y(t) + 3} textAnchor="end" fontSize={8} fill="#8b949e">{fmtVal(t)}</text>
          </g>
        ))}
        {/* segments only between CONSECUTIVE finite points — a gap stays a gap */}
        {pts.slice(1).map((p, i) => {
          const a = pts[i];
          if (a.value == null || p.value == null) return null;
          return <line key={i} x1={x(a.date)} y1={y(a.value)} x2={x(p.date)} y2={y(p.value)}
                       stroke="#7fd8e6" strokeWidth={1.2} />;
        })}
        {pts.map((p, i) => (
          p.value == null ? null :
            <circle key={i} cx={x(p.date)} cy={y(p.value)} r={2.6} fill="#7fd8e6">
              <title>{`${p.id}\n${p.date ?? "—"} · ${fmtVal(p.value, unit)} · n=${p.n_valid}`}</title>
            </circle>
        ))}
        {pts.map((p, i) => (
          <text key={`l${i}`} x={x(p.date)} y={H - 5} textAnchor="middle" fontSize={7.5} fill="#5a636e">
            {dateShort(p.date)}
          </text>
        ))}
      </svg>
      {res.missing.length > 0 && (
        <p role="note" className="mt-1 text-[10px] text-[#d9c98a]">
          {res.missing.length} granule(s) missing: {res.missing.map((m) => `${m.id.slice(14, 30)}… (${m.reason})`).join("; ")}
        </p>
      )}
      {res.notes.map((n, i) => <p key={i} className="text-[10px] text-[#8b949e]">{n}</p>)}
    </div>
  );
}

function HistogramChart({ res, unit }: { res: InspectResponse | null; unit: string | null }) {
  if (!res) return <Empty what="no histogram yet — pick a box and a layer." />;
  const bars = histogramBars(res.histogram.edges, res.histogram.counts, W - PAD_L - 12, H - PAD_B - 4);
  if (bars.length === 0) {
    return <Empty what={`every value in this box is no-data at this scale — the engine returned no bins. ${res.notes[0] ?? ""}`} />;
  }
  const y = (count: number) => {
    const max = Math.max(...res.histogram.counts, 1);
    return (H - PAD_B - 4) * (1 - count / max) + 4;
  };
  const xTicks = numTicks(res.histogram.edges[0], res.histogram.edges[res.histogram.edges.length - 1], 4);
  const xa = (v: number) => {
    const lo = res.histogram.edges[0];
    const span = res.histogram.edges[res.histogram.edges.length - 1] - lo || 1;
    return PAD_L + ((v - lo) / span) * (W - PAD_L - 12);
  };
  return (
    <div>
      <svg role="img" aria-label={`histogram of the box in ${unit ?? "legend units"}, engine bin edges`}
           viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[860px]">
        {bars.map((b, i) => (
          <rect key={i} x={PAD_L + b.x} y={b.y} width={Math.max(0.5, b.w - 0.5)} height={b.h}
                fill="#3fb6c9" opacity={0.85}>
            <title>{`${fmtVal(b.from, unit)} … ${fmtVal(b.to, unit)}: ${b.count} px`}</title>
          </rect>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={xa(t)} y={H - 5} textAnchor="middle" fontSize={8} fill="#8b949e">{fmtVal(t)}</text>
        ))}
        <text x={PAD_L - 4} y={12} textAnchor="end" fontSize={8} fill="#8b949e">{res.stats.unit ?? unit ?? ""}</text>
      </svg>
      <p className="text-[10px] text-[#8b949e]">
        {res.histogram.n} valid values · {Math.round(res.stats.nan_fraction * 100)}% no-data · scale {res.scale}
      </p>
    </div>
  );
}

function PairsNetworkView({ net, onPick }: {
  net: PairNetworkResponse | null;
  onPick: (granuleIds: string[]) => void;
}) {
  if (!net) return <Empty what="no network yet — the engine is deriving it from the search." />;
  if (net.n_nodes === 0) {
    return <Empty what="no acquisition epochs over this box in this window — the network is empty." />;
  }
  const W2 = 860, L = 44, R = 12, T = 14, laneH = 46;
  // stacks in first-seen order; one lane each (presentation layout only — the FACTS are the engine's)
  const stacks: string[] = [];
  for (const n of net.nodes) if (!stacks.includes(n.stack)) stacks.push(n.stack);
  const H2 = T + stacks.length * laneH + 18;
  const dates = net.nodes.map((n) => Date.parse(n.date));
  const t0 = Math.min(...dates), t1 = Math.max(...dates);
  const xOf = (iso: string) => L + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * (W2 - L - R);
  const yOf = (stack: string) => T + stacks.indexOf(stack) * laneH + laneH / 2;
  return (
    <div>
      <svg role="img" aria-label={`pair network: ${net.n_nodes} epochs, ${net.n_edges} pairs, ${net.n_components} components`}
           viewBox={`0 0 ${W2} ${H2}`} className="w-full max-w-[860px]">
        {/* the pair edges: arcs between their epochs, clickable, titled with the facts */}
        {net.edges.map((e, i) => {
          const x1 = xOf(e.from), x2 = xOf(e.to), y = yOf(e.stack);
          const mx = (x1 + x2) / 2;
          return (
            <g key={i}>
              <path d={`M ${x1} ${y} C ${mx} ${y - laneH * 0.7}, ${mx} ${y - laneH * 0.7}, ${x2} ${y}`}
                    fill="none" stroke="#7fd8e6" strokeWidth={1.6} opacity={0.85}
                    style={{ cursor: "pointer" }} onClick={() => onPick(e.granule_ids)}>
                <title>{`${e.stack}: ${e.from} → ${e.to}
baseline ${e.baseline_days ?? "?"} d${e.flipped ? " · stored secondary-first (flipped)" : ""}
${e.n_variants} variant(s) — click to load this pair`}</title>
              </path>
              {/* the hit area: the whole lens under the arc (closed shape, transparent fill,
                  pointer-events all) — a bare curve is too thin to click reliably */}
              <path d={`M ${x1} ${y} C ${mx} ${y - laneH * 0.7}, ${mx} ${y - laneH * 0.7}, ${x2} ${y} Z`}
                    fill="transparent" pointerEvents="all" stroke="none"
                    style={{ cursor: "pointer" }} onClick={() => onPick(e.granule_ids)} />
            </g>
          );
        })}
        {/* the adjacent-epoch gaps the engine stated (no pair product) */}
        {net.possible_edges.map((p, i) => {
          const x1 = xOf(p.from), x2 = xOf(p.to), y = yOf(p.stack);
          return <line key={`g${i}`} x1={x1} y1={y} x2={x2} y2={y} stroke="#3a4250" strokeWidth={1}
                       strokeDasharray="2 3">
            <title>{`${p.stack}: ${p.from} → ${p.to} (${p.baseline_days ?? "?"} d) — ${p.note}`}</title>
          </line>;
        })}
        {/* the epoch nodes */}
        {net.nodes.map((n, i) => (
          <circle key={i} cx={xOf(n.date)} cy={yOf(n.stack)} r={3.5} fill="#aab3bd">
            <title>{`${n.stack} · ${n.date}
${n.direction === "A" ? "ascending" : n.direction === "D" ? "descending" : "direction unknown"} track ${n.track ?? "?"}`}</title>
          </circle>
        ))}
        {/* the stack lane labels */}
        {stacks.map((st) => (
          <text key={st} x={L - 6} y={yOf(st) + 3} textAnchor="end" fontSize={9} fill="#8b949e">{st}</text>
        ))}
        {/* the time axis: first / last epoch, engine dates verbatim */}
        <text x={L} y={H2 - 4} fontSize={8} fill="#5a636e">{net.nodes[0]?.date.slice(0, 10)}</text>
        <text x={W2 - R} y={H2 - 4} textAnchor="end" fontSize={8} fill="#5a636e">
          {net.nodes[net.nodes.length - 1]?.date.slice(0, 10)}
        </text>
      </svg>
      <p className="text-[10px] text-[#8b949e]">{net.network_note}</p>
      {net.search?.degraded && (
        <p role="note" className="text-[10px] text-[#d9c98a]">the underlying search was degraded — the network may be incomplete</p>
      )}
      {net.search?.search_incomplete && (
        <p role="note" className="text-[10px] text-[#d9c98a]">
          the search over {net.search.search_incomplete_levels?.join(", ")} came back short — nodes may be missing
        </p>
      )}
      {net.unplaced.length > 0 && (
        <p role="note" className="text-[10px] text-[#e8a087]">
          {net.unplaced.length} pair group(s) could not be placed: {net.unplaced[0].reason}
        </p>
      )}
    </div>
  );
}

function RoiView({ res, shape, drawMode, onArm, onClear, unit }: {
  res: RoiResponse | null;
  shape: LabRoi | null;
  drawMode: "box" | "polygon" | null;
  onArm: (mode: "box" | "polygon" | null) => void;
  onClear: () => void;
  unit: string | null;
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <button type="button" aria-pressed={drawMode === "box"}
          onClick={() => onArm(drawMode === "box" ? null : "box")}
          className={`rounded border px-2 py-0.5 text-[10px] ${drawMode === "box" ? "border-[#7fd8e6] bg-[#12333a] text-[#7fd8e6]" : "border-[#262c36] text-[#8b949e] hover:border-[#4a5462]"}`}>
          draw box
        </button>
        <button type="button" aria-pressed={drawMode === "polygon"}
          onClick={() => onArm(drawMode === "polygon" ? null : "polygon")}
          className={`rounded border px-2 py-0.5 text-[10px] ${drawMode === "polygon" ? "border-[#7fd8e6] bg-[#12333a] text-[#7fd8e6]" : "border-[#262c36] text-[#8b949e] hover:border-[#4a5462]"}`}>
          draw polygon
        </button>
        {shape && (
          <button type="button" onClick={onClear}
            className="rounded border border-[#4a2f24] px-2 py-0.5 text-[10px] text-[#e8a087] hover:border-[#6a4034]">
            clear shape
          </button>
        )}
      </div>
      {!shape && <Empty what="no shape yet — arm a mode above, then draw on the map. The engine decides which pixels fall inside and computes every number." />}
      {shape && !res && <Empty what="asking the engine…" />}
      {shape && res && <RoiStats res={res} unit={unit} />}
    </div>
  );
}

function RoiStats({ res, unit }: { res: RoiResponse; unit: string | null }) {
  const r = res.roi;
  const stats = r.stats;
  const rows: [string, string][] = [
    ["pixels inside", `${r.n_pixels} (valid ${r.n_valid})`],
    ["shape area", `${r.area_km2.toFixed(2)} km²`],
    ["pixel pitch", `${r.pixel_pitch_m[0].toFixed(0)} × ${r.pixel_pitch_m[1].toFixed(0)} m`],
    ["min", stats.min == null ? "—" : fmtVal(stats.min, stats.unit ?? unit)],
    ["mean", stats.mean == null ? "—" : fmtVal(stats.mean, stats.unit ?? unit)],
    ["max", stats.max == null ? "—" : fmtVal(stats.max, stats.unit ?? unit)],
    ["p50", stats.p50 == null ? "—" : fmtVal(stats.p50, stats.unit ?? unit)],
    ["p98", stats.p98 == null ? "—" : fmtVal(stats.p98, stats.unit ?? unit)],
  ];
  const bars = histogramBars(r.histogram.edges, r.histogram.counts, W - PAD_L - 12, 64);
  const maxCount = Math.max(...r.histogram.counts, 1);
  return (
    <div className="flex flex-wrap items-start gap-4">
      <table className="text-[10px] text-[#aab3bd]" aria-label="ROI statistics (engine-computed)">
        <caption className="sr-only">statistics of the legend&apos;s values inside the drawn shape</caption>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className="pr-3 text-left font-normal text-[#8b949e]">{k}</th>
              <td className="font-mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="min-w-[280px] flex-1">
        <svg role="img" aria-label="histogram of the values inside the drawn shape"
             viewBox={`0 0 ${W} 84`} className="w-full max-w-[560px]">
          {bars.map((b, i) => (
            <rect key={i} x={PAD_L + b.x} y={(64 * (1 - b.count / maxCount)) + 4}
                  width={Math.max(0.5, b.w - 0.5)} height={(64 * b.count / maxCount)}
                  fill="#7fd8e6" opacity={0.85}>
              <title>{`${fmtVal(b.from, unit)} … ${fmtVal(b.to, unit)}: ${b.count} px`}</title>
            </rect>
          ))}
          {r.histogram.edges.length > 1 && numTicks(r.histogram.edges[0], r.histogram.edges[r.histogram.edges.length - 1], 4).map((t) => {
            const lo = r.histogram.edges[0];
            const span = r.histogram.edges[r.histogram.edges.length - 1] - lo || 1;
            return <text key={t} x={PAD_L + ((t - lo) / span) * (W - PAD_L - 12)} y={80}
                         textAnchor="middle" fontSize={8} fill="#8b949e">{fmtVal(t)}</text>;
          })}
        </svg>
        <p className="text-[10px] text-[#8b949e]">
          {r.n_valid} valid values inside · {r.mask_rule}
        </p>
        {res.los?.cc_gate && <p className="text-[10px] text-[#d9c98a]">{res.los.cc_gate}</p>}
        {res.notes.map((n, i) => <p key={i} className="text-[10px] text-[#8b949e]">{n}</p>)}
      </div>
    </div>
  );
}

function ProfileChart({ res, unit }: { res: InspectResponse | null; unit: string | null }) {
  if (!res) return <Empty what="no profile yet — click two points on the map (A, then B)." />;
  if (!res.profile) return <Empty what="this answer carries no profile (ask again with A and B set)." />;
  const prof = res.profile;
  const pts = prof.samples;
  // x: cumulative km via the shared helper (presentation geometry; the engine stated the length)
  const cum = cumulativeKm(pts.map((s) => ({ lon: s.lon, lat: s.lat })));
  const finite = pts.filter((s) => s.value != null);
  if (finite.length === 0) {
    return <Empty what="every sample of this transect is outside the granule or no-data — pick A/B inside the image." />;
  }
  const yr = seriesYRange(finite.map((s) => s.value));
  const xMax = cum[cum.length - 1] || 1;
  const x = (km: number) => PAD_L + (km / xMax) * (W - PAD_L - 12);
  const y = (v: number) => H - PAD_B - ((v - (yr?.lo ?? 0)) / ((yr?.hi ?? 1) - (yr?.lo ?? 1) || 1)) * (H - PAD_B - 8);
  const yTicks = yr ? numTicks(yr.lo, yr.hi, 3) : [];
  return (
    <div>
      <svg role="img" aria-label="profile of values along the A to B transect, engine-sampled"
           viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[860px]">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 12} y1={y(t)} y2={y(t)} stroke="#1c222b" strokeWidth={1} />
            <text x={PAD_L - 4} y={y(t) + 3} textAnchor="end" fontSize={8} fill="#8b949e">{fmtVal(t)}</text>
          </g>
        ))}
        {/* segments only between CONSECUTIVE valid samples — gaps stay gaps */}
        {pts.slice(1).map((p, i) => {
          const a = pts[i];
          if (a.value == null || p.value == null) return null;
          return <line key={i} x1={x(cum[i])} y1={y(a.value)} x2={x(cum[i + 1])} y2={y(p.value)}
                       stroke="#e6c977" strokeWidth={1.2} />;
        })}
        {pts.map((s, i) => (
          s.value == null ? null :
            <circle key={i} cx={x(cum[i])} cy={y(s.value)} r={2} fill="#e6c977">
              <title>{`${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}\n${fmtVal(s.value, unit)}`}</title>
            </circle>
        ))}
        <text x={W - 12} y={H - 5} textAnchor="end" fontSize={8} fill="#5a636e">
          {`0 → ${xMax.toFixed(1)} km (engine length ${fmtVal(prof.length_m / 1000)} km, ${prof.n_valid}/${prof.n_samples} valid)`}
        </text>
      </svg>
    </div>
  );
}

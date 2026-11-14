"use client";

/** MapRunArrays — the Map's processed-data tree: what the common preprocessing built for this tile, laid out like the
 *  bundle itself instead of one flat P0–P13 list. Three folders per run:
 *    flags    the bundle's quality flags (code, severity, step, message)
 *    arrays   every array, filed stage > folder > array by its path; click one to draw it on the map
 *    routing  each pipeline's routing decision, its reasons, and the arrays it reads
 *  Arrays are drawn through the same overlay slot as the SAR pictures and the two-dot differences.
 *
 *  Source: the engine's /api/background/lab-runs (the runs whose tile overlaps this tile + the arrays of each run's
 *  trace, with the engine's own corners), /api/background/runs/{id}/preprocessing (the flags and the routing/handoff
 *  rows of the same run) and /api/background/runs/{id}/arrays/{aid} (the picture). Local state only:
 *  it never starts a scan and never fetches from NASA. The arrays exist after a scan has run on this machine; a run's
 *  trace lives in memory and is evicted with the run.
 *
 *  Thin client: the list, the grouping field (`step`), the corners, the colours, the statistics and the notes are the
 *  engine's. The person only chooses which array, the colour map and the opacity. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bg } from "@/lib/bg";
import { bgFetch } from "@/lib/bgApi";
import { fmtNum } from "@/lib/format";
import type { HandoffRow, LabRunsResponse, PreprocessingTrace, PreviewMeta } from "@/lib/types";
import BigLoader, { MiniSpinner } from "@/components/BigLoader";
import type { OverlaySpec } from "./GlobeMap";

type Run = LabRunsResponse["runs"][number];
type Arr = Run["arrays"][string][number];

const CMAPS = ["auto", "diverging", "viridis", "magma", "gray"] as const;
type Cmap = (typeof CMAPS)[number];

/** a display default only: arrays that are differences read best on a two-sided scale (the engine stretches it
 *  symmetrically around zero when asked for `diverging`) */
const looksLikeDifference = (a: Arr) => /db_diff_prev|z_prev|los_m|_diff|diff\b/i.test(a.path ?? a.label ?? "");

const num = (v: number | null | undefined) => (v == null ? "—" : fmtNum(v));

/** "every 2nd pixel" / "every 3rd pixel" / "the full pixel grid" — the engine's own stride, said plainly */
const sub = (n: number) => (n <= 1 ? "the full pixel grid" : `every ${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]} pixel`);

const stepOrder = (s: string | null) => (s && /^P\d+/.test(s) ? Number(s.slice(1).replace(/\D.*/, "")) : 99);


/** the arrays tree: stage (the engine's own name for the path's first part) > folders > array.
 *  `path` is the engine's "group/…/name" string; an array without one falls back to its stage, step, then "other". */
type TArr = Arr & { group?: string | null; stage?: string | null; first_step?: string | null };
interface TNode { name: string; key: string; kids: Map<string, TNode>; arrs: TArr[]; steps: Set<string> }
const newNode = (name: string, key: string): TNode => ({ name, key, kids: new Map(), arrs: [], steps: new Set() });
const INDEX = /^\[\d+\]$/;
/** "los_m" + "[0]" read as one array: los_m[0] */
function split(a: TArr): { folders: { key: string; name: string }[]; leaf: string } {
  const segs = (a.path ?? "").split("/").filter(Boolean);
  const top = { key: a.group ?? segs[0] ?? a.step ?? "other", name: a.stage ?? a.group ?? segs[0] ?? a.step ?? "other" };
  if (segs.length <= 1) return { folders: [top], leaf: segs[0] ?? a.label ?? a.aid };
  let leaf = segs[segs.length - 1];
  let mid = segs.slice(1, -1);
  if (INDEX.test(leaf) && mid.length) { leaf = `${mid[mid.length - 1]}${leaf}`; mid = mid.slice(0, -1); }
  return { folders: [top, ...mid.map((m) => ({ key: m, name: m }))], leaf };
}
function buildTree(list: TArr[]): TNode {
  const root = newNode("", "");
  for (const a of list) {
    const { folders } = split(a);
    let n = root;
    const chain: TNode[] = [root];
    for (const f of folders) {
      const key = n.key ? `${n.key}/${f.key}` : f.key;
      n = n.kids.get(f.key) ?? (n.kids.set(f.key, newNode(f.name, key)).get(f.key)!);
      chain.push(n);
    }
    n.arrs.push(a);
    if (a.step) chain.forEach((c) => c.steps.add(a.step!));
  }
  return root;
}
const countArrs = (n: TNode): number => n.arrs.length + [...n.kids.values()].reduce((t, k) => t + countArrs(k), 0);
const firstStep = (n: TNode): number => Math.min(...[...n.steps].map(stepOrder), 99);
const sortedKids = (n: TNode) => [...n.kids.values()].sort((x, y) => firstStep(x) - firstStep(y) || x.name.localeCompare(y.name));
const dims = (a: Arr) => (a.shape ? a.shape.slice(-2).join("×") : null);

const rowBtn = "flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[#f1eee8]";

function Folder({ node, depth, picked, onPick, forceOpen }: {
  node: TNode; depth: number; picked: string | null; onPick: (a: TArr) => void; forceOpen: boolean;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isOpen = forceOpen || open;
  return (
    <div role="treeitem" aria-expanded={isOpen} aria-selected={false} data-testid="array-folder">
      <button type="button" onClick={() => setOpen(!isOpen)} className={rowBtn}>
        <span aria-hidden className={`inline-block w-2 text-[9px] text-[#8a837b] transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
        <span className="mono truncate text-[11px] font-medium text-[#1c1a17]">{node.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-[#a39d94]">{countArrs(node)}</span>
      </button>
      {isOpen && (
        <div role="group" className="ml-[7px] space-y-0.5 border-l border-[#e7e2da] pl-2">
          {sortedKids(node).map((k) => (
            <Folder key={k.key} node={k} depth={depth + 1} picked={picked} onPick={onPick} forceOpen={forceOpen} />
          ))}
          {node.arrs.map((a) => {
            const ok = !!a.corners_lonlat && a.corners_lonlat.length === 4;
            const on = picked === a.aid;
            return (
              <button key={a.aid} type="button" role="treeitem" disabled={!ok} aria-selected={on} aria-pressed={on}
                      title={a.note ?? a.corners_note ?? a.path ?? ""} onClick={() => onPick(a)}
                      className={`flex w-full items-center gap-1.5 rounded border-l-2 px-1.5 py-1 text-left text-[11px] ${
                        on ? "border-[#2c5f58] bg-[#eef6f3] font-medium text-[#2c5f58]"
                          : ok ? "border-transparent hover:bg-[#f1eee8]"
                            : "cursor-not-allowed border-transparent text-[#a39d94]"}`}>
                <span className="mono truncate">{split(a).leaf}</span>
                {a.step && <span className="mono shrink-0 rounded bg-[#efece5] px-1 text-[9px] text-[#8a837b]" title="the step that wrote this version">{a.step}</span>}
                {dims(a) && <span className="mono shrink-0 text-[9px] text-[#a39d94]">{dims(a)}</span>}
                {a.stats && a.stats.min != null && a.stats.max != null && (
                  <span className="mono ml-auto shrink-0 text-[9px] text-[#8a837b]">{num(a.stats.min)} … {num(a.stats.max)}</span>
                )}
                {!ok && <span className="ml-auto shrink-0 text-[9px]">cannot be placed</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** a top-level folder of the bundle tree (flags / arrays / routing) */
function Section({ name, count, children, defaultOpen = true, forceOpen = false }: {
  name: string; count: number | string; children: ReactNode; defaultOpen?: boolean; forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <div role="treeitem" aria-expanded={isOpen} aria-selected={false}>
      <button type="button" onClick={() => setOpen(!isOpen)} className={rowBtn}>
        <span aria-hidden className={`inline-block w-2 text-[9px] text-[#8a837b] transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
        <span className="mono text-[11px] font-semibold text-[#1c1a17]">{name}</span>
        <span className="ml-auto text-[10px] text-[#a39d94]">{count}</span>
      </button>
      {isOpen && <div role="group" className="ml-[7px] space-y-0.5 border-l border-[#e7e2da] pl-2">{children}</div>}
    </div>
  );
}

/** the routing word the engine gave this pipeline: yes / no / unknown (or whatever its routing object says) */
function routeWord(r: HandoffRow): string | null {
  const x = (r.routing ?? null) as Record<string, unknown> | null;
  const v = x?.applies ?? x?.route;
  return typeof v === "string" ? v : null;
}
const wordCls = (w: string | null) =>
  w === "yes" ? "border-[#2c5f58] bg-[#2c5f58] text-white"
    : w === "no" ? "border-[#cfc9be] text-[#8a837b]"
      : w === "unknown" ? "border-[#c9a94d] bg-[#fbf5e0] text-[#7a6438]"
        : "border-[#cfc9be] text-[#4a443c]";
const sevCls = (s: string) =>
  /err|crit|fatal/i.test(s) ? "text-[#9e3b2c]" : /warn/i.test(s) ? "text-[#7a6438]" : "text-[#8a837b]";

type Sel = { k: "array"; aid: string } | { k: "flag"; i: number } | { k: "route"; name: string } | null;

export default function MapRunArrays({ bbox, tileId, onOverlay }: {
  bbox: [number, number, number, number] | null;
  /** the tile the Data panel is about: runs of neighbouring tiles that merely touch its box are not listed */
  tileId?: string | null;
  onOverlay: (o: OverlaySpec | null) => void;
}) {
  const [runs, setRuns] = useState<LabRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Sel>(null);                          // what is selected in the tree
  const picked = sel?.k === "array" ? sel.aid : null;                   // the array drawn on the map (aid)
  const [pre, setPre] = useState<{ status: "busy" | "ok" | "err"; trace?: PreprocessingTrace | null; message?: string } | null>(null);
  const [cmap, setCmap] = useState<Cmap | null>(null);                 // null = the display default for the pick
  const [opacity, setOpacity] = useState(0.85);
  const [img, setImg] = useState<{ status: "busy" | "ok" | "err"; url?: string; meta?: PreviewMeta; message?: string } | null>(null);

  const bboxKey = bbox ? bbox.join(",") : "";

  // ---- the runs over this tile ---------------------------------------------------------------------------------
  useEffect(() => {
    if (!bbox) return;
    const ctrl = new AbortController();
    setRuns(null); setError(null);
    bg.labRuns({ west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }, ctrl.signal)
      .then((r) => {
        setRuns(r);
        setRunId((cur) => (cur && r.runs.some((x) => x.id === cur)) ? cur : (r.runs.find((x) => x.has_live_trace)?.id ?? null));
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxKey, nonce]);

  const mine = useMemo(() => {
    const all = runs?.runs ?? [];
    const same = tileId ? all.filter((r) => r.tile === tileId) : all;
    return { list: same, hidden: all.length - same.length };
  }, [runs, tileId]);
  useEffect(() => {      // the selected run must be one of the listed ones
    if (runs && !mine.list.some((r) => r.id === runId)) setRunId(mine.list.find((r) => r.has_live_trace)?.id ?? mine.list[0]?.id ?? null);
  }, [runs, mine, runId]);
  const run = useMemo(() => mine.list.find((r) => r.id === runId) ?? null, [mine, runId]);
  const rows = useMemo(() => {
    const all = run ? Object.values(run.arrays).flat() : [];
    const needle = q.trim().toLowerCase();
    const kept = needle
      ? all.filter((a) => `${a.label ?? ""} ${a.path ?? ""} ${a.note ?? ""}`.toLowerCase().includes(needle))
      : all;
    const by = new Map<string, Arr[]>();
    for (const a of kept) {
      const k = a.step ?? "other";
      (by.get(k) ?? by.set(k, []).get(k)!).push(a);
    }
    return { total: all.length, shown: kept.length,
             groups: [...by.entries()].sort((x, y) => stepOrder(x[0]) - stepOrder(y[0]) || x[0].localeCompare(y[0])) };
  }, [run, q]);
  const tree = useMemo(() => buildTree(rows.groups.flatMap(([, l]) => l) as TArr[]), [rows]);

  // ---- the flags and the routing rows of the same run (its preprocessing trace) ---------------------------------
  useEffect(() => {
    if (!run || !run.has_live_trace) { setPre(null); return; }
    const ctrl = new AbortController();
    setPre({ status: "busy" });
    bg.preprocessing(run.id, undefined, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setPre({ status: "ok", trace: r.trace }); })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setPre({ status: "err", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [run?.id, run?.has_live_trace]);       // eslint-disable-line react-hooks/exhaustive-deps
  const needle = q.trim().toLowerCase();
  const flags = useMemo(() => {
    const all = pre?.trace?.flags ?? [];
    return all.map((f, i) => ({ f, i })).filter(({ f }) => !needle || `${f.code} ${f.severity} ${f.step} ${f.message}`.toLowerCase().includes(needle));
  }, [pre, needle]);
  const routes = useMemo(() => {
    const all = pre?.trace?.handoff?.rows ?? [];
    return all.filter((r) => !needle || `${r.name} ${r.code} ${routeWord(r) ?? ""} ${r.reasons.join(" ")}`.toLowerCase().includes(needle));
  }, [pre, needle]);
  const allArrays = useMemo(() => (run ? (Object.values(run.arrays).flat() as TArr[]) : []), [run]);
  const selFlag = sel?.k === "flag" ? pre?.trace?.flags?.[sel.i] ?? null : null;
  const selRoute = sel?.k === "route" ? (pre?.trace?.handoff?.rows ?? []).find((r) => r.name === sel.name) ?? null : null;
  /** the arrays a routed pipeline reads: those written by the preprocessing steps it declares it uses */
  const routeArrays = useMemo(() => {
    if (!selRoute) return [] as TArr[];
    const codes = new Set(selRoute.uses.map((u) => u.code));
    return allArrays.filter((a) => a.step && codes.has(a.step) && !!a.corners_lonlat && a.corners_lonlat.length === 4).slice(0, 12);
  }, [selRoute, allArrays]);
  const arr = useMemo(
    () => (run ? Object.values(run.arrays).flat().find((a) => a.aid === picked) ?? null : null), [run, picked]);

  // ---- the picture of the picked array ---------------------------------------------------------------------------
  const useCmap: Cmap = cmap ?? (arr && looksLikeDifference(arr) ? "diverging" : "auto");
  useEffect(() => {
    if (!run || !arr) { setImg(null); return; }
    const ctrl = new AbortController();
    let url: string | undefined;
    setImg({ status: "busy" });
    (async () => {
      try {
        const res = await bgFetch(bg.traceArrayUrl(run.id, arr.aid, { cmap: useCmap, maxPx: 512 }), { signal: ctrl.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { detail?: { error?: string } })?.detail?.error ?? `${res.status}`);
        }
        const meta = JSON.parse(res.headers.get("X-Img-Meta") ?? "{}") as PreviewMeta;
        url = URL.createObjectURL(await res.blob());
        if (!ctrl.signal.aborted) setImg({ status: "ok", url, meta });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setImg({ status: "err", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, arr?.aid, useCmap]);

  // ---- on the map (the corners are the engine's) ---------------------------------------------------------------------
  const onOverlayRef = useRef(onOverlay);
  onOverlayRef.current = onOverlay;
  const placed = useRef(false);
  useEffect(() => {
    const c = (arr?.corners_lonlat?.length === 4 ? arr.corners_lonlat : img?.meta?.corners_lonlat) as OverlaySpec["corners"] | null | undefined;
    if (run && arr && img?.status === "ok" && img.url && c) {
      const lons = c.map((p) => p[0]);
      const lats = c.map((p) => p[1]);
      placed.current = true;
      onOverlayRef.current({
        id: `overlay:array:${run.id}:${arr.aid}:${useCmap}:${img.url.slice(-12)}`,
        dataUrl: img.url, opacity, corners: c,
        bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],   // envelope only
      });
    } else if (placed.current) {
      placed.current = false;
      onOverlayRef.current(null);
    }
  }, [run, arr, img, opacity, useCmap]);
  useEffect(() => () => { if (placed.current) onOverlayRef.current(null); }, []);

  if (!bbox) return null;
  const meta = img?.status === "ok" ? img.meta : undefined;

  return (
    <details className="rounded-lg border border-[#e7e2da] bg-[#faf9f6]" data-testid="run-arrays">
      <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-[#1c1a17]">
        Processed data — the bundle, by folder
        {runs && run ? <span className="ml-1 font-normal text-[#8a837b]">({rows.total})</span> : null}
      </summary>
      <div className="space-y-2 border-t border-[#e7e2da] px-3 py-2 text-[11px] text-[#4a443c]">
        {error && <p role="alert" className="text-[#9e3b2c]">{error} <button type="button" className="underline" onClick={() => setNonce((n) => n + 1)}>retry</button></p>}
        {!runs && !error && <BigLoader size="sm" title="Looking for preprocessing runs over this tile…" />}
        {runs && mine.list.length === 0 && (
          <p className="text-[#8a837b]">
            No preprocessing run exists for this tile yet{mine.hidden > 0 ? ` (${mine.hidden} run${mine.hidden === 1 ? "" : "s"} on neighbouring tiles not shown)` : ""}.
            Arrays appear here after a scan has run on this machine — this list only reads local state; it never starts a scan.
          </p>
        )}
        {runs && mine.list.length > 0 && (
          <>
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-[#8a837b]">run</span>
              <select value={runId ?? ""} onChange={(e) => { setRunId(e.target.value || null); setSel(null); }}
                      className="min-w-0 flex-1 rounded border border-[#e7e2da] bg-white px-1.5 py-1 text-[11px]">
                {mine.list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.tile} · {r.pipelines.join(", ") || r.kind} · {r.created_at?.slice(0, 16).replace("T", " ") ?? r.id}{r.has_live_trace ? "" : " · no live trace"}
                  </option>
                ))}
              </select>
            </label>
            {run && !run.has_live_trace && (
              <p className="text-[#8a837b]">This run&apos;s arrays are gone (a run&apos;s trace lives in memory and is dropped with it). Pick another run or scan again.</p>
            )}
            {run && run.has_live_trace && (
              <>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter: los, coherence, flood, P10…"
                       aria-label="filter arrays" className="w-full rounded border border-[#e7e2da] bg-white px-2 py-1 text-[11px]" />
                <p className="text-[10px] text-[#8a837b]">
                  {rows.shown === rows.total ? `${rows.total} arrays` : `${rows.shown} of ${rows.total} arrays`} · flags, arrays and routing of this run · click an array to draw it, click again to remove it
                </p>
                <div role="tree" aria-label="Processed data" className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
                  <Section name="flags" count={pre?.status === "ok" ? flags.length : "…"} forceOpen={needle !== ""}>
                    {pre?.status === "busy" && <p className="px-1 text-[#8a837b]">reading the run&apos;s flags…</p>}
                    {pre?.status === "err" && <p role="alert" className="px-1 text-[#9e3b2c]">{pre.message}</p>}
                    {pre?.status === "ok" && !pre.trace && <p className="px-1 text-[#8a837b]">This run recorded no trace, so it has no flags.</p>}
                    {pre?.status === "ok" && pre.trace && flags.length === 0 && <p className="px-1 text-[#8a837b]">{needle ? "No flag matches." : "The bundle raised no flags."}</p>}
                    {flags.map(({ f, i }) => {
                      const on = sel?.k === "flag" && sel.i === i;
                      return (
                        <button key={`${f.code}-${i}`} type="button" role="treeitem" aria-selected={on} onClick={() => setSel(on ? null : { k: "flag", i })}
                                className={`flex w-full items-center gap-1.5 rounded border-l-2 px-1.5 py-1 text-left text-[11px] ${on ? "border-[#2c5f58] bg-[#eef6f3] font-medium" : "border-transparent hover:bg-[#f1eee8]"}`}>
                          <span className="mono truncate">{f.code}</span>
                          <span className={`shrink-0 text-[9px] ${sevCls(f.severity)}`}>{f.severity}</span>
                          <span className="mono ml-auto shrink-0 text-[9px] text-[#8a837b]">{f.step}</span>
                        </button>
                      );
                    })}
                  </Section>
                  <Section name="arrays" count={needle ? `${rows.shown} of ${rows.total}` : rows.total} forceOpen={needle !== ""}>
                    {sortedKids(tree).map((k) => (
                      <Folder key={k.key} node={k} depth={0} picked={picked} forceOpen={needle !== ""}
                              onPick={(a) => setSel(picked === a.aid ? null : { k: "array", aid: a.aid })} />
                    ))}
                    {rows.shown === 0 && <p className="px-1 text-[#8a837b]">Nothing matches that filter.</p>}
                  </Section>
                  <Section name="routing" count={pre?.status === "ok" ? routes.length : "…"} forceOpen={needle !== ""}>
                    {pre?.status === "ok" && pre.trace && !pre.trace.handoff && <p className="px-1 text-[#8a837b]">This run has no routing rows (cached or older runs carry none).</p>}
                    {routes.map((r) => {
                      const on = sel?.k === "route" && sel.name === r.name;
                      const w = routeWord(r);
                      return (
                        <button key={r.name} type="button" role="treeitem" aria-selected={on} onClick={() => setSel(on ? null : { k: "route", name: r.name })}
                                className={`flex w-full items-center gap-1.5 rounded border-l-2 px-1.5 py-1 text-left text-[11px] ${on ? "border-[#2c5f58] bg-[#eef6f3] font-medium" : "border-transparent hover:bg-[#f1eee8]"}`}>
                          <span className="mono truncate">{r.name}</span>
                          {w && <span className={`ml-auto shrink-0 rounded-full border px-1.5 text-[9px] font-semibold ${wordCls(w)}`}>{w}</span>}
                        </button>
                      );
                    })}
                  </Section>
                </div>
              </>
            )}
            {selFlag && (
              <div className="space-y-1 rounded-lg border border-[#e7e2da] bg-white p-2" data-testid="flag-detail">
                <p className="mono text-[11px] font-medium">{selFlag.code}</p>
                <p className="mono text-[10px] text-[#8a837b]">severity <span className={sevCls(selFlag.severity)}>{selFlag.severity}</span> · raised by {selFlag.step}</p>
                <p>{selFlag.message}</p>
              </div>
            )}
            {selRoute && (
              <div className="space-y-1.5 rounded-lg border border-[#e7e2da] bg-white p-2" data-testid="route-detail">
                <p className="flex items-center gap-2">
                  <span className="mono text-[11px] font-medium">{selRoute.name}</span>
                  {routeWord(selRoute) && <span className={`rounded-full border px-1.5 text-[9px] font-semibold ${wordCls(routeWord(selRoute))}`}>{routeWord(selRoute)}</span>}
                </p>
                {selRoute.reasons.length > 0 && <p>{selRoute.reasons.join(" · ")}</p>}
                <p className="mono text-[10px] text-[#8a837b]">registry {selRoute.registry_status} · verdict {selRoute.verdict_state}{selRoute.min_epochs != null ? ` · needs ${selRoute.min_epochs} epochs` : ""}</p>
                {selRoute.uses.length > 0 && (
                  <ul className="space-y-0.5 text-[10px]">
                    {selRoute.uses.map((u) => (
                      <li key={u.code}><span className="mono">{u.code}</span> {u.name} — <span className="text-[#8a837b]">{u.state}{u.why ? `: ${u.why}` : ""}</span></li>
                    ))}
                  </ul>
                )}
                {selRoute.missing_uses.length > 0 && <p className="text-[10px] text-[#7a6438]">missing: {selRoute.missing_uses.join(", ")}</p>}
                {routeArrays.length > 0 && (
                  <div>
                    <p className="text-[10px] text-[#8a837b]">arrays it reads — click to draw</p>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {routeArrays.map((a) => (
                        <button key={a.aid} type="button" onClick={() => setSel({ k: "array", aid: a.aid })}
                                className="mono rounded border border-[#e7e2da] bg-[#faf9f6] px-1.5 py-0.5 text-[10px] hover:border-[#2c5f58]/50">{split(a).leaf}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {arr && (
              <div className="space-y-1.5 rounded-lg border border-[#e7e2da] bg-white p-2">
                <p className="mono truncate text-[11px] font-medium">{arr.label ?? arr.aid}</p>
                <p className="mono break-all text-[10px] text-[#8a837b]" data-testid="array-path">{arr.path}</p>
                {img?.status === "busy" && <p role="status" className="flex items-center gap-2 text-[#2c5f58]">drawing<MiniSpinner /></p>}
                {img?.status === "err" && <p role="alert" className="text-[#9e3b2c]">{img.message}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label className="flex items-center gap-1">colours
                    <select value={useCmap} onChange={(e) => setCmap(e.target.value as Cmap)}
                            className="rounded border border-[#e7e2da] bg-white px-1 py-0.5 text-[11px]">
                      {CMAPS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">opacity
                    <input type="range" min={0.2} max={1} step={0.05} value={opacity}
                           onChange={(e) => setOpacity(Number(e.target.value))} aria-label="opacity" className="w-24" />
                  </label>
                </div>
                <p className="mono text-[10px] text-[#8a837b]">
                  {arr.dtype ?? "?"}{arr.shape ? ` · ${arr.shape[0]}×${arr.shape[1]}` : ""}
                  {meta ? ` · colours ${num(meta.lo)} … ${num(meta.hi)}` : ""}
                  {arr.stats ? ` · data ${num(arr.stats.min)} … ${num(arr.stats.max)} · mean ${num(arr.stats.mean)}` : ""}
                </p>
                {arr.note && <p className="text-[10px] text-[#8a837b]">{arr.note}</p>}
                <p role="note" data-testid="preview-note" className="rounded border border-[#e3d3a1] bg-[#fbf5e0] px-2 py-1 text-[10px] leading-snug text-[#7a6438]">
                  <b>Preview only.</b> This picture is a thumbnail
                  {arr.stride && arr.thumb_shape ? `: ${sub(arr.stride)}, ${arr.thumb_shape[1]}×${arr.thumb_shape[0]} of ${arr.shape ? `${arr.shape[1]}×${arr.shape[0]}` : "the full array"}` : " (at most 400 px on its longest side)"}.
                  The statistics above are for the full array. For analysis, use the full-resolution array from the bundle — not this picture.
                </p>
              </div>
            )}
          </>
        )}
        {runs?.notes.map((n, i) => <p key={i} className="text-[10px] text-[#8a837b]">{n}</p>)}
      </div>
    </details>
  );
}

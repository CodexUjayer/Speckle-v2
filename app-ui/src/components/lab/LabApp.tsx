"use client";

/** LabApp — the Data Lab (/lab): look at any NISAR layer, compare dates, see the engine's
 *  computed difference. Layout: left = granule + layers, centre = map, right = compare +
 *  provenance. A URL reproduces the view (box / level / window / pair / layer / mode / diff
 *  mode), validated and ignorable exactly like the Explorer's.
 *
 *  Thin client, enforced: the BEFORE/AFTER images come from /preview with the FIRST image's
 *  resolved scale + colour map + explicit lo/hi (one fixed range — two independently stretched
 *  images would mislead); the DIFFERENCE comes from /api/background/diff, engine-computed on
 *  raw values. Nothing here subtracts, converts units or decides validity — the inventory's
 *  diff_modes (engine-annotated) is mirrored, and the engine's 422 text is shown verbatim. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { granulesBbox } from "@/lib/api";
import { bg } from "@/lib/bg";
import { loadExplain } from "@/lib/explainCache";
import type { ExplainPayload, ExplorerGranule, GranuleDetailResponse } from "@/lib/types";
import { parseLabState, writeLabState, roiFromParam, roiToParam, type LabCompareMode, type LabDiffMode, type LabCorr, type LabRoi } from "@/lib/urlstate";
import type { RoiShape } from "@/components/lab/LabMap";
import type { LabRunsResponse, PairNetworkResponse } from "@/lib/types";
import type { TraceArrayMeta } from "@/lib/types";
import { createUrlWriter, type UrlWriter } from "@/lib/urlSync";
import { loadQueryContext, saveQueryContext, toDateOnly } from "@/lib/queryContext";
import LayerStackPanel from "@/components/lab/LayerStackPanel";
import ComparePanel, { type DiffRange } from "@/components/lab/ComparePanel";
import LabLegend from "@/components/lab/LabLegend";
import ProvenanceDrawer from "@/components/lab/ProvenanceDrawer";
import PairPicker from "@/components/lab/PairPicker";
import RunArraysPanel, { type ArrayOverlaySpec } from "@/components/lab/RunArraysPanel";
import BottomPanel, { type PanelTab, type ProfilePoint } from "@/components/lab/BottomPanel";
import { useSarImage } from "@/components/globe/explorer/useSarImage";

const LabMap = dynamic(() => import("@/components/lab/LabMap"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-[#8b949e]">loading the map…</div>,
});

type InvLayer = NonNullable<GranuleDetailResponse["inventory"]>["grids"][number]["layers"][number];

const LAB_PATH = "/lab";

/** the diff transport for useSarImage: granuleId carries "idA|idB" (validated ids, no spaces) */
function diffFetch(p: Parameters<typeof bg.diffBlob>[0] & { id: string; layer: string }, signal?: AbortSignal) {
  const [idA, ...rest] = p.id.split("|");
  return bg.diffBlob({
    idA, idB: rest.join("|"), layer: p.layer, west: p.west, south: p.south, east: p.east, north: p.north,
    maxPx: p.maxPx, mode: p.mode ?? "auto", cmap: p.cmap ?? "auto",
    ...(p.lo != null && p.hi != null ? { lo: p.lo, hi: p.hi } : {}),
    patient: true, onWait: p.onWait,
  }, signal);
}

export default function LabApp() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ---- the box / level / window (Explorer vocabulary, shared through the URL) -----------------
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const [granules, setGranules] = useState<ExplorerGranule[]>([]);
  const [level, setLevel] = useState("GCOV");
  const [product, setProduct] = useState<"GCOV" | "GUNW">("GCOV");
  const [pickStep, setPickStep] = useState<"a" | "b">("a");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  // ---- the pair / layer / modes ----------------------------------------------------------------
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [layerKey, setLayerKey] = useState("");
  const [compareMode, setCompareMode] = useState<LabCompareMode>("before-after");
  const [diffMode, setDiffMode] = useState<LabDiffMode>("db_diff");
  const [corr, setCorr] = useState<LabCorr>("off");          // Phase 3: correction diagnostic
  // Phase 4 — the drawn ROI + the drawing state (box: 2 clicks; polygon: vertices + close)
  const [roiShape, setRoiShape] = useState<LabRoi | null>(null);
  const [drawMode, setDrawMode] = useState<"box" | "polygon" | null>(null);
  const [draftRing, setDraftRing] = useState<[number, number][]>([]);
  // Phase 5 — the pair network (engine-derived over the box) + the pipeline bridge's runs
  const [pairNet, setPairNet] = useState<PairNetworkResponse | null>(null);
  const [labRunsRes, setLabRunsRes] = useState<LabRunsResponse | null>(null);
  const [arrayOverlay, setArrayOverlay] = useState<ArrayOverlaySpec | null>(null);
  const [lockedRange, setLockedRange] = useState<DiffRange | null>(null);
  const [shownEnd, setShownEnd] = useState<"before" | "after">("before");
  const [swipe, setSwipe] = useState(0.5);
  const [flickerEnd, setFlickerEnd] = useState<"before" | "after">("before");
  const [explain, setExplain] = useState<ExplainPayload | null>(null);
  const [invByGranule, setInvByGranule] = useState<Record<string, GranuleDetailResponse["inventory"] | null>>({});
  const bootRef = useRef(false);
  // a link that names no pair and no mode gets the engine's default pair shown as a DIFFERENCE (the point of the Lab)
  const autoDiffRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback((box: [number, number, number, number], level: string, from: string, to: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true);
    setSearchError(null);
    granulesBbox({ west: box[0], south: box[1], east: box[2], north: box[3], level, from: from || undefined, to: to || undefined }, ctrl.signal)
      .then((r) => {
        setGranules(r.granules);
        saveQueryContext({ bbox: box, level, from: toDateOnly(from), to: toDateOnly(to) });
        // default pair: the oldest and the newest acquisition of the FIRST stack
        const first = r.granules.find((g) => g.product === (level.includes("GCOV") ? "GCOV" : "GUNW")) ?? r.granules[0];
        const stack = r.granules.filter((g) => g.stack === first?.stack && g.product === first?.product)
          .sort((x, y) => String(x.start ?? x.sec_time).localeCompare(String(y.start ?? y.sec_time)));
        setBeforeId((cur) => cur || stack[0]?.id || "");
        setAfterId((cur) => cur || stack[stack.length - 1]?.id || "");
        setLayerKey((cur) => cur || "");
        if (autoDiffRef.current && stack.length >= 2) { autoDiffRef.current = false; setCompareMode("difference"); }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSearchError(err instanceof Error ? err.message : String(err));
        setGranules([]);
      })
      .finally(() => { if (!ctrl.signal.aborted) setSearching(false); });
  }, []);

  // ---- boot: URL first, then the shared map context --------------------------------------------
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const st = parseLabState(new URLSearchParams(searchParams.toString()));
    autoDiffRef.current = !(st.a && st.b) && !st.cmp;
    if (st.west !== undefined && st.south !== undefined && st.east !== undefined && st.north !== undefined) {
      const box: [number, number, number, number] = [st.west, st.south, st.east, st.north];
      setBbox(box);
      if (st.a) setBeforeId(st.a);
      if (st.b) setAfterId(st.b);
      if (st.layer) setLayerKey(st.layer);
      if (st.cmp) setCompareMode(st.cmp);
      if (st.dmode) setDiffMode(st.dmode as LabDiffMode);
      if ((st as { corr?: string }).corr) setCorr((st as { corr?: string }).corr as LabCorr);
      const stRoi = roiFromParam((st as { roi?: string }).roi);
      if (stRoi) setRoiShape(stRoi);
      setLevel(st.level ?? "GCOV");
      setProduct(st.level && !st.level.includes("GCOV") ? "GUNW" : "GCOV");
      setTimeout(() => runSearch(box, st.level ?? "GCOV", st.from ?? "", st.to ?? ""), 0);
    } else {
      const ctx = loadQueryContext();
      if (ctx.bbox) {
        const box = ctx.bbox as [number, number, number, number];
        setBbox(box);
        setLevel(ctx.level ?? "GCOV");
        setTimeout(() => runSearch(box, ctx.level ?? "GCOV", ctx.from ?? "", ctx.to ?? ""), 0);
      }
    }
    loadExplain().then(setExplain).catch(() => setExplain(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- URL write-back (a pasted link restores the same view) ------------------------------------
  const urlWriter = useRef<UrlWriter<ReturnType<typeof parseLabState>> | null>(null);
  useEffect(() => {
    const w = createUrlWriter<ReturnType<typeof parseLabState>>({
      pathPrefix: LAB_PATH,
      build: (current, patch) => {
        writeLabState(current, { ...parseLabState(current), ...patch });
        return current;
      },
    });
    urlWriter.current = w;
    return () => {
      w.dispose();
      if (urlWriter.current === w) urlWriter.current = null;
      abortRef.current?.abort();
    };
  }, []);
  const pushUrl = useCallback((patch: Partial<ReturnType<typeof parseLabState>>) => {
    urlWriter.current?.schedule(patch);
  }, []);

  // ---- the layer inventories of the pair (needed for diff-mode gating) ---------------------------
  useEffect(() => {
    for (const gid of [beforeId, afterId]) {
      if (!gid || gid in invByGranule) continue;
      setInvByGranule((cur) => ({ ...cur, [gid]: null }));
      const ctrl = new AbortController();
      bg.granule(gid, ctrl.signal)
        .then((d) => { if (!ctrl.signal.aborted) setInvByGranule((cur) => ({ ...cur, [gid]: d.inventory ?? null })); })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beforeId, afterId]);

  const pairLayers = useMemo(() => {
    const a = (invByGranule[beforeId]?.grids ?? []).flatMap((g) => g.layers);
    const b = new Set((invByGranule[afterId]?.grids ?? []).flatMap((g) => g.layers.map((l) => l.key)));
    return a.filter((l) => l.previewable && b.has(l.key));
  }, [invByGranule, beforeId, afterId]);
  const withDiff = pairLayers.find((l) => l.diff_modes && Object.values(l.diff_modes).some((m) => m.valid));
  const effectiveLayer = pairLayers.some((l) => l.key === layerKey) ? layerKey : ((withDiff ?? pairLayers[0])?.key ?? "");
  const invLayer = pairLayers.find((l) => l.key === effectiveLayer) ?? null;
  const modes = invLayer?.diff_modes ?? null;

  // a compare mode that just became impossible falls back honestly (the buttons state the reason)
  useEffect(() => {
    if (compareMode === "difference" && modes && !modes[diffMode]?.valid) {
      const ok = (Object.keys(modes) as LabDiffMode[]).find((m) => modes[m].valid);
      if (!ok) setCompareMode("before-after");
      else setDiffMode(ok);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modes]);

  // ---- the images -------------------------------------------------------------------------------
  // BEFORE decides the scale / colour map / range; AFTER is drawn with exactly those (one range).
  // A LOCKED range overrides: both dates and both ends of the lock are the SAME stretch, exactly
  // the Explorer's Before/After rule made explicit (two independently stretched images mislead).
  // Phase 3 — the correction diagnostic replaces the layer picture (GUNW phase layers only);
  // a non-phase layer or the difference view turns it off honestly
  const corrActive = corr !== "off" && compareMode !== "difference"
    && (invLayer?.role === "unw_phase" || invLayer?.role === "iono_phase"
        || invLayer?.role === "tropo_hydro_phase" || invLayer?.role === "tropo_wet_phase"
        || invLayer?.role === "tide_phase");
  const before = useSarImage({
    enabled: !!effectiveLayer && beforeId !== afterId && compareMode !== "difference",
    granuleId: beforeId, layerKey: effectiveLayer, bbox, maxPx: 512,
    ...(corrActive ? { corr } : {}),
    ...(lockedRange ? { lo: lockedRange.lo, hi: lockedRange.hi } : {}),
  });
  const bm = before.meta;
  const locked = !!lockedRange && lockedRange.lo < lockedRange.hi;
  const pairLo = locked ? lockedRange!.lo : (Number.isFinite(bm?.lo) ? bm!.lo : null);
  const pairHi = locked ? lockedRange!.hi : (Number.isFinite(bm?.hi) ? bm!.hi : null);
  const fixable = (locked || (!!bm && bm.cmap !== "categorical" && Number.isFinite(bm.lo) && Number.isFinite(bm.hi) && bm.lo < bm.hi))
    && pairLo != null && pairHi != null && pairLo < pairHi;
  const after = useSarImage({
    enabled: !!effectiveLayer && beforeId !== afterId && compareMode !== "difference" && fixable,
    granuleId: afterId, layerKey: effectiveLayer, bbox, maxPx: 512,
    ...(corrActive ? { corr } : {}),
    scale: locked ? undefined : bm?.scale, cmap: locked ? undefined : bm?.cmap,
    lo: pairLo, hi: pairHi,
  });
  // the DIFFERENCE: engine-computed; the same hook, a different transport
  const rangeArgs = lockedRange ? { lo: lockedRange.lo, hi: lockedRange.hi } : {};
  const diff = useSarImage({
    enabled: !!effectiveLayer && !!beforeId && !!afterId && beforeId !== afterId && compareMode === "difference",
    granuleId: `${beforeId}|${afterId}`, layerKey: effectiveLayer, bbox, maxPx: 512,
    scale: diffMode, cmap: "auto", ...rangeArgs,
    fetcher: diffFetch as never,
  });

  // flicker: alternate the two images (display only; reduced-motion people get a manual toggle)
  useEffect(() => {
    if (compareMode !== "flicker") return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = setInterval(() => setFlickerEnd((e) => (e === "before" ? "after" : "before")), 1000);
    return () => clearInterval(id);
  }, [compareMode]);

  // ---- what is on the map right now --------------------------------------------------------------
  const active = compareMode === "difference" ? diff : (compareMode === "flicker" ? (flickerEnd === "before" ? before : after) : (shownEnd === "before" ? before : after));
  const overlays = useMemo(() => {
    if (compareMode === "swipe" && before.url && before.corners && after.url && after.corners) {
      // both dates at once: the divider element states which side is which; both at reduced
      // opacity would muddy either — the engine drew them on ONE range, so full opacity is honest
      return [
        { id: "before", url: before.url, corners: before.corners, opacity: 1 },
        { id: "after", url: after.url, corners: after.corners, opacity: 1 },
      ];
    }
    if (active.url && active.corners) {
      const stack = [{ id: active === diff ? "diff" : "pair", url: active.url, corners: active.corners, opacity: 0.9 }];
      if (arrayOverlay?.url) {
        stack.push({ id: `run:${arrayOverlay.runId}:${arrayOverlay.aid}`, url: arrayOverlay.url,
                     corners: arrayOverlay.corners, opacity: 0.75 });
      }
      return stack;
    }
    if (arrayOverlay?.url) {
      return [{ id: `run:${arrayOverlay.runId}:${arrayOverlay.aid}`, url: arrayOverlay.url,
                corners: arrayOverlay.corners, opacity: 0.75 }];
    }
    return [];
  }, [compareMode, before.url, before.corners, after.url, after.corners, active, diff, arrayOverlay]);

  // ---- handlers -----------------------------------------------------------------------------------
  const selectGranule = (id: string) => {
    setBeforeId(id);
    pushUrl({ a: id });
  };
  const pickLayer = (key: string) => {
    setLayerKey(key);
    pushUrl({ layer: key });
  };
  const setPairA = (id: string) => { setBeforeId(id); pushUrl({ a: id }); };
  const setPairB = (id: string) => { setAfterId(id); pushUrl({ b: id }); };
  const setMode = (m: LabCompareMode) => { setCompareMode(m); pushUrl({ cmp: m }); };
  const setDMode = (m: LabDiffMode) => { setDiffMode(m); pushUrl({ dmode: m }); };
  const setCorrChip = (c: LabCorr) => { setCorr(c); pushUrl({ corr: c === "off" ? "" : c }); };
  const setRange = (r: DiffRange | null) => { setLockedRange(r); };

  // ---- pick two on the time axis: first click = A, second = B, third starts over ------------------
  const pickOne = (id: string) => {
    if (pickStep === "a" || !beforeId) {
      setBeforeId(id); setAfterId(""); setPickStep("b");
      pushUrl({ a: id, b: "" });
      return;
    }
    if (id === beforeId) return;                      // the same acquisition twice is a zero difference: ignore the click
    setAfterId(id); setPickStep("a");
    setCompareMode("difference");
    pushUrl({ b: id, cmp: "difference" });
  };
  const swapPair = () => {
    setBeforeId(afterId); setAfterId(beforeId);
    pushUrl({ a: afterId, b: beforeId });
  };
  const clearPair = () => {
    setBeforeId(""); setAfterId(""); setPickStep("a");
    pushUrl({ a: "", b: "" });
  };
  const switchProduct = (p: "GCOV" | "GUNW") => {
    setProduct(p);
    setBeforeId(""); setAfterId(""); setPickStep("a"); setLayerKey("");
    setLevel(p);
    pushUrl({ level: p, a: "", b: "", layer: "" });
    if (bbox && !granules.some((g) => g.product === p)) {
      const st = parseLabState(new URLSearchParams(window.location.search));
      runSearch(bbox, p, st.from ?? "", st.to ?? "");
    }
  };

  // ---- the bottom panel's numeric views (Phase 2) ---------------------------------------------
  const [panelTab, setPanelTab] = useState<PanelTab>("series");
  const [profilePts, setProfilePts] = useState<ProfilePoint[]>([]);
  // the series runs over the pair's stack: same stack AND same product as the first date (the
  // engine refuses mixed product/track stacks, so the ask is scoped before it is made), capped
  const seriesIds = useMemo(() => {
    const me = granules.find((g) => g.id === beforeId);
    return granules
      .filter((g) => (me ? g.stack === me.stack && g.product === me.product : g.id === beforeId))
      .slice()
      .sort((x, y) => String(x.start).localeCompare(String(y.start)))
      .slice(0, 24)
      .map((g) => g.id);
  }, [granules, beforeId]);
  const armProfile = useCallback(() => {
    setProfilePts([]);                      // a fresh A->B each time the tab is (re)armed
  }, []);
  const onMapClick = useCallback((lat: number, lon: number) => {
    if (panelTab !== "profile") return;
    setProfilePts((pts) => (pts.length >= 2 ? [{ lon, lat }] : [...pts, { lon, lat }]));
  }, [panelTab]);

  // Phase 4 — ROI drawing: the panel arms a mode; the map collects vertices; a finished shape
  // is pushed to the URL (roi=box:…|polygon:…) exactly like every other choice
  const armRoi = useCallback((mode: "box" | "polygon" | null) => {
    setDrawMode(mode);
    setDraftRing([]);
  }, []);
  const finishRoi = useCallback(() => {
    setDraftRing((ring) => {
      if (ring.length >= 3) {
        const shape: LabRoi = { kind: "polygon", ring };
        setRoiShape(shape);
        pushUrl({ roi: roiToParam(shape) ?? "" });
      }
      return ring;
    });
    setDrawMode(null);
  }, [pushUrl]);
  // a box completes on its second click (the ring reaches 2 corners)
  useEffect(() => {
    if (drawMode !== "box" || draftRing.length < 2) return;
    const shape: LabRoi = { kind: "box", ring: draftRing };
    setRoiShape(shape);
    setDrawMode(null);
    pushUrl({ roi: roiToParam(shape) ?? "" });
  }, [drawMode, draftRing, pushUrl]);
  const clearRoi = useCallback(() => {
    setRoiShape(null);
    setDraftRing([]);
    setDrawMode(null);
    pushUrl({ roi: "" });
  }, [pushUrl]);

  // Phase 5 — the pair network (engine-derived) + the pipeline bridge, one call each per box/window
  useEffect(() => {
    if (!bbox) return;
    const ctrl = new AbortController();
    setPairNet(null);
    bg.pairNetwork({ west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3], level }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setPairNet(r); })
      .catch(() => { if (!ctrl.signal.aborted) setPairNet(null); });   // the tab states its own empties
    return () => ctrl.abort();
  }, [bbox, level]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bbox) return;
    const ctrl = new AbortController();
    setLabRunsRes(null);
    bg.labRuns({ west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setLabRunsRes(r); })
      .catch(() => { if (!ctrl.signal.aborted) setLabRunsRes(null); });
    return () => ctrl.abort();
  }, [bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // clicking a network edge loads its pair (the FIRST variant's granule id pair; the group's
  // facts already carry the choice the engine made)
  const pickPair = useCallback((granuleIds: string[]) => {
    if (granuleIds.length < 1) return;
    setBeforeId(granuleIds[0]);
    setAfterId(granuleIds[granuleIds.length - 1]);
    pushUrl({ a: granuleIds[0], b: granuleIds[granuleIds.length - 1] });
  }, [pushUrl]);

  // dates for the header (the engine's own strings, verbatim)
  const gOf = (id: string) => granules.find((g) => g.id === id);
  const dateLine = compareMode === "difference" && diff.meta?.diff
    ? `${diff.meta.diff.date_a ?? "—"} → ${diff.meta.diff.date_b ?? "—"} · gap ${diff.meta.diff.gap_days} d`
    : `${gOf(beforeId)?.start ?? gOf(beforeId)?.ref_time ?? "—"} → ${gOf(afterId)?.start ?? gOf(afterId)?.ref_time ?? "—"}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0e1116] text-[#d9dee4]">
      {/* ---- top bar ---- */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#262c36] px-4 py-2 text-xs">
        <span className="font-medium text-[#7fd8e6]">Data Lab</span>
        <span className="font-mono text-[10px] text-[#8b949e]">
          {bbox ? `box ${bbox.map((v) => Number(v.toFixed(3))).join(", ")}` : "no box yet — open a box from the Explorer or paste a /lab link"}
        </span>
        <span className="font-mono text-[10px] text-[#8b949e]">{dateLine}</span>
        <span className="ml-auto flex items-center gap-3 text-[10px] text-[#8b949e]">
          <Link href="/background/retrieval" className="text-[#7ec8d3] hover:underline">find data (Explorer)</Link>
          <span>times UTC · every colour and difference comes from the engine</span>
        </span>
      </header>

      {/* ---- banners ---- */}
      {searching && <p role="status" className="border-b border-[#262c36] px-4 py-1.5 text-[10px] text-[#8b949e]">searching for granules…</p>}
      {searchError && <p role="alert" className="border-b border-[#4a2f24] bg-[#2a1712] px-4 py-1.5 text-[10px] text-[#e8a087]">{searchError}</p>}
      {!bbox && !searching && (
        <p role="status" className="border-b border-[#262c36] px-4 py-1.5 text-[10px] text-[#8b949e]">
          no box in the URL — searching the map&apos;s last context…
        </p>
      )}
      {before.message && compareMode !== "difference" && (
        <p role="alert" className="border-b border-[#4a2f24] bg-[#2a1712] px-4 py-1.5 text-[10px] text-[#e8a087]">{before.message}</p>
      )}
      {diff.message && compareMode === "difference" && (
        <p role="alert" className="border-b border-[#4a2f24] bg-[#2a1712] px-4 py-1.5 text-[10px] text-[#e8a087]">{diff.message}</p>
      )}
      {(before.wait || after.wait || diff.wait) && (
        <p role="status" className="border-b border-[#3a3524] bg-[#222012] px-4 py-1.5 text-[10px] text-[#d9c98a]">
          {before.wait ?? after.wait ?? diff.wait}
        </p>
      )}

      <PairPicker
        candidates={granules} product={product}
        hasProduct={{ GCOV: granules.some((g) => g.product === "GCOV"), GUNW: granules.some((g) => g.product === "GUNW") }}
        aId={beforeId} bId={afterId} step={pickStep} busy={searching}
        diffActive={compareMode === "difference" && !!afterId && !!beforeId}
        onProduct={switchProduct} onPick={pickOne} onSwap={swapPair} onClear={clearPair}
      />

      {/* ---- main: left panel | map | right panel ---- */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        {/* left: granule + layers */}
        <aside className="max-h-[40vh] w-full shrink-0 overflow-y-auto border-b border-[#262c36] bg-[#12161d] lg:max-h-none lg:w-[300px] lg:border-r lg:border-b-0" aria-label="data and layers">
          <LayerStackPanel
            candidates={granules.filter((g) => g.product === product)}
            selectedId={beforeId}
            layerKey={effectiveLayer}
            onSelect={selectGranule}
            onLayer={pickLayer}
            busy={before.busy || after.busy || diff.busy}
          />
        </aside>

        {/* centre: the map */}
        <section className="relative min-h-[320px] flex-1" aria-label="map canvas">
          <LabMap
            overlays={overlays}
            bbox={bbox}
            swipe={compareMode === "swipe" ? swipe : undefined}
            onSwipe={setSwipe}
            onClick={onMapClick}
            pins={profilePts.map((p, i) => ({ lon: p.lon, lat: p.lat, label: i === 0 ? "A" : "B" }))}
            drawMode={drawMode}
            draftRing={draftRing}
            onDraftRing={setDraftRing}
            roiShape={roiShape as RoiShape | null}
            onDrawDone={finishRoi}
          />
          {/* before/after toggle + flicker state sit on the map (they act on the images) */}
          {compareMode !== "difference" && beforeId !== afterId && (
            <div className="absolute bottom-3 left-3 z-10 flex overflow-hidden rounded-md border border-[#333b47] bg-[#0e1116]/90 text-[10px]">
              <button
                type="button"
                aria-pressed={(compareMode === "flicker" ? flickerEnd : shownEnd) === "before"}
                onClick={() => { setCompareMode("before-after"); setShownEnd("before"); }}
                className={`px-2.5 py-1 ${(compareMode === "flicker" ? flickerEnd : shownEnd) === "before" ? "bg-[#12333a] text-[#7fd8e6]" : "text-[#8b949e] hover:text-[#d9dee4]"}`}
              >
                before
              </button>
              <button
                type="button"
                aria-pressed={(compareMode === "flicker" ? flickerEnd : shownEnd) === "after"}
                onClick={() => { setCompareMode("before-after"); setShownEnd("after"); }}
                className={`border-l border-[#333b47] px-2.5 py-1 ${(compareMode === "flicker" ? flickerEnd : shownEnd) === "after" ? "bg-[#12333a] text-[#7fd8e6]" : "text-[#8b949e] hover:text-[#d9dee4]"}`}
              >
                after
              </button>
            </div>
          )}
          {compareMode === "swipe" && (
            <p className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded bg-[#0e1116]/90 px-2 py-1 text-[10px] text-[#8b949e]">
              west of the divider: first date · east: second date
            </p>
          )}
          {compareMode === "difference" && !diff.busy && !diff.message && diff.meta && (
            <p className="absolute bottom-3 left-3 z-10 rounded bg-[#0e1116]/90 px-2 py-1 font-mono text-[10px] text-[#e6c977]">
              {diff.meta.diff?.mode_label}
            </p>
          )}
        </section>

        {/* right: compare + legend + provenance */}
        <aside className="w-full shrink-0 overflow-y-auto border-t border-[#262c36] bg-[#12161d] lg:w-[340px] lg:border-l lg:border-t-0" aria-label="compare and provenance">
          <ComparePanel
            candidates={granules.filter((g) => g.product === product)}
            beforeId={beforeId}
            afterId={afterId}
            layerKey={effectiveLayer}
            invLayer={invLayer}
            meta={active.meta}
            lockedRange={lockedRange}
            compareMode={compareMode}
            diffMode={diffMode}
            corr={corr}
            onBefore={setPairA}
            onAfter={setPairB}
            onLayer={pickLayer}
            onCompareMode={setMode}
            onDiffMode={setDMode}
            onCorr={setCorrChip}
            onLockRange={setRange}
            busy={active.busy}
          />
          <div className="space-y-2 border-t border-[#262c36] p-3">
            <LabLegend meta={active.meta} label={compareMode === "difference" ? "difference" : effectiveLayer.replace(/^science__LSAR__\w+__grids__frequency[AB]__/, "")} />
            {/* teaching text per layer + per diff mode (engine-served, static config) */}
            {explain?.diff_modes?.[compareMode === "difference" ? diffMode : ""] && (
              <div className="rounded border border-[#262c36] bg-[#0e1116] p-2 text-[10px] text-[#8b949e]">
                <p className="text-[#d9dee4]">{explain.diff_modes[compareMode === "difference" ? diffMode : ""].what_it_is}</p>
                <p className="mt-1">how to read: {explain.diff_modes[compareMode === "difference" ? diffMode : ""].how_to_read}</p>
                <p className="mt-1 text-[#d9c98a]">easy to misread: {explain.diff_modes[compareMode === "difference" ? diffMode : ""].misread}</p>
              </div>
            )}
          </div>
          <details className="border-t border-[#262c36]">
            <summary className="cursor-pointer px-3 py-2 text-[11px] text-[#7ec8d3]">provenance</summary>
            <div className="px-3 pb-3">
              <ProvenanceDrawer
                meta={active.meta}
                whatItIs={invLayer?.what_it_is ?? null}
                howToRead={explain?.layers?.[invLayer?.role ?? ""]?.how_to_read ?? null}
              />
            </div>
          </details>
          <RunArraysPanel runs={labRunsRes} overlay={arrayOverlay} onOverlay={setArrayOverlay} />
        </aside>
      </div>

      {/* ---- bottom: the engine-computed numeric panels (Phase 2) ---- */}
      <BottomPanel
        tab={panelTab}
        box={bbox}
        id={beforeId}
        layer={effectiveLayer}
        scale={active.meta?.scale}
        corr={corrActive ? corr : "off"}
        unit={active.meta?.unit ?? null}
        seriesIds={seriesIds}
        profilePoints={profilePts}
        onArmProfile={armProfile}
        roiShape={roiShape}
        drawMode={drawMode}
        onArmRoi={armRoi}
        onClearRoi={clearRoi}
        pairNetwork={panelTab === "pairs" ? pairNet : null}
        onPickPair={pickPair}
        onTab={setPanelTab}
      />
    </div>
  );
}

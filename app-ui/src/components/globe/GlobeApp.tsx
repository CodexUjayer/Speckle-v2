"use client";

/** GlobeApp (§7) — the globe landing experience. Orchestrates: engine health + cache lists, the
 *  pin -> tile-at flow (debounced, AbortController), scans (POST /api/scans, pollWhile), results
 *  (live slim run + pipeline-scoped layers, or cached rows), overlay rendering with an LRU layer
 *  cache, the Data tab, and URL state (§7.7). Honesty rules: engine strings verbatim, an empty
 *  cache renders an honest empty state, a field the engine doesn't compute is simply absent. */
import { boxFromCenter, type Box } from "@/lib/boxFromCenter";
import { fitBoxToCap } from "@/lib/fitBoxToCap";
import type { AreaTile } from "./ScanPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { api, pollWhile } from "@/lib/api";
import { useEngineUrl } from "@/lib/engineUrl";
import { cache, cacheConfigured } from "@/lib/cache";
import { colorize, validateLayerPayload, decodeLayer } from "@/lib/raster";
import { parseCoordinates } from "@/lib/geo-input";
import { mostNotableTier, TIER_PIN_COLORS } from "@/lib/status";
import { parseUrlState, writeUrlState, type PanelMode, type UrlState } from "@/lib/urlstate";
import { createUrlWriter, MAP_PATH_PREFIX, type UrlWriter } from "@/lib/urlSync";
import { engineJson } from "@/lib/engineFetch";
import { loadCamera } from "@/lib/camera";
import { clearQueryContext, saveQueryContext } from "@/lib/queryContext";
import type {
  CachedSummary, CachedVerdict, FeaturedArea, Health, LayerPayload, PipelineInfo, PipelineResult, RunState, TileInfo,
} from "@/lib/types";
import { timeAgo } from "@/lib/format";
import SearchBar from "./SearchBar";
import AppNav from "./AppNav";
import Legend, { MapKey } from "./Legend";
import AreasPanel from "./AreasPanel";
import ScanPanel from "./ScanPanel";
import { ScanStatusStrip, scanStatusFrom, useScanTraffic } from "./ScanStatus";
import { useAreaLayers } from "./useAreaLayers";
import FindingsPanel, { type LayerSource } from "./FindingsPanel";
import { verdictUseFrom } from "@/lib/verdictUse";
import DataPanel from "./DataPanel";
import BgWaitNote from "@/components/BgWaitNote";
import BottomSheet from "./BottomSheet";
import VerdictDock, { type DockMode } from "./dock/VerdictDock";
import { useGranules } from "@/lib/useGranules";
import { useTimelinePicks } from "@/lib/useTimelinePicks";
import { pickVerdict, verdictFromSummaries, type Hotspot } from "@/lib/verdictView";
import type { OverlaySpec } from "./GlobeMap";

const GlobeMap = dynamic(() => import("./GlobeMap"), {
  ssr: false,
  loading: () => <div className="flex h-full w-full items-center justify-center bg-[#0b0d12]"><p className="text-xs text-[#8a837b]">loading the globe…</p></div>,
});

// The scan window is NOT chosen here: the engine uses window.lookback_days from config/common.yaml (shown by GET /api/settings/defaults).

/** Desktop Data panel: open by default (so "how much SAR data exists here" needs no extra click),
 *  remembered across reloads only once the user explicitly closes it ("0") or reopens it ("1"). */
const DATA_OPEN_KEY = "globe-data-open";

interface LayerCacheEntry {
  dataUrl: string;
  bounds: [number, number, number, number];
  payload: LayerPayload;
}

export default function GlobeApp() {
  const engineUrl = useEngineUrl();
  const searchParams = useSearchParams();

  // ---- engine + cache state ---------------------------------------------------------------
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineInfo[] | null>(null);
  const [featured, setFeatured] = useState<FeaturedArea[] | null>(null);
  const [cachedRows, setCachedRows] = useState<CachedSummary[] | null>(null);
  const [cachedTotal, setCachedTotal] = useState<number | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  // ---- selection state ---------------------------------------------------------------------
  const [pin, setPin] = useState<[number, number] | null>(null);
  const [latInput, setLatInput] = useState("");
  const [lonInput, setLonInput] = useState("");
  const [tile, setTile] = useState<TileInfo | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);
  const [tileLoading, setTileLoading] = useState(false);
  // Range (km): a square box of this side around the pin. Empty = the engine's own tile box.
  const [rangeInput, setRangeInput] = useState("");
  const customBox = useMemo(() => {
    if (!pin || rangeInput.trim() === "") return null;
    return boxFromCenter(pin[0], pin[1], Number(rangeInput));
  }, [pin, rangeInput]);
  const rangeBad = rangeInput.trim() !== "" && !customBox;
  // The Range box is the scan scope: the engine says which of its tiles the box touches (capped), and a scan runs
  // them one after another. No range typed = the pin's own tile, as before. A box over the cap is auto-shrunk
  // (fitBoxToCap) to the largest size that fits, rather than refused outright — areaPlan.box is that EFFECTIVE
  // box (may be smaller than customBox); fitKm/requestedKm say so when it happened.
  const [areaPlan, setAreaPlan] = useState<{
    tiles: TileInfo[] | null; error: string | null; loading: boolean;
    box: Box | null; fitKm: number | null; requestedKm: number | null;
  }>({ tiles: null, error: null, loading: false, box: null, fitKm: null, requestedKm: null });
  const shownPolygon = useMemo<[number, number][] | null>(() => {
    const b = areaPlan.box ?? customBox;
    return b
      ? [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]
      : (tile?.polygon_lonlat ?? null);
  }, [areaPlan.box, customBox, tile?.polygon_lonlat]);
  useEffect(() => {
    if (!pin || rangeBad || rangeInput.trim() === "") {
      setAreaPlan({ tiles: null, error: null, loading: false, box: null, fitKm: null, requestedKm: null });
      return;
    }
    const requestedKm = Number(rangeInput);
    let alive = true;
    setAreaPlan((p) => ({ ...p, loading: true, error: null }));
    const t = setTimeout(() => {
      fitBoxToCap(pin[0], pin[1], requestedKm)
        .then((r) => {
          if (!alive) return;
          if (r.ok) {
            setAreaPlan({
              tiles: r.tiles, error: null, loading: false, box: r.box,
              fitKm: r.shrunk ? r.usedKm : null, requestedKm,
            });
          } else {
            setAreaPlan({ tiles: null, error: r.error, loading: false, box: null, fitKm: null, requestedKm });
          }
        })
        .catch((e) => {
          if (!alive) return;
          setAreaPlan({
            tiles: null, error: e instanceof Error ? e.message : String(e),
            loading: false, box: null, fitKm: null, requestedKm,
          });
        });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [pin, rangeInput, rangeBad]);
  const [queue, setQueue] = useState<AreaTile[] | null>(null);
  const queueRef = useRef<AreaTile[] | null>(null);
  const stopRef = useRef(false);
  const areaLayers = useAreaLayers(queue);
  const updateQueue = useCallback((fn: (q: AreaTile[]) => AreaTile[]) => {
    if (!queueRef.current) return;
    queueRef.current = fn(queueRef.current);
    setQueue(queueRef.current);
  }, []);
  const [panel, setPanel] = useState<PanelMode>("explore");
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const [cachedForTile, setCachedForTile] = useState<CachedSummary[] | null>(null);

  // ---- run + results state ------------------------------------------------------------------
  const [scanRunId, setScanRunId] = useState<string | null>(null);
  /** Scan pressed, engine has not named a run yet: the status strip says so instead of showing nothing */
  const [starting, setStarting] = useState(false);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [resultsBundleId, setResultsBundleId] = useState<string | null>(null); // cached source
  const [resultsRunId, setResultsRunId] = useState<string | null>(null);       // live source
  const [cachedResults, setCachedResults] = useState<{ rows: CachedVerdict[]; bundleId: string } | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null);
  const [selectedDetection, setSelectedDetection] = useState<{ id: string; bbox: [number, number, number, number] } | null>(null);

  // ---- overlays ------------------------------------------------------------------------------
  const [overlays, setOverlays] = useState<Record<string, { pipeline: string; layer: string; opacity: number }>>({});
  const [overlayErrors, setOverlayErrors] = useState<Record<string, string>>({});
  const layerCache = useRef<Map<string, LayerCacheEntry>>(new Map());
  const lastOverlayOrder = useRef<string[]>([]);
  const [sarSpec, setSarSpec] = useState<OverlaySpec | null>(null);

  // ---- map state -----------------------------------------------------------------------------
  const [flat, setFlat] = useState(false);
  // 3D terrain (relief + hillshade + tilt) is ON by default; the choice and the exaggeration are remembered
  const [terrain3d, setTerrain3d] = useState(true);
  const [terrainEx, setTerrainEx] = useState(1.5);
  const [buildings3d, setBuildings3d] = useState(true);
  const [viewCmd, setViewCmd] = useState<{ key: number; pitch?: number; rotateBy?: number } | null>(null);
  const [flyTarget, setFlyTarget] = useState<{ center: [number, number]; zoom: number; key: number } | null>(null);
  const [pairFootprint, setPairFootprint] = useState<[number, number][] | null>(null);
  const [fitFootprintKey, setFitFootprintKey] = useState(0);
  const [webglMsg, setWebglMsg] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  // Data is NOT a tab of the left panel any more: on desktop it is its own details panel on the RIGHT (the left panel
  // keeps Explore / Pin / Results). On a phone there is no room for two panels, so there it stays a tab of the sheet.
  // It starts closed (nothing pinned yet) but opens itself, on desktop, the moment a point IS pinned — see the
  // pin -> tile-at effect below — so "how much SAR data exists here" is visible without an extra click.
  const [dataOpen, setDataOpen] = useState(false);
  const bootOpensData = useRef(false);
  // the verdict dock (bottom): its height keeps the side panels and the camera clear of it; "See why" hides the side panels
  const [dockH, setDockH] = useState(0);
  const [dockMode, setDockMode] = useState<DockMode>("verdict");
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [focusSpot, setFocusSpot] = useState<string | null>(null);
  const [fitBox, setFitBox] = useState<{ key: number; bbox: [number, number, number, number] } | null>(null);
  const [wantFullBundle, setWantFullBundle] = useState<string | null>(null);
  // bottom edge of the legend (top-right): the right-hand panel starts below it so the two never overlap
  const legendRef = useRef<HTMLDivElement | null>(null);
  const [legendBottom, setLegendBottom] = useState(0);
  const zoomRef = useRef<number | undefined>(undefined);
  const pinRef = useRef<[number, number] | null>(null);
  useEffect(() => { pinRef.current = pin; }, [pin]);
  // read inside the pin effect without making it re-run the tile-at fetch on every resize
  const isNarrowRef = useRef(false);
  useEffect(() => { isNarrowRef.current = isNarrow; }, [isNarrow]);

  // the camera a link asks for — read ONCE; GlobeMap creates the map there (no world view first)
  const startAt = useMemo(() => {
    const st = parseUrlState(new URLSearchParams(searchParams.toString()));
    return { lat: st.lat, lon: st.lon, z: st.z };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const engineOnline = healthChecked ? health !== null : false;

  // ---- boot: URL state + env -----------------------------------------------------------------
  useEffect(() => {
    const st: UrlState = parseUrlState(new URLSearchParams(searchParams.toString()));
    if (st.lat !== undefined && st.lon !== undefined) {
      setPin([st.lat, st.lon]);
      setLatInput(String(st.lat));
      setLonInput(String(st.lon));
      // no flyTarget here on purpose: GlobeMap is CREATED at this camera (startAt), so a fly
      // from the world view would only add the zoom-out this fixes
    }
    if (st.tile && (st.lat === undefined || st.lon === undefined)) {
      // §7.7: a pasted ?tile= (or ?panel=granules&tile=) link restores the same view — the
      // engine resolves the id back to geometry; the UI never inverts MGRS ids itself.
      api.tileAtId(st.tile).then((r) => {
        const [clon, clat] = r.tile.center_lonlat;
        setSelectedTile(r.tile.id);
        setPin([clat, clon]);
        setLatInput(String(Number(clat.toFixed(5))));
        setLonInput(String(Number(clon.toFixed(5))));
        setFlyTarget({ center: [clon, clat], zoom: st.z ?? 11.5, key: Date.now() });
      }).catch(() => {
        // unknown tile id: stay on the default view, nothing invented
      });
    }
    if (st.z !== undefined) zoomRef.current = st.z;
    if (st.tile) setSelectedTile(st.tile);
    if (st.scan) {
      setScanRunId(st.scan);
      setPanel("results");
    } else if (st.bundle) {
      setResultsBundleId(st.bundle);
      setPanel("results");
    }
    if (st.data) setDataOpen(true);
    else if (window.innerWidth >= 1024) {
      // desktop default: open unless the user explicitly closed it in an earlier visit
      try {
        if (window.localStorage.getItem(DATA_OPEN_KEY) !== "0") setDataOpen(true);
      } catch { /* private mode */ }
    }
    if (st.panel === "granules") {
      // old links (?panel=granules) keep working: the Data panel opens, the left panel shows the pin
      bootOpensData.current = true;
      setDataOpen(true);
      setPanel("pin");
    } else if (st.panel !== "explore") setPanel(st.panel);
    try {
      const saved = window.localStorage.getItem("globe-flat");
      if (saved === "1") setFlat(true);
      else if (saved === null && loadCamera()?.projection === "mercator") setFlat(true);
    } catch { /* private mode */ }
    try {
      if (window.localStorage.getItem("globe-3d") === "0") setTerrain3d(false);
      if (window.localStorage.getItem("globe-3d-bld") === "0") setBuildings3d(false);
      const ex = Number(window.localStorage.getItem("globe-3d-ex"));
      if (Number.isFinite(ex) && ex >= 1 && ex <= 5) setTerrainEx(ex);
    } catch { /* private mode */ }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onMq = () => setReducedMotion(mq.matches);
    mq.addEventListener?.("change", onMq);
    const onResize = () => {
      setIsNarrow(window.innerWidth < 1024);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      mq.removeEventListener?.("change", onMq);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- engine + cache loads ------------------------------------------------------------------
  const refreshLists = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null)).finally(() => setHealthChecked(true));
    api.pipelines().then((r) => setPipelines(r.pipelines)).catch(() => setPipelines(null));
    const cacheErrorText = (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      // a bare network refusal ("Failed to fetch") names nothing — say what failed
      return /failed to fetch|networkerror|load failed/i.test(message)
        ? `the verdict cache is unreachable (${message})`
        : message;
    };
    if (cacheConfigured) {
      cache
        .pins(200)
        .then(({ rows, total }) => {
          setCachedRows(rows);
          setCachedTotal(total);
          setCacheError(null);
        })
        .catch((e) => setCacheError(cacheErrorText(e)));
      cache
        .featured()
        .then(setFeatured)
        .catch((e) => setCacheError(cacheErrorText(e)));
    } else {
      setFeatured([]);
      setCachedRows([]);
    }
  }, []);

  useEffect(() => {
    refreshLists();
    const id = setInterval(refreshLists, 30_000);
    return () => clearInterval(id);
  }, [refreshLists]);

  // ---- URL state write-back (debounced; never navigates, never fires after the user left /map) ----
  const urlWriter = useRef<UrlWriter<UrlState> | null>(null);
  useEffect(() => {
    const w = createUrlWriter<UrlState>({
      pathPrefix: MAP_PATH_PREFIX,
      build: (current, patch) => {
        writeUrlState(current, { ...parseUrlState(current), ...patch });
        return current;
      },
    });
    urlWriter.current = w;
    return () => {
      w.dispose();
      if (urlWriter.current === w) urlWriter.current = null;
    };
  }, []);
  const pushUrl = useCallback((patch: Partial<UrlState>) => {
    urlWriter.current?.schedule(patch);
  }, []);

  // ---- pin -> tile-at (debounced ~300ms, AbortController, out-of-order ignored) ---------------
  useEffect(() => {
    if (!pin) {
      setTile(null);
      setTileError(null);
      return;
    }
    // the verdict dock (bottom) now answers "how much SAR data exists here"; the Data panel stays one click away
    // remember the pin NOW (before the tile resolves) so Background can pick it up even if the
    // user switches tab mid-load; the previous pin's tile/box is dropped so it can't leak across
    saveQueryContext({ lat: pin[0], lon: pin[1], tile: undefined, bbox: undefined });
    const ctrl = new AbortController();
    setTileLoading(true);
    const id = setTimeout(() => {
      engineJson<{ ok: true; tile: TileInfo }>(`/api/tile-at?lon=${pin[1]}&lat=${pin[0]}`, { signal: ctrl.signal })
        .then((body) => {
          setTile(body.tile);
          setTileError(null);
          setSelectedTile(body.tile.id);
          // the engine's own box for this tile — exactly the area the Data tab searches
          saveQueryContext({
            lat: pin[0], lon: pin[1], tile: body.tile.id, bbox: body.tile.bbox_lonlat,
            level: "GUNW,GCOV",
          });
          pushUrl({ tile: body.tile.id, lat: pin[0], lon: pin[1] });
        })
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          setTile(null);
          setTileError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setTileLoading(false);
        });
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(id);
    };
  }, [pin, pushUrl]);

  // Bring the whole tile (or the Range box) into the part of the screen the dock leaves free, as soon as it is known.
  // The dock grows a little while its verdict, pictures and timeline arrive, so the fit is repeated while the pin is new.
  const fitBoxNow = customBox ?? tile?.bbox_lonlat ?? null;
  const fitSig = fitBoxNow ? `${tile?.id ?? ""}|${fitBoxNow.join(",")}` : "";
  const fitAt = useRef(0);
  const fitBoxRef = useRef(fitBoxNow);
  fitBoxRef.current = fitBoxNow;
  useEffect(() => {
    if (!fitSig || !fitBoxRef.current) return;
    fitAt.current = Date.now();
    setFitBox({ key: Date.now(), bbox: fitBoxRef.current });
  }, [fitSig]);
  const dockFitSig = Math.round(dockH / 40);
  useEffect(() => {
    if (!fitBoxRef.current || Date.now() - fitAt.current > 6000) return;
    const t = setTimeout(() => { if (fitBoxRef.current) setFitBox({ key: Date.now(), bbox: fitBoxRef.current }); }, 450);
    return () => clearTimeout(t);
  }, [dockFitSig]);

  // the Data retrieval tab searches exactly the box drawn here: a custom range replaces the tile box
  useEffect(() => {
    if (!pin) return;
    if (customBox) saveQueryContext({ lat: pin[0], lon: pin[1], bbox: customBox });
    else if (tile?.bbox_lonlat) saveQueryContext({ lat: pin[0], lon: pin[1], bbox: tile.bbox_lonlat });
  }, [customBox, tile?.bbox_lonlat, pin]);

  // ---- cached rows for the selected tile -------------------------------------------------------
  useEffect(() => {
    if (!tile?.id || !cacheConfigured) {
      setCachedForTile(null);
      return;
    }
    let alive = true;
    cache
      .forTile(tile.id)
      .then((rows) => alive && setCachedForTile(rows))
      .catch(() => alive && setCachedForTile([]));
    return () => {
      alive = false;
    };
  }, [tile?.id]);

  // ---- area scan: the next tile of the queue --------------------------------------------------
  const launchQueued = useCallback((i: number, attempt = 0) => {
    const q = queueRef.current;
    if (!q || i >= q.length) return;
    if (stopRef.current) {                               // "stop after the current tile"
      updateQueue((cur) => cur.map((x, j) => (j >= i && x.status === "waiting" ? { ...x, status: "skipped" } : x)));
      return;
    }
    const [lon, lat] = q[i].tile.center_lonlat;
    api.startScan(lon, lat)
      .then((r) => {
        updateQueue((cur) => cur.map((x, j) => (j === i ? { ...x, status: "running", runId: r.run_id } : x)));
        setScanRunId(r.run_id);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        if (/already active/i.test(message) && attempt < 10) {        // the engine is still closing the last run
          setTimeout(() => launchQueued(i, attempt + 1), 1500);
          return;
        }
        // could not even start (scans off, no credentials, …): every later tile would fail the same way — stop here
        updateQueue((cur) => cur.map((x, j) => (j === i ? { ...x, status: "error", error: message }
          : j > i && x.status === "waiting" ? { ...x, status: "skipped" } : x)));
        setRunError(message);
      });
  }, [updateQueue]);

  const startAreaScan = useCallback(() => {
    const tiles = areaPlan.tiles;
    if (!tiles?.length) return;
    setRunError(null);
    setBusyRunId(null);
    setRunState(null);
    stopRef.current = false;
    queueRef.current = tiles.map((t) => ({ tile: t, status: "waiting" as const }));
    setQueue(queueRef.current);
    launchQueued(0);
  }, [areaPlan.tiles, launchQueued]);

  // ---- poll a running scan / re-attach ---------------------------------------------------------
  useEffect(() => {
    if (!scanRunId) return;
    const stop = pollWhile(
      () =>
        api
          .run(scanRunId, { slim: true })
          .then((state) => ({ done: state.status === "ok" || state.status === "error", value: state })),
      (state: RunState) => {
        setRunState(state);
        const qi = queueRef.current ? queueRef.current.findIndex((x) => x.runId === scanRunId) : -1;
        if (qi >= 0) {                       // a tile of an area scan: record it, then start the next one
          if ((state.status === "ok" || state.status === "error") && queueRef.current?.[qi].status === "running") {
            updateQueue((q) => q.map((x, j) => (j === qi ? {
              ...x, status: state.status === "ok" ? "ok" : "error",
              bundleId: state.bundle_id, error: state.status === "error" ? (state.error ?? "scan failed") : undefined,
            } : x)));
            if (state.status === "ok") refreshLists();
            launchQueued(qi + 1);
          }
          return;
        }
        if (state.status === "ok") {
          setResultsRunId(scanRunId);
          setResultsBundleId(null);
          setPanel("results");
          pushUrl({ scan: scanRunId, panel: "results" });
          refreshLists();
          // re-attach (?scan= without coordinates): re-centre on the scanned tile so the
          // overlays are actually visible — the engine resolves the id back to a centre
          if (!pinRef.current && state.tile) {
            api.tileAtId(state.tile).then((r) => {
              const [clon, clat] = r.tile.center_lonlat;
              setSelectedTile(r.tile.id);
              setPin([clat, clon]);
              setLatInput(String(Number(clat.toFixed(5))));
              setLonInput(String(Number(clon.toFixed(5))));
              setFlyTarget({ center: [clon, clat], zoom: 11.5, key: Date.now() });
            }).catch(() => undefined);
          }
        }
      },
      1500,
      (message) => setRunError(message),
    );
    return stop;
  }, [scanRunId, pushUrl, refreshLists, updateQueue, launchQueued]);

  // ---- cached bundle results -------------------------------------------------------------------
  useEffect(() => {
    if (!resultsBundleId || !cacheConfigured) {
      if (!resultsRunId) setCachedResults(null);
      return;
    }
    let alive = true;
    cache
      .forBundle(resultsBundleId)
      .then((rows: CachedVerdict[]) => {
        if (!alive) return;
        setCachedResults({ rows, bundleId: resultsBundleId });
        setResultsRunId(null);
        setRunState(null);
      })
      .catch((e) => alive && setRunError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [resultsBundleId, cacheConfigured, resultsRunId]);

  // ---- keyboard: Esc clears the selection / closes the panel -----------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanel("explore");
        setPin(null);
        setSelectedTile(null);
        setSelectedDetection(null);
        setPairFootprint(null);
        setDataOpen(false);
        clearQueryContext();
        pushUrl({ panel: undefined, data: undefined, tile: undefined, scan: undefined, bundle: undefined, lat: undefined, lon: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushUrl]);

  // ---- overlay loading (LRU 12, one colour implementation) --------------------------------------
  const loadLayerPayload = useCallback(async (source: "live" | "cached", sourceId: string, pipeline: string, layer: string): Promise<LayerPayload> => {
    const key = `${source}|${sourceId}|${pipeline}|${layer}`;
    const hit = layerCache.current.get(key);
    if (hit) return hit.payload;
    const payload =
      source === "live"
        ? (await api.pipelineLayer(sourceId, pipeline, layer)).layer
        : await cache.layer(sourceId, pipeline, layer);
    if (layerCache.current.size >= 12) {
      const oldest = layerCache.current.keys().next().value;
      if (oldest) layerCache.current.delete(oldest);
    }
    return payload;
  }, []);

  const layerSource: LayerSource = useCallback(
    (pipeline: string, layer: string) => {
      if (resultsRunId) return loadLayerPayload("live", resultsRunId, pipeline, layer);
      if (cachedResults) return loadLayerPayload("cached", cachedResults.bundleId, pipeline, layer);
      return Promise.reject(new Error("no result is open"));
    },
    [resultsRunId, cachedResults, loadLayerPayload],
  );

  const ensureOverlay = useCallback(
    async (pipeline: string, layer: string, opts?: { exclusive?: boolean }): Promise<string | null> => {
      const key = `${pipeline}:${layer}`;
      // `exclusive` (the See why tour) makes this layer the ONLY overlay, so the previous picture fades out as this one fades in
      if (overlays[key] && (!opts?.exclusive || Object.keys(overlays).length === 1)) return null;
      try {
        const sourceId = resultsRunId ?? cachedResults?.bundleId;
        if (!sourceId) throw new Error("no result is open");
        const source = resultsRunId ? "live" : "cached";
        const entryKey = `${source}|${sourceId}|${pipeline}|${layer}`;
        let entry = layerCache.current.get(entryKey);
        if (!entry) {
          const payload = await loadLayerPayload(source, sourceId, pipeline, layer);
          const problems = validateLayerPayload(payload);
          if (problems.length) {
            throw new Error(`layer present but not displayable: ${problems.join("; ")}`);
          }
          const decoded = decodeLayer(payload);
          if (!decoded.ok) throw new Error(`layer present but not displayable: ${decoded.reason}`);
          const canvas = document.createElement("canvas");
          colorize(payload, decoded.data, canvas);
          entry = {
            dataUrl: canvas.toDataURL(),
            bounds: payload.bounds_lonlat as [number, number, number, number],
            payload,
          };
          if (layerCache.current.size >= 12) {
            const oldest = layerCache.current.keys().next().value;
            if (oldest) layerCache.current.delete(oldest);
          }
          layerCache.current.set(entryKey, entry);
        }
        setOverlayErrors((m) => {
          const { [key]: _drop, ...rest } = m;
          return rest;
        });
        if (opts?.exclusive) {
          lastOverlayOrder.current = [key];
          setOverlays((m) => ({ [key]: { pipeline, layer, opacity: m[key]?.opacity ?? 0.85 } }));
        } else {
          lastOverlayOrder.current = [...lastOverlayOrder.current.filter((k) => k !== key), key];
          setOverlays((m) => ({
            ...m,
            [key]: { pipeline, layer, opacity: m[key]?.opacity ?? 0.8 },
          }));
        }
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setOverlayErrors((m) => ({ ...m, [key]: message }));
        return message;
      }
    },
    [overlays, resultsRunId, cachedResults, loadLayerPayload],
  );

  // NOTE: data: URLs need no revoking; the LRU cap (12) bounds memory.

  const toggleOverlay = useCallback(
    (pipeline: string, layer: string, kind: string, on: boolean) => {
      const key = `${pipeline}:${layer}`;
      setOverlays((m) => {
        const next = { ...m };
        if (on && kind === "raster") {
          void ensureOverlay(pipeline, layer);
          lastOverlayOrder.current = [...lastOverlayOrder.current.filter((k) => k !== key), key];
          next[key] = { pipeline, layer, opacity: m[key]?.opacity ?? 0.8 };
        } else {
          delete next[key];
          setPairFootprint(null);
        }
        return next;
      });
    },
    [ensureOverlay],
  );

  const setOverlayOpacity = useCallback((pipeline: string, layer: string, opacity: number) => {
    setOverlays((m) => ({ ...m, [`${pipeline}:${layer}`]: { pipeline, layer, opacity } }));
  }, []);

  // ---- map specs -------------------------------------------------------------------------------
  const overlaySpecs: OverlaySpec[] = useMemo(() => {
    const specs: OverlaySpec[] = [];
    for (const key of lastOverlayOrder.current) {
      const o = overlays[key];
      if (!o) continue;
      const sourceId = resultsRunId ?? cachedResults?.bundleId;
      if (!sourceId) continue;
      const entry = layerCache.current.get(`${resultsRunId ? "live" : "cached"}|${sourceId}|${o.pipeline}|${o.layer}`);
      if (entry) specs.push({ id: `overlay:${key}`, dataUrl: entry.dataUrl, bounds: entry.bounds, opacity: o.opacity });
    }
    specs.push(...areaLayers.specs);           // one layer from every finished tile of an area scan
    if (sarSpec) specs.push(sarSpec);          // a SAR image of a selected granule sits on top
    return specs;
  }, [overlays, resultsRunId, cachedResults, sarSpec, areaLayers.specs]);

  const pins: { tile: string; lon: number; lat: number; tier: string; label: string }[] = useMemo(() => {
    const out: { tile: string; lon: number; lat: number; tier: string; label: string }[] = [];
    if (cachedRows) {
      const best = new Map<string, CachedSummary>();
      for (const r of cachedRows) {
        if (r.center_lon == null || r.center_lat == null) continue;
        const cur = best.get(r.tile);
        if (!cur || cur.computed_at < r.computed_at) best.set(r.tile, r);
      }
      for (const [t, r] of best) {
        out.push({
          tile: t, lon: r.center_lon as number, lat: r.center_lat as number,
          tier: TIER_PIN_COLORS[r.tier ?? "insufficient"] ? (r.tier as string) : "insufficient",
          label: `${t} · ${r.status.replace(/_/g, " ").toLowerCase()}`,
        });
      }
    }
    return out;
  }, [cachedRows]);

  // ---- actions ----------------------------------------------------------------------------------
  const selectPoint = useCallback((lat: number, lon: number, opts?: { zoom?: number; panel?: PanelMode }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    setPin([lat, lon]);
    setLatInput(String(Number(lat.toFixed(5))));
    setLonInput(String(Number(lon.toFixed(5))));
    setSelectedDetection(null);
    setPairFootprint(null);
    setFlyTarget({ center: [lon, lat], zoom: opts?.zoom ?? Math.max(zoomRef.current ?? 0, 10.5), key: Date.now() });
    if (opts?.panel) setPanel(opts.panel);
    pushUrl({ lat, lon, panel: opts?.panel });
  }, [pushUrl]);

  const onMapClick = useCallback(
    (lat: number, lon: number) => {
      selectPoint(lat, lon, { panel: "pin" });
    },
    [selectPoint],
  );

  const startScan = useCallback(
    (lon: number, lat: number) => {
      setRunError(null);
      setBusyRunId(null);
      setStarting(true);
      api
        .startScan(lon, lat)
        .then((r) => {
          setStarting(false);
          setScanRunId(r.run_id);
          setPanel("pin");
          pushUrl({ scan: r.run_id, panel: "pin" });
        })
        .catch((e) => {
          setStarting(false);
          const message = e instanceof Error ? e.message : String(e);
          setRunError(message);
          const m = /run-[0-9a-f]{12}/.exec(message);
          if (m) setBusyRunId(m[0]);
        });
    },
    [pushUrl],
  );

  const openCachedResult = useCallback(
    (bundleId: string, opts?: { quiet?: boolean }) => {
      setResultsBundleId(bundleId);
      setResultsRunId(null);
      setScanRunId(null);
      setRunState(null);
      if (opts?.quiet) return;           // opened by the dock on its own: the side panel and the link stay as they are
      setPanel("results");
      pushUrl({ bundle: bundleId, panel: "results" });
    },
    [pushUrl],
  );

  const openRunResult = useCallback(
    (runId: string) => {
      setScanRunId(runId);
      setResultsBundleId(null);
      setResultsRunId(null);
      setPanel("results");
      pushUrl({ scan: runId, panel: "results" });
    },
    [pushUrl],
  );

  // once a live run finished, fetch its full (still slim) state for the findings list
  useEffect(() => {
    if (!resultsRunId) return;
    let alive = true;
    api
      .run(resultsRunId, { slim: true })
      .then((state) => alive && setRunState(state))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [resultsRunId]);

  // attach a scan id from the URL without re-running
  useEffect(() => {
    const st = parseUrlState(new URLSearchParams(searchParams.toString()));
    if (st.scan && st.scan !== scanRunId && !runState) {
      setScanRunId(st.scan);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const results: RunState | null = runState;
  const implementedCount = pipelines?.filter((p) => p.implemented).length ?? null;
  const totalCount = pipelines?.length ?? null;

  // ---- the verdict dock: lead finding, granule list and picked dots for the pinned tile ----------------------
  const tileId = tile?.id ?? selectedTile;
  const granules = useGranules(
    pin ? pin[1] : null, pin ? pin[0] : null,
    engineOnline && !!tileId && health?.granule_search?.status !== "disabled",
  );
  const onFootprint = useCallback((ring: [number, number][] | null, fit?: boolean) => {
    setPairFootprint(ring ? [...ring] : null);
    if (ring && fit) setFitFootprintKey((k) => k + 1);
  }, []);
  const picks = useTimelinePicks(granules.data, onFootprint, pin ? `${pin[0]},${pin[1]}` : null);

  // the open result only counts for the dock when it is the pinned tile's own
  const openResults: PipelineResult[] | null = useMemo(() => {
    const rows = resultsRunId && results ? { tile: results.tile ?? tileId, list: results.results }
      : cachedResults ? { tile: cachedResults.rows[0]?.tile ?? null, list: cachedResults.rows.map((r) => r.result) } : null;
    if (!rows || (tileId && rows.tile && rows.tile !== tileId)) return null;
    return rows.list;
  }, [resultsRunId, results, cachedResults, tileId]);
  const verdict = useMemo(
    () => (openResults ? pickVerdict(openResults)
      : cachedForTile?.length ? verdictFromSummaries(cachedForTile) : null),
    [openResults, cachedForTile],
  );
  const dockVerdictUse = useMemo(() => verdictUseFrom(openResults ?? []), [openResults]);
  const scanning = !!scanRunId && !!runState && (runState.status === "queued" || runState.status === "running");
  // the run id is known but its first poll has not come back yet (or the queue is between two tiles): still "starting", never blank
  const rawScanStatus = useMemo(
    () => scanStatusFrom({ runState, queue, starting: starting || (!!scanRunId && !runState && !runError) }),
    [runState, queue, starting, scanRunId, runError],
  );
  const scanStatus = useScanTraffic(rawScanStatus);   // + MB downloaded by the whole scan and the recent MB/s
  const stopAreaScan = useCallback(() => { stopRef.current = true; }, []);
  const scanOffer = {
    canScan: engineOnline && !!health?.scans_enabled && health?.earthdata_credentials !== "absent",
    reason: !engineOnline ? "The engine is offline, so scanning is not available."
      : !health?.scans_enabled ? "Scans are switched off on this engine (set NISAR_ENABLE_SCANS=1)."
        : health?.earthdata_credentials === "absent" ? "The engine has no Earthdata credentials, so it cannot read the radar archive."
          : null,
    running: scanning || !!scanStatus,
    stage: scanStatus ? scanStatus.stage : null,
    status: scanStatus,
    error: runError,
    onScan: () => { if (pin) startScan(pin[1], pin[0]); },
  };
  const immersive = dockMode !== "verdict";
  const showLayerOnly = useCallback((pipeline: string, layer: string) => ensureOverlay(pipeline, layer, { exclusive: true }), [ensureOverlay]);
  const clearTourLayers = useCallback(() => {
    lastOverlayOrder.current = [];
    setOverlays({});
    setOverlayErrors({});
  }, []);

  const openOverlayLegend = useMemo(() => {
    const keys = Object.keys(overlays);
    if (keys.length === 0) return null;
    const key = lastOverlayOrder.current[lastOverlayOrder.current.length - 1] ?? keys[keys.length - 1];
    const o = overlays[key];
    if (!o) return null;
    const sourceId = resultsRunId ?? cachedResults?.bundleId;
    if (!sourceId) return null;
    const entry = layerCache.current.get(`${resultsRunId ? "live" : "cached"}|${sourceId}|${o.pipeline}|${o.layer}`);
    return entry ? { layer: entry.payload, opacity: o.opacity } : null;
  }, [overlays, resultsRunId, cachedResults]);
  const activeOverlayLegend = useMemo(
    () => openOverlayLegend ?? (areaLayers.legend ? { layer: areaLayers.legend, opacity: areaLayers.opacity } : null),
    [openOverlayLegend, areaLayers.legend, areaLayers.opacity],
  );

  useEffect(() => {
    const el = legendRef.current;
    if (!el) return;
    const measure = () => setLegendBottom(el.getBoundingClientRect().bottom);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeOverlayLegend]);

  // phone: a map click / scan that switches the sheet to another section leaves the Data tab
  const prevPanel = useRef(panel);
  useEffect(() => {
    if (prevPanel.current === panel) return;
    prevPanel.current = panel;
    if (bootOpensData.current) { bootOpensData.current = false; return; }   // the ?panel=granules deep link's own panel switch
    if (isNarrow) { setDataOpen(false); pushUrl({ data: undefined }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const openData = useCallback(() => {
    setDataOpen(true);
    try { window.localStorage.setItem(DATA_OPEN_KEY, "1"); } catch { /* private mode */ }
    pushUrl({ data: true, panel: panel === "granules" ? "pin" : panel });
  }, [pushUrl, panel]);
  const closeData = useCallback(() => {
    setDataOpen(false);
    try { window.localStorage.setItem(DATA_OPEN_KEY, "0"); } catch { /* private mode */ }
    pushUrl({ data: undefined });
  }, [pushUrl]);

  const dataPanelEl = (
    <DataPanel
      verdictUse={verdictUseFrom(results?.results ?? [])}
      tileId={tile?.id ?? selectedTile}
      tileBbox={tile?.bbox_lonlat ?? null}
      lon={pin ? pin[1] : null}
      lat={pin ? pin[0] : null}
      engineOnline={engineOnline}
      credentials={health?.earthdata_credentials}
      granuleSearchStatus={health?.granule_search?.status}
      granuleSearchReason={health?.granule_search?.reason ?? null}
      onFootprintOnMap={onFootprint}
      onSarOverlay={setSarSpec}
      granules={granules}
      picks={picks}
      inlineTimeline={isNarrow}
      suppressPairDiff={immersive}
    />
  );

  const clearSelection = () => {
    setPanel("explore");
    setPin(null);
    setSelectedDetection(null);
    setPairFootprint(null);
    setDataOpen(false);
    clearQueryContext();
    pushUrl({ panel: undefined, data: undefined, tile: undefined, scan: undefined, bundle: undefined, lat: undefined, lon: undefined });
  };

  const tabs: readonly (readonly [string, string])[] = isNarrow
    ? [["explore", "Explore"], ["pin", "Pin"], ["results", "Results"], ["granules", "Data"]]
    : [["explore", "Explore"], ["pin", "Pin"], ["results", "Results"]];
  const activeTab = isNarrow && dataOpen ? "granules" : panel;

  const panelContent = (
    <>
      <div className="flex items-center justify-between border-b border-[#f0ece4] px-3 py-2">
        <div role="tablist" aria-label="Panel sections" className="flex gap-1">
          {tabs.map(([mode, label]) => (
            <button
              key={mode}
              role="tab"
              aria-selected={activeTab === mode}
              onClick={() => {
                if (mode === "granules") { openData(); return; }
                setPanel(mode as PanelMode);
                if (isNarrow) { setDataOpen(false); pushUrl({ panel: mode as PanelMode, data: undefined }); }
                else pushUrl({ panel: mode as PanelMode });
              }}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                activeTab === mode ? "bg-[#1c1a17] text-[#faf9f6]" : "text-[#4a443c] hover:bg-[#f0ece4]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={clearSelection}
          className="rounded p-1 text-[#8a837b] hover:bg-[#f0ece4]"
          title="clear selection (Esc)"
          aria-label="clear selection"
        >
          <span aria-hidden>Clear</span>
        </button>
      </div>

      <div className="mx-3 mt-2 empty:hidden"><BgWaitNote /></div>

      {!healthChecked && <div className="m-3 skeleton h-10 rounded-lg" aria-busy="true" />}
      {healthChecked && (
        <p role="status" className="mx-3 mt-2 rounded-lg border border-[#e7e2da] bg-white px-3 py-2 text-[11px] text-[#4a443c]">
          {engineOnline ? (
            <>
              engine online
              {health?.scans_enabled ? " · scans enabled" : " · scans disabled (set NISAR_ENABLE_SCANS=1)"}
              {health?.earthdata_credentials ? ` · Earthdata ${health.earthdata_credentials}` : ""}
              {health?.cache_write ? ` · cache ${health.cache_write.status}` : ""}
            </>
          ) : (
            <>
              engine offline at <span className="mono">{engineUrl}</span> — cached results still open;
              scans and the Data tab need the engine.
            </>
          )}
        </p>
      )}

      {isNarrow && dataOpen ? dataPanelEl : (<>
      {panel === "explore" && (
        <AreasPanel
          featured={featured}
          cachedRows={cachedRows}
          cachedTotal={cachedTotal}
          cacheError={cacheError}
          cacheConfigured={cacheConfigured}
          selectedTile={selectedTile}
          onSelectTile={(t, lon, lat, zoom) => {
            setSelectedTile(t);
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
              selectPoint(lat, lon, { zoom: zoom ?? 11.5, panel: "pin" });
            }
          }}
          onOpenResult={openCachedResult}
          onScan={(t, lon, lat) => {
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
              selectPoint(lat, lon, { zoom: 11.5, panel: "pin" });
            }
          }}
          onSelectPoint={(lat, lon, zoom) => selectPoint(lat, lon, { zoom, panel: "pin" })}
        />
      )}
      {panel === "pin" && (
        <ScanPanel
          tile={tile}
          tileError={tileError}
          tileLoading={tileLoading}
          pin={pin}
          cachedForTile={cachedForTile}
          health={health}
          engineOnline={engineOnline}
          implementedCount={implementedCount}
          totalCount={totalCount}
          runState={runState}
          runError={runError}
          busyRunId={busyRunId}
          onScan={() => pin && startScan(pin[1], pin[0])}
          area={{
            box: areaPlan.box ?? customBox, rangeKm: rangeInput, plan: areaPlan, queue,
            onScan: startAreaScan,
            onStop: () => { stopRef.current = true; },
            onOpen: openCachedResult,
            layers: areaLayers,
          }}
          onOpenResult={(id) => (scanRunId && id === scanRunId ? openRunResult(id) : openCachedResult(id))}
          onOpenDataTab={openData}
        />
      )}
      {panel === "results" && (() => {
        const overlayErrorEntries = Object.entries(overlayErrors);
        if (resultsRunId && results) {
          return (
            <>
              {overlayErrorEntries.length > 0 && (
                <p role="status" className="mx-3 mt-2 rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[11px] text-[#7a6438]">
                  {overlayErrorEntries.map(([k, v]) => (
                    <span key={k} className="block">{v}</span>
                  ))}
                </p>
              )}
              <FindingsPanel
                results={results.results}
                title={`Scan ${results.id}`}
                sourceBadge="live run"
                scanTimeIso={null}
                tile={results.tile ?? tile?.id ?? null}
                bundleId={results.bundle_id ?? null}
                runId={results.id}
                loadLayer={layerSource}
                cacheReport={results.cache ?? null}
                selectedPipeline={selectedPipeline}
                onSelectPipeline={setSelectedPipeline}
                activeOverlays={overlays}
                onToggleOverlay={toggleOverlay}
                onOverlayOpacity={setOverlayOpacity}
                onSelectDetection={(d) => {
                  setSelectedDetection(d);
                  setFlyTarget({ center: [(d.bbox[1] + d.bbox[3]) / 2, (d.bbox[0] + d.bbox[2]) / 2], zoom: 12.5, key: Date.now() });
                }}
                selectedDetectionId={selectedDetection?.id ?? null}
                linkFullReport={`/runs/${results.id}`}
              />
            </>
          );
        }
        if (cachedResults) {
          const primaryRows = cachedResults.rows;
          const resultsList = primaryRows.map((r) => r.result);
          return (
            <>
              {overlayErrorEntries.length > 0 && (
                <p role="status" className="mx-3 mt-2 rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[11px] text-[#7a6438]">
                  {overlayErrorEntries.map(([k, v]) => (
                    <span key={k} className="block">{v}</span>
                  ))}
                </p>
              )}
              <FindingsPanel
                results={resultsList}
                title={`Cached verdict · tile ${primaryRows[0]?.tile ?? "?"}`}
                sourceBadge={`cached · ${timeAgo(primaryRows[0]?.computed_at)}`}
                scanTimeIso={primaryRows[0]?.computed_at ?? null}
                tile={primaryRows[0]?.tile ?? null}
                bundleId={cachedResults.bundleId}
                runId={primaryRows[0]?.run_id ?? null}
                loadLayer={layerSource}
                selectedPipeline={selectedPipeline}
                onSelectPipeline={setSelectedPipeline}
                activeOverlays={overlays}
                onToggleOverlay={toggleOverlay}
                onOverlayOpacity={setOverlayOpacity}
                onSelectDetection={(d) => {
                  setSelectedDetection(d);
                  setFlyTarget({ center: [(d.bbox[1] + d.bbox[3]) / 2, (d.bbox[0] + d.bbox[2]) / 2], zoom: 12.5, key: Date.now() });
                }}
                selectedDetectionId={selectedDetection?.id ?? null}
                linkFullReport={`/verdicts/${encodeURIComponent(cachedResults.bundleId)}`}
              />
            </>
          );
        }
        return (
          <div className="p-3 text-xs text-[#8a837b]">
            nothing open yet — scan a tile or open a cached result from Explore.
          </div>
        );
      })()}
      </>)}
    </>
  );

  return (
    <div
      className={`globe-root fixed inset-0 bg-[#0b0d12]${activeOverlayLegend ? " legend-open" : ""}${dataOpen && !isNarrow && !immersive ? " details-open" : ""}`}
      style={{ ["--dock-h" as string]: `${dockH}px` }}
    >
      <GlobeMap
        flyTarget={flyTarget}
        startAt={startAt}
        fitFootprintKey={fitFootprintKey}
        pin={pin}
        tilePolygon={shownPolygon}
        enginePolygon={customBox && !areaPlan.tiles ? (tile?.polygon_lonlat ?? null) : null}
        engineTiles={customBox ? (areaPlan.tiles?.map((t) => t.polygon_lonlat) ?? null) : null}
        pins={pins}
        selectedTile={selectedTile}
        overlays={overlaySpecs}
        pairFootprint={pairFootprint}
        detectionOutline={selectedDetection?.bbox ? bboxRing(selectedDetection.bbox) : null}
        hotspots={hotspots}
        focusSpotId={focusSpot}
        fitBounds={fitBox}
        bottomInset={isNarrow ? dockH + Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.2) : dockH + 18}
        flat={flat}
        terrain3d={terrain3d}
        terrainExaggeration={terrainEx}
        buildings3d={buildings3d}
        viewCmd={viewCmd}
        reducedMotion={reducedMotion}
        idleSpin={!pin}
        onMapClick={onMapClick}
        onPinSelect={(t) => {
          const hit = pins.find((p) => p.tile === t);
          setSelectedTile(t);
          if (hit) selectPoint(hit.lat, hit.lon, { zoom: 11.5, panel: "pin" });
        }}
        onMove={(_lat, _lon, z) => {
          zoomRef.current = z;
          pushUrl({ z });
        }}
        onWebglUnavailable={setWebglMsg}
      />

      {/* a thin line along the top while anything is loading: a scan, the tile lookup, the radar-pass search, a saved verdict */}
      {(!!scanStatus || tileLoading || areaPlan.loading || granules.loading || (!!tileId && cacheConfigured && cachedForTile === null && !openResults)) && (
        <div className="gb-line" aria-hidden data-testid="busy-line"><span /></div>
      )}

      {webglMsg && (
        <div className="pointer-events-auto absolute left-1/2 top-1/2 z-30 w-[min(90vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[#e7e2da] bg-[#faf9f6] p-4 text-sm">
          <p className="font-semibold text-[#1c1a17]">The globe cannot start</p>
          <p className="mt-1 text-xs text-[#4a443c]">{webglMsg}</p>
          <p className="mt-1 text-xs text-[#8a837b]">
            the panel still works: search, lists, scan status, findings and the Data tab are usable
            without the map (the Data tab shows the timeline without the footprint inset).
          </p>
        </div>
      )}

      {/* left column: nav + search pill + the panel (Explore / Pin / Results); Data is its own panel on the right; on a phone everything is the bottom sheet (Data = a tab there) */}
      <div
        className={`pointer-events-none absolute left-3 top-3 z-30 flex flex-col gap-2 transition-[transform,opacity] duration-[380ms] ease-[cubic-bezier(0.32,0.72,0,1)]${isNarrow ? "" : " w-[300px]"}${immersive ? " -translate-x-[110%] opacity-0" : ""}`}
        style={isNarrow ? undefined : { bottom: 12 }}
        inert={immersive}
      >
        <div className="pointer-events-auto w-fit rounded-xl border border-[#262c36] bg-[#0e1116]/95 px-3 py-2 backdrop-blur">
          <AppNav active="map" dark />
        </div>
        <SearchBar
          range={rangeInput}
          onRange={setRangeInput}
          rangeBad={rangeBad}
          rangeNote={rangeBad
            ? "Range must be 1–200 km, with the box inside ±84° latitude."
            : customBox
              ? (areaPlan.tiles
                ? (areaPlan.fitKm
                  ? `Shrunk to fit: the ${rangeInput} km box you entered touches more engine tiles than one area scan allows, so it's been shrunk to ${areaPlan.fitKm} × ${areaPlan.fitKm} km — ${areaPlan.tiles.length} engine tile${areaPlan.tiles.length === 1 ? "" : "s"} (dashed green). A scan runs them one after another. The Data tab, Background and SAR pictures still show the pin's own tile.`
                  : `Scan scope: the ${rangeInput} × ${rangeInput} km box touches ${areaPlan.tiles.length} engine tile${areaPlan.tiles.length === 1 ? "" : "s"} (dashed green). A scan runs them one after another. The Data tab, Background and SAR pictures still show the pin's own tile.`)
                : areaPlan.error ?? "Finding the tiles this box covers…")
              : null}
          lat={latInput}
          lon={lonInput}
          onLat={(v) => {
            setLatInput(v);
            const parsed = Number(v);
            if (Number.isFinite(parsed) && lonInput && Number.isFinite(Number(lonInput))) {
              const pv = parseQuiet(`${v}, ${lonInput}`);
              if (pv) {
                setPin([pv.lat, pv.lon]);
                setFlyTarget({ center: [pv.lon, pv.lat], zoom: Math.max(zoomRef.current ?? 0, 10.5), key: Date.now() });
              }
            }
          }}
          onLon={(v) => {
            setLonInput(v);
            const parsed = Number(v);
            if (Number.isFinite(parsed) && latInput && Number.isFinite(Number(latInput))) {
              const pv = parseQuiet(`${latInput}, ${v}`);
              if (pv) {
                setPin([pv.lat, pv.lon]);
                setFlyTarget({ center: [pv.lon, pv.lat], zoom: Math.max(zoomRef.current ?? 0, 10.5), key: Date.now() });
              }
            }
          }}
          onSubmit={(lat, lon) => selectPoint(lat, lon, { zoom: 11.5, panel: "pin" })}
          onLocate={(lat, lon) => selectPoint(lat, lon, { zoom: 4.2 })}
          flat={flat}
          onToggleFlat={() => {
            setFlat((f) => {
              try {
                window.localStorage.setItem("globe-flat", f ? "0" : "1");
              } catch { /* private mode */ }
              return !f;
            });
          }}
          terrain3d={terrain3d}
          onToggleTerrain={() => {
            setTerrain3d((v) => {
              try { window.localStorage.setItem("globe-3d", v ? "0" : "1"); } catch { /* private mode */ }
              return !v;
            });
          }}
          terrainExaggeration={terrainEx}
          buildings3d={buildings3d}
          onToggleBuildings={() => {
            setBuildings3d((v) => {
              try { window.localStorage.setItem("globe-3d-bld", v ? "0" : "1"); } catch { /* private mode */ }
              return !v;
            });
          }}
          onView={(c) => setViewCmd({ key: Date.now(), ...c })}
          onTerrainExaggeration={(v) => {
            setTerrainEx(v);
            try { window.localStorage.setItem("globe-3d-ex", String(v)); } catch { /* private mode */ }
          }}
          reducedMotion={reducedMotion}
        />
        {!engineOnline && healthChecked && (
          <p role="status" className="pointer-events-auto w-full rounded-xl border border-[#b08d57]/40 bg-[#f7f2e7]/95 px-3 py-2 text-[11px] text-[#7a6438] backdrop-blur">
            engine offline at <span className="mono">{engineUrl}</span> — Scan is disabled; cached
            results still open from Explore.
          </p>
        )}
        {!isNarrow && scanStatus && (
          <div className="pointer-events-auto">
            <ScanStatusStrip s={scanStatus} tone="light" onStop={queue?.some((t) => t.status === "waiting") ? stopAreaScan : undefined} />
          </div>
        )}
        {!isNarrow && (
          <aside
            className="pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#e7e2da] bg-[#faf9f6]/97 backdrop-blur"
            aria-label="globe panel"
          >
            <div className="flex-1 overflow-y-auto">{panelContent}</div>
          </aside>
        )}
      </div>

      {/* legend (top-right, left of the zoom controls: the left side is the panel, the bottom is the timeline dock) */}
      <div ref={legendRef} className="pointer-events-none absolute right-16 top-3 z-30 hidden md:block">
        <Legend layer={activeOverlayLegend?.layer ?? null} opacity={activeOverlayLegend?.opacity ?? 0.8} />
        <div className="pointer-events-none absolute bottom-2 right-2 z-10"><MapKey /></div>
      </div>

      {/* attribution/scale bottom-right is part of maplibre; nothing else needed */}

      {/* the verdict dock: the verdict, big, with the acquisition timeline under it; "See why" plays the differences.
          On a phone it sits just above the sheet's peek. */}
      <div
        className={`pointer-events-none absolute z-30 flex justify-center ${isNarrow ? "inset-x-0 px-3" : ""}`}
        style={isNarrow
          ? { bottom: "calc(20vh + 12px)" }
          : { bottom: 12, left: immersive ? 12 : 324, right: immersive ? 12 : (dataOpen ? 324 : 12), transition: "left 380ms cubic-bezier(0.32,0.72,0,1), right 380ms cubic-bezier(0.32,0.72,0,1)" }}
      >
        <div className="w-full max-w-[920px]">
          <VerdictDock
            pinned={!!pin}
            verdict={verdict}
            verdictLoading={!!tileId && cacheConfigured && cachedForTile === null && !openResults}
            scan={scanOffer}
            granules={granules}
            picks={picks}
            verdictUse={dockVerdictUse}
            tileBbox={tile?.bbox_lonlat ?? null}
            reducedMotion={reducedMotion}
            narrow={isNarrow}
            onOverlay={setSarSpec}
            showLayer={showLayerOnly}
            loadLayer={layerSource}
            clearLayers={clearTourLayers}
            onHotspots={setHotspots}
            onFocusSpot={setFocusSpot}
            onFit={(bbox) => setFitBox({ key: Date.now(), bbox })}
            onLoadFull={(o) => { if (verdict?.bundleId) openCachedResult(verdict.bundleId, o); }}
            engineOnline={engineOnline}
            onOpenEvidence={() => { setPanel("results"); pushUrl({ panel: "results" }); }}
            onModeChange={setDockMode}
            onHeight={setDockH}
          />
        </div>
      </div>

      {isNarrow ? (
        !immersive && <BottomSheet ariaLabel="globe panel">{panelContent}</BottomSheet>
      ) : !immersive && (
        <>
          {/* the Data panel: details of the pinned tile (search box, run arrays, one acquisition's SAR picture), on the RIGHT.
              The verdict dock carries the timeline; this panel is one click away and no longer opens by itself. */}
          {dataOpen ? (
            <aside
              aria-label="Data panel"
              style={{ top: Math.max(148, legendBottom + 8), bottom: 12 }}
              className="pointer-events-auto absolute right-3 z-30 flex w-[300px] flex-col overflow-hidden rounded-2xl border border-[#e7e2da] bg-[#faf9f6]/97 backdrop-blur"
            >
              <div className="flex items-center justify-between border-b border-[#f0ece4] px-3 py-2">
                <h2 className="text-xs font-semibold text-[#1c1a17]">Details <span className="font-normal text-[#8a837b]">for the pinned tile</span></h2>
                <button
                  type="button"
                  onClick={closeData}
                  className="rounded px-2 py-1 text-[11px] text-[#4a443c] hover:bg-[#f0ece4]"
                  aria-label="Close details"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto pb-6">{dataPanelEl}</div>
            </aside>
          ) : (
            <button
              type="button"
              onClick={openData}
              style={{ top: Math.max(148, legendBottom + 8) }}
              className="pointer-events-auto absolute right-3 z-30 rounded-full border border-[#e7e2da] bg-[#faf9f6]/97 px-3.5 py-1.5 text-xs font-medium text-[#1c1a17] backdrop-blur hover:bg-[#f0ece4]"
              aria-label="Open details"
            >
              Details
            </button>
          )}
        </>
      )}
    </div>
  );
}

function bboxRing(bbox: [number, number, number, number]): [number, number][] {
  const [w, s, e, n] = bbox;
  return [
    [w, s], [e, s], [e, n], [w, n], [w, s],
  ];
}

function parseQuiet(text: string): { lat: number; lon: number } | null {
  const out = parseCoordinates(text);
  return out.ok ? out.value : null;
}

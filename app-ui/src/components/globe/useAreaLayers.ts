"use client";

/** useAreaLayers: draw one result layer from EVERY finished tile of an area scan at once.
 *
 *  Why it exists: the map's overlay machinery is bound to a single open result (one run or one cached bundle = one
 *  10 km tile). An area scan produces one result per tile, so before this the map could only ever show the tile you
 *  had opened. Here each finished tile's layer is fetched from its own run or bundle, coloured by the same
 *  colorize() as everywhere else (the engine's own vmin / vmax / colormap / bounds), and handed to the map as one
 *  overlay per tile. Nothing is computed or estimated in the UI. A tile that has no such layer, or whose layer
 *  cannot be displayed, is counted and reported, never silently skipped.
 *
 *  Which tiles: every tile of the scan box that has a result. That is the tiles finished by the scan that is running
 *  AND the tiles scanned earlier (the newest cached result of each), so the whole area shows up at once instead of one
 *  tile at a time as a long scan crawls along; a tile's new result replaces its earlier one the moment it is done. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cache, cacheConfigured } from "@/lib/cache";
import { colorize, decodeLayer, validateLayerPayload } from "@/lib/raster";
import type { LayerPayload, PipelineResult, TileInfo } from "@/lib/types";
import type { OverlaySpec } from "./GlobeMap";
import type { AreaTile } from "./ScanPanel";

export interface AreaLayerChoice { pipeline: string; layer: string }

export interface AreaLayers {
  /** raster layers the first finished tile offers (every tile of one scan runs the same pipelines) */
  choices: AreaLayerChoice[];
  selected: AreaLayerChoice | null;
  select: (c: AreaLayerChoice | null) => void;
  /** one overlay per tile that has the layer */
  specs: OverlaySpec[];
  /** tiles that have a result to draw (this scan's finished tiles plus earlier cached ones) */
  sourceCount: number;
  /** done = tiles tried (drawn or not); pending = finished tiles still being fetched; total = the whole scan's tile count */
  progress: { done: number; drawn: number; unavailable: number; pending: number; total: number } | null;
  /** the first drawn tile's payload: what the colour legend shows */
  legend: LayerPayload | null;
  opacity: number;
  setOpacity: (v: number) => void;
  error: string | null;
}

type Loaded = { spec: OverlaySpec; payload: LayerPayload } | null;   // null = this tile has no displayable layer

/** Overlay spec ids MUST start with "overlay:" (GlobeMap only removes and fades sources it can map back to such an id) and
 *  end with the result they draw (`@bundle`), so a re-scanned tile's new picture is a new source that replaces the old one. */
export const areaSpecPrefix = (tileId: string) => `overlay:area:${tileId}:`;

/** one tile result: the same tile with a NEW bundle/run (its scan just finished) is a different result */
const keyOf = (t: AreaTile) => `${t.tile.id}|${t.bundleId ?? ""}|${t.runId ?? ""}`;

async function loadOne(t: AreaTile, c: AreaLayerChoice): Promise<Loaded> {
  const live = !(cacheConfigured && t.bundleId);
  const id = live ? t.runId : t.bundleId;
  if (!id) return null;
  let payload: LayerPayload;
  try {
    payload = live ? (await api.pipelineLayer(id, c.pipeline, c.layer)).layer : await cache.layer(id, c.pipeline, c.layer);
  } catch {
    return null;
  }
  if (validateLayerPayload(payload).length || !payload.bounds_lonlat) return null;
  const decoded = decodeLayer(payload);
  if (!decoded.ok) return null;
  const canvas = document.createElement("canvas");
  colorize(payload, decoded.data, canvas);
  return {
    payload,
    spec: { id: `${areaSpecPrefix(t.tile.id)}${c.pipeline}:${c.layer}@${(t.bundleId ?? t.runId ?? "").replace(/[^A-Za-z0-9_-]/g, "_")}`, dataUrl: canvas.toDataURL(), bounds: payload.bounds_lonlat, opacity: 0.8 },
  };
}

/** raster layer names of a list of pipeline results (the engine sends layers as { name, kind } objects) */
function rasterChoices(results: PipelineResult[]): AreaLayerChoice[] {
  const out: AreaLayerChoice[] = [];
  for (const r of results) {
    for (const l of (r.layers ?? []) as unknown as { name?: string; kind?: string }[]) {
      if (l && l.kind === "raster" && typeof l.name === "string" && !out.some((o) => o.pipeline === r.pipeline && o.layer === l.name)) {
        out.push({ pipeline: r.pipeline, layer: l.name });
      }
    }
  }
  return out;
}

const POOL = 3;       // layers fetched at once: enough to be quick, few enough not to flood the engine or the cache

export function useAreaLayers(queue: AreaTile[] | null, plan: TileInfo[] | null = null): AreaLayers {
  // earlier scans of the area: the newest cached bundle of each tile of the box
  const planIds = useMemo(() => (queue ?? plan?.map((t) => ({ tile: t })) ?? []).map((t) => t.tile.id), [queue, plan]);
  const planKey = planIds.join(",");
  const [earlier, setEarlier] = useState<Map<string, string>>(new Map());
  const [earlierError, setEarlierError] = useState<string | null>(null);
  useEffect(() => {
    if (!cacheConfigured || planIds.length === 0) { setEarlier(new Map()); setEarlierError(null); return; }
    let alive = true;
    cache.forTiles(planIds)
      .then((rows) => {
        if (!alive) return;
        const m = new Map<string, string>();
        for (const r of rows) if (!m.has(r.tile)) m.set(r.tile, r.bundle_id);      // rows come newest first
        setEarlier(m); setEarlierError(null);
      })
      .catch((e) => { if (alive) setEarlierError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [planKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ok = useMemo(() => {
    const base: AreaTile[] = queue ?? plan?.map((t) => ({ tile: t, status: "waiting" as const })) ?? [];
    const out: AreaTile[] = [];
    for (const t of base) {
      if (t.status === "ok" && (t.bundleId || t.runId)) { out.push(t); continue; }       // finished by this scan
      const b = earlier.get(t.tile.id);                                                  // else its earlier result, if any
      if (b) out.push({ ...t, status: "ok", bundleId: b, runId: undefined });
    }
    return out;
  }, [queue, plan, earlier]);
  const okKey = ok.map(keyOf).join(",");
  const total = queue?.length ?? plan?.length ?? 0;

  const [choices, setChoices] = useState<AreaLayerChoice[]>([]);
  const [selected, setSelected] = useState<AreaLayerChoice | null>(null);
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(new Map());
  const [opacity, setOpacity] = useState(0.8);
  const [layerError, setError] = useState<string | null>(null);
  const error = layerError ?? earlierError;
  const memo = useRef<{ sel: string; done: Map<string, Loaded> }>({ sel: "", done: new Map() });
  const choicesFrom = useRef<string>("");
  /** what the person last asked for: undefined = never chose (a layer is picked for them), null = pressed Hide, else a layer.
   *  Kept across scans, so a new scan draws the same layer again and a Hide stays hidden. */
  const userChoice = useRef<AreaLayerChoice | null | undefined>(undefined);
  const select = useCallback((c: AreaLayerChoice | null) => { userChoice.current = c; setSelected(c); }, []);

  // a new scan (or none): forget the old one
  useEffect(() => {
    if (ok.length === 0) {
      choicesFrom.current = "";
      memo.current = { sel: "", done: new Map() };
      setChoices([]);
      setSelected(null);
      setLoaded(new Map());
      setError(null);
    }
  }, [ok.length]);

  // which layers exist: read once from the first finished tile
  useEffect(() => {
    const t = ok[0];
    if (!t) return;
    const from = keyOf(t);
    if (choicesFrom.current === from) return;
    choicesFrom.current = from;
    let alive = true;
    void (async () => {
      try {
        const results: PipelineResult[] = cacheConfigured && t.bundleId
          ? (await cache.forBundle(t.bundleId)).map((r) => r.result)
          : t.runId ? (await api.run(t.runId)).results : [];
        if (alive) { setChoices(rasterChoices(results)); setError(null); }
      } catch (e) {
        if (alive) { choicesFrom.current = ""; setError(e instanceof Error ? e.message : String(e)); }
      }
    })();
    return () => { alive = false; };
  }, [okKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // load the chosen layer for every finished tile that has not been tried yet (tiles finishing later are added as they finish)
  useEffect(() => {
    if (!selected) { memo.current = { sel: "", done: new Map() }; setLoaded(new Map()); return; }
    const selKey = `${selected.pipeline}:${selected.layer}`;
    if (memo.current.sel !== selKey) memo.current = { sel: selKey, done: new Map() };
    const done = memo.current.done;
    const todo = ok.filter((t) => !done.has(keyOf(t)));
    if (todo.length === 0) { setLoaded(new Map(done)); return; }
    let cancelled = false;
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < todo.length) {
        const t = todo[next++];
        const r = await loadOne(t, selected);
        if (cancelled) return;
        done.set(keyOf(t), r);
        setLoaded(new Map(done));
      }
    };
    void Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
    return () => { cancelled = true; };
  }, [selected, okKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // draw by default: as soon as the scan says which layers exist, every finished tile gets one (no hidden dropdown to find first).
  // Presentation only: the first layer the engine lists is the default, the picker still switches or hides it.
  useEffect(() => {
    if (selected || choices.length === 0 || userChoice.current === null) return;
    const want = userChoice.current;
    const same = want ? choices.find((c) => c.pipeline === want.pipeline && c.layer === want.layer) : undefined;
    setSelected(same ?? choices[0]);
  }, [choices, selected]);

  const entries = useMemo(() => ok.map((t) => loaded.get(keyOf(t))).filter((x): x is NonNullable<Loaded> => !!x), [ok, loaded]);
  const specs = useMemo(() => entries.map((e) => ({ ...e.spec, opacity })), [entries, opacity]);
  const tried = ok.filter((t) => loaded.has(keyOf(t))).length;
  return {
    choices, selected, select, specs, sourceCount: ok.length,
    progress: selected ? { done: tried, drawn: entries.length, unavailable: tried - entries.length, pending: ok.length - tried, total } : null,
    legend: entries[0]?.payload ?? null,
    opacity, setOpacity, error,
  };
}

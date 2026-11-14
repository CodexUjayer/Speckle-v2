"use client";

/** Typed client for the GATED /api/background/* routes (UI-build-2 §4.5/§5/§6). Transport only.
 *  The bearer token rides the Authorization header (never a URL); preview PNGs are fetched as
 *  blobs for the same reason. Types mirror the engine shapes in lib/types.ts. */
import { bgGet } from "./bgApi";
import { EngineError } from "./engineFetch";
import type {
  BackgroundGroup,
  ExplainPayload,
  ExplorerGranule,
  HealthPayload,
  NetworkCheckPayload,
  OverviewPayload,
  GranuleDetailResponse,
  PipelineDetailResponse,
  PreprocessingResponse,
  PreviewMeta,
  RunSummary,
  StackPairResponse,
  InspectResponse,
  LabRunsResponse,
  PairNetworkResponse,
  RoiResponse,
  TimeseriesResponse,
} from "./types";


/** a non-2xx preview answer: keeps the HTTP status (429 = rate limited) so callers can back off */
export class PreviewHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS: number | null = null) {
    super(message);
    this.name = "PreviewHttpError";
  }
}

/** Why a failed preview attempt is worth retrying (a plain-language reason), or null when retrying cannot help. */
export function transientReason(err: unknown): string | null {
  if (err instanceof PreviewHttpError) {
    if (err.status === 409) return "the engine is busy with another read";
    if (err.status === 429) return "the engine asked for a short pause";
    if (err.status === 502 || err.status === 504 || (err.status >= 520 && err.status <= 530))
      return "the connection dropped while the engine kept working";
    return null;                                    // 400/404/422/500: the request itself is the problem
  }
  if (err instanceof EngineError) {
    if (err.kind === "timeout") return "the engine is still reading from NASA";
    if (err.kind === "unreachable") return "the engine cannot be reached right now";
  }
  return null;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `attempt` until it succeeds. Only transient failures are retried (backoff 1.5 s -> 5 s, or the engine's own
 *  Retry-After); anything else, and an abort, is thrown straight away. No attempt limit and no total time limit. */
export async function patiently<T>(attempt: () => Promise<T>, signal?: AbortSignal,
                                   onWait?: (why: string) => void): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (signal?.aborted) throw err;
      const why = transientReason(err);
      if (why === null) throw err;
      onWait?.(why);
      const hinted = err instanceof PreviewHttpError && err.retryAfterS ? err.retryAfterS * 1000 : 0;
      await sleepAbortable(Math.max(hinted, Math.min(1500 * (n + 1), 5000)), signal);
    }
  }
}

export const bg = {
  granule: (id: string, signal?: AbortSignal) =>
    bgGet<GranuleDetailResponse>(
      `/api/background/granule?id=${encodeURIComponent(id)}`, signal),

  /** The PNG itself: fetched as a blob (Authorization header, never a URL token). */
  previewBlob: async (
    p: { id: string; layer: string; west: number; south: number; east: number; north: number;
         maxPx?: number; cmap?: string; scale?: string; format?: "json";
         /** explicit colour range (engine units of meta.scale): both or neither */
         lo?: number; hi?: number;
         /** "coherence": fade pixels by interferometric coherence (the engine decides how; GUNW layers only) */
         quality?: "coherence";
         /** Phase 3: render a correction diagnostic instead of the layer itself (iono | tropo_hydrostatic |
          *  tropo_wet | solid_earth_tide) — the SAME phase→LOS conversion applied to the product's own
          *  correction screen; a diagnostic, never removed from los_m. GUNW layers only. */
         corr?: "iono" | "tropo_hydrostatic" | "tropo_wet" | "solid_earth_tide";
         /** keep trying - no time limit - while the engine is busy, the connection drops or a read is slow;
          *  stops only on success, a real error (bad request, no token) or the AbortSignal */
         patient?: boolean;
         /** patient mode: why it is still waiting (shown to the person), called before every wait */
         onWait?: (why: string) => void },
    signal?: AbortSignal,
    longWait = false,
  ): Promise<{ blob: Blob | null; meta: PreviewMeta }> => {
    if (p.patient) return patiently(() => bg.previewBlob({ ...p, patient: false }, signal, true), signal, p.onWait);
    const q = new URLSearchParams({
      id: p.id, layer: p.layer,
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
      max_px: String(p.maxPx ?? 256), cmap: p.cmap ?? "auto", scale: p.scale ?? "auto",
    });
    if (p.format) q.set("format", p.format);
    if (p.lo != null && p.hi != null) { q.set("lo", String(p.lo)); q.set("hi", String(p.hi)); }
    if (p.quality) q.set("quality", p.quality);
    if (p.corr) q.set("corr", p.corr);
    const { bgFetch } = await import("./bgApi");
    const res = await bgFetch(`/api/background/preview?${q.toString()}`, { signal },
                              longWait ? { timeoutMs: 10 * 60_000 } : undefined);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new PreviewHttpError(
        res.status,
        (body as { detail?: { error?: string }; error?: string })?.detail?.error
        ?? (body as { error?: string })?.error
        ?? `${res.status} ${res.statusText}`,
        Number(res.headers.get("Retry-After")) || null);
    }
    if (p.format === "json") {
      const body = (await res.json()) as { meta: PreviewMeta };
      return { blob: null, meta: body.meta };
    }
    const meta = JSON.parse(res.headers.get("X-Img-Meta") ?? "{}") as PreviewMeta;
    return { blob: await res.blob(), meta };
  },

  probe: (p: { id: string; layer: string; lon: number; lat: number }, signal?: AbortSignal) =>
    bgGet<{ ok: true; value: number | null; finite: boolean; row: number; col: number;
            epsg: number; x: number; y: number; lon: number; lat: number; dtype: string }>(
      `/api/background/probe?id=${encodeURIComponent(p.id)}&layer=${encodeURIComponent(p.layer)}`
      + `&lon=${p.lon}&lat=${p.lat}`, signal),

  /** The pair difference PNG: same transport rules as previewBlob (blob fetch, meta on
   *  X-Img-Meta, patient retry while the engine works). The DIFFERENCE ITSELF is engine-side —
   *  this only moves the picture the engine already computed. */
  diffBlob: async (
    p: { idA: string; idB: string; layer: string; west: number; south: number; east: number; north: number;
         maxPx?: number; mode?: string; cmap?: string; format?: "json";
         /** fixed colour range so two diffs stay comparable (both or neither) */
         lo?: number; hi?: number;
         patient?: boolean;
         onWait?: (why: string) => void },
    signal?: AbortSignal,
    longWait = false,
  ): Promise<{ blob: Blob | null; meta: PreviewMeta }> => {
    if (p.patient) return patiently(() => bg.diffBlob({ ...p, patient: false }, signal, true), signal, p.onWait);
    const q = new URLSearchParams({
      id_a: p.idA, id_b: p.idB, layer: p.layer,
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
      max_px: String(p.maxPx ?? 256), mode: p.mode ?? "auto", cmap: p.cmap ?? "auto",
    });
    if (p.format) q.set("format", p.format);
    if (p.lo != null && p.hi != null) { q.set("lo", String(p.lo)); q.set("hi", String(p.hi)); }
    const { bgFetch } = await import("./bgApi");
    const res = await bgFetch(`/api/background/diff?${q.toString()}`, { signal },
                              longWait ? { timeoutMs: 10 * 60_000 } : undefined);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new PreviewHttpError(
        res.status,
        (body as { detail?: { error?: string }; error?: string })?.detail?.error
        ?? (body as { error?: string })?.error
        ?? `${res.status} ${res.statusText}`,
        Number(res.headers.get("Retry-After")) || null);
    }
    if (p.format === "json") {
      const body = (await res.json()) as { meta: PreviewMeta };
      return { blob: null, meta: body.meta };
    }
    const meta = JSON.parse(res.headers.get("X-Img-Meta") ?? "{}") as PreviewMeta;
    return { blob: await res.blob(), meta };
  },

  stackPair: (id: string, signal?: AbortSignal) =>
    bgGet<StackPairResponse>(`/api/background/stack-pair?id=${encodeURIComponent(id)}`, signal),

  /** The Lab's numeric panels over ONE granule/layer/box: stats (+ histogram, + optional A->B
   *  profile). Every number is engine-computed on the values the legend describes. */
  /** Phase 4 — drawn-ROI statistics: the person draws a box/polygon on the map; the ENGINE
   *  masks the layer's pixel centres and computes stats + histogram on the legend's values.
   *  The UI carries no polygon math. ring = [[lon, lat], ...] (box: 2 corners, polygon: >= 3). */
  roi: (p: { id: string; layer: string; kind: "box" | "polygon"; ring: [number, number][];
             scale?: string; corr?: string; bins?: number },
        signal?: AbortSignal) => {
    const q = new URLSearchParams({
      id: p.id, layer: p.layer, kind: p.kind,
      ring: p.ring.map(([lon, lat]) => `${lon},${lat}`).join(";"),
      scale: p.scale ?? "auto",
    });
    if (p.corr) q.set("corr", p.corr);
    if (p.bins) q.set("bins", String(p.bins));
    return bgGet<RoiResponse>(`/api/background/roi?${q.toString()}`, signal);
  },

  /** Phase 5 — the interferometric pair network over the box (nodes = stack epochs,
   *  edges = pair products; engine-derived from the Explorer's own clustering). */
  pairNetwork: (p: { west: number; south: number; east: number; north: number; level: string },
                signal?: AbortSignal) => {
    const q = new URLSearchParams({
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
      level: p.level,
    });
    return bgGet<PairNetworkResponse>(`/api/background/pair-network?${q.toString()}`, signal);
  },

  /** Phase 5 — the pipeline bridge: runs overlapping the box + placeable trace arrays. */
  labRuns: (p: { west: number; south: number; east: number; north: number },
            signal?: AbortSignal) => {
    const q = new URLSearchParams({
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
    });
    return bgGet<LabRunsResponse>(`/api/background/lab-runs?${q.toString()}`, signal);
  },

  inspect: (p: { id: string; layer: string; west: number; south: number; east: number; north: number;
                  scale?: string; bins?: number; corr?: string;
                  profile?: { aLon: number; aLat: number; bLon: number; bLat: number } },
            signal?: AbortSignal) => {
    const q = new URLSearchParams({
      id: p.id, layer: p.layer,
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
      scale: p.scale ?? "auto",
    });
    if (p.corr) q.set("corr", p.corr);
    if (p.bins != null) q.set("bins", String(p.bins));
    if (p.profile) {
      q.set("a_lon", String(p.profile.aLon));
      q.set("a_lat", String(p.profile.aLat));
      q.set("b_lon", String(p.profile.bLon));
      q.set("b_lat", String(p.profile.bLat));
    }
    return bgGet<InspectResponse>(`/api/background/inspect?${q.toString()}`, signal);
  },

  /** One engine-computed value per date over the box (same-stack granules only, engine-validated). */
  timeseries: (p: { ids: string[]; layer: string; west: number; south: number; east: number; north: number;
                    scale?: string; stat?: string }, signal?: AbortSignal) => {
    const q = new URLSearchParams({
      ids: p.ids.join(","), layer: p.layer,
      west: String(p.west), south: String(p.south), east: String(p.east), north: String(p.north),
      scale: p.scale ?? "auto", stat: p.stat ?? "mean",
    });
    return bgGet<TimeseriesResponse>(`/api/background/timeseries?${q.toString()}`, signal);
  },

  runs: () => bgGet<{ ok: true; runs: RunSummary[] }>("/api/runs"),

  explain: (signal?: AbortSignal) => bgGet<ExplainPayload>("/api/background/explain", signal),
  overview: (signal?: AbortSignal) => bgGet<OverviewPayload>("/api/background/overview", signal),
  health: (signal?: AbortSignal) => bgGet<HealthPayload>("/api/background/health", signal),
  /** on demand only (a button): it opens real connections to NASA hosts */
  healthNetwork: (signal?: AbortSignal) => bgGet<NetworkCheckPayload>("/api/background/health/network", signal),

  preprocessing: (runId: string, bundleId?: string, signal?: AbortSignal) =>
    bgGet<PreprocessingResponse>(
      `/api/background/runs/${encodeURIComponent(runId)}/preprocessing`
      + (bundleId ? `?bundle_id=${encodeURIComponent(bundleId)}` : ""), signal),

  traceArrayUrl: (runId: string, aid: string, opts?: { cmap?: string; lo?: number; hi?: number; maxPx?: number }) => {
    const q = new URLSearchParams();
    if (opts?.cmap) q.set("cmap", opts.cmap);
    if (opts?.lo != null) q.set("lo", String(opts.lo));
    if (opts?.hi != null) q.set("hi", String(opts.hi));
    if (opts?.maxPx) q.set("max_px", String(opts.maxPx));
    const qs = q.toString();
    return `/api/background/runs/${encodeURIComponent(runId)}/arrays/${encodeURIComponent(aid)}${qs ? `?${qs}` : ""}`;
  },

  traceProbe: (runId: string, aid: string, fx: number, fy: number, signal?: AbortSignal) =>
    bgGet<{ ok: true; row: number; col: number; stride: number; value: number | null;
            finite: boolean; lon?: number; lat?: number; epsg?: number }>(
      `/api/background/runs/${encodeURIComponent(runId)}/arrays/${encodeURIComponent(aid)}`
      + `/probe?fx=${fx}&fy=${fy}`, signal),

  pipelineDetail: (runId: string, name: string, signal?: AbortSignal) =>
    bgGet<PipelineDetailResponse>(
      `/api/background/runs/${encodeURIComponent(runId)}/pipelines/${encodeURIComponent(name)}`,
      signal),
};

/** groups helpers (display-only pure logic lives in lib/groups.ts) */
export function groupTimes(g: BackgroundGroup): { start: number; end: number } | null {
  const a = g.ref_time ?? g.start;
  const b = g.sec_time ?? g.start;
  const t0 = a ? Date.parse(a) : NaN;
  const t1 = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(t0)) return null;
  return { start: Math.min(t0, Number.isFinite(t1) ? t1 : t0), end: Math.max(t0, Number.isFinite(t1) ? t1 : t0) };
}

export function groupOfGranule(groups: BackgroundGroup[] | undefined, id: string): BackgroundGroup | null {
  if (!groups) return null;
  return groups.find((g) => g.granule_ids.includes(id)) ?? null;
}

export type { ExplorerGranule, BackgroundGroup };

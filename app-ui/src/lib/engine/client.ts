/** Typed client for the hazard engine (the repo's own engine/, FastAPI on :8900).
 *
 *  Transport only — zero science. Two deployment modes:
 *
 *  · direct  — NEXT_PUBLIC_ENGINE_API is set (the repo's app-ui convention,
 *    e.g. http://127.0.0.1:8900), or the page itself is served from
 *    localhost (the repo's app-ui default engine URL): every call goes to
 *    that absolute base URL.
 *  · gateway — a hosted preview origin (the sandbox deployment): every
 *    call stays a SAME-ORIGIN relative request carrying the engine port in
 *    the `XTransformPort` query parameter (the gateway forwards it to
 *    localhost:8900), so no absolute URLs and no CORS are involved.
 *
 *  Failures become an EngineError whose message names what failed and what
 *  to do — never a bare "Failed to fetch". HTTP errors keep the engine's
 *  own text verbatim. */

import type {
  BundleListItem,
  EventItem,
  GranuleSearchResponse,
  Health,
  LayerResponse,
  PipelineInfo,
  RunState,
  RunSummary,
  StoredVerdict,
  TileInfo,
} from "./types";

/** The engine port this deployment proxies to (8900 in WIRING.md). */
export const ENGINE_PORT = 8900;

/** Direct engine base URL — same convention as the repo's app-ui
 *  (NEXT_PUBLIC_ENGINE_API, default http://127.0.0.1:8900 there). Resolved
 *  per call: an explicit env URL wins; a page served from localhost goes
 *  direct to the local engine; any other hosted origin uses the gateway
 *  transport (relative requests carrying XTransformPort). */
const ENV_API = (process.env.NEXT_PUBLIC_ENGINE_API || "").replace(/\/+$/, "");

export function engineApi(): string {
  if (ENV_API) return ENV_API;
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") {
      return "http://127.0.0.1:8900"; // the repo app-ui's default engine URL
    }
  }
  return ""; // gateway transport
}

export class EngineError extends Error {
  readonly status?: number;
  readonly detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.detail = detail;
  }
}

/** "unreachable" vs "answered with an error" — for honest UI copy. */
export function isUnreachable(e: unknown): boolean {
  return e instanceof EngineError && e.status === undefined;
}

/** Build an engine request URL for the active transport mode.
 *  Exported for the rare raw fetch that needs the same wiring. */
export function engineUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const base = engineApi();
  const q = new URLSearchParams();
  if (!base) q.set("XTransformPort", String(ENGINE_PORT));
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  const url = base ? `${base}${path}` : path;
  return qs ? `${url}?${qs}` : url;
}

async function engineJson<T>(
  path: string,
  init?: RequestInit,
  opts?: { timeoutMs?: number; params?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const url = engineUrl(path, opts?.params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new EngineError(
        `The engine did not answer within ${Math.round((opts?.timeoutMs ?? 30_000) / 1000)} s — it may be busy or down. Try again shortly.`,
      );
    }
    throw new EngineError(
      "The hazard engine is unreachable — is it running? (uvicorn engine.api.main:app --port 8900)",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `engine answered ${res.status} ${res.statusText}`;
    let detail: unknown;
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown } | null;
      const d = (body as { detail?: { error?: string } | string } | null)?.detail;
      message = (body?.error) || (typeof d === "string" ? d : d?.error) || message;
      detail = body ?? d;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new EngineError(message, res.status, detail);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new EngineError("The engine answered, but not with JSON — is that the engine URL?");
  }
}

async function get<T>(
  path: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; params?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  return engineJson<T>(path, { signal: opts?.signal }, { timeoutMs: opts?.timeoutMs, params: opts?.params });
}

async function post<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  return engineJson<T>(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { timeoutMs },
  );
}

/* ------------------------------------------------------------------ */
/* the engine API surface (engine/api/main.py docstring)                */
/* ------------------------------------------------------------------ */

export const api = {
  health: (signal?: AbortSignal) => get<Health>("/api/health", { signal, timeoutMs: 10_000 }),

  pipelines: (signal?: AbortSignal) =>
    get<{ ok: true; pipelines: PipelineInfo[]; implemented_count: number }>("/api/pipelines", { signal }),

  bundles: (signal?: AbortSignal) => get<{ ok: true; bundles: BundleListItem[] }>("/api/bundles", { signal }),

  events: (lon: number, lat: number, days = 60, minMagnitude = 4.5, signal?: AbortSignal) =>
    get<{ ok: true; events: EventItem[]; source: string }>("/api/events", {
      signal,
      params: { lon, lat, days, min_magnitude: minMagnitude },
    }),

  /** §5.2: the engine does the tiling — the UI never computes MGRS itself. */
  tileAt: (lon: number, lat: number, signal?: AbortSignal) =>
    get<{ ok: true; tile: TileInfo }>("/api/tile-at", { signal, params: { lon, lat } }),

  tileAtId: (tile: string, signal?: AbortSignal) =>
    get<{ ok: true; tile: TileInfo }>("/api/tile-at", { signal, params: { tile } }),

  /** §5.5: granule availability, metadata-only. A slow search answers 202 +
   *  a job id — resolved here by polling (the engine never holds requests). */
  granules: (lon: number, lat: number, signal?: AbortSignal) =>
    get<GranuleSearchResponse & { pending?: boolean; job_id?: string }>("/api/granules", {
      signal,
      timeoutMs: 30_000,
      params: { lon, lat },
    }).then((r) => resolvePending(r, signal)),

  /** §5.3: a scan is a run — one polling path for everything. */
  startScan: (lon: number, lat: number, opts?: { as_of?: string; lookback_days?: number }) =>
    post<{ ok: true; run_id: string; tile: TileInfo }>("/api/scans", {
      lon,
      lat,
      ...(opts?.as_of ? { as_of: opts.as_of } : {}),
      ...(opts?.lookback_days ? { lookback_days: opts.lookback_days } : {}),
    }),

  /** POST /api/runs — (re-)run selected pipelines on a stored bundle. */
  startRun: (bundleId: string, pipelines: string[], params?: Record<string, number>) =>
    post<{ ok: true; run_id: string }>("/api/runs", {
      bundle_id: bundleId,
      pipelines,
      params: params ?? {},
    }),

  runs: (signal?: AbortSignal) => get<{ ok: true; runs: RunSummary[] }>("/api/runs", { signal }),

  /** The engine returns the run state FLAT: {ok, id, status, progress, error, results}. */
  run: (id: string, opts?: { slim?: boolean; signal?: AbortSignal }) =>
    get<RunState & { ok: true }>(`/api/runs/${encodeURIComponent(id)}`, {
      signal: opts?.signal,
      params: { slim: opts?.slim ? 1 : undefined },
    }),

  /** D5: the pipeline-scoped layer route — layer names collide across pipelines. */
  pipelineLayer: (id: string, pipeline: string, layer: string, signal?: AbortSignal) =>
    get<LayerResponse>(
      `/api/runs/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipeline)}/layers/${encodeURIComponent(layer)}`,
      { signal, timeoutMs: 60_000 },
    ),

  tiles: (signal?: AbortSignal) =>
    get<{
      ok: true;
      tiles: { tile: string; n_verdicts: number; latest: { pipeline: string; status: string; tier?: string | null; raw_p?: number | null; written_at?: string }[] }[];
    }>("/api/tiles", { signal }),

  tileVerdicts: (tileId: string, signal?: AbortSignal) =>
    get<{ ok: true; tile: string; verdicts: StoredVerdict[] }>(
      `/api/tiles/${encodeURIComponent(tileId)}/verdicts`,
      { signal },
    ),
};

/** The engine never holds a request open past ~25 s: a slow granule search
 *  answers 202 + job id and the result is polled here. */
async function resolvePending<T extends { pending?: boolean; job_id?: string }>(
  first: T,
  signal?: AbortSignal,
  maxWaitMs = 5 * 60_000,
): Promise<T> {
  let cur = first;
  const t0 = Date.now();
  while (cur && cur.pending && cur.job_id) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (Date.now() - t0 > maxWaitMs) {
      throw new EngineError("The granule search is still running on the engine — try again in a moment.");
    }
    await new Promise((r) => setTimeout(r, 2500));
    cur = await get<T & { pending?: boolean; job_id?: string }>(`/api/granules/jobs/${encodeURIComponent(cur.job_id)}`, {
      signal,
    });
  }
  return cur;
}

/** TanStack Query hooks over the engine client — all server state for the
 *  Earthquake page flows through here. Data is ALWAYS the engine's own;
 *  these hooks add caching/polling only. */

"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api, EngineError, engineUrl, engineApi, isUnreachable } from "@/lib/engine/client";
import { BUNDLE_INFO, type BundleInfo } from "@/lib/engine/bundleInfo";
import type { GranuleSearchResponse, Health, PipelineResult, RunState, StoredVerdict } from "@/lib/engine/types";

const q = (k: string) => [k] as const;

/* preview self-healing ------------------------------------------------- */

/** In the preview deployment the engine is a sibling process that can die or
 *  restart independently of the site. When it is unreachable, the site asks
 *  its own /api/engine-keepalive route to spawn it (that route boots the
 *  engine detached and answers the health it verified). Only the gateway
 *  transport ever does this — a direct deployment (NEXT_PUBLIC_ENGINE_API
 *  set) points at a real server that must be started by its host. */
let reviveArmed = true;
let reviveTriedAt = 0;
const REVIVE_COOLDOWN_MS = 120_000;
async function reviveEngine(): Promise<Health | null> {
  const now = Date.now();
  if (!reviveArmed && now - reviveTriedAt < REVIVE_COOLDOWN_MS) return null;
  reviveArmed = false;
  reviveTriedAt = now;
  try {
    const r = await fetch("/api/engine-keepalive", { cache: "no-store" });
    if (r.ok) {
      const body = (await r.json()) as { running?: boolean; health?: Health };
      if (body.running && body.health?.ok === true) return body.health;
    }
  } catch {
    /* keep the honest failure — the next poll retries after the cooldown */
  }
  return null;
}

/** "The engine is not answering" — either the request never landed
 *  (network-level unreachable) or, in the gateway transport, the gateway
 *  itself answered 502/503/504 because its upstream port is dead. Direct
 *  deployments treat their engine host's own HTTP errors as errors. */
function engineLooksDown(e: unknown): boolean {
  if (isUnreachable(e)) return true;
  if (engineApi()) return false;
  const status = e instanceof EngineError ? e.status : undefined;
  return status === 502 || status === 503 || status === 504;
}

export function useEngineHealth() {
  const qc = useQueryClient();
  return useQuery<Health, EngineError>({
    queryKey: q("health"),
    queryFn: async ({ signal }) => {
      try {
        const h = await api.health(signal);
        reviveArmed = true; // engine answered — allow a future revive again
        return h;
      } catch (e) {
        if (engineLooksDown(e) && !engineApi()) {
          const h = await reviveEngine();
          if (h) {
            reviveArmed = true;
            // the engine just came back: re-ask every engine query that
            // errored while it was down (this health query excluded)
            void qc.invalidateQueries({
              predicate: (query) => query.queryKey[0] !== "health",
            });
            return h;
          }
        }
        throw e;
      }
    },
    refetchInterval: 15_000,
    retry: 1,
    staleTime: 10_000,
  });
}

export function useEvents(lon: number, lat: number, days: number, minMagnitude: number, enabled = true) {
  return useQuery({
    queryKey: ["events", lon, lat, days, minMagnitude],
    queryFn: ({ signal }) => api.events(lon, lat, days, minMagnitude, signal),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useTileAt(lon: number | null, lat: number | null) {
  return useQuery({
    queryKey: ["tile-at", lon, lat],
    queryFn: ({ signal }) => api.tileAt(lon as number, lat as number, signal),
    enabled: lon !== null && lat !== null,
    staleTime: Infinity,
    retry: 1,
  });
}

export function useGranules(lon: number | null, lat: number | null, enabled = true) {
  return useQuery<GranuleSearchResponse, EngineError>({
    queryKey: ["granules", lon, lat],
    queryFn: ({ signal }) => api.granules(lon as number, lat as number, signal),
    enabled: enabled && lon !== null && lat !== null,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

export function useRuns(poll = true) {
  return useQuery({
    queryKey: q("runs"),
    queryFn: ({ signal }) => api.runs(signal),
    refetchInterval: poll ? 4000 : false,
    staleTime: 2_000,
    retry: 1,
  });
}

/** Poll a single run while it is queued/running; stop when it settles. */
export function useRun(runId: string | null) {
  return useQuery<RunState & { ok: true }, EngineError>({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => api.run(runId as string, { signal }),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === "queued" || st === "running" ? 1500 : false;
    },
    staleTime: 1_000,
    retry: 1,
  });
}

export function useTiles() {
  return useQuery({
    queryKey: q("tiles"),
    queryFn: ({ signal }) => api.tiles(signal),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useTileVerdicts(tileId: string | null) {
  return useQuery<{ ok: true; tile: string; verdicts: StoredVerdict[] }, EngineError>({
    queryKey: ["tile-verdicts", tileId],
    queryFn: ({ signal }) => api.tileVerdicts(tileId as string, signal),
    enabled: tileId !== null,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useBundles() {
  return useQuery({
    queryKey: q("bundles"),
    queryFn: ({ signal }) => api.bundles(signal),
    staleTime: 30_000,
    retry: 1,
  });
}

type BundleDetail = {
  ok: true;
  bundle: {
    bundle_id: string;
    tile: Record<string, unknown>;
    epoch: string | null;
    status: string | null;
    depth: { n_gunw_pairs: number | null; n_gunw_dates: number | null; n_gcov_epochs: number | null; cold_start: boolean | null } | null;
    routing_decisions: unknown;
    applicable: unknown;
    flags: string[];
  } | BundleInfo;
};

export function useBundle(bundleId: string | null) {
  return useQuery({
    queryKey: ["bundle", bundleId],
    queryFn: ({ signal }) =>
      fetch(engineUrl(`/api/bundles/${encodeURIComponent(bundleId as string)}`), {
        cache: "no-store",
        signal,
      })
        .then(async (r): Promise<BundleDetail> => {
          if (!r.ok) throw new Error(`bundle detail answered ${r.status}`);
          return (await r.json()) as BundleDetail;
        })
        .catch((e: unknown): BundleDetail => {
          // The engine keeps per-bundle depth under its (gitignored) data dir — a
          // host that never stored this bundle answers 404. Fall back to the same
          // presence-only metadata the shipped registry carries for it.
          const shipped = BUNDLE_INFO[bundleId as string];
          if (shipped) return { ok: true, bundle: shipped };
          throw e;
        }),
    enabled: bundleId !== null,
    staleTime: 60_000,
    retry: 1,
  });
}

export function usePipelines() {
  return useQuery({
    queryKey: q("pipelines"),
    queryFn: ({ signal }) => api.pipelines(signal),
    staleTime: Infinity,
    retry: 1,
  });
}

/** The earthquake_coseismic result of a run, if it produced one. */
export function eqResultOf(run: RunState | undefined): PipelineResult | null {
  if (!run?.results) return null;
  return run.results.find((r) => r.pipeline === "earthquake_coseismic") ?? null;
}

/** The latest stored earthquake verdict for a tile, if any. */
export function latestEqVerdict(verdicts: StoredVerdict[] | undefined): StoredVerdict | null {
  if (!verdicts?.length) return null;
  const eq = verdicts.filter((v) => v.pipeline === "earthquake_coseismic");
  if (!eq.length) return null;
  return eq.reduce((a, b) => ((b.written_at ?? "") > (a.written_at ?? "") ? b : a));
}

/* mutations ---------------------------------------------------------------- */

export function useStartScan() {
  return useMutation({
    mutationFn: (v: { lon: number; lat: number; as_of?: string; lookback_days?: number }) =>
      api.startScan(v.lon, v.lat, { as_of: v.as_of, lookback_days: v.lookback_days }),
  });
}

export function useStartRun() {
  return useMutation({
    mutationFn: (v: { bundleId: string; pipelines?: string[]; params?: Record<string, number> }) =>
      api.startRun(v.bundleId, v.pipelines ?? ["earthquake_coseismic"], v.params),
  });
}

/* layer fetch (not react-query — imperative, cache-free, on demand) ------- */

export async function fetchLayer(runId: string, layer: string) {
  return api.pipelineLayer(runId, "earthquake_coseismic", layer);
}

export type { UseQueryOptions };

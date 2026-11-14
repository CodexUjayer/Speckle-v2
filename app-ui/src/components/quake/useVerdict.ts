"use client";

/** Resolves WHICH earthquake verdict the page is looking at.
 *
 *  Order: the selected run's own earthquake_coseismic result → the latest
 *  stored verdict for the target tile (verdicts.db via /api/tiles/{id}/verdicts)
 *  → nothing yet. The stored row is adapted into the same PipelineResult
 *  shape the run API returns, so every panel downstream renders one shape.
 *  No values are recomputed — fields are copied verbatim. */

import { useMemo } from "react";
import { eqResultOf, latestEqVerdict, useRun, useTileAt, useTileVerdicts } from "@/components/quake/engineHooks";
import type { PipelineResult, StoredVerdict, EvidenceItem } from "@/lib/engine/types";
import type { Target } from "./shared";

export interface QuakeVerdict {
  result: PipelineResult | null;
  /** where this verdict came from */
  origin: "run" | "store" | "none";
  runId: string | null;
  runStatus?: string;
  runError?: string | null;
  stored: StoredVerdict | null;
}

export function useQuakeVerdict(target: Target | null, runId: string | null): QuakeVerdict {
  const run = useRun(runId);
  const tile = useTileAt(target?.lon ?? null, target?.lat ?? null);
  const tileId = tile.data?.tile.id ?? null;
  const stored = useTileVerdicts(runId ? null : tileId); // only when no run is selected

  return useMemo<QuakeVerdict>(() => {
    const runData = run.data;
    if (runData) {
      const eq = eqResultOf(runData);
      if (eq) {
        return {
          result: eq,
          origin: "run",
          runId: runData.id,
          runStatus: runData.status,
          runError: runData.error,
          stored: null,
        };
      }
    }
    const row = latestEqVerdict(stored.data?.verdicts);
    if (row) {
      const adapted: PipelineResult = {
        pipeline: row.pipeline,
        tile: row.tile,
        epoch: row.epoch ?? null,
        raw_p: row.raw_p ?? null,
        status: row.status,
        tier: row.tier ?? undefined,
        tier_label: undefined,
        summary: row.summary ?? undefined,
        evidence: (row.evidence as EvidenceItem[]) ?? [],
        layers: [],
        provenance: (row.provenance as PipelineResult["provenance"]) ?? [],
        data_used: (row.data_used as string[]) ?? [],
        references_used: (row.references_used as string[]) ?? [],
        runtime_s: 0,
        warnings: (row.warnings as string[] | null) ?? [],
        min_epochs_met: null,
        bundle_id: row.bundle_id ?? null,
        detail: (row.detail as PipelineResult["detail"]) ?? {},
      };
      return {
        result: adapted,
        origin: "store",
        runId: row.run_id ?? null,
        stored: row,
      };
    }
    return {
      result: null,
      origin: "none",
      runId,
      runStatus: runData?.status,
      runError: runData?.error ?? null,
      stored: null,
    };
  }, [run.data, stored.data, runId]);
}

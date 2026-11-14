"use client";

/** RunArraysPanel — the Data Lab's pipeline bridge (Phase 5): the hazard-pipeline runs whose
 *  tile overlaps the current box, and the trace arrays each can place ON the map. Pure display:
 *  the run list, the tile overlap decision, the array inventory and every corner come from the
 *  engine's /api/background/lab-runs answer; picking an array asks the engine for its PNG (the
 *  arrays route's own metadata carries the corners the map needs). */
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { bg } from "@/lib/bg";
import { bgFetch } from "@/lib/bgApi";
import type { LabRunsResponse } from "@/lib/types";

export interface ArrayOverlaySpec {
  runId: string;
  aid: string;
  label: string;
  url: string;
  corners: [[number, number], [number, number], [number, number], [number, number]];
  note: string | null;
}

interface Props {
  runs: LabRunsResponse | null;
  overlay: ArrayOverlaySpec | null;
  onOverlay: (spec: ArrayOverlaySpec | null) => void;
}

export default function RunArraysPanel({ runs, overlay, onOverlay }: Props) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // picking an array: fetch the PNG as a blob (Authorization header, never a URL token) and
  // hand the caller the object URL + the engine's corners for the map
  useEffect(() => {
    if (!overlay) return;
    const ctrl = new AbortController();
    setError(null);
    setBusy(true);
    (async () => {
      try {
        const res = await bgFetch(bg.traceArrayUrl(overlay.runId, overlay.aid, { maxPx: 320 }),
                                 { signal: ctrl.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { detail?: { error?: string } })?.detail?.error ?? `${res.status}`);
        }
        const url = URL.createObjectURL(await res.blob());
        if (!ctrl.signal.aborted) onOverlay({ ...overlay, url });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    })();
    return () => ctrl.abort();
    // one fetch per selected array — the corners arrive with the pick, not from the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay?.runId, overlay?.aid]);

  return (
    <details className="border-t border-[#262c36]">
      <summary className="cursor-pointer px-3 py-2 text-[11px] text-[#7ec8d3]">
        pipeline runs over this box
      </summary>
      <div className="px-3 pb-3">
        {!runs && <p className="text-[10px] text-[#5a636e]">asking the engine for the runs over this box…</p>}
        {runs && runs.n_runs === 0 && (
          <p className="text-[10px] text-[#5a636e]">
            no pipeline run&apos;s tile overlaps this box yet — runs appear here once a scan has
            produced one (the bridge reads local state only; it never starts a scan).
          </p>
        )}
        {runs && runs.runs.map((run) => (
          <div key={run.id} className="mb-1 rounded border border-[#262c36]">
            <button type="button" onClick={() => setOpenRun(openRun === run.id ? null : run.id)}
                    aria-expanded={openRun === run.id}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] hover:bg-[#161b22]">
              <Layers size={10} aria-hidden className="shrink-0 text-[#8b949e]" />
              <span className="font-mono text-[#aab3bd]">{run.id}</span>
              <span className="text-[#5a636e]">{run.status ?? "?"}</span>
              <span className="ml-auto text-[#5a636e]">{run.tile} · {run.pipelines.join(", ") || "no pipeline"}</span>
            </button>
            {openRun === run.id && (
              <div className="border-t border-[#1c222b] p-2">
                <p className="mb-1 text-[10px] text-[#8b949e]">
                  {run.has_live_trace
                    ? `${run.n_arrays} trace array(s) — click one to place it on the map`
                    : "no live trace for this run (evicted or built without one) — its arrays cannot be placed"}
                </p>
                {Object.entries(run.arrays).map(([group, arrs]) => (
                  <div key={group} className="mb-1">
                    <p className="text-[10px] font-medium text-[#8b949e]">{group}</p>
                    {arrs.map((a) => {
                      const active = overlay?.runId === run.id && overlay?.aid === a.aid;
                      const placeable = a.corners_lonlat && a.corners_lonlat.length === 4;
                      return (
                        <button key={a.aid} type="button" disabled={!placeable}
                                 aria-pressed={active}
                                 onClick={() => onOverlay(active ? null : {
                                   runId: run.id, aid: a.aid,
                                   label: `${a.label ?? a.aid} (${run.id})`,
                                   url: "",
                                   corners: a.corners_lonlat as ArrayOverlaySpec["corners"],
                                   note: a.note,
                                 })}
                                 className={`block w-full truncate rounded border px-2 py-0.5 text-left text-[10px] ${
                                   active ? "border-[#7fd8e6] bg-[#12333a] text-[#7fd8e6]"
                                     : placeable ? "border-[#262c36] text-[#aab3bd] hover:border-[#4a5462]"
                                       : "cursor-not-allowed border-[#1c222b] text-[#5a636e]"}`}>
                          {a.label ?? a.aid}
                          <span className="ml-1 text-[#5a636e]">{a.shape ? `${a.shape[0]}×${a.shape[1]}` : ""}</span>
                          {!placeable && <span className="ml-1 text-[#5a636e]">— no placement</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <p role="status" className="text-[10px] text-[#8b949e]">the engine is rendering the array…</p>}
        {error && <p role="alert" className="text-[10px] text-[#e8a087]">{error}</p>}
        {overlay && overlay.url && (
          <p className="mt-1 text-[10px] text-[#7fd8e6]">
            on the map: {overlay.label} — pick another array or the same one again to remove it
          </p>
        )}
        {runs?.notes.map((n, i) => <p key={i} className="mt-1 text-[10px] text-[#5a636e]">{n}</p>)}
      </div>
    </details>
  );
}

"use client";

/** Chapter III — run the analysis.
 *  POST /api/scans is the engine's real scan: resolve tile → retrieve the
 *  newest interferograms from ASF → run the pipelines → persist verdicts.
 *  Single-flight (a 409 names the active run). Everything shown here is the
 *  engine's own progress heartbeat. */

import { useEffect } from "react";
import { Activity, PlayCircle, Radio } from "lucide-react";
import { QuakeSection, Panel, PanelHead, PrimaryPill, Spinner, ErrorPanel, EmptyPanel, Chip, Mono, Readout } from "../ui";
import { useEngineHealth, useRuns, useRun, useStartScan, eqResultOf } from "@/components/quake/engineHooks";
import type { ScanProgress } from "@/lib/engine/types";
import type { EngineError } from "@/lib/engine/client";
import { fmtDuration, type Target } from "../shared";
import { cn } from "@/components/quake/utils";

/** A 409 single-flight answer carries the active run id in its detail —
 *  surfaced as the panel's hint so the next action is obvious. */
function activeRunHint(e: EngineError): string | undefined {
  const d = e.detail as { active_run_id?: string } | undefined;
  return d && typeof d === "object" && d.active_run_id
    ? `Another run is active (${d.active_run_id}) — single-flight protection.`
    : undefined;
}

/* ------------------------------------------------------------------ */
/* the event-anchored scan window (engine POST /api/scans fields)        */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function scanWindowOf(t: Target): { as_of?: string; lookback_days?: number } {
  const iso = t.event?.time ?? t.curated?.eventTime ?? null;
  if (!iso) return {};
  const eventTime = Date.parse(iso);
  if (!Number.isFinite(eventTime)) return {};
  const asOf = Math.min(Date.now(), eventTime + 12 * DAY_MS);
  const spanDays = Math.max(120, Math.ceil((asOf - eventTime) / DAY_MS) + 45);
  return {
    as_of: new Date(asOf).toISOString().replace(/\.\d+Z$/, "Z"),
    lookback_days: Math.min(spanDays, 365),
  };
}

export default function ScanSection({
  target,
  runId,
  onRunId,
}: {
  target: Target | null;
  runId: string | null;
  onRunId: (id: string | null) => void;
}) {
  const health = useEngineHealth();
  const scan = useStartScan();
  const runs = useRuns(true);
  const active = useRun(runId);

  const progress = (active.data?.progress ?? {}) as ScanProgress;
  const running = active.data?.status === "queued" || active.data?.status === "running";

  /* when a scan we started finishes, keep it selected; the verdict section
     picks it up from runId */
  useEffect(() => {
    if (scan.data?.run_id) onRunId(scan.data.run_id);
  }, [scan.data?.run_id]);

  const engineReady = health.data?.ok === true;
  const scansEnabled = health.data?.scans_enabled === true;
  const busy = health.data?.busy ?? null;

  /* The engine's scan window, ANCHORED TO THE EVENT BEING INVESTIGATED: as_of =
     event time + one NISAR repeat cycle (12 d, so post-event scenes exist), and a
     lookback that covers pre-event reference scenes. Without this the scan always
     analyses the newest epochs and an older target event falls outside the screen
     window (proven: the M5.8 Fujishiro quake of 2026-08-22 was 4 days outside the
     default window of the first scan). */
  const scanWindow = target ? scanWindowOf(target) : {};

  const launch = () => {
    if (!target) return;
    scan.mutate(
      { lon: target.lon, lat: target.lat, ...scanWindow },
      {
        onSuccess: (res) => {
          onRunId(res.run_id);
          document.getElementById("scan-progress")?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
      },
    );
  };

  const canLaunch = !!target && engineReady && scansEnabled && !running && !scan.isPending;

  const stepRows = Array.isArray(progress.steps) ? progress.steps : [];
  const net = progress.net;
  const gr = progress.granules;

  return (
    <QuakeSection
      id="scan"
      channel="03"
      kicker="ask the engine"
      title="Run the analysis."
      body="A scan is the engine's real workflow: it resolves the tile, retrieves the newest interferometric pairs over ASF (the heavy part — hundreds of megabytes), runs every applicable pipeline, and files each verdict. One run at a time; the progress below is the engine's own heartbeat."
    >
      {!target ? (
        <EmptyPanel title="Waiting for a target">
          Pick an earthquake first — the engine scans the tile that contains it.
        </EmptyPanel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          {/* ---------------- launcher ---------------- */}
          <div className="flex flex-col gap-6">
            <Panel className="p-5">
              <div className="flex items-center gap-2.5">
                <PlayCircle className="h-4 w-4 text-[var(--qp-red)]" aria-hidden />
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-2)]">
                  Launch a scan
                </p>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-[var(--qp-ink-2)]">
                Point the engine at{" "}
                <span className="text-[var(--qp-ink)]/90">{target.label}</span> (
                {target.lat.toFixed(2)}°, {target.lon.toFixed(2)}°) and let it work through
                retrieval, preprocessing and verdicts.
              </p>
              {scanWindow.as_of ? (
                <p className="qp-readout mt-3 text-[10px] leading-relaxed tracking-[0.08em] text-[var(--qp-ink-3)]">
                  window anchored to the event · as_of {scanWindow.as_of.slice(0, 10)} · lookback{" "}
                  {scanWindow.lookback_days} d — the interferograms span the quake itself
                </p>
              ) : null}
              <div className="mt-5">
                <PrimaryPill onClick={launch} disabled={!canLaunch}>
                  {running ? (
                    <>
                      <Spinner className="border-[var(--qp-ink)]/25" />
                      Engine working…
                    </>
                  ) : (
                    <>
                      <Activity className="h-4 w-4" aria-hidden />
                      Scan this tile
                    </>
                  )}
                </PrimaryPill>
              </div>
              {!engineReady ? (
                <p className="mt-4 text-xs leading-relaxed text-[#ff5d55]">
                  The engine is not reachable right now — start it with{" "}
                  <code className="font-mono">uvicorn engine.api.main:app --port 8900</code>.
                </p>
              ) : !scansEnabled ? (
                <p className="mt-4 text-xs leading-relaxed text-[#e8b74e]">
                  Scans are disabled on this engine (set NISAR_ENABLE_SCANS=1).
                </p>
              ) : busy ? (
                <p className="mt-4 text-xs leading-relaxed text-[var(--qp-ink-2)]">
                  The engine is busy with another run ({busy.kind} · {String(busy.step ?? "")}) —
                  it answers one investigation at a time.
                </p>
              ) : null}
              {scan.isError ? (
                <div className="mt-4">
                  <ErrorPanel
                    title="The scan could not start"
                    message={scan.error.message}
                    hint={activeRunHint(scan.error as EngineError)}
                  />
                </div>
              ) : null}
            </Panel>

            {/* ---------------- recent runs ---------------- */}
            <Panel className="overflow-hidden">
              <PanelHead
                title="Recent runs"
                right={runs.isFetching ? <Spinner /> : <Chip>{runs.data?.runs.length ?? 0}</Chip>}
              />
              {runs.isPending ? (
                <div className="px-5 py-6">
                  <Mono>loading run history…</Mono>
                </div>
              ) : (runs.data?.runs.length ?? 0) === 0 ? (
                <div className="px-5 py-6">
                  <Mono>no runs yet — this engine has not scanned anything</Mono>
                </div>
              ) : (
                <ul className="max-h-72 divide-y divide-[var(--qp-edge)] overflow-y-auto">
                  {(runs.data?.runs ?? []).map((r) => {
                    const selected = r.id === runId;
                    const done = r.status === "ok" || r.status === "error";
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onRunId(r.id);
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                            selected ? "bg-[var(--qp-red)]/[0.06]" : "hover:bg-[var(--qp-paper-3)]",
                          )}
                        >
                          <span
                            className={cn(
                              "block h-1.5 w-1.5 shrink-0 rounded-full",
                              r.status === "ok"
                                ? "bg-[#3ecf9a]"
                                : r.status === "error"
                                  ? "bg-[#ff5d55]"
                                  : "bg-[#e8b74e] animate-pulse",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[11px] text-[var(--qp-ink)]">
                              {r.id}
                            </span>
                            <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)]">
                              {r.kind ?? "bundle"} · {r.tile || "no tile"} ·{" "}
                              {done ? r.status : r.status}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>

          {/* ---------------- live progress console ---------------- */}
          <Panel id="scan-progress" className="overflow-hidden">
            <PanelHead
              title="Acquisition console"
              right={
                active.data ? (
                  <Chip tone={active.data.status === "ok" ? "ok" : active.data.status === "error" ? "off" : "mid"}>
                    {active.data.status}
                  </Chip>
                ) : (
                  <Chip>idle</Chip>
                )
              }
            />
            {!runId ? (
              <div className="flex items-center gap-3 px-5 py-10">
                <Radio className="h-4 w-4 text-[var(--qp-ink-3)]" aria-hidden />
                <Mono>no run selected — launch a scan or pick one from the history</Mono>
              </div>
            ) : active.isError ? (
              <div className="p-4">
                <ErrorPanel title="This run could not be read" message={active.error.message} onRetry={() => active.refetch()} />
              </div>
            ) : active.data ? (
              <div className="p-5">
                {/* headline readouts */}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Readout label="Run" value={<span className="truncate">{runId}</span>} />
                  <Readout
                    label="Stage"
                    value={
                      <span className="truncate">
                        {progress.stage ?? active.data.status}
                      </span>
                    }
                  />
                  <Readout
                    label="Elapsed"
                    value={fmtDuration(progress.elapsed_s ?? null)}
                  />
                  <Readout
                    label="Tile"
                    value={<span className="truncate">{active.data.tile || progress.tile || "—"}</span>}
                  />
                </div>

                {/* wire + granule counters while running */}
                {net || gr ? (
                  <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--qp-edge)] pt-4 sm:grid-cols-4">
                    {net ? (
                      <>
                        <Readout label="On wire" value={`${(net.mb ?? 0).toFixed(1)} MB`} />
                        <Readout
                          label="Rate"
                          value={`${(net.mbps_now ?? 0).toFixed(2)} MB/s`}
                          hint={`average ${(net.mbps_avg ?? 0).toFixed(2)} MB/s`}
                        />
                        <Readout label="Requests" value={`${net.requests ?? 0} · ${net.retries ?? 0} retries`} />
                        <Readout
                          label="Granules"
                          value={
                            gr?.total
                              ? `${gr.done ?? 0}/${gr.total}${gr.failed ? ` · ${gr.failed} failed` : ""}`
                              : `${net.inflight ?? 0} in flight`
                          }
                          hint={gr?.eta_s ? `ETA ~${Math.round(gr.eta_s / 60)} min` : undefined}
                        />
                      </>
                    ) : null}
                  </div>
                ) : null}

                {/* the step ledger */}
                {stepRows.length ? (
                  <ul className="mt-5 max-h-64 divide-y divide-[var(--qp-edge)] overflow-y-auto border-t border-[var(--qp-edge)]">
                    {stepRows.map((s) => (
                      <li key={s.code} className="flex items-center gap-3 py-2 font-mono text-[11px]">
                        <span
                          className={cn(
                            "block h-1.5 w-1.5 shrink-0 rounded-full",
                            s.status === "ok"
                              ? "bg-[#3ecf9a]"
                              : s.status === "error"
                                ? "bg-[#ff5d55]"
                                : s.status === "skipped"
                                  ? "bg-[var(--qp-ink-3)]/50"
                                  : "bg-[#e8b74e] animate-pulse",
                          )}
                          aria-hidden
                        />
                        <span className="w-28 shrink-0 text-[var(--qp-ink-2)]">{s.code}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--qp-ink-2)]">{s.name}</span>
                        <span className="shrink-0 text-[var(--qp-ink-2)]">
                          {s.status}
                          {s.seconds != null ? ` · ${s.seconds.toFixed(1)}s` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* settled: what came out */}
                {active.data.status === "ok" ? (
                  <div className="mt-5 border-t border-[var(--qp-edge)] pt-4">
                    <p className="text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
                      Run finished —{" "}
                      {(() => {
                        const eq = eqResultOf(active.data);
                        if (!eq) return "no earthquake verdict in this run's results.";
                        return (
                          <>
                            the earthquake pipeline answered{" "}
                            <span className="text-[var(--qp-red)]">{eq.status.replaceAll("_", " ").toLowerCase()}</span>.
                            The verdict is below.
                          </>
                        );
                      })()}
                    </p>
                  </div>
                ) : null}
                {active.data.status === "error" ? (
                  <div className="mt-5 rounded-md border border-[#ff5d55]/25 bg-[#ff5d55]/[0.05] px-4 py-3">
                    <p className="font-mono text-[11px] leading-relaxed text-[#ff5d55]">
                      {active.data.error ?? "run failed"}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-3 px-5 py-10">
                <Spinner />
                <Mono>reading run state…</Mono>
              </div>
            )}
          </Panel>
        </div>
      )}
    </QuakeSection>
  );
}

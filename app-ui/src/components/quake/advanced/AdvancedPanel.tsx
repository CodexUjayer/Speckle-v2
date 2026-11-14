"use client";

/** Advanced analysis — the technical dashboard.
 *
 *  Everything here is a direct rendering of the engine's own outputs:
 *  decision trace, parameters, the pairs that were analysed, the events
 *  the model screened (with its forward-model predictions), the
 *  uncatalogued-source fit when the engine attempted one, per-detection
 *  geometry, the evidence rasters with the engine's colormaps, and a
 *  re-run control that exercises the engine's own parameter surface
 *  (POST /api/runs with the four ALLOWED_PARAMS). */

import { useMemo, useState } from "react";
import { Activity, BookOpen, Boxes, Cog, Layers, ListTree, Microscope, Radar, RefreshCw, Satellite, Sigma } from "lucide-react";
import { Panel, PanelHead, TierBadge, Chip, Mono, KeyValue, EmptyPanel, Spinner, PrimaryPill, ErrorPanel, Readout } from "../ui";
import { ClustersChart, EventsChart, PairsChart, ScreensChart, ScreensScatter } from "../charts/QuakeCharts";
import LayerViewer from "./LayerViewer";
import { useQuakeVerdict } from "../useVerdict";
import { useEngineHealth, usePipelines, useRun, useRuns, useStartRun, useTiles, useBundles, useTileVerdicts } from "@/components/quake/engineHooks";
import { api } from "@/lib/engine/client";
import { fmtArea, fmtDate, fmtDateTime, fmtDuration, fmtKm, fmtMagnitude, fmtMm, fmtNum, type Target } from "../shared";
import type { EqParamsDict, PairRecord } from "@/lib/engine/types";
import { crossCheckLabel, crossCheckNote, type ForwardScreen } from "../data";
import { cn } from "@/components/quake/utils";

/* ------------------------------------------------------------------ */
/* sub-navigation                                                       */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  { id: "adv-verdict", label: "Verdict & decision", icon: Sigma },
  { id: "adv-pairs", label: "Pairs analysed", icon: ListTree },
  { id: "adv-events", label: "Events & forward model", icon: Radar },
  { id: "adv-detections", label: "Detections", icon: Microscope },
  { id: "adv-layers", label: "Evidence rasters", icon: Layers },
  { id: "adv-rerun", label: "Re-run with parameters", icon: RefreshCw },
  { id: "adj-browser", label: "Runs · verdicts · bundles", icon: Boxes },
  { id: "adv-engine", label: "Engine internals", icon: Cog },
] as const;

function goto(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------------ */
/* the panel                                                            */
/* ------------------------------------------------------------------ */

export default function AdvancedPanel({
  target,
  onTarget,
  runId,
  onRunId,
}: {
  target: Target | null;
  onTarget: (t: Target) => void;
  runId: string | null;
  onRunId: (id: string | null) => void;
  onExit: () => void;
}) {
  const verdict = useQuakeVerdict(target, runId);
  const res = verdict.result;
  const detail = res?.detail ?? {};

  return (
    <div className="relative">
      {/* opening — the annex header, a channel like the rest */}
      <section className="relative px-5 pb-10 pt-16 sm:px-8 sm:pt-20">
        <div className="relative mx-auto max-w-6xl">
          <div className="flex items-end justify-between gap-4">
            <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--qp-red)]">
              CH·08 — <span className="text-[var(--qp-ink-2)]">the annex · for reviewers</span>
            </p>
            <span aria-hidden className="qp-readout hidden text-[10px] tracking-[0.3em] text-[var(--qp-ink-3)] sm:block">
              TECHNICAL RECORD
            </span>
          </div>
          <div aria-hidden className="qp-channel-rule mt-2" />
          <h2 className="mt-6 font-display text-3xl font-normal leading-[1.06] text-[var(--qp-ink)] sm:text-4xl lg:text-[2.9rem]">
            The full technical record.
          </h2>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--qp-ink-2)]">
            The complete output surface of the earthquake_coseismic pipeline: decision traces,
            screened events with forward-model numbers, per-pair statistics, detection geometry,
            evidence rasters — and the engine&apos;s own re-run controls.
          </p>
          {res ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <TierBadge result={res} />
              <Mono>
                tile {res.tile} · {verdict.origin === "run" ? `run ${verdict.runId}` : "stored verdict"}
              </Mono>
            </div>
          ) : (
            <p className="qp-readout mt-6 max-w-xl text-[11px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
              no verdict selected — run a scan above, or pick a run below
            </p>
          )}
        </div>
      </section>

      <div className="mx-auto flex max-w-7xl gap-10 px-5 pb-24 sm:px-8">
        {/* rail */}
        <nav aria-label="Advanced sections" className="sticky top-36 hidden h-fit w-56 shrink-0 lg:block">
          <p className="text-[9px] font-semibold uppercase tracking-[0.3em] text-[var(--qp-ink-3)]">Record</p>
          <ul className="mt-4 space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goto(s.id)}
                  className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--qp-ink-2)] transition-colors hover:bg-[var(--qp-paper-3)] hover:text-[var(--qp-ink)]"
                >
                  <s.icon className="h-3.5 w-3.5 text-[var(--qp-ink-3)] transition-colors group-hover:text-[var(--qp-red)]" aria-hidden />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* content */}
        <div className="min-w-0 flex-1 space-y-16">
          <VerdictBlock res={res} runId={runId} />
          <PairsBlock pairs={detail.pairs_analysed ?? []} />
          <EventsBlock detail={detail} />
          <DetectionsBlock detections={detail.detections ?? []} truncated={detail.detections_truncated} />
          <LayersBlock layers={detail.layers ?? {}} />
          <RerunBlock
            bundleId={res?.bundle_id ?? verdict.stored?.bundle_id ?? null}
            target={target}
            onTarget={onTarget}
            onRunId={onRunId}
          />
          <BrowserBlock runId={runId} onRunId={onRunId} onTarget={onTarget} verdict={verdict} />
          <EngineBlock />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* verdict & decision                                                   */
/* ------------------------------------------------------------------ */

function VerdictBlock({ res, runId }: { res: ReturnType<typeof useQuakeVerdict>["result"]; runId: string | null }) {
  if (!res) return <EmptyPanel title="No verdict selected" />;
  const detail = res.detail ?? {};
  const params = (detail.params ?? {}) as EqParamsDict;
  const versions = (res as unknown as { versions?: Record<string, unknown> }).versions ?? {};
  const paramRows = Object.entries(params).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string");
  return (
    <section id="adv-verdict" aria-labelledby="adv-verdict-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-verdict-h" kicker="01" title="Verdict & decision" />
      <Panel className="overflow-hidden">
        <PanelHead title="Result" right={<TierBadge result={res} />} />
        <KeyValue
          rows={[
            { k: "Pipeline", v: res.pipeline, mono: true },
            { k: "Tile", v: res.tile, mono: true },
            { k: "Status", v: res.status, mono: true },
            { k: "Tier", v: res.tier ?? "—", mono: true },
            { k: "raw_p", v: res.raw_p === null || res.raw_p === undefined ? "None (not scored)" : res.raw_p.toFixed(4), mono: true },
            { k: "Bundle", v: res.bundle_id ?? "—", mono: true },
            { k: "Runtime", v: res.runtime_s ? fmtDuration(res.runtime_s) : "—", mono: true },
            { k: "Run", v: runId ?? "—", mono: true },
          ]}
        />
        {res.summary ? (
          <div className="border-t border-[var(--qp-edge)] px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">Summary (verbatim)</p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--qp-ink)]">{res.summary}</p>
          </div>
        ) : null}
        {detail.status_meaning ? (
          <div className="border-t border-[var(--qp-edge)] px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">Status meaning</p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--qp-ink-2)]">{String(detail.status_meaning)}</p>
          </div>
        ) : null}
        {detail.narrative?.note ? (
          <div className="border-t border-[var(--qp-edge)] px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">Narrative note</p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--qp-ink-2)]">{String(detail.narrative.note)}</p>
          </div>
        ) : null}
      </Panel>

      {detail.decision ? (
        <Panel className="overflow-hidden">
          <PanelHead title="Decision trace" right={<Chip tone="accent">{String(detail.decision.rule ?? "—")}</Chip>} />
          <KeyValue
            rows={Object.entries(detail.decision)
              .filter(([k]) => k !== "rule")
              .map(([k, v]) => ({
                k,
                v: typeof v === "number" ? String(v) : v === null ? "—" : String(Array.isArray(v) ? v.join("; ") : v),
                mono: true,
              }))}
          />
        </Panel>
      ) : null}

      {paramRows.length ? (
        <Panel className="overflow-hidden">
          <PanelHead title="Parameters in force" right={<Chip>{paramRows.length}</Chip>} />
          <div className="grid gap-x-8 sm:grid-cols-2">
            <KeyValue rows={paramRows.slice(0, Math.ceil(paramRows.length / 2)).map(([k, v]) => ({ k, v: String(v), mono: true }))} />
            <KeyValue rows={paramRows.slice(Math.ceil(paramRows.length / 2)).map(([k, v]) => ({ k, v: String(v), mono: true }))} />
          </div>
        </Panel>
      ) : null}

      {Object.keys(versions).length ? (
        <Panel className="overflow-hidden">
          <PanelHead title="Versions" />
          <KeyValue rows={Object.entries(versions).map(([k, v]) => ({ k, v: String(v), mono: true }))} />
        </Panel>
      ) : null}

      {res.warnings?.length ? (
        <Panel className="overflow-hidden">
          <PanelHead title={`Warnings (${res.warnings.length})`} right={<Chip tone="mid">review</Chip>} />
          <ul className="max-h-64 divide-y divide-[var(--qp-edge)] overflow-y-auto">
            {res.warnings.map((w, i) => (
              <li key={i} className="px-5 py-3 text-[12px] leading-relaxed text-[#e8b74e]/85">
                {w}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* pairs                                                                */
/* ------------------------------------------------------------------ */

function PairsBlock({ pairs }: { pairs: PairRecord[] }) {
  return (
    <section id="adv-pairs" aria-labelledby="adv-pairs-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-pairs-h" kicker="02" title="Pairs analysed" />
      {!pairs.length ? (
        <EmptyPanel title="No pairs analysed">
          The pipeline did not reach pair analysis on this tile — the verdict block states why.
        </EmptyPanel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            <PanelHead title="Detection weight per pair" right={<Chip>engine values</Chip>} />
            <div className="p-4 sm:p-5">
              <PairsChart pairs={pairs} />
            </div>
          </Panel>
          <Panel className="overflow-hidden">
            <PanelHead title="Pair ledger" right={<Chip>{pairs.length}</Chip>} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left">
                <thead>
                  <tr className="border-b border-[var(--qp-edge)] font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
                    <th className="px-4 py-2.5">stack</th>
                    <th className="px-3 py-2.5">window</th>
                    <th className="px-3 py-2.5">valid px</th>
                    <th className="px-3 py-2.5">detected</th>
                    <th className="px-3 py-2.5">area km²</th>
                    <th className="px-3 py-2.5">clusters</th>
                    <th className="px-3 py-2.5">ref offset</th>
                    <th className="px-3 py-2.5">edge touch</th>
                    <th className="px-3 py-2.5">state</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px] text-[var(--qp-ink-2)]">
                  {pairs.map((p, i) => (
                    <tr key={i} className={cn("border-b border-[var(--qp-edge)]", p.selected && "bg-[var(--qp-red)]/[0.06]")}>
                      <td className="px-4 py-2.5 whitespace-nowrap">{p.stack_key}#{p.pair_index}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[var(--qp-ink-2)]">
                        {(p.ref_time ?? "—").slice(0, 10)}→{(p.sec_time ?? "—").slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5">{fmtNum(p.valid_pixels)}</td>
                      <td className="px-3 py-2.5">{fmtNum(p.detected_pixels)}</td>
                      <td className="px-3 py-2.5">{fmtArea(p.affected_area_km2, 2)}</td>
                      <td className="px-3 py-2.5">{fmtNum(p.clusters?.count)}</td>
                      <td className="px-3 py-2.5">{fmtMm(p.ref_offset_m, 1)}</td>
                      <td className="px-3 py-2.5">
                        {p.edge_touch_fraction === null || p.edge_touch_fraction === undefined
                          ? "—"
                          : `${(p.edge_touch_fraction * 100).toFixed(1)}%`}
                      </td>
                      <td className="px-3 py-2.5">
                        {p.skipped ? <Chip tone="mid">skipped</Chip> : p.selected ? <Chip tone="ok">selected</Chip> : <Chip>analysed</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* events & forward model                                               */
/* ------------------------------------------------------------------ */

function EventsBlock({ detail }: { detail: NonNullable<ReturnType<typeof useQuakeVerdict>["result"]>["detail"] }) {
  const considered = detail.events_considered ?? [];
  const excluded = detail.events_excluded ?? [];
  const screens = (detail.forward_screens ?? []) as unknown as ForwardScreen[];
  const uncat = detail.uncatalogued;
  return (
    <section id="adv-events" aria-labelledby="adv-events-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-events-h" kicker="03" title="Events & forward model" />
      {!considered.length && !screens.length ? (
        <EmptyPanel title="No events were screened">
          Either no catalog event fell inside the acquisition window, or the pipeline did not reach
          the screen — the verdict block states which.
        </EmptyPanel>
      ) : (
        <>
          {considered.length ? (
            <Panel className="overflow-hidden">
              <PanelHead
                title="Catalogued events considered"
                right={<Chip>ranked by the engine</Chip>}
              />
              <div className="p-4 sm:p-5">
                <EventsChart events={considered} />
              </div>
              <div className="overflow-x-auto border-t border-[var(--qp-edge)]">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr className="border-b border-[var(--qp-edge)] font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
                      <th className="px-4 py-2.5">event</th>
                      <th className="px-3 py-2.5">magnitude</th>
                      <th className="px-3 py-2.5">distance</th>
                      <th className="px-3 py-2.5">time</th>
                      <th className="px-3 py-2.5">place</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[11px] text-[var(--qp-ink-2)]">
                    {considered.map((e) => (
                      <tr key={e.id} className="border-b border-[var(--qp-edge)]">
                        <td className="px-4 py-2.5">{e.id}</td>
                        <td className="px-3 py-2.5">{fmtMagnitude(e.magnitude)}</td>
                        <td className="px-3 py-2.5">{fmtKm(e.distance_km, 1)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-[var(--qp-ink-2)]">{e.time?.slice(0, 16).replace("T", " ")}</td>
                        <td className="px-3 py-2.5 text-[var(--qp-ink-2)]">{e.place}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {screens.length ? (
            <>
              <Panel className="overflow-hidden">
                <PanelHead title="Forward screens — predicted vs measured peak LOS" right={<Chip>{screens.length} screens</Chip>} />
                <div className="p-4 sm:p-5">
                  <ScreensChart screens={screens} />
                </div>
              </Panel>
              <Panel className="overflow-hidden">
                <PanelHead title="Consistency plane — amplitude ratio vs pattern correlation" />
                <div className="p-4 sm:p-5">
                  <ScreensScatter screens={screens} />
                </div>
              </Panel>
              <Panel className="overflow-hidden">
                <PanelHead title="Screen ledger" />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left">
                    <thead>
                      <tr className="border-b border-[var(--qp-edge)] font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
                        <th className="px-4 py-2.5">event · plane</th>
                        <th className="px-3 py-2.5">predicted</th>
                        <th className="px-3 py-2.5">measured</th>
                        <th className="px-3 py-2.5">ratio</th>
                        <th className="px-3 py-2.5">correlation</th>
                        <th className="px-3 py-2.5">state</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-[11px] text-[var(--qp-ink-2)]">
                      {screens.map((s, i) => (
                        <tr key={i} className="border-b border-[var(--qp-edge)]">
                          <td className="px-4 py-2.5">
                            {crossCheckLabel(s)}
                          </td>
                          <td className="px-3 py-2.5">{fmtMm(s.predicted_peak_m)}</td>
                          <td className="px-3 py-2.5">{fmtMm(s.measured_peak_m)}</td>
                          <td className="px-3 py-2.5">{s.amplitude_ratio?.toFixed(3) ?? "—"}</td>
                          <td className="px-3 py-2.5">{s.pattern_correlation?.toFixed(3) ?? "—"}</td>
                          <td className="px-3 py-2.5">
                            {s.skipped ? <Chip tone="mid">skipped</Chip> : <Chip tone="ok">screened</Chip>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-[var(--qp-edge)] px-5 py-3">
                  {screens
                    .filter((s) => s.note)
                    .slice(0, 3)
                    .map((s, i) => (
                      <Mono key={i} className="block">
                        {crossCheckNote(s)}
                      </Mono>
                    ))}
                </div>
              </Panel>
            </>
          ) : null}

          {excluded.length ? (
            <Panel className="overflow-hidden">
              <PanelHead title="Events excluded (engine's reasons)" right={<Chip>{excluded.length}</Chip>} />
              <ul className="divide-y divide-[var(--qp-edge)]">
                {excluded.map((e, i) => (
                  <li key={i} className="flex items-baseline gap-3 px-5 py-3">
                    <Mono className="shrink-0">{String(e.id)}</Mono>
                    <span className="text-[12px] leading-relaxed text-[var(--qp-ink-2)]">{String(e.reason ?? "—")}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {uncat ? (
            <Panel className="overflow-hidden">
              <PanelHead
                title="Uncatalogued-source fit"
                right={<Chip tone={uncat.converged ? "mid" : "off"}>{uncat.converged ? "converged" : "not converged"}</Chip>}
              />
              {uncat.parameters ? (
                <KeyValue
                  rows={[
                    { k: "Strike", v: `${(uncat.parameters.strike_deg ?? Number.NaN).toFixed(0)}°`, mono: true },
                    { k: "Dip", v: `${(uncat.parameters.dip_deg ?? Number.NaN).toFixed(0)}°`, mono: true },
                    { k: "Length × width", v: `${((uncat.parameters.length_m ?? 0) / 1000).toFixed(1)} × ${((uncat.parameters.width_m ?? 0) / 1000).toFixed(1)} km`, mono: true },
                    { k: "Centroid depth", v: `${((uncat.parameters.centroid_depth_m ?? 0) / 1000).toFixed(1)} km`, mono: true },
                    { k: "Slip", v: `${Math.abs(uncat.parameters.slip_m ?? 0).toFixed(2)} m (${uncat.parameters.sense ?? "?"})`, mono: true },
                    { k: "Residual RMS", v: fmtMm(uncat.rms_m), mono: true },
                    { k: "RMS ratio", v: uncat.rms_ratio?.toFixed(2) ?? "—", mono: true },
                    { k: "Pattern correlation", v: uncat.pattern_correlation?.toFixed(3) ?? "—", mono: true },
                  ]}
                />
              ) : (
                <div className="px-5 py-4">
                  <Mono>{uncat.reason ?? "fit not attempted"}</Mono>
                </div>
              )}
              {uncat.simplifications?.length ? (
                <div className="border-t border-[var(--qp-edge)] px-5 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">v1 simplifications</p>
                  <ul className="mt-2 space-y-1">
                    {uncat.simplifications.map((s, i) => (
                      <li key={i} className="text-[12px] leading-relaxed text-[var(--qp-ink-2)]">
                        · {s}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {uncat.weakly_constrained?.length ? (
                <div className="border-t border-[var(--qp-edge)] px-5 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">Weakly constrained</p>
                  <p className="mt-2 text-[12px] leading-relaxed text-[var(--qp-ink-2)]">{uncat.weakly_constrained.join(", ")}</p>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* detections                                                           */
/* ------------------------------------------------------------------ */

function DetectionsBlock({ detections, truncated }: { detections: NonNullable<ReturnType<typeof useQuakeVerdict>["result"]>["detail"]["detections"]; truncated?: boolean }) {
  return (
    <section id="adv-detections" aria-labelledby="adv-detections-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-detections-h" kicker="04" title="Detections" />
      {!detections?.length ? (
        <EmptyPanel title="No detection geometry">
          The engine reported no per-detection geometry for this verdict — either nothing crossed
          the threshold or the pipeline did not run.
        </EmptyPanel>
      ) : (
        <>
          {truncated ? (
            <div className="flex items-center gap-2.5 rounded-md border border-[#e8b74e]/25 bg-[#e8b74e]/[0.05] px-4 py-2.5">
              <Chip tone="mid">truncated</Chip>
              <Mono>the engine caps the geometry list at 50 clusters</Mono>
            </div>
          ) : null}
          <Panel className="overflow-hidden">
            <PanelHead title="Cluster ranking" right={<Chip>{detections.length}</Chip>} />
            <div className="p-4 sm:p-5">
              <ClustersChart detections={detections} />
            </div>
          </Panel>
          <Panel className="overflow-hidden">
            <PanelHead title="Detection ledger" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left">
                <thead>
                  <tr className="border-b border-[var(--qp-edge)] font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
                    <th className="px-4 py-2.5">label</th>
                    <th className="px-3 py-2.5">area km²</th>
                    <th className="px-3 py-2.5">polarity</th>
                    <th className="px-3 py-2.5">peak |LOS|</th>
                    <th className="px-3 py-2.5">centroid</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px] text-[var(--qp-ink-2)]">
                  {detections.map((d) => (
                    <tr key={d.id} className="border-b border-[var(--qp-edge)]">
                      <td className="px-4 py-2.5">{d.label}</td>
                      <td className="px-3 py-2.5">{fmtArea(d.area_km2, 2)}</td>
                      <td className="px-3 py-2.5">
                        <Chip tone={d.polarity === "toward" ? "ok" : d.polarity === "away" ? "off" : "dim"}>
                          {d.polarity ?? "—"}
                        </Chip>
                      </td>
                      <td className="px-3 py-2.5">{fmtMm(d.metrics?.peak_abs_los_m?.value ?? null)}</td>
                      <td className="px-3 py-2.5 text-[var(--qp-ink-2)]">
                        {d.centroid_lonlat[1].toFixed(3)}°, {d.centroid_lonlat[0].toFixed(3)}°
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* rasters                                                              */
/* ------------------------------------------------------------------ */

const LAYER_ORDER = ["displacement", "detected", "threshold", "residual"] as const;

function LayersBlock({ layers }: { layers: Record<string, import("@/lib/engine/types").LayerPayload> }) {
  const available: string[] = [
    ...LAYER_ORDER.filter((n) => layers[n]?.data_b64),
    ...Object.keys(layers).filter((n) => !LAYER_ORDER.includes(n as (typeof LAYER_ORDER)[number]) && layers[n]?.data_b64),
  ];
  const [active, setActive] = useState<string | null>(available[0] ?? null);
  const layer = active ? layers[active] : null;
  return (
    <section id="adv-layers" aria-labelledby="adv-layers-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-layers-h" kicker="05" title="Evidence rasters" />
      {!available.length ? (
        <EmptyPanel title="No rasters on this verdict">
          The pipeline emits displacement / threshold / detected (and residual when a forward model
          ran) layers — this verdict carried none.
        </EmptyPanel>
      ) : (
        <Panel className="overflow-hidden">
          <PanelHead
            title="Layer viewer"
            right={
              <div className="flex flex-wrap items-center gap-1.5">
                {available.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setActive(n)}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                      active === n
                        ? "border-[var(--qp-red)]/60 bg-[var(--qp-red)]/10 text-[var(--qp-red)]"
                        : "border-[var(--qp-edge-2)] text-[var(--qp-ink-2)] hover:text-[var(--qp-ink)]",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            }
          />
          <div className="p-4 sm:p-5">
            {layer ? <LayerViewer layer={layer} /> : null}
          </div>
          <div className="grid gap-3 border-t border-[var(--qp-edge)] px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
            {available.map((n) => (
              <Readout
                key={n}
                label={n}
                value={
                  layers[n].bounds_lonlat
                    ? `bounds W${layers[n].bounds_lonlat![0].toFixed(2)} S${layers[n].bounds_lonlat![1].toFixed(2)} E${layers[n].bounds_lonlat![2].toFixed(2)} N${layers[n].bounds_lonlat![3].toFixed(2)}`
                    : "no bounds"
                }
              />
            ))}
          </div>
        </Panel>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* re-run                                                               */
/* ------------------------------------------------------------------ */

const PARAM_DEFS: { key: keyof EqParamsDict; label: string; min: number; max: number; step: number; def: number; unit: string }[] = [
  { key: "coherence_threshold", label: "Coherence threshold", min: 0, max: 1, step: 0.05, def: 0.5, unit: "—" },
  { key: "significance_k", label: "Significance k (σ)", min: 1, max: 6, step: 0.5, def: 3, unit: "σ" },
  { key: "detection_floor_m", label: "Detection floor", min: 0.001, max: 0.2, step: 0.001, def: 0.01, unit: "m" },
  { key: "far_field_margin", label: "Far-field margin", min: 0.02, max: 0.4, step: 0.02, def: 0.12, unit: "—" },
];

function RerunBlock({
  bundleId,
  target,
  onTarget,
  onRunId,
}: {
  bundleId: string | null;
  target: Target | null;
  onTarget: (t: Target) => void;
  onRunId: (id: string | null) => void;
}) {
  const startRun = useStartRun();
  const [params, setParams] = useState<Record<string, number>>(() =>
    Object.fromEntries(PARAM_DEFS.map((p) => [p.key, p.def])),
  );
  const [newRunId, setNewRunId] = useState<string | null>(null);
  const newRun = useRun(newRunId);
  void target;
  void onTarget;

  return (
    <section id="adv-rerun" aria-labelledby="adv-rerun-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-rerun-h" kicker="06" title="Re-run with parameters" />
      <Panel className="p-5 sm:p-6">
        <div className="flex items-center gap-2.5">
          <RefreshCw className="h-4 w-4 text-[var(--qp-red)]" aria-hidden />
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-2)]">
            The engine&apos;s own parameter surface
          </p>
        </div>
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
          POST /api/runs re-runs the earthquake pipeline on the stored bundle with different
          parameters — the four the engine&apos;s API accepts. The bundle on disk is never
          modified; overrides ride the run request and land in the result&apos;s{" "}
          <Mono>detail.params</Mono> for audit.
        </p>
        {!bundleId ? (
          <div className="mt-5">
            <EmptyPanel title="No bundle to re-run">
              A re-run needs a stored bundle — finish a scan first (or select a verdict that has
              one).
            </EmptyPanel>
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-x-10 gap-y-5 sm:grid-cols-2">
              {PARAM_DEFS.map((p) => (
                <div key={String(p.key)}>
                  <div className="flex items-baseline justify-between">
                    <label htmlFor={`param-${String(p.key)}`} className="text-[11px] uppercase tracking-[0.16em] text-[var(--qp-ink-2)]">
                      {p.label}
                    </label>
                    <Mono className="text-[var(--qp-ink)]">
                      {params[String(p.key)]}
                      {p.unit === "σ" ? " σ" : p.unit === "m" ? " m" : ""}
                    </Mono>
                  </div>
                  <input
                    id={`param-${String(p.key)}`}
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={params[String(p.key)]}
                    onChange={(e) => setParams((cur) => ({ ...cur, [String(p.key)]: Number.parseFloat(e.target.value) }))}
                    className="mt-2 w-full accent-[var(--qp-red)]"
                  />
                  <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)]">
                    range [{p.min}, {p.max}] · default {p.def}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <PrimaryPill
                disabled={startRun.isPending || (newRun.data?.status === "running")}
                onClick={() =>
                  startRun.mutate(
                    { bundleId: bundleId as string, pipelines: ["earthquake_coseismic"], params },
                    {
                      onSuccess: (r) => {
                        setNewRunId(r.run_id);
                        onRunId(r.run_id);
                      },
                    },
                  )
                }
              >
                {startRun.isPending || newRun.data?.status === "running" || newRun.data?.status === "queued" ? (
                  <>
                    <Spinner className="border-[var(--qp-ink)]/25" />
                    Re-running…
                  </>
                ) : (
                  <>
                    <Activity className="h-4 w-4" aria-hidden />
                    Re-run earthquake pipeline
                  </>
                )}
              </PrimaryPill>
              <Mono>bundle {bundleId.slice(0, 18)}…</Mono>
            </div>
            {startRun.isError ? (
              <div className="mt-4">
                <ErrorPanel title="The re-run could not start" message={startRun.error.message} />
              </div>
            ) : null}
            {newRun.data ? (
              <div className="mt-5 border-t border-[var(--qp-edge)] pt-4">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Readout label="New run" value={newRun.data.id} />
                  <Readout label="Status" value={newRun.data.status} />
                  <Readout label="Stage" value={String((newRun.data.progress as { stage?: string })?.stage ?? "—")} />
                  <Readout
                    label="Result"
                    value={
                      newRun.data.results.find((r) => r.pipeline === "earthquake_coseismic")?.status ?? "—"
                    }
                  />
                </div>
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* browser: runs · verdicts · bundles                                   */
/* ------------------------------------------------------------------ */

function BrowserBlock({
  runId,
  onRunId,
  onTarget,
  verdict,
}: {
  runId: string | null;
  onRunId: (id: string | null) => void;
  onTarget: (t: Target) => void;
  verdict: ReturnType<typeof useQuakeVerdict>;
}) {
  const runs = useRuns(true);
  const tiles = useTiles();
  const bundles = useBundles();
  const [tileFilter, setTileFilter] = useState<string | null>(null);
  const tileVerdicts = useTilesVerdictsAdapter(tileFilter);
  void verdict;

  return (
    <section id="adj-browser" aria-labelledby="adj-browser-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adj-browser-h" kicker="07" title="Runs · verdicts · bundles" />
      <Panel className="overflow-hidden">
        <PanelHead title="Run history" right={runs.isFetching ? <Spinner /> : <Chip>{runs.data?.runs.length ?? 0}</Chip>} />
        {(runs.data?.runs.length ?? 0) === 0 ? (
          <div className="px-5 py-5">
            <Mono>no runs recorded by this engine process</Mono>
          </div>
        ) : (
          <ul className="max-h-72 divide-y divide-[var(--qp-edge)] overflow-y-auto">
            {(runs.data?.runs ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onRunId(r.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left font-mono text-[11px] transition-colors",
                    r.id === runId ? "bg-[var(--qp-red)]/[0.06] text-[var(--qp-ink)]" : "text-[var(--qp-ink-2)] hover:bg-[var(--qp-paper-3)]",
                  )}
                >
                  <span
                    className={cn(
                      "block h-1.5 w-1.5 shrink-0 rounded-full",
                      r.status === "ok" ? "bg-[#3ecf9a]" : r.status === "error" ? "bg-[#ff5d55]" : "bg-[#e8b74e] animate-pulse",
                    )}
                    aria-hidden
                  />
                  <span className="w-44 shrink-0 truncate">{r.id}</span>
                  <span className="w-16 shrink-0 text-[var(--qp-ink-2)]">{r.kind ?? "bundle"}</span>
                  <span className="w-24 shrink-0 truncate text-[var(--qp-ink-2)]">{r.tile || "—"}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--qp-ink-2)]">{r.bundle_id || "—"}</span>
                  <span className="shrink-0 text-[var(--qp-ink-2)]">{r.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHead
          title="Verdict store (verdicts.db)"
          right={tiles.isFetching ? <Spinner /> : <Chip>{tiles.data?.tiles.length ?? 0} tiles</Chip>}
        />
        {(tiles.data?.tiles.length ?? 0) === 0 ? (
          <div className="px-5 py-5">
            <Mono>the canonical verdict store is still empty</Mono>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--qp-edge)]">
            {(tiles.data?.tiles ?? []).map((t) => (
              <li key={t.tile} className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => setTileFilter(t.tile === tileFilter ? null : t.tile)}
                  className="flex w-full items-center gap-3 text-left"
                >
                  <span className="w-24 shrink-0 font-mono text-[11px] text-[var(--qp-ink)]">{t.tile}</span>
                  <Chip>{t.n_verdicts} verdicts</Chip>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--qp-ink-3)]">
                    {t.latest
                      .map((v) => `${v.pipeline}:${v.status}`)
                      .slice(0, 4)
                      .join(" · ")}
                  </span>
                </button>
                {tileFilter === t.tile ? (
                  <div className="mt-3 space-y-2 border-l border-[var(--qp-edge-2)] pl-4">
                    {(tileVerdicts.data?.verdicts ?? []).map((v, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          onRunId(v.run_id ?? null);
                          /* restore the target from the engine's own tile
                             geometry (GET /api/tile-at?tile=…) so the map,
                             coverage and hero all follow the stored verdict */
                          api
                            .tileAtId(t.tile)
                            .then((r) =>
                              onTarget({
                                lon: r.tile.center_lonlat[0],
                                lat: r.tile.center_lonlat[1],
                                label: `tile ${t.tile}`,
                                source: "custom",
                              }),
                            )
                            .catch(() => undefined);
                        }}
                        className="block w-full text-left font-mono text-[10px] leading-relaxed text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-ink)]"
                      >
                        {v.pipeline} · {v.status} · tier {v.tier ?? "—"} · raw_p{" "}
                        {v.raw_p === null || v.raw_p === undefined ? "—" : v.raw_p.toFixed(3)} ·{" "}
                        {fmtDate(v.written_at)} · run {v.run_id ?? "—"}
                        {v.summary ? (
                          <span className="mt-0.5 block text-[var(--qp-ink-3)]">“{v.summary}”</span>
                        ) : null}
                      </button>
                    ))}
                    {tileVerdicts.isPending ? <Mono>reading verdicts…</Mono> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHead title="Bundle store" right={bundles.isFetching ? <Spinner /> : <Chip>{bundles.data?.bundles.length ?? 0}</Chip>} />
        {(bundles.data?.bundles.length ?? 0) === 0 ? (
          <div className="px-5 py-5">
            <Mono>no scene bundles ingested yet</Mono>
          </div>
        ) : (
          <ul className="max-h-72 divide-y divide-[var(--qp-edge)] overflow-y-auto">
            {(bundles.data?.bundles ?? []).map((b) => (
              <li key={b.bundle_id} className="flex items-center gap-3 px-4 py-3 font-mono text-[10px] text-[var(--qp-ink-2)]">
                <span className="min-w-0 flex-1 truncate">{b.bundle_id}</span>
                <span className="w-24 shrink-0 truncate text-[var(--qp-ink-2)]">{b.tile ?? "—"}</span>
                <span className="shrink-0 text-[var(--qp-ink-2)]">{b.created_at ? fmtDate(b.created_at) : "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

/** small adapter so the tile-verdict query can live inside the browser block */
function useTilesVerdictsAdapter(tileId: string | null) {
  return useTileVerdicts(tileId);
}

/* ------------------------------------------------------------------ */
/* engine internals                                                     */
/* ------------------------------------------------------------------ */

function EngineBlock() {
  const health = useEngineHealth();
  const pipelines = usePipelines();
  const eq = pipelines.data?.pipelines.find((p) => p.name === "earthquake_coseismic");
  const h = health.data;
  return (
    <section id="adv-engine" aria-labelledby="adv-engine-h" className="scroll-mt-36 space-y-6">
      <SubHead id="adv-engine-h" kicker="08" title="Engine internals" />
      <Panel className="overflow-hidden">
        <PanelHead
          title="GET /api/health"
          right={
            <Chip tone={health.isError ? "off" : h?.ok ? "ok" : "mid"}>
              {health.isError ? "offline" : h?.ok ? "online" : "probing"}
            </Chip>
          }
        />
        {h ? (
          <KeyValue
            rows={[
              { k: "Data dir", v: h.data_dir, mono: true },
              { k: "Bundles dir", v: `${h.bundles_dir}${h.bundles_dir_exists ? "" : " (missing)"}`, mono: true },
              { k: "Scans", v: h.scans_enabled ? "enabled" : "disabled", mono: true },
              { k: "Earthdata credentials", v: h.earthdata_credentials ?? "—", mono: true },
              { k: "Granule search", v: `${h.granule_search?.status ?? "—"}${h.granule_search?.reason ? ` — ${h.granule_search.reason}` : ""}`, mono: false },
              { k: "Cache write", v: `${h.cache_write?.status ?? "—"}${h.cache_write?.reason ? ` — ${h.cache_write.reason}` : ""}`, mono: false },
              { k: "Busy", v: h.busy ? `${h.busy.kind} ${h.busy.run_id ?? ""} (${String(h.busy.step ?? "")})` : "idle", mono: false },
              { k: "Note", v: h.note, mono: false },
            ]}
          />
        ) : health.isError ? (
          <div className="p-4">
            <ErrorPanel message={health.error.message} onRetry={() => health.refetch()} />
          </div>
        ) : (
          <div className="px-5 py-5">
            <Mono>probing…</Mono>
          </div>
        )}
      </Panel>

      {eq ? (
        <Panel className="overflow-hidden">
          <PanelHead title="earthquake_coseismic manifest" right={<Chip tone="ok">implemented</Chip>} />
          <KeyValue
            rows={[
              { k: "Code", v: eq.code, mono: true },
              { k: "Sensor", v: eq.sensor, mono: true },
              { k: "Applies", v: eq.applies, mono: false },
              { k: "Execution", v: eq.execution ?? "—", mono: true },
              { k: "Min epochs", v: eq.min_epochs === null ? "—" : String(eq.min_epochs), mono: true },
              { k: "Status values", v: eq.status_values.join(" · "), mono: false },
              { k: "Uses", v: eq.uses_codes.join(", "), mono: true },
              { k: "Fetches", v: eq.fetch_codes.join(", "), mono: true },
            ]}
          />
        </Panel>
      ) : null}

      <Panel className="px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Satellite className="h-3.5 w-3.5 text-[var(--qp-ink-3)]" aria-hidden />
          <Mono>references the pipeline itself cites are listed in the Overview&apos;s evidence section</Mono>
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <BookOpen className="h-3.5 w-3.5 text-[var(--qp-ink-3)]" aria-hidden />
          <Mono>LOS convention: + = toward the sensor (later − earlier)</Mono>
        </div>
      </Panel>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* shared bits                                                          */
/* ------------------------------------------------------------------ */

function SubHead({ id, kicker, title }: { id: string; kicker: string; title: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <span className="stage-number">{kicker}</span>
      <h2 id={id} className="font-display text-2xl font-light text-[var(--qp-ink)] sm:text-3xl">
        {title}
      </h2>
    </div>
  );
}

"use client";

/** Chapter IV — the verdict. THE main result of the page.
 *
 *  The one short sentence is the engine's own `summary` field, verbatim —
 *  written by engine/pipelines/earthquake_coseismic/verdict.py's _headline,
 *  which is deliberately plain language ("Possible coseismic signal — up to
 *  27 mm across 12.4 km²…", "Nothing above threshold in the analysed
 *  window…", "Not enough usable data…"). The page never rewords it, never
 *  upgrades its certainty, and never invents a number it didn't send. */

import { useMemo } from "react";
import { AlertTriangle, FileSearch, Quote } from "lucide-react";
import { QuakeSection, Panel, PanelHead, TierBadge, StampBadge, Chip, Mono, KeyValue, EmptyPanel, Spinner } from "../ui";
import { useQuakeVerdict } from "../useVerdict";
import { evidenceText, fmtArea, fmtDate, fmtMm, fmtNum, mainSentence, toneOf, TONE_TEXT, type Target } from "../shared";
import type { EvidenceItem } from "@/lib/engine/types";
import { cn } from "@/components/quake/utils";

const LEVEL_TONE: Record<string, string> = {
  decision: "text-[var(--qp-red)] border-[var(--qp-red)]/30",
  corroboration: "text-[#3ecf9a] border-[#3ecf9a]/25",
  caveat: "text-[#e8b74e] border-[#e8b74e]/25",
  info: "text-[var(--qp-ink-2)] border-[var(--qp-edge-2)]",
  insufficient: "text-[#ff5d55] border-[#ff5d55]/25",
};

export default function VerdictSection({
  target,
  runId,
  onGoto,
}: {
  target: Target | null;
  runId: string | null;
  onGoto: (anchor: string) => void;
}) {
  const verdict = useQuakeVerdict(target, runId);
  const res = verdict.result;
  const running = verdict.runStatus === "queued" || verdict.runStatus === "running";

  /* key numbers — read verbatim from the engine's evidence/diagnostics */
  const stats = useMemo(() => {
    if (!res) return [];
    const ev = res.evidence ?? [];
    const det = ev.find((e) => e.id === "detection.summary" || e.id === "detection.null");
    const support = (det?.support ?? {}) as Record<string, unknown>;
    const detail = res.detail ?? {};
    const pairs = detail.pairs_analysed ?? [];
    const selected = pairs.find((p) => p.selected) ?? pairs[0];
    const out: { label: string; value: string; hint?: string }[] = [];
    if (typeof support.affected_area_km2 === "number")
      out.push({ label: "Affected area", value: fmtArea(support.affected_area_km2 as number) });
    if (typeof support.max_toward_mm === "number")
      out.push({ label: "Largest toward", value: `${fmtNum(support.max_toward_mm as number, 1)} mm` });
    if (typeof support.max_away_mm === "number")
      out.push({ label: "Largest away", value: `${fmtNum(Math.abs(support.max_away_mm as number), 1)} mm` });
    if (typeof support.clusters === "number")
      out.push({ label: "Clusters", value: fmtNum(support.clusters as number) });
    if (selected?.detected_pixels !== undefined)
      out.push({ label: "Detected pixels", value: fmtNum(selected.detected_pixels) });
    if (detail.events_considered)
      out.push({ label: "Events considered", value: fmtNum(detail.events_considered.length) });
    const pair = detail.inputs?.selected_pair;
    if (pair?.ref_time && pair?.sec_time)
      out.push({
        label: "Pair analysed",
        value: `${fmtDate(pair.ref_time)} → ${fmtDate(pair.sec_time)}`,
      });
    return out;
  }, [res]);

  /* the honest data-availability caveat, only when the engine itself said so */
  const routingBlock = useMemo(() => {
    if (!res) return null;
    const routing = res.detail?.routing;
    const reasons = routing?.reasons ?? [];
    if (!reasons.length) return null;
    return reasons.map(String);
  }, [res]);

  return (
    <QuakeSection
      id="verdict"
      channel="05"
      kicker="the verdict"
      title="What did the analysis find?"
      body="One sentence, in the engine's own words. Its tier, its meaning and every supporting claim sit right underneath — the same hierarchy a reviewer of the pipeline would ask for."
    >
      {/* ---------------- working ---------------- */}
      {running ? (
        <Panel className="flex items-center gap-4 px-6 py-8">
          <Spinner className="h-4 w-4" />
          <div>
            <p className="text-sm text-[var(--qp-ink)]">The engine is still working on this tile.</p>
            <Mono>run {runId} · retrieval → preprocessing → pipelines → verdicts</Mono>
          </div>
        </Panel>
      ) : null}

      {/* ---------------- no verdict yet ---------------- */}
      {!res && !running ? (
        verdict.runStatus === "error" ? (
          <Panel className="border-[#ff5d55]/25 bg-[#ff5d55]/[0.04] px-6 py-8">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#ff5d55]">
              The run failed
            </p>
            <p className="mt-2 font-mono text-[12px] leading-relaxed text-[var(--qp-ink-2)]">
              {verdict.runError}
            </p>
          </Panel>
        ) : (
          <EmptyPanel title={target ? "No verdict for this tile yet" : "Waiting for a target"}>
            {target ? (
              <>
                Nothing has been filed for this tile&apos;s earthquakes in the engine&apos;s
                verdict store, and no finished run is selected. Launch a scan above — or select a
                recent run from the history — and the verdict will appear here the moment the
                engine settles.
              </>
            ) : (
              <>Choose an earthquake first; the verdict follows the target.</>
            )}
          </EmptyPanel>
        )
      ) : null}

      {/* ---------------- the verdict ---------------- */}
      {res ? (
        <div className="flex flex-col gap-6">
          {/* THE sentence — on its own lit stage, the seal beside it */}
          <Panel className="qp-verdict-hero relative overflow-hidden px-6 py-8 sm:px-10 sm:py-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <TierBadge result={res} />
                <Mono className="mt-2 block">
                  {verdict.origin === "run" ? `run ${verdict.runId}` : `stored verdict · ${fmtDate(verdict.stored?.written_at)}`}
                  {" · "}
                  {res.pipeline}
                </Mono>
              </div>
              <StampBadge result={res} />
            </div>
            <Quote className="mt-6 h-5 w-5 text-[var(--qp-red)]/60" aria-hidden />
            <p
              className={cn(
                "mt-3 font-display text-2xl font-normal leading-[1.25] text-[var(--qp-ink)] sm:text-3xl lg:text-[2.4rem]",
              )}
            >
              {mainSentence(res)}
            </p>

            {/* what the tier means — the engine's own words */}
            {res.detail?.status_meaning ? (
              <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
                <span className="text-[var(--qp-ink-3)]">What this tier means: </span>
                {String(res.detail.status_meaning)}
              </p>
            ) : null}
            {res.raw_p !== null && res.raw_p !== undefined ? (
              <p className="mt-3 font-mono text-[11px] tracking-[0.04em] text-[var(--qp-ink-3)]">
                raw_p {res.raw_p.toFixed(3)} — {res.detail?.raw_p_meaning ?? "an uncalibrated within-tier rank score, not a probability."}
              </p>
            ) : null}
          </Panel>

          {/* key numbers — real values only, absent stays absent */}
          {stats.length ? (
            <div data-stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {stats.map((s) => (
                <Panel key={s.label} className="px-4 py-3.5" as="div">
                  <p className="text-[9px] font-medium uppercase tracking-[0.22em] text-[var(--qp-ink-3)]">
                    {s.label}
                  </p>
                  <p className="mt-1.5 font-mono text-[15px] tracking-[0.02em] text-[var(--qp-ink)]/90">
                    {s.value}
                  </p>
                </Panel>
              ))}
            </div>
          ) : null}

          {/* why the pipeline did not run — verbatim, plus the honest context */}
          {routingBlock && res.status === "NOT_RUN" ? (
            <Panel className="border-[#e8b74e]/25 bg-[#e8b74e]/[0.04] px-5 py-5">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-4 w-4 text-[#e8b74e]" aria-hidden />
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#e8b74e]">
                  The pipeline did not run — and says exactly why
                </p>
              </div>
              <ul className="mt-3 space-y-1.5">
                {routingBlock.map((r, i) => (
                  <li key={i} className="font-mono text-[12px] leading-relaxed text-[var(--qp-ink)]">
                    · {r}
                  </li>
                ))}
              </ul>
              <p className="mt-4 max-w-3xl text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
                In plain words: the retrieval step delivered no usable radar arrays for this tile,
                so the earthquake screen had nothing to measure. When the satellite listing above
                shows products exist but nothing arrives, the gap is between the catalogue and the
                download — an availability or credentials limitation of the deployment, not a
                property of the algorithm: with byte-authorized credentials the same scan runs
                end-to-end and this panel is replaced by the verdict above.
              </p>
            </Panel>
          ) : null}

          {/* key findings — the engine's evidence, one card per claim */}
          <Panel className="overflow-hidden">
            <PanelHead
              title="Key findings · the engine's evidence"
              right={<Chip>{res.evidence?.length ?? 0} claims</Chip>}
            />
            {(res.evidence?.length ?? 0) === 0 ? (
              <div className="px-5 py-6">
                <Mono>this verdict carries no evidence items</Mono>
              </div>
            ) : (
              <ul className="max-h-[30rem] divide-y divide-[var(--qp-edge)] overflow-y-auto">
                {(res.evidence ?? []).map((ev: EvidenceItem, i) => (
                  <li key={ev.id ?? i} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
                          LEVEL_TONE[ev.level ?? "info"] ?? LEVEL_TONE.info,
                        )}
                      >
                        {[ev.level ?? "info", ev.kind].filter(Boolean).join(" · ")}
                      </span>
                      {ev.source_ref ? (
                        <Mono className="truncate">via {String(ev.source_ref)}</Mono>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-[var(--qp-ink)]">{evidenceText(ev)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* narrative reliability line + warnings */}
          {res.detail?.narrative?.reliability ? (
            <Panel className="px-5 py-4">
              <p className="text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
                <span className="text-[var(--qp-ink-3)]">Reliability context: </span>
                {String(res.detail.narrative.reliability)}
              </p>
            </Panel>
          ) : null}
          {res.warnings?.length ? (
            <Panel className="px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-3)]">
                Warnings ({res.warnings.length})
              </p>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                {res.warnings.map((w, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-[#e8b74e]/85">
                    · {w}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {/* deeper context for non-technical readers */}
          {res.status !== "NOT_RUN" ? (
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => onGoto("map")}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--qp-ink)]/30 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--qp-ink)] transition-colors hover:border-[var(--qp-red)] hover:text-[var(--qp-ink)]"
              >
                <FileSearch className="h-3.5 w-3.5" aria-hidden />
                See it on the map
              </button>
              <Mono className={TONE_TEXT[toneOf(res)]}>
                evidence tiers, never probabilities — calibration needs labelled histories the
                archive does not have yet
              </Mono>
            </div>
          ) : null}

          {/* decision metadata for reviewers */}
          {res.detail?.decision?.rule ? (
            <Panel className="overflow-hidden">
              <PanelHead title="Decision trace" right={<Chip tone="accent">{String(res.detail.decision.rule)}</Chip>} />
              <KeyValue
                rows={Object.entries(res.detail.decision)
                  .filter(([k]) => k !== "rule")
                  .map(([k, v]) => ({
                    k,
                    v: typeof v === "number" ? String(v) : v === null ? "—" : String(Array.isArray(v) ? v.join("; ") : v),
                    mono: true,
                  }))}
              />
            </Panel>
          ) : null}
        </div>
      ) : null}
    </QuakeSection>
  );
}

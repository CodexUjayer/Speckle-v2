"use client";

/** Chapter VI — the evidence trail. Where every input came from: the
 *  interferograms actually used (stack, pair, granule ids), the external
 *  records with their provenance entries, the bundle's data depth, the
 *  assumptions the engine recorded, and the scientific references the
 *  pipeline cites. All strings verbatim from the engine. */

import { AlertTriangle, BookOpen, Database, Link2, Layers } from "lucide-react";
import { QuakeSection, Panel, PanelHead, Chip, Mono, EmptyPanel, KeyValue, LoadingPanel } from "../ui";
import { useQuakeVerdict } from "../useVerdict";
import { useBundle } from "@/components/quake/engineHooks";
import { fmtDateTime, fmtNum, type Target } from "../shared";
import type { Source } from "@/lib/engine/types";

export default function EvidenceSection({ target, runId }: { target: Target | null; runId: string | null }) {
  const verdict = useQuakeVerdict(target, runId);
  const res = verdict.result;
  const bundle = useBundle(res?.bundle_id ?? verdict.stored?.bundle_id ?? null);

  const provenance = ((res as unknown as { provenance?: Source[] })?.provenance ?? []) as Source[];
  const inputs = res?.detail?.inputs;
  const selectedPair = inputs?.selected_pair;
  const granuleIds = selectedPair?.granule_ids ?? [];

  return (
    <QuakeSection
      id="evidence"
      channel="07"
      kicker="data & evidence"
      title="Where the answer came from."
      body="The engine records its own evidence chain: which interferograms entered the verdict, which catalogue records it read, what it assumed, and which physics it cites. Nothing on this page quotes a source the engine did not declare."
    >
      {!res ? (
        <EmptyPanel title="No verdict to trace yet">
          Run a scan (or select a past run) and this section fills with the exact inputs behind the
          answer — granules, catalog events, assumptions and references.
        </EmptyPanel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ---------------- what the verdict used ---------------- */}
          <Panel className="overflow-hidden">
            <PanelHead
              title="Inputs the verdict used"
              right={<Chip tone="accent">{inputs?.mode === "scan" ? "scan mode" : inputs?.mode === "event" ? "event mode" : "—"}</Chip>}
            />
            {selectedPair ? (
              <KeyValue
                rows={[
                  { k: "Stack", v: selectedPair.stack ?? "—", mono: true },
                  { k: "Pair index", v: selectedPair.pair_index ?? "—", mono: true },
                  { k: "Reference", v: fmtDateTime(selectedPair.ref_time ?? null), mono: true },
                  { k: "Secondary", v: fmtDateTime(selectedPair.sec_time ?? null), mono: true },
                  ...(inputs?.window?.text ? [{ k: "Window analysed", v: String(inputs.window.text), mono: false }] : []),
                  ...(inputs?.stacks?.note ? [{ k: "Stacks", v: String(inputs.stacks.note), mono: false }] : []),
                  ...(inputs?.listing?.complete === false
                    ? [{ k: "Listing", v: "incomplete — see caveats in the verdict", mono: false }]
                    : []),
                ]}
              />
            ) : (
              <div className="px-5 py-4">
                <Mono>the pipeline did not reach pair selection on this tile</Mono>
              </div>
            )}
            {granuleIds.length ? (
              <div className="border-t border-[var(--qp-edge)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <Layers className="h-3.5 w-3.5 text-[var(--qp-red)]" aria-hidden />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">
                    Granules in the verdict
                  </p>
                </div>
                <ul className="mt-2.5 space-y-1">
                  {granuleIds.map((gid) => (
                    <li key={gid} className="break-all font-mono text-[10px] leading-relaxed text-[var(--qp-ink-2)]">
                      {gid}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {inputs?.pair_selection && (inputs.pair_selection.dropped_by_cap_total ?? 0) > 0 ? (
              <div className="border-t border-[var(--qp-edge)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-[var(--qp-ink-3)]" aria-hidden />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">
                    Pairs listed but not retrieved (newest-N cap)
                  </p>
                </div>
                <ul className="mt-2.5 space-y-1">
                  {Object.entries(inputs.pair_selection.per_stack ?? {}).map(([stack, sel]) => (
                    <li key={stack} className="font-mono text-[10px] leading-relaxed text-[var(--qp-ink-2)]">
                      {stack}: {sel.listed ?? "?"} listed → {sel.available ?? "?"} unique → newest{" "}
                      {sel.cap ?? "?"} retrieved · {sel.dropped_by_cap?.length ?? 0} dropped
                      {sel.merged_duplicates?.length ? ` · ${sel.merged_duplicates.length} variant(s) merged` : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--qp-ink-3)]">
                  {inputs.pair_selection.dropped_by_cap_total} pair(s) never entered this verdict — the
                  engine analyses only the newest few pairs per stack (bandwidth cap) and says so.
                </p>
              </div>
            ) : null}
            {res.data_used?.length ? (
              <div className="border-t border-[var(--qp-edge)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <Database className="h-3.5 w-3.5 text-[var(--qp-red)]" aria-hidden />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">
                    Data used (engine's own lines)
                  </p>
                </div>
                <ul className="mt-2.5 space-y-1.5">
                  {res.data_used.map((d, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-[var(--qp-ink-2)]">
                      · {d}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          {/* ---------------- provenance + references ---------------- */}
          <div className="flex flex-col gap-6">
            <Panel className="overflow-hidden">
              <PanelHead
                title="External records read"
                right={<Chip>{provenance.length}</Chip>}
              />
              {provenance.length ? (
                <ul className="divide-y divide-[var(--qp-edge)]">
                  {provenance.map((p, i) => (
                    <li key={i} className="px-5 py-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone="accent">{p.adapter}</Chip>
                        <Mono className="truncate">{fmtDateTime(p.retrieved_at || null)}</Mono>
                      </div>
                      {p.url_or_id ? (
                        <p className="mt-1.5 flex items-center gap-1.5 break-all font-mono text-[10px] text-[var(--qp-ink-2)]">
                          <Link2 className="h-3 w-3 shrink-0" aria-hidden />
                          {p.url_or_id}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-5 py-4">
                  <Mono>this verdict declared no external provenance entries</Mono>
                </div>
              )}
            </Panel>

            <Panel className="overflow-hidden">
              <PanelHead title="The bundle behind it" right={bundle.isFetching ? <Chip>loading…</Chip> : <Chip tone="dim">content-addressed</Chip>} />
              {res.bundle_id || verdict.stored?.bundle_id ? (
                bundle.isPending ? (
                  <LoadingPanel label="Reading bundle metadata" />
                ) : bundle.data ? (
                  <KeyValue
                    rows={[
                      { k: "Bundle", v: bundle.data.bundle.bundle_id, mono: true },
                      {
                        k: "GUNW pairs stored",
                        v: fmtNum(bundle.data.bundle.depth?.n_gunw_pairs ?? null),
                        mono: true,
                      },
                      {
                        k: "GUNW dates",
                        v: fmtNum(bundle.data.bundle.depth?.n_gunw_dates ?? null),
                        mono: true,
                      },
                      {
                        k: "GCOV epochs",
                        v: fmtNum(bundle.data.bundle.depth?.n_gcov_epochs ?? null),
                        mono: true,
                      },
                      {
                        k: "Cold start",
                        v: bundle.data.bundle.depth?.cold_start ? "yes — short history" : "no",
                        mono: true,
                      },
                      ...(bundle.data.bundle.flags?.length
                        ? [{ k: "Flags", v: bundle.data.bundle.flags.join(", "), mono: true }]
                        : []),
                    ]}
                  />
                ) : (
                  <div className="px-5 py-4">
                    <Mono>bundle metadata unavailable</Mono>
                  </div>
                )
              ) : (
                <div className="px-5 py-4">
                  <Mono>no bundle recorded for this verdict</Mono>
                </div>
              )}
            </Panel>

            <Panel className="overflow-hidden">
              <PanelHead title="Science the pipeline cites" right={<BookOpen className="h-3.5 w-3.5 text-[var(--qp-ink-3)]" aria-hidden />} />
              {res.references_used?.length ? (
                <ul className="divide-y divide-[var(--qp-edge)]">
                  {res.references_used.map((r, i) => (
                    <li key={i} className="px-5 py-3 text-[12px] leading-relaxed text-[var(--qp-ink-2)]">
                      · {r}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-5 py-4">
                  <Mono>no references recorded on this verdict</Mono>
                </div>
              )}
            </Panel>

            {inputs?.assumptions && Object.keys(inputs.assumptions).length ? (
              <Panel className="overflow-hidden">
                <PanelHead title="Assumptions recorded" />
                <KeyValue
                  rows={Object.entries(inputs.assumptions).map(([k, v]) => ({
                    k,
                    v: typeof v === "object" ? JSON.stringify(v) : String(v),
                    mono: true,
                  }))}
                />
              </Panel>
            ) : null}
          </div>
        </div>
      )}
    </QuakeSection>
  );
}

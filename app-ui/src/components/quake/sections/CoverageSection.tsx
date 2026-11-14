"use client";

/** Chapter II — what the satellite actually saw over the target.
 *  Tile resolution and granule availability are BOTH engine answers
 *  (GET /api/tile-at, GET /api/granules — a live ASF search with the
 *  server-side Earthdata credentials). The timeline chart renders only
 *  the engine's own listing fields. */

import { AlertTriangle } from "lucide-react";
import { QuakeSection, Panel, PanelHead, LoadingPanel, ErrorPanel, EmptyPanel, KeyValue, Chip, Mono } from "../ui";
import { useGranules, useTileAt } from "@/components/quake/engineHooks";
import CoverageTimeline from "../charts/CoverageTimeline";
import { fmtDate, type Target } from "../shared";

export default function CoverageSection({ target }: { target: Target | null }) {
  const tile = useTileAt(target?.lon ?? null, target?.lat ?? null);
  const granules = useGranules(target?.lon ?? null, target?.lat ?? null, !!target);

  const g = granules.data;
  const stacks = g ? Object.entries(g.stacks ?? {}) : [];
  const nGunw = stacks.reduce((a, [, s]) => a + (s.gunw?.length ?? 0), 0);
  const nGcov = stacks.reduce((a, [, s]) => a + (s.gcov?.length ?? 0), 0);

  return (
    <QuakeSection
      id="coverage"
      channel="02"
      kicker="the archive answers"
      title="What did the satellite see?"
      body="The engine resolves your point to its 10 km MGRS radar tile and asks ASF — live, with its server-side Earthdata credentials — which NISAR interferometric products cover that tile. This is the raw observation inventory the earthquake pipeline will draw from."
    >
      {!target ? (
        <EmptyPanel title="Waiting for a target">
          Choose an earthquake above — the tile and its satellite coverage follow the target
          automatically.
        </EmptyPanel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* ---------------- the tile ---------------- */}
          <div className="flex flex-col gap-6">
            {tile.isPending ? (
              <LoadingPanel label="Resolving the MGRS tile" />
            ) : tile.isError ? (
              <ErrorPanel title="The tile could not be resolved" message={tile.error.message} onRetry={() => tile.refetch()} />
            ) : tile.data ? (
              <Panel>
                <PanelHead title="The radar tile" right={<Chip tone="accent">engine-resolved</Chip>} />
                <KeyValue
                  rows={[
                    { k: "MGRS tile", v: tile.data.tile.id, mono: true },
                    { k: "Size", v: `${(tile.data.tile.size_m / 1000).toFixed(0)} × ${(tile.data.tile.size_m / 1000).toFixed(0)} km`, mono: true },
                    { k: "Projection", v: `EPSG:${tile.data.tile.epsg}`, mono: true },
                    { k: "Centre", v: `${tile.data.tile.center_lonlat[1].toFixed(3)}°, ${tile.data.tile.center_lonlat[0].toFixed(3)}°`, mono: true },
                    {
                      k: "Corners",
                      v: (
                        <span className="font-mono text-[12px]">
                          W {tile.data.tile.bbox_lonlat[0].toFixed(2)} · S {tile.data.tile.bbox_lonlat[1].toFixed(2)} · E{" "}
                          {tile.data.tile.bbox_lonlat[2].toFixed(2)} · N {tile.data.tile.bbox_lonlat[3].toFixed(2)}
                        </span>
                      ),
                    },
                  ]}
                />
              </Panel>
            ) : null}

            {g ? (
              <Panel>
                <PanelHead title="Listing honesty" right={<Chip tone={g.search_degraded || g.search_incomplete ? "mid" : "ok"}>{g.search_degraded || g.search_incomplete ? "caveats" : "clean"}</Chip>} />
                <KeyValue
                  rows={[
                    { k: "Search window", v: `${fmtDate(g.window.t0)} → ${fmtDate(g.window.t1)}`, mono: true },
                    { k: "Stacks", v: `${stacks.length}`, mono: true },
                    { k: "Interferometric pairs", v: `${nGunw}`, mono: true },
                    { k: "Backscatter epochs", v: `${nGcov}`, mono: true },
                    { k: "Dropped (older)", v: `${g.dropped_older}`, mono: true },
                    ...(g.search_incomplete
                      ? [{ k: "Listing", v: "incomplete — ASF served a short page even after retrying; some granules may be missing (not cached)", mono: false }]
                      : []),
                    ...Object.entries(g.search_errors ?? {}).map(([prod, err]) => ({
                      k: `Search error (${prod})`,
                      v: String(err),
                      mono: true,
                    })),
                    ...(g.flags ?? []).slice(0, 4).map((f) => ({
                      k: `Flag ${f.code}`,
                      v: f.message,
                      mono: false,
                    })),
                  ]}
                />
              </Panel>
            ) : null}
          </div>

          {/* ---------------- the coverage timeline ---------------- */}
          <div className="min-w-0">
            {granules.isPending ? (
              <LoadingPanel label="Searching ASF for NISAR coverage (live)" />
            ) : granules.isError ? (
              <ErrorPanel
                title="The granule search failed"
                message={granules.error.message}
                hint="The engine searches ASF with the Earthdata credentials configured server-side (EARTHDATA_TOKEN)."
                onRetry={() => granules.refetch()}
              />
            ) : g && stacks.length === 0 ? (
              <EmptyPanel title="No SAR products listed for this tile">
                The ASF search returned no NISAR GUNW/GCOV products for this tile in the engine&apos;s
                lookback window. A scan here will honestly report insufficient data — that is a
                real answer, not a failure.
              </EmptyPanel>
            ) : g ? (
              <Panel className="overflow-hidden">
                <PanelHead
                  title="Observation coverage · engine's ASF listing"
                  right={<Chip tone="ok">live metadata</Chip>}
                />
                <div className="overflow-x-auto p-4 sm:p-5">
                  <CoverageTimeline data={g} />
                </div>
                <div className="border-t border-[var(--qp-edge)] px-5 py-3.5">
                  <Mono>
                    bars = interferometric pairs (ref → secondary acquisition) · dots = GCOV
                    backscatter epochs · search window {fmtDate(g.window.t0)} → {fmtDate(g.window.t1)}
                  </Mono>
                </div>
              </Panel>
            ) : null}

            {g && g.gcov_note ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-[var(--qp-edge)] bg-[var(--qp-paper-3)]/60 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--qp-ink-3)]" aria-hidden />
                <p className="text-[13px] leading-relaxed text-[var(--qp-ink-2)]">{g.gcov_note}</p>
              </div>
            ) : null}

            {g && (g.search_degraded || g.search_incomplete) ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-[#d9a13f]/25 bg-[#d9a13f]/[0.05] px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#d9a13f]" aria-hidden />
                <p className="text-[13px] leading-relaxed text-[var(--qp-ink-2)]">
                  The engine flagged this listing{g.search_degraded ? " as degraded" : ""}
                  {g.search_incomplete ? " as incomplete" : ""}. Downstream verdicts carry the same
                  caveat — a quiet answer on an incomplete listing is downgraded to insufficient
                  evidence by the engine itself.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </QuakeSection>
  );
}

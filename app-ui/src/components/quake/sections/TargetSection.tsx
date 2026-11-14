"use client";

/** Chapter I — choose the earthquake to investigate.
 *  The live feed is the engine's own /api/events (USGS ComCat via the R1
 *  adapter, ±0.5° around a region centre). The curated list is the
 *  repository's own disasters dataset (Earthquake category). Selecting a
 *  target only sets coordinates — the engine does everything else. */

import { useMemo, useState } from "react";
import { ArrowRight, Crosshair, Search } from "lucide-react";
import { QuakeSection, Panel, PanelHead, PrimaryPill, GhostPill, Spinner, ErrorPanel, EmptyPanel, Chip } from "../ui";
import { useEvents } from "@/components/quake/engineHooks";
import { CURATED_QUAKES, REGIONS, fmtDate, fmtDepth, fmtMagnitude, type Target } from "../shared";
import { cn } from "@/components/quake/utils";

const MAG_OPTIONS = [4.0, 4.5, 5.0, 5.5, 6.0];
const DAY_OPTIONS = [30, 90, 180, 365];

export default function TargetSection({
  target,
  onTarget,
}: {
  target: Target | null;
  onTarget: (t: Target) => void;
}) {
  const [regionId, setRegionId] = useState(REGIONS[0].id);
  const [minMag, setMinMag] = useState(4.5);
  const [days, setDays] = useState(180);
  const [customLat, setCustomLat] = useState("");
  const [customLon, setCustomLon] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const region = REGIONS.find((r) => r.id === regionId) ?? REGIONS[0];
  const events = useEvents(region.lon, region.lat, days, minMag);

  const sorted = useMemo(() => {
    const list = [...(events.data?.events ?? [])];
    list.sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
    return list;
  }, [events.data]);

  const applyCustom = () => {
    const lat = Number.parseFloat(customLat);
    const lon = Number.parseFloat(customLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || lon < -180 || lon > 180) {
      setCustomError("Give a latitude in [-85, 85] and a longitude in [-180, 180].");
      return;
    }
    setCustomError(null);
    onTarget({
      lon,
      lat,
      label: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      source: "custom",
    });
  };

  return (
    <QuakeSection
      id="target"
      channel="01"
      kicker="choose the event"
      title="Which earthquake should we interrogate?"
      body="The engine pulls live earthquake context from the USGS ComCat catalogue through its own event adapter — the same feed its pipeline uses. Pick one, or point it at any coordinates. The scan will analyse the 10 km radar tile that contains your point."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- live feed ---------------- */}
        <Panel className="flex flex-col overflow-hidden">
          <PanelHead
            title="Live catalogue · USGS ComCat via the engine"
            right={
              events.isFetching ? <Spinner /> : <Chip tone="ok">live</Chip>
            }
          />
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--qp-edge)] px-4 py-3">
            <label className="sr-only" htmlFor="region">
              Region
            </label>
            <select
              id="region"
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
              className="h-9 min-w-36 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 text-[12px] text-[var(--qp-ink)] outline-none transition-colors focus:border-[var(--qp-red)]"
            >
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Minimum magnitude"
              value={minMag}
              onChange={(e) => setMinMag(Number.parseFloat(e.target.value))}
              className="h-9 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 text-[12px] text-[var(--qp-ink)] outline-none transition-colors focus:border-[var(--qp-red)]"
            >
              {MAG_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  M ≥ {m.toFixed(1)}
                </option>
              ))}
            </select>
            <select
              aria-label="Lookback window in days"
              value={days}
              onChange={(e) => setDays(Number.parseInt(e.target.value, 10))}
              className="h-9 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 text-[12px] text-[var(--qp-ink)] outline-none transition-colors focus:border-[var(--qp-red)]"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  last {d} days
                </option>
              ))}
            </select>
          </div>

          <div className="px-4 pt-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
              events within ±0.5° of {region.label} · {sorted.length} found
              {events.data?.source ? ` · source: ${events.data.source}` : ""}
            </p>
          </div>

          <div className="min-h-24">
            {events.isPending ? (
              <div className="flex items-center gap-3 px-5 py-8">
                <Spinner />
                <span className="font-mono text-[11px] tracking-[0.08em] text-[var(--qp-ink-2)]">
                  asking ComCat through the engine…
                </span>
              </div>
            ) : events.isError ? (
              <div className="p-4">
                <ErrorPanel
                  title="The catalogue could not be reached"
                  message={events.error.message}
                  onRetry={() => events.refetch()}
                />
              </div>
            ) : sorted.length === 0 ? (
              <div className="p-4">
                <EmptyPanel title="No events in this window">
                  No earthquake above the chosen magnitude inside this region box in the last {days}{" "}
                  days. Widen the window, lower the magnitude, or try another region.
                </EmptyPanel>
              </div>
            ) : (
              <ul className="max-h-[26rem] divide-y divide-[var(--qp-edge)] overflow-y-auto">
                {sorted.map((ev) => {
                  const active = target?.source === "live" && target.event?.id === ev.id;
                  return (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() =>
                          onTarget({
                            lon: ev.lon,
                            lat: ev.lat,
                            label: ev.place || ev.id,
                            source: "live",
                            event: ev,
                          })
                        }
                        aria-pressed={active}
                        className={cn(
                          "flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors",
                          active ? "bg-[var(--qp-red)]/[0.06]" : "hover:bg-[var(--qp-paper-3)]",
                        )}
                      >
                        <span
                          className={cn(
                            "shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] tracking-[0.04em]",
                            (ev.magnitude ?? 0) >= 6
                              ? "border-[#ff5d55]/40 text-[#ff5d55]"
                              : (ev.magnitude ?? 0) >= 5
                                ? "border-[#e8b74e]/40 text-[#e8b74e]"
                                : "border-[var(--qp-edge-2)] text-[var(--qp-ink-2)]",
                          )}
                        >
                          {fmtMagnitude(ev.magnitude)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-[var(--qp-ink)]">
                            {ev.place || "—"}
                          </span>
                          <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--qp-ink-3)]">
                            {fmtDate(ev.time)} · {fmtDepth(ev.depth_km)} · {ev.id}
                          </span>
                        </span>
                        {active ? (
                          <Chip tone="accent">selected</Chip>
                        ) : (
                          <ArrowRight
                            className="h-4 w-4 shrink-0 text-[var(--qp-ink-3)] transition-colors group-hover:text-[var(--qp-red)]"
                            aria-hidden
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>

        {/* ---------------- curated + custom ---------------- */}
        <div className="flex flex-col gap-6">
          <Panel className="overflow-hidden">
            <PanelHead
              title="The project's curated earthquakes"
              right={<Chip>repo dataset</Chip>}
            />
            <p className="px-5 pt-4 text-xs leading-relaxed text-[var(--qp-ink-2)]">
              Twenty-three earthquakes from the repository&apos;s own disasters dataset (post-NISAR-launch
              list, Wikipedia-sourced) — the events the team uses for exactly this investigation.
            </p>
            <ul className="max-h-[19rem] divide-y divide-[var(--qp-edge)] overflow-y-auto">
              {CURATED_QUAKES.map((q) => {
                const active = target?.source === "curated" && target.curated?.id === q.id;
                return (
                  <li key={q.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onTarget({
                          lon: q.lon,
                          lat: q.lat,
                          label: q.event,
                          source: "curated",
                          curated: q,
                        })
                      }
                      aria-pressed={active}
                      className={cn(
                        "flex w-full items-center gap-4 px-5 py-3 text-left transition-colors",
                        active ? "bg-[var(--qp-red)]/[0.06]" : "hover:bg-[var(--qp-paper-3)]",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-[var(--qp-ink)]">{q.event}</span>
                        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--qp-ink-3)]">
                          {q.region} · {q.dateText} · {q.size}
                        </span>
                      </span>
                      {active ? <Chip tone="accent">selected</Chip> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel className="p-5">
            <div className="flex items-center gap-2.5">
              <Crosshair className="h-4 w-4 text-[var(--qp-red)]" aria-hidden />
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-2)]">
                Any coordinates
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="custom-lat"
                  className="mb-1.5 block text-[10px] uppercase tracking-[0.2em] text-[var(--qp-ink-3)]"
                >
                  Latitude
                </label>
                <input
                  id="custom-lat"
                  value={customLat}
                  onChange={(e) => setCustomLat(e.target.value)}
                  placeholder="35.70"
                  inputMode="decimal"
                  className="h-10 w-28 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 font-mono text-[13px] text-[var(--qp-ink)] outline-none transition-colors placeholder:text-[var(--qp-ink-3)] focus:border-[var(--qp-red)]"
                />
              </div>
              <div>
                <label
                  htmlFor="custom-lon"
                  className="mb-1.5 block text-[10px] uppercase tracking-[0.2em] text-[var(--qp-ink-3)]"
                >
                  Longitude
                </label>
                <input
                  id="custom-lon"
                  value={customLon}
                  onChange={(e) => setCustomLon(e.target.value)}
                  placeholder="140.71"
                  inputMode="decimal"
                  className="h-10 w-28 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)] px-3 font-mono text-[13px] text-[var(--qp-ink)] outline-none transition-colors placeholder:text-[var(--qp-ink-3)] focus:border-[var(--qp-red)]"
                />
              </div>
              <GhostPill onClick={applyCustom} className="px-5 py-3">
                <Search className="h-3.5 w-3.5" aria-hidden />
                Point here
              </GhostPill>
            </div>
            {customError ? (
              <p className="mt-3 text-xs text-[#ff5d55]">{customError}</p>
            ) : null}
          </Panel>
        </div>
      </div>

      {/* ---------------- the selected target ---------------- */}
      {target ? (
        <Panel className="mt-6 border-[var(--qp-red)]/25 bg-[var(--qp-red)]/[0.04] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--qp-red)]">Investigation target</p>
              <p className="mt-2 font-display text-2xl font-light text-[var(--qp-ink)]">{target.label}</p>
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--qp-ink-2)]">
                {target.lat.toFixed(3)}°, {target.lon.toFixed(3)}° · source:{" "}
                {target.source === "live"
                  ? `USGS ComCat ${target.event?.id ?? ""}`
                  : target.source === "curated"
                    ? "repository curated list"
                    : "manual coordinates"}
              </p>
              {target.event ? (
                <p className="mt-1.5 text-[13px] text-[var(--qp-ink-2)]">
                  {fmtMagnitude(target.event.magnitude)} · {fmtDepth(target.event.depth_km)} ·{" "}
                  {fmtDate(target.event.time)}
                </p>
              ) : null}
              {target.curated ? (
                <p className="mt-1.5 text-[13px] text-[var(--qp-ink-2)]">
                  {target.curated.size} · {target.curated.dateText}
                </p>
              ) : null}
            </div>
            <a
              href="#coverage"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("coverage")?.scrollIntoView({ behavior: "smooth" });
              }}
              className="qp-readout group inline-flex min-h-11 items-center gap-2.5 rounded-full border border-[var(--qp-edge-2)] bg-[var(--qp-paper-3)]/60 px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--qp-ink)] transition-all duration-300 hover:border-[var(--qp-red)]/60 hover:text-[var(--qp-red-2)]"
            >
              What did the satellite see
              <ArrowRight
                className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
                aria-hidden
              />
            </a>
          </div>
        </Panel>
      ) : (
        <Panel className="mt-6 p-5">
          <p className="text-sm leading-relaxed text-[var(--qp-ink-2)]">
            No target yet. The sections below wake up the moment you choose one — coverage,
            analysis and verdict all follow the target.
          </p>
        </Panel>
      )}
    </QuakeSection>
  );
}

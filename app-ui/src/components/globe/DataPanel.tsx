"use client";

/** DataPanel (§7.5) — the fourth tab: granule availability for the selected tile. LIVE-ENGINE-ONLY
 *  (DEC5): granule search is not cached in Supabase, so offline it says so plainly. Read-only
 *  discovery: it never triggers a scan. Loading/empty/error states follow the honesty rules. */
import BigLoader from "@/components/BigLoader";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useEngineUrl } from "@/lib/engineUrl";
import { retrievalHref, saveQueryContext, toDateOnly } from "@/lib/queryContext";
import type { GranulesState } from "@/lib/useGranules";
import type { TimelinePicks } from "@/lib/useTimelinePicks";
import GranuleTimeline, { selectionFromPath } from "./GranuleTimeline";
import GranuleDetail from "./GranuleDetail";
import MapSarControl from "./MapSarControl";
import MapPairDifferences from "./MapPairDifferences";
import MapRunArrays from "./MapRunArrays";
import type { OverlaySpec } from "./GlobeMap";

export interface DataPanelProps {
  /** pairs the verdict analysed (★ = the one it is based on), drawn on the timeline */
  verdictUse?: { stack: string; ref_time: string; sec_time: string; selected: boolean }[];
  tileId: string | null;
  /** the engine's bbox for the pinned tile (west, south, east, north) — the area this tab searches */
  tileBbox?: [number, number, number, number] | null;
  lon: number | null;
  lat: number | null;
  engineOnline: boolean;
  credentials: "present" | "absent" | undefined;
  granuleSearchStatus: "enabled" | "disabled" | undefined;
  granuleSearchReason: string | null | undefined;
  onFootprintOnMap: (ring: [number, number][] | null, fit?: boolean) => void;
  /** a georeferenced SAR image of the selected granule, drawn by the map (null = remove) */
  onSarOverlay?: (o: OverlaySpec | null) => void;
  /** the granule listing and the picked dots, shared with the verdict dock (lifted to the globe app) */
  granules: GranulesState;
  picks: TimelinePicks;
  /** draw the timeline inside this panel (phones). On desktop the verdict dock draws it. */
  inlineTimeline: boolean;
  /** "See why" is playing its own differences: do not start a second set for the same two dots */
  suppressPairDiff?: boolean;
}

export default function DataPanel(props: DataPanelProps) {
  const engineUrl = useEngineUrl();
  const { data, error, loading } = props.granules;
  const { selection, selectionB, picked } = props.picks;

  // ---- the search area + window, made visible and editable --------------------------------------
  // The per-tile search is fixed by the ENGINE to the pin's MGRS tile (config/tiling.yaml
  // cell_size_m) over its default lookback window (config/common.yaml window.lookback_days). That
  // was invisible before. These fields show it, let the user change it, and hand the (possibly
  // edited) box to Data retrieval, which is the screen that searches arbitrary boxes.
  const [area, setArea] = useState({ w: "", s: "", e: "", n: "", from: "", to: "" });
  const bboxSig = props.tileBbox ? props.tileBbox.join(",") : "";
  useEffect(() => {
    if (!props.tileBbox) return;
    const [w, s, e, n] = props.tileBbox;
    const r = (v: number) => String(Number(v.toFixed(4)));
    setArea((a) => ({ ...a, w: r(w), s: r(s), e: r(e), n: r(n) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxSig]);

  // the window the engine actually used (default lookback, or the timeline's visible range)
  const winFrom = toDateOnly(data?.window.t0);
  const winTo = toDateOnly(data?.window.t1);
  useEffect(() => {
    if (!winFrom || !winTo) return;
    setArea((a) => ({ ...a, from: winFrom, to: winTo }));
    saveQueryContext({ from: winFrom, to: winTo });   // Background shows the same window
  }, [winFrom, winTo]);

  const areaCheck = useMemo(() => {
    const [w, s, e, n] = [area.w, area.s, area.e, area.n].map((v) => (v.trim() === "" ? NaN : Number(v)));
    if (![w, s, e, n].every(Number.isFinite)) return { ok: false as const, msg: "enter all four edges (decimal degrees)" };
    if (w < -180 || e > 180 || s < -90 || n > 90) return { ok: false as const, msg: "edges outside the valid range" };
    if (w > e) return { ok: false as const, msg: "west is east of east (antimeridian) — split the box at ±180" };
    if (s >= n) return { ok: false as const, msg: "south must be below north" };
    if (area.from && area.to && area.from >= area.to) return { ok: false as const, msg: "From must be before To" };
    return { ok: true as const, bbox: [w, s, e, n] as [number, number, number, number] };
  }, [area]);

  const retrievalLink = areaCheck.ok
    ? retrievalHref({
        bbox: areaCheck.bbox, tile: props.tileId ?? undefined, level: "GUNW,GCOV",
        from: area.from || undefined, to: area.to || undefined,
      })
    : null;

  if (!props.engineOnline) {
    return (
      <div className="p-3 text-xs">
        <p role="status" className="rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[#7a6438]">
          the engine is offline — granule availability needs it (this tab is live-engine-only and
          is never cached, so it will not show stale data).
        </p>
        <p className="mono mt-2 text-[10px] text-[#8a837b]">engine: {engineUrl}</p>
      </div>
    );
  }
  if (props.granuleSearchStatus === "disabled") {
    return (
      <div className="p-3 text-xs">
        <p role="status" className="rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[#7a6438]">
          {props.granuleSearchReason ?? "granule search is disabled on this engine"}
        </p>
      </div>
    );
  }
  if (!props.tileId) {
    return (
      <div className="p-3 text-xs text-[#8a837b]">
        pick a place on the globe (or a cached pin) to see how much SAR data exists there — every
        acquisition, grouped by orbit track and direction, on a real time-scaled timeline.
      </div>
    );
  }
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Data — granule availability · tile {props.tileId}</h3>
      </div>
      <p className="text-[11px] text-[#8a837b]">
        every acquisition the engine can see, grouped exactly the way it groups them (stack =
        direction + track). read-only: this panel never fetches or processes data — Scan does that.
      </p>
      {loading && !data && (
        <div className="space-y-2" aria-busy="true">
          <BigLoader size="lg" testId="data-loading"
                     title="Looking for SAR data over this tile…"
                     hint="Asking NASA's catalogue which acquisitions exist here. This is only a search — nothing is downloaded yet." />
          <div className="skeleton h-16 rounded-lg" />
        </div>
      )}
      {error && (
        <p role="alert" className="mono rounded-lg border border-[#9e3b2c] bg-[#fbf3ef] px-3 py-2 text-[11px] text-[#9e3b2c]">
          {error}
        </p>
      )}
      {data && (
        <>
          {(data.search_degraded || data.search_incomplete) && (
            <p role="status" className="rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[11px] text-[#7a6438]">
              {data.search_incomplete ? "Heads-up: NASA's catalogue returned a slightly short list even after a retry, so a granule or two may be missing from the timeline. The details are in the technical notes below." : "Heads-up: the search was degraded, so the timeline may be missing some acquisitions. The details are in the technical notes below."}
            </p>
          )}
          {props.inlineTimeline && (
            <GranuleTimeline
              verdictUse={props.verdictUse}
              data={data}
              selection={selection}
              selectionB={selectionB}
              onSelect={props.picks.onSelect}
              onWindowChange={props.granules.setWindow}
            />
          )}
          {Object.keys(data.search_errors).length > 0 && (
            <div className="rounded-lg border border-[#b08d57]/40 bg-[#f7f2e7] px-3 py-2 text-[11px] text-[#7a6438]">
              {Object.entries(data.search_errors).map(([prod, reason]) => (
                <p key={prod} className="mono">{prod}: {reason}</p>
              ))}
            </div>
          )}
          {data.flags.length > 0 && (
            <details className="rounded-lg border border-[#e7e2da] bg-[#faf9f6] px-3 py-1.5 text-[10px] text-[#8a837b]">
              <summary className="cursor-pointer select-none text-[11px] font-medium text-[#4a443c]">
                Technical notes from the search ({data.flags.length}) — click to read
              </summary>
              <ul className="mt-1 space-y-1">
                {data.flags.map((f, i) => (
                  <li key={i} className="mono">{f.message}</li>
                ))}
              </ul>
            </details>
          )}
          {picked && !props.suppressPairDiff ? (
            <MapPairDifferences
              key={`${picked.a.id}|${picked.b.id}`}
              pair={picked}
              bbox={props.tileBbox ?? null}
              onOverlay={props.onSarOverlay ?? (() => undefined)}
              onClose={props.picks.clear}
            />
          ) : (
            <GranuleDetail
              data={data}
              selection={selection}
              onFootprintOnMap={props.onFootprintOnMap}
            />
          )}
          {!picked && (() => {
            const sel = selectionFromPath(data, selection);
            const gid = sel ? (sel.kind === "gunw" ? sel.pair.granule_ids[0] : sel.epoch.granule_ids[0]) : null;
            return gid && props.onSarOverlay
              ? <MapSarControl key={gid} granuleId={gid} bbox={props.tileBbox ?? null} onOverlay={props.onSarOverlay} />
              : null;
          })()}
          {props.onSarOverlay && props.tileBbox && (
            <MapRunArrays bbox={props.tileBbox} tileId={props.tileId} onOverlay={props.onSarOverlay} />
          )}
        </>
      )}
      {!loading && !data && !error && (
        <BigLoader size="md" title="Loading granule availability…" />
      )}
      {/* the search form sits BELOW the selected acquisition's details: this panel is the details view, so what you
          just clicked on the timeline (and its SAR switch) is the first thing you see, not something below a form */}
      <fieldset className="rounded-lg border border-[#e7e2da] bg-white px-3 py-2">
        <legend className="px-1 text-[11px] font-medium text-[#4a443c]">Search area &amp; window</legend>
        <p className="text-[10px] text-[#8a837b]">
          this tab searches the pinned tile&apos;s box (the engine fixes it to the tile around your pin)
          over the engine&apos;s default lookback window. Edit the box or dates and open it in Data
          retrieval to search any area.
        </p>
        <div className="mt-1.5 grid grid-cols-4 gap-1.5">
          {([["w", "West"], ["s", "South"], ["e", "East"], ["n", "North"]] as const).map(([k, label]) => (
            <label key={k} className="text-[10px] text-[#8a837b]">
              {label}
              <input suppressHydrationWarning
                inputMode="decimal"
                value={area[k]}
                onChange={(ev) => setArea((a) => ({ ...a, [k]: ev.target.value }))}
                className="mono mt-0.5 w-full rounded border border-[#e7e2da] px-1.5 py-1 text-[11px] text-[#1c1a17]"
              />
            </label>
          ))}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {([["from", "From (UTC)"], ["to", "To (UTC)"]] as const).map(([k, label]) => (
            <label key={k} className="text-[10px] text-[#8a837b]">
              {label}
              <input suppressHydrationWarning
                type="date"
                value={area[k]}
                onChange={(ev) => setArea((a) => ({ ...a, [k]: ev.target.value }))}
                className="mono mt-0.5 w-full rounded border border-[#e7e2da] px-1.5 py-1 text-[11px] text-[#1c1a17]"
              />
            </label>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {retrievalLink ? (
            <Link
              href={retrievalLink}
              onClick={() => areaCheck.ok && saveQueryContext({
                bbox: areaCheck.bbox, level: "GUNW,GCOV",
                from: area.from || undefined, to: area.to || undefined,
              })}
              className="rounded-md bg-[#2c5f58] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#37736a]"
            >
              Search this box in Data retrieval →
            </Link>
          ) : (
            <span className="rounded-md bg-[#e7e2da] px-2.5 py-1 text-[11px] font-medium text-[#8a837b]">
              Search this box in Data retrieval →
            </span>
          )}
          {props.tileBbox && (
            <button
              type="button"
              onClick={() => {
                const [w, s, e, n] = props.tileBbox as [number, number, number, number];
                const r = (v: number) => String(Number(v.toFixed(4)));
                setArea((a) => ({ ...a, w: r(w), s: r(s), e: r(e), n: r(n) }));
              }}
              className="text-[11px] text-[#4a443c] underline"
            >
              reset to tile
            </button>
          )}
        </div>
        {!areaCheck.ok && <p role="status" className="mt-1 text-[10px] text-[#9e3b2c]">{areaCheck.msg}</p>}
      </fieldset>
    </div>
  );
}

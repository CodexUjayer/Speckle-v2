"use client";

/** PairDifferences — pick TWO dots on the timeline and every difference the engine can make between them
 *  appears at once, on the existing footprint map. No separate workspace.
 *
 *  What it does: loads both acquisitions' layer inventories, takes the layers they share, and for each the
 *  engine says are differenceable (inventory `diff_modes[mode].valid`) it asks the engine for that
 *  difference as a small picture. One tile per (layer, mode); click a tile and it is drawn large on the map.
 *  GCOV pairs: dB difference + power ratio per backscatter layer. GUNW pairs: coherence difference and
 *  line-of-sight displacement (m / mm) difference.
 *
 *  Thin client, same rule as the rest of the Explorer: nothing here subtracts, converts units or decides
 *  validity. The tile list mirrors the engine's own per-layer verdicts; the pictures, colours, units, gap and
 *  referencing notes come from the engine; its 422 text is shown verbatim. Tiles load one at a time (the
 *  engine serves one preview read at a time) and the one on the map is asked for first. */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { bg } from "@/lib/bg";
import { loadExplain } from "@/lib/explainCache";
import { fmtUtc, previewLegend } from "@/lib/format";
import type { ExplainPayload, ExplorerGranule, GranuleDetailResponse, PreviewMeta } from "@/lib/types";
import { diffFetch, useSarImage } from "./useSarImage";
import type { SarOverlay } from "./FootprintMiniMap";

const FootprintMap = dynamic(() => import("./FootprintMiniMap"), {
  ssr: false,
  loading: () => <p className="p-3 text-[11px] text-[#8b949e]">footprint map…</p>,
});

type Inv = NonNullable<GranuleDetailResponse["inventory"]>;
type InvLayer = Inv["grids"][number]["layers"][number];

/** short display names only; the engine's own mode_label replaces these once a tile has loaded */
const MODE_FALLBACK: Record<string, string> = {
  db_diff: "dB difference",
  ratio: "power ratio",
  coh_diff: "coherence difference",
  los_m: "line-of-sight, metres",
  los_mm: "line-of-sight, millimetres",
};

interface Tile { id: string; layerKey: string; layerLabel: string; mode: string }
interface Thumb { status: "wait" | "busy" | "ok" | "err"; url?: string; meta?: PreviewMeta; message?: string }

const layersOf = (inv: Inv | null | undefined): InvLayer[] =>
  (inv?.grids ?? []).flatMap((g) => g.layers).filter((l) => l.previewable);

const timeOf = (g: ExplorerGranule) => {
  const t = Date.parse(g.start ?? g.sec_time ?? g.ref_time ?? "");
  return Number.isFinite(t) ? t : 0;
};

export default function PairDifferences({ a: ga, b: gb, bbox, stackGranules, onClose }: {
  a: ExplorerGranule;
  b: ExplorerGranule;
  bbox: [number, number, number, number] | null;
  stackGranules: ExplorerGranule[];
  onClose: () => void;
}) {
  // earlier = first date, later = second (the engine states "later minus earlier" itself)
  const [first, second] = useMemo(() => (timeOf(ga) <= timeOf(gb) ? [ga, gb] : [gb, ga]), [ga, gb]);
  const mismatch = first.product !== second.product
    ? `one is a ${first.product ?? "?"} and the other a ${second.product ?? "?"} — differences need two of the same product`
    : first.stack !== second.stack
      ? `these two are in different stacks (${first.stack} vs ${second.stack}) — pick two dots from the same row`
      : first.id === second.id ? "the same acquisition twice is a zero difference — pick a different second dot" : null;

  // ---- both inventories ----------------------------------------------------------------------------------
  const [invs, setInvs] = useState<{ a: Inv | null; b: Inv | null } | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  useEffect(() => {
    setInvs(null);
    setInvError(null);
    if (mismatch) return;
    const ctrl = new AbortController();
    Promise.all([bg.granule(first.id, ctrl.signal), bg.granule(second.id, ctrl.signal)])
      .then(([x, y]) => { if (!ctrl.signal.aborted) setInvs({ a: x.inventory ?? null, b: y.inventory ?? null }); })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setInvError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [first.id, second.id, mismatch]);

  // ---- every (layer, mode) the engine says is valid, over layers both dates carry ---------------------------
  const { tiles, undefinedCount } = useMemo(() => {
    const out: Tile[] = [];
    let none = 0;
    if (!invs) return { tiles: out, undefinedCount: 0 };
    const inB = new Set(layersOf(invs.b).map((l) => l.key));
    for (const l of layersOf(invs.a)) {
      if (!inB.has(l.key)) continue;
      const modes = Object.entries(l.diff_modes ?? {}).filter(([, v]) => v.valid).map(([m]) => m);
      if (modes.length === 0) { none += 1; continue; }
      for (const m of modes) {
        out.push({ id: `${l.key}::${m}`, layerKey: l.key, layerLabel: l.path.split("/").slice(-3).join("/"), mode: m });
      }
    }
    return { tiles: out, undefinedCount: none };
  }, [invs]);

  const [selId, setSelId] = useState("");
  useEffect(() => { setSelId(tiles[0]?.id ?? ""); }, [tiles]);
  const sel = tiles.find((t) => t.id === selId) ?? tiles[0] ?? null;

  // ---- thumbnails: one at a time, the selected tile first ------------------------------------------------------
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const tilesKey = tiles.map((t) => t.id).join("|");
  const firstTileId = tiles[0]?.id ?? "";
  const bboxKey = bbox ? bbox.join(",") : "";
  useEffect(() => {
    setThumbs({});
    if (!bbox || tiles.length === 0) return;
    const ctrl = new AbortController();
    const urls: string[] = [];
    const order = [...tiles].sort((x, y) => (x.id === firstTileId ? -1 : 0) - (y.id === firstTileId ? -1 : 0));
    setThumbs(Object.fromEntries(order.map((t) => [t.id, { status: "wait" } as Thumb])));
    (async () => {
      for (const t of order) {
        if (ctrl.signal.aborted) return;
        setThumbs((s) => ({ ...s, [t.id]: { status: "busy" } }));
        try {
          const { blob, meta } = await bg.diffBlob({
            idA: first.id, idB: second.id, layer: t.layerKey, west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3],
            maxPx: 160, mode: t.mode, cmap: "auto", patient: true,
          }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (!blob) { setThumbs((s) => ({ ...s, [t.id]: { status: "err", meta, message: "the engine returned no picture" } })); continue; }
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setThumbs((s) => ({ ...s, [t.id]: { status: "ok", url, meta } }));
        } catch (err) {
          if (ctrl.signal.aborted) return;
          setThumbs((s) => ({ ...s, [t.id]: { status: "err", message: err instanceof Error ? err.message : String(err) } }));
        }
      }
    })();
    return () => { ctrl.abort(); urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.id, second.id, tilesKey, bboxKey]);

  // ---- the chosen difference, large, on the map ----------------------------------------------------------------
  const [opacity, setOpacity] = useState(0.85);
  const big = useSarImage({
    enabled: !!sel && !mismatch,
    granuleId: `${first.id}|${second.id}`, layerKey: sel?.layerKey ?? "", bbox, maxPx: 512,
    scale: sel?.mode, cmap: "auto", fetcher: diffFetch as never,
  });
  const overlay: SarOverlay | null = big.url && big.corners ? { url: big.url, corners: big.corners, opacity } : null;

  const [explain, setExplain] = useState<ExplainPayload | null>(null);
  useEffect(() => { loadExplain().then(setExplain).catch(() => setExplain(null)); }, []);
  const teach = sel ? explain?.diff_modes?.[sel.mode] : undefined;
  const diff = big.meta?.diff;

  const modeName = (t: Tile) => thumbs[t.id]?.meta?.diff?.mode_label ?? MODE_FALLBACK[t.mode] ?? t.mode;
  const waiting = !invs && !invError && !mismatch;

  return (
    <div className="p-3 text-xs" data-testid="pair-differences">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium text-[#7fd8e6]">Differences between two dates</p>
          <p className="mt-0.5 font-mono text-[10px] text-[#aab3bd]">
            {fmtUtc(first.start ?? first.sec_time ?? first.ref_time ?? null)} → {fmtUtc(second.start ?? second.sec_time ?? second.ref_time ?? null)}
            {diff ? ` · gap ${diff.gap_days} d` : ""}
          </p>
          <p className="mt-0.5 text-[10px] text-[#5a636e]">{first.product} · {first.stack} · later minus earlier · times UTC</p>
        </div>
        <button type="button" onClick={onClose} aria-label="clear the two selected dots"
                className="rounded p-1 text-[#8b949e] hover:bg-[#1c222b] hover:text-[#e6eaee]">
          <X size={13} aria-hidden />
        </button>
      </div>

      {mismatch && <p role="alert" className="rounded border border-[#4a2f24] bg-[#2a1712] p-2 text-[10px] text-[#e8a087]">{mismatch}</p>}
      {invError && <p role="alert" className="rounded border border-[#4a2f24] bg-[#2a1712] p-2 text-[10px] text-[#e8a087]">{invError}</p>}
      {waiting && <p role="status" className="text-[10px] text-[#8b949e]">asking the engine which differences exist for these two…</p>}

      {!mismatch && (
        <div className="overflow-hidden rounded-md border border-[#262c36]">
          <FootprintMap
            bbox={bbox}
            stackRings={stackGranules.map((g) => ({ id: g.id, ring: g.footprint }))}
            selectedId={second.id}
            overlay={overlay}
          />
        </div>
      )}

      {invs && tiles.length === 0 && !mismatch && (
        <p role="status" className="mt-2 rounded border border-[#262c36] bg-[#12161d] p-2 text-[10px] text-[#8b949e]">
          the engine defines no difference for any layer these two share
          {undefinedCount > 0 ? ` (${undefinedCount} previewable layer(s), none differenceable)` : ""}.
        </p>
      )}

      {tiles.length > 0 && (
        <>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-[#8b949e]">
            <span>{tiles.length} difference{tiles.length === 1 ? "" : "s"} — click one to put it on the map</span>
            <label className="ml-auto flex items-center gap-1">opacity
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
          </div>
          <ul className="mt-1 grid grid-cols-2 gap-2" aria-label="all differences for this pair">
            {tiles.map((t) => {
              const th = thumbs[t.id];
              const on = sel?.id === t.id;
              return (
                <li key={t.id}>
                  <button type="button" aria-pressed={on} onClick={() => setSelId(t.id)} title={th?.message ?? t.layerKey}
                          className={`w-full rounded border p-1 text-left ${on ? "border-[#e6c977] bg-[#2a2212]" : "border-[#262c36] bg-[#0e1116] hover:border-[#4a5462]"}`}>
                    <div className="flex h-20 items-center justify-center overflow-hidden rounded bg-[#0b0e13]">
                      {th?.status === "ok" && th.url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={th.url} alt={`${modeName(t)} of ${t.layerLabel}`} className="max-h-full max-w-full object-contain" />
                        : th?.status === "err"
                          ? <span className="px-1 text-[9px] text-[#e8a087]">{th.message}</span>
                          : <span className="text-[9px] text-[#5a636e]">{th?.status === "busy" ? "drawing…" : "queued"}</span>}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-[#e6c977]">{t.mode}</p>
                    <p className="truncate text-[9.5px] text-[#aab3bd]">{modeName(t)}</p>
                    <p className="truncate font-mono text-[9px] text-[#5a636e]">{t.layerLabel}</p>
                  </button>
                </li>
              );
            })}
          </ul>
          {undefinedCount > 0 && (
            <p className="mt-1 text-[10px] text-[#5a636e]">
              {undefinedCount} other shared layer(s) have no difference defined (masks, geometry, offsets…).
            </p>
          )}
        </>
      )}

      {/* the chosen one: legend, notes, teaching text — all engine-served */}
      {sel && (
        <div className="mt-2 space-y-1 rounded-md border border-[#262c36] bg-[#12161c] p-2 text-[10px] text-[#cfd6dc]">
          {big.busy && <p role="status" className="text-[#8b949e]">drawing {sel.mode}…{big.wait ? ` ${big.wait}, still trying` : ""}</p>}
          {big.message && <p role="alert" className="text-[#e8a087]">{big.message}</p>}
          {big.meta && !big.busy && !big.message && (
            <>
              <p className="font-mono text-[#8b949e]">{diff?.mode_label ? `${diff.mode_label} · ` : ""}{previewLegend(big.meta)}</p>
              {diff?.resampled && <p className="text-[#8b949e]">{diff.resampled}</p>}
              {diff?.referencing && <p className="text-[#d9c98a]">{diff.referencing.note}</p>}
              {(big.meta.notes ?? []).map((n) => <p key={n} role="note" className="text-[#e6c977]">{n}</p>)}
            </>
          )}
          {teach && (
            <div className="border-t border-[#262c36] pt-1 text-[#8b949e]">
              <p className="text-[#d9dee4]">{teach.what_it_is}</p>
              {teach.how_to_read && <p className="mt-1">how to read: {teach.how_to_read}</p>}
              {teach.misread && <p className="mt-1 text-[#d9c98a]">easy to misread: {teach.misread}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

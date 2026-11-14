"use client";

/** MapPairDifferences — the Map page's "pick two dots, see every difference" panel.
 *
 *  The person clicks a first dot (A) and a second dot (B) on the bottom timeline; DataPanel hands the two granule
 *  ids here. This asks the engine for both granules' layer inventories, keeps the layers both dates carry, and for
 *  every (layer, mode) the engine itself marks as differenceable (`diff_modes[mode].valid`) it asks for that
 *  difference as a picture. One tile per difference; the chosen tile is drawn on the globe / flat map through the
 *  same OverlaySpec the single-granule SAR control uses (corners placed by the engine).
 *
 *  Thin client, same rule as the rest of the Map: nothing here subtracts, converts a unit or decides validity.
 *  The tile list mirrors the engine's own verdicts; pictures, colours, units, gap and referencing notes are the
 *  engine's; its 422 text is shown as it came. Tiles load one at a time (the engine serves one read at a time), the
 *  chosen tile first, and a loaded tile is drawn on the map from the picture already held — no second request.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { bg } from "@/lib/bg";
import { loadExplain } from "@/lib/explainCache";
import { fmtUtc, previewLegend } from "@/lib/format";
import type { ExplainPayload, GranuleDetailResponse, PreviewMeta } from "@/lib/types";
import BigLoader, { MiniSpinner } from "@/components/BigLoader";
import type { OverlaySpec } from "./GlobeMap";

export interface PickedPair {
  kind: "gcov" | "gunw";
  stackKey: string;
  a: { id: string; time: string | null };
  b: { id: string; time: string | null };
}

type Inv = NonNullable<GranuleDetailResponse["inventory"]>;
type InvLayer = Inv["grids"][number]["layers"][number];

/** short display names only; the engine's own mode_label replaces these once a tile has loaded */
const MODE_FALLBACK: Record<string, string> = {
  db_diff: "dB difference",
  ratio: "power ratio",
  z_db: "change in speckle-noise units",
  coh_diff: "coherence difference",
  los_m: "line-of-sight, metres",
  los_mm: "line-of-sight, millimetres",
};

const MAX_PX = 512;

interface Tile { id: string; layerKey: string; layerLabel: string; mode: string }
interface Thumb { status: "wait" | "busy" | "ok" | "err"; url?: string; meta?: PreviewMeta; message?: string }

const layersOf = (inv: Inv | null | undefined): InvLayer[] =>
  (inv?.grids ?? []).flatMap((g) => g.layers).filter((l) => l.previewable);

const msOf = (iso: string | null) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
};

export default function MapPairDifferences({ pair, bbox, onOverlay, onClose }: {
  pair: PickedPair;
  bbox: [number, number, number, number] | null;
  onOverlay: (o: OverlaySpec | null) => void;
  onClose: () => void;
}) {
  // earlier = first date, later = second (the engine states "later minus earlier" itself)
  const [first, second] = useMemo(
    () => (msOf(pair.a.time) <= msOf(pair.b.time) ? [pair.a, pair.b] : [pair.b, pair.a]),
    [pair],
  );
  const mismatch = first.id === second.id
    ? "the same acquisition twice is a zero difference — pick a different second dot" : null;


  // ---- both inventories ------------------------------------------------------------------------------------
  const [invs, setInvs] = useState<{ a: Inv | null; b: Inv | null } | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  useEffect(() => {
    setInvs(null);
    setInvError(null);
    if (mismatch) return;
    const ctrl = new AbortController();
    Promise.all([bg.granule(first.id, ctrl.signal), bg.granule(second.id, ctrl.signal)])
      .then(([x, y]) => { if (!ctrl.signal.aborted) { setInvs({ a: x.inventory ?? null, b: y.inventory ?? null }); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setInvError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [first.id, second.id, mismatch]);

  // ---- every (layer, mode) the engine says is valid, over the layers both dates carry ----------------------
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
  const selRef = useRef("");
  selRef.current = sel?.id ?? "";

  // ---- the pictures: one at a time, the chosen tile always next -------------------------------------------
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const [waitWhy, setWaitWhy] = useState<string | null>(null);
  const tilesKey = tiles.map((t) => t.id).join("|");
  const bboxKey = bbox ? bbox.join(",") : "";
  useEffect(() => {
    setThumbs({});
    setWaitWhy(null);
    if (!bbox || tiles.length === 0) return;
    const box = bbox;
    const ctrl = new AbortController();
    const urls: string[] = [];
    setThumbs(Object.fromEntries(tiles.map((t) => [t.id, { status: "wait" } as Thumb])));
    (async () => {
      const done = new Set<string>();
      for (;;) {
        if (ctrl.signal.aborted) return;
        const order = [selRef.current, ...tiles.map((t) => t.id)];
        const nextId = order.find((id) => id && !done.has(id) && tiles.some((t) => t.id === id));
        const t = tiles.find((x) => x.id === nextId);
        if (!t) return;
        done.add(t.id);
        setThumbs((s) => ({ ...s, [t.id]: { status: "busy" } }));
        try {
          const { blob, meta } = await bg.diffBlob({
            idA: first.id, idB: second.id, layer: t.layerKey,
            west: box[0], south: box[1], east: box[2], north: box[3],
            maxPx: MAX_PX, mode: t.mode, cmap: "auto", patient: true,
            onWait: (why) => { if (!ctrl.signal.aborted) setWaitWhy(why); },
          }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setWaitWhy(null);
          if (!blob || !meta.corners_lonlat) {
            setThumbs((s) => ({ ...s, [t.id]: { status: "err", meta,
              message: meta.corners_note ?? "the engine returned no placed picture for this difference" } }));
            continue;
          }
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setThumbs((s) => ({ ...s, [t.id]: { status: "ok", url, meta } }));
        } catch (err) {
          if (ctrl.signal.aborted) return;
          setWaitWhy(null);
          setThumbs((s) => ({ ...s, [t.id]: { status: "err", message: err instanceof Error ? err.message : String(err) } }));
        }
      }
    })();
    return () => { ctrl.abort(); urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.id, second.id, tilesKey, bboxKey]);

  // ---- the chosen difference on the map ----------------------------------------------------------------------
  const [opacity, setOpacity] = useState(0.85);
  const onOverlayRef = useRef(onOverlay);
  onOverlayRef.current = onOverlay;
  const chosen = sel ? thumbs[sel.id] : undefined;
  useEffect(() => {
    const c = chosen?.meta?.corners_lonlat;
    if (sel && chosen?.status === "ok" && chosen.url && c) {
      const lons = c.map((p) => p[0]);
      const lats = c.map((p) => p[1]);
      onOverlayRef.current({
        id: `overlay:diff:${first.id}:${second.id}:${sel.id}:${chosen.url.slice(-12)}`,   // a new image is a new source
        dataUrl: chosen.url, opacity, corners: c,
        bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],   // envelope only
      });
    } else {
      onOverlayRef.current(null);
    }
  }, [sel, chosen, opacity, first.id, second.id]);
  useEffect(() => () => onOverlayRef.current(null), []);

  const [explain, setExplain] = useState<ExplainPayload | null>(null);
  useEffect(() => { loadExplain().then(setExplain).catch(() => setExplain(null)); }, []);
  const teach = sel ? explain?.diff_modes?.[sel.mode] : undefined;
  const meta = chosen?.status === "ok" ? chosen.meta : undefined;
  const diff = meta?.diff;

  const modeName = (t: Tile) => thumbs[t.id]?.meta?.diff?.mode_label ?? MODE_FALLBACK[t.mode] ?? t.mode;
  const waiting = !invs && !invError && !mismatch;
  const nDone = Object.values(thumbs).filter((t) => t.status === "ok" || t.status === "err").length;

  return (
    <div className="space-y-2 rounded-lg border border-[#e7e2da] bg-white p-3 text-xs" data-testid="map-pair-differences">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold text-[#1c1a17]">Every difference between the two dots</p>
          <p className="mono mt-0.5 text-[10px] text-[#4a443c]">
            A {fmtUtc(first.time)} → B {fmtUtc(second.time)}{diff ? ` · gap ${diff.gap_days} d` : ""}
          </p>
          <p className="mt-0.5 text-[10px] text-[#8a837b]">
            {pair.kind.toUpperCase()} · stack {pair.stackKey} · later minus earlier · times UTC
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="clear the two picked dots" title="clear the two picked dots"
                className="rounded border border-[#e7e2da] p-1 text-[#8a837b] hover:border-[#2c5f58] hover:text-[#2c5f58]">
          <X size={13} aria-hidden />
        </button>
      </div>

      {mismatch && <p role="alert" className="rounded border border-[#9e3b2c] bg-[#fbf3ef] p-2 text-[10px] text-[#9e3b2c]">{mismatch}</p>}
      {invError && <p role="alert" className="mono rounded border border-[#9e3b2c] bg-[#fbf3ef] p-2 text-[10px] text-[#9e3b2c]">{invError}</p>}
      {!bbox && <p role="status" className="text-[10px] text-[#8a837b]">pin a tile first: the pictures are clipped to the tile&apos;s box.</p>}
      {waiting && (
        <BigLoader size="lg" testId="pair-loading"
                   title="Finding every difference between your two dots…"
                   hint="The engine is reading both files' layer lists. The first time can take a minute — you don't need to do anything." />
      )}

      {invs && tiles.length === 0 && !mismatch && (
        <p role="status" className="rounded border border-[#e7e2da] bg-[#faf9f6] p-2 text-[10px] text-[#8a837b]">
          the engine defines no difference for any layer these two share
          {undefinedCount > 0 ? ` (${undefinedCount} previewable layer(s), none differenceable)` : ""}.
        </p>
      )}

      {tiles.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-[10px] text-[#8a837b]">
            <span data-testid="pair-count">
              {tiles.length} difference{tiles.length === 1 ? "" : "s"} · {nDone} of {tiles.length} drawn — click one to put it on the map
            </span>
            <label className="ml-auto flex items-center gap-1">opacity
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
          </div>
          {nDone < tiles.length && (
            <BigLoader size="sm" testId="pair-drawing" done={nDone} total={tiles.length}
                       title="Drawing the differences…"
                       hint="One picture at a time. The one you click is drawn next." />
          )}
          <ul className="grid grid-cols-2 gap-2" aria-label="all differences for this pair">
            {tiles.map((t) => {
              const th = thumbs[t.id];
              const on = sel?.id === t.id;
              return (
                <li key={t.id}>
                  <button type="button" aria-pressed={on} onClick={() => setSelId(t.id)} title={th?.message ?? t.layerKey}
                          data-testid={`pair-tile-${t.mode}`}
                          className={`w-full rounded border p-1 text-left ${on ? "border-[#2c5f58] bg-[#eef5f3]" : "border-[#e7e2da] bg-white hover:border-[#2c5f58]"}`}>
                    <div className="flex h-20 items-center justify-center overflow-hidden rounded bg-[#f3f0ea]">
                      {th?.status === "ok" && th.url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={th.url} alt={`${modeName(t)} of ${t.layerLabel}`} className="max-h-full max-w-full object-contain" />
                        : th?.status === "err"
                          ? <span className="px-1 text-[9px] text-[#9e3b2c]">{th.message}</span>
                          : th?.status === "busy"
                            ? <span className="flex flex-col items-center gap-1 text-[10px] font-medium text-[#2c5f58]"><MiniSpinner />drawing…</span>
                            : <span className="text-[10px] text-[#8a837b]">waiting its turn…</span>}
                    </div>
                    <p className="mono mt-1 truncate text-[10px] font-semibold text-[#2c5f58]">{t.mode}</p>
                    <p className="truncate text-[9.5px] text-[#4a443c]">{modeName(t)}</p>
                    <p className="mono truncate text-[9px] text-[#8a837b]">{t.layerLabel}</p>
                  </button>
                </li>
              );
            })}
          </ul>
          {waitWhy && <p role="status" className="text-[10px] text-[#8a837b]">{waitWhy}, still trying…</p>}
          {undefinedCount > 0 && (
            <p className="text-[10px] text-[#8a837b]">
              {undefinedCount} other shared layer(s) have no difference defined (masks, geometry, offsets…).
            </p>
          )}
        </>
      )}

      {/* the chosen one: legend, notes, teaching text — all engine-served */}
      {sel && (
        <div className="space-y-1 rounded-md border border-[#e7e2da] bg-[#faf9f6] p-2 text-[10px] text-[#4a443c]">
          {(!chosen || chosen.status === "wait" || chosen.status === "busy") && (
            <p role="status" className="flex items-center gap-2 text-[#2c5f58]">drawing {sel.mode} for the map<MiniSpinner /></p>
          )}
          {chosen?.status === "err" && <p role="alert" className="text-[#9e3b2c]">{chosen.message}</p>}
          {meta && (
            <>
              <p className="mono text-[#8a837b]">{diff?.mode_label ? `${diff.mode_label} · ` : ""}{previewLegend(meta)}</p>
              {diff?.resampled && <p className="text-[#8a837b]">{diff.resampled}</p>}
              <p role="note" data-testid="preview-note" className="text-[#8a837b]">
                Preview picture{meta.shown_stride && meta.shown_stride > 1 ? ` (every ${meta.shown_stride}th pixel)` : ""}: the engine computed this
                difference from the full-resolution values, but the picture is a reduced preview. For analysis, use the full-resolution data, not the picture.
              </p>
              {diff?.referencing && <p className="text-[#8a6d1f]">{diff.referencing.note}</p>}
              {(meta.notes ?? []).map((n) => <p key={n} role="note" className="text-[#8a6d1f]">{n}</p>)}
            </>
          )}
          {teach && (
            <div className="border-t border-[#e7e2da] pt-1 text-[#8a837b]">
              <p className="text-[#1c1a17]">{teach.what_it_is}</p>
              {teach.how_to_read && <p className="mt-1">how to read: {teach.how_to_read}</p>}
              {teach.misread && <p className="mt-1 text-[#8a6d1f]">easy to misread: {teach.misread}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

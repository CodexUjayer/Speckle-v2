"use client";

/** Every difference the engine defines between two acquisitions, as pictures, for the map's "See why" player.
 *  Same engine calls and the same rules as MapPairDifferences (the Data panel's list): both granules' layer lists,
 *  keep the layers both carry, and for every (layer, mode) the engine itself marks valid ask for that difference
 *  as a placed picture. Nothing here subtracts, converts a unit or decides validity. Pictures load one at a time
 *  (the engine serves one read at a time); `priority` tells the loop which tile to draw next. */
import { useEffect, useMemo, useRef, useState } from "react";
import { bg } from "./bg";
import { loadExplain } from "./explainCache";
import type { ExplainPayload, GranuleDetailResponse, PreviewMeta } from "./types";
import type { PickedPair } from "@/components/globe/MapPairDifferences";

type Inv = NonNullable<GranuleDetailResponse["inventory"]>;
type InvLayer = Inv["grids"][number]["layers"][number];

export interface DiffTile { id: string; layerKey: string; layerLabel: string; mode: string }
export interface DiffThumb { status: "wait" | "busy" | "ok" | "err"; url?: string; meta?: PreviewMeta; message?: string }

const MAX_PX = 640;
const layersOf = (inv: Inv | null | undefined): InvLayer[] =>
  (inv?.grids ?? []).flatMap((g) => g.layers).filter((l) => l.previewable);
const msOf = (iso: string | null) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : 0; };

export interface PairDifferences {
  first: { id: string; time: string | null } | null;
  second: { id: string; time: string | null } | null;
  tiles: DiffTile[];
  thumbs: Record<string, DiffThumb>;
  /** modes the engine explains in plain words (config/explain.yaml) */
  explain: ExplainPayload | null;
  invError: string | null;
  mismatch: string | null;
  /** still reading the two layer lists */
  reading: boolean;
  /** every tile has either a picture or an error */
  finished: boolean;
  nDone: number;
  undefinedCount: number;
  retry: () => void;
}

export function usePairDifferences(
  pair: PickedPair | null,
  bbox: [number, number, number, number] | null,
  enabled: boolean,
  priority: string,
): PairDifferences {
  const [first, second] = useMemo(() => {
    if (!pair) return [null, null] as const;
    return msOf(pair.a.time) <= msOf(pair.b.time) ? ([pair.a, pair.b] as const) : ([pair.b, pair.a] as const);
  }, [pair]);
  const mismatch = first && second && first.id === second.id
    ? "These are the same acquisition twice, which gives no difference. Pick another." : null;

  const [nonce, setNonce] = useState(0);
  const [invs, setInvs] = useState<{ a: Inv | null; b: Inv | null } | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  const active = enabled && !!first && !!second && !mismatch;

  useEffect(() => {
    setInvs(null); setInvError(null);
    if (!active || !first || !second) return;
    const ctrl = new AbortController();
    Promise.all([bg.granule(first.id, ctrl.signal), bg.granule(second.id, ctrl.signal)])
      .then(([x, y]) => { if (!ctrl.signal.aborted) { setInvs({ a: x.inventory ?? null, b: y.inventory ?? null }); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setInvError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [active, first?.id, second?.id, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const { tiles, undefinedCount } = useMemo(() => {
    const out: DiffTile[] = [];
    let none = 0;
    if (!invs) return { tiles: out, undefinedCount: 0 };
    const inB = new Set(layersOf(invs.b).map((l) => l.key));
    for (const l of layersOf(invs.a)) {
      if (!inB.has(l.key)) continue;
      const modes = Object.entries(l.diff_modes ?? {}).filter(([, v]) => v.valid).map(([m]) => m);
      if (modes.length === 0) { none += 1; continue; }
      for (const m of modes) out.push({ id: `${l.key}::${m}`, layerKey: l.key, layerLabel: l.path.split("/").slice(-3).join("/"), mode: m });
    }
    return { tiles: out, undefinedCount: none };
  }, [invs]);

  const prioRef = useRef(priority);
  prioRef.current = priority;
  const [thumbs, setThumbs] = useState<Record<string, DiffThumb>>({});
  const tilesKey = tiles.map((t) => t.id).join("|");
  const bboxKey = bbox ? bbox.join(",") : "";
  useEffect(() => {
    setThumbs({});
    if (!bbox || !first || !second || tiles.length === 0) return;
    const box = bbox;
    const ctrl = new AbortController();
    const urls: string[] = [];
    setThumbs(Object.fromEntries(tiles.map((t) => [t.id, { status: "wait" } as DiffThumb])));
    (async () => {
      const done = new Set<string>();
      for (;;) {
        if (ctrl.signal.aborted) return;
        const order = [prioRef.current, ...tiles.map((t) => t.id)];
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
          }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (!blob || !meta.corners_lonlat) {
            setThumbs((s) => ({ ...s, [t.id]: { status: "err", meta, message: meta.corners_note ?? "The engine returned no placed picture for this difference." } }));
            continue;
          }
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
  }, [first?.id, second?.id, tilesKey, bboxKey, nonce]);

  const [explain, setExplain] = useState<ExplainPayload | null>(null);
  useEffect(() => { if (active) loadExplain().then(setExplain).catch(() => setExplain(null)); }, [active]);

  const nDone = Object.values(thumbs).filter((t) => t.status === "ok" || t.status === "err").length;
  return {
    first, second, tiles, thumbs, explain, invError, mismatch,
    reading: active && !invs && !invError,
    finished: !!invs && (tiles.length === 0 || nDone >= tiles.length),
    nDone, undefinedCount,
    retry: () => { setNonce((n) => n + 1); },
  };
}

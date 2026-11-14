"use client";

/** The dock's chosen picture (e.g. "Brightness change") for EVERY other tile of the scan box, not just the pinned one.
 *
 *  The picture is the engine's own: the same pair of acquisitions, layer and difference mode as the chosen chip, asked of
 *  the same /api/background/diff call over each tile's box. The colour range is the pinned tile's own (the engine's lo/hi
 *  from that picture), so every tile is coloured on one scale and they can be compared. Nothing is subtracted, converted
 *  or scaled here. The engine reads one file at a time, so the tiles go one after another, nearest the pin first (the
 *  order of `boxes`). A tile the pair does not cover is counted and reported, never silently skipped. */
import { useEffect, useMemo, useState } from "react";
import { bg } from "./bg";
import type { OverlaySpec } from "@/components/globe/GlobeMap";

export interface AreaBox { id: string; bbox: [number, number, number, number] }
export interface AreaDiffState {
  specs: OverlaySpec[];
  /** tiles asked for / drawn / the pair gave no picture there */
  total: number;
  drawn: number;
  failed: number;
  busy: boolean;
}

const MAX_PX = 640;
const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export function useAreaDiffPictures(p: {
  enabled: boolean;
  firstId: string | null;
  secondId: string | null;
  layerKey: string | null;
  mode: string | null;
  range: { lo: number; hi: number } | null;
  boxes: AreaBox[];
  opacity?: number;
}): AreaDiffState {
  const { firstId, secondId, layerKey, mode, range, boxes } = p;
  const opacity = p.opacity ?? 0.86;
  const on = p.enabled && !!firstId && !!secondId && !!layerKey && !!mode && !!range
    && Number.isFinite(range.lo) && Number.isFinite(range.hi) && boxes.length > 0;
  const boxKey = boxes.map((b) => `${b.id}:${b.bbox.join(",")}`).join(";");
  const rangeKey = range ? `${range.lo},${range.hi}` : "";

  const [pics, setPics] = useState<Record<string, OverlaySpec>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPics({}); setFailed([]); setBusy(false);
    if (!on || !firstId || !secondId || !layerKey || !mode || !range) return;
    const ctrl = new AbortController();
    const urls: string[] = [];
    setBusy(true);
    (async () => {
      for (const b of boxes) {
        if (ctrl.signal.aborted) return;
        try {
          const { blob, meta } = await bg.diffBlob({
            idA: firstId, idB: secondId, layer: layerKey,
            west: b.bbox[0], south: b.bbox[1], east: b.bbox[2], north: b.bbox[3],
            maxPx: MAX_PX, mode, cmap: "auto", lo: range.lo, hi: range.hi, patient: true,
          }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          const c = meta.corners_lonlat;
          if (!blob || !c) { setFailed((f) => [...f, b.id]); continue; }
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const lons = c.map((q) => q[0]), lats = c.map((q) => q[1]);
          const spec: OverlaySpec = {
            // starts with "overlay:" (the map only removes sources it can map back to such an id)
            id: `overlay:areadiff:${slug(b.id)}:${slug(layerKey)}_${slug(mode)}@${slug(firstId)}_${slug(secondId)}`,
            dataUrl: url, opacity, corners: c,
            bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
          };
          setPics((s) => ({ ...s, [b.id]: spec }));
        } catch {
          if (ctrl.signal.aborted) return;
          setFailed((f) => [...f, b.id]);
        }
      }
      if (!ctrl.signal.aborted) setBusy(false);
    })();
    return () => { ctrl.abort(); urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, firstId, secondId, layerKey, mode, rangeKey, boxKey]);

  const specs = useMemo(
    () => boxes.map((b) => pics[b.id]).filter((x): x is OverlaySpec => !!x).map((s) => ({ ...s, opacity })),
    [boxes, pics, opacity],   // eslint-disable-line react-hooks/exhaustive-deps
  );
  return { specs, total: on ? boxes.length : 0, drawn: specs.length, failed: failed.length, busy: on && busy };
}

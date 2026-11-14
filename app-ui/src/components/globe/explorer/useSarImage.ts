"use client";

/** useSarImage — ONE place that fetches an engine preview PNG for (granule, layer, box) and owns its object URL.
 *  Used by the footprint mini-map control, the Map-page control, the Before/After toggle and the Data Lab, so the
 *  fetch / abort / revoke rules exist once:
 *   - every request has an AbortController; a newer request or unmount aborts the older one;
 *   - every URL.createObjectURL is revoked when replaced, when the hook is disabled and on unmount;
 *   - nothing is set after unmount (a `signal.aborted` check guards every update);
 *   - the engine decides colours, dB, unit and corners; this only transports and reports them.
 *  `fetcher` swaps the transport (preview vs the Lab's pair difference): the SAME lifecycle rules
 *  apply to both, so the diff never grows a second fetch/abort path. The default is bg.previewBlob. */
import { useEffect, useRef, useState } from "react";
import { bg } from "@/lib/bg";
import type { PreviewMeta } from "@/lib/types";

export type Corners = NonNullable<PreviewMeta["corners_lonlat"]>;

/** The pair-difference transport for `fetcher`: granuleId carries "idA|idB" (validated ids, no spaces) and
 *  `scale` carries the difference mode. The subtraction is the engine's (raw values, never rendered PNGs). */
export function diffFetch(
  p: Parameters<typeof bg.diffBlob>[0] & { id: string; layer: string; scale?: string; maxPx?: number },
  signal?: AbortSignal,
) {
  const [idA, ...rest] = p.id.split("|");
  const { id: _id, layer, scale, ...r } = p as typeof p & { id: string };
  void _id;
  return bg.diffBlob({
    idA, idB: rest.join("|"), layer, west: r.west, south: r.south, east: r.east, north: r.north,
    maxPx: r.maxPx, mode: scale && scale !== "auto" ? scale : "auto", cmap: r.cmap ?? "auto",
    ...(r.lo != null && r.hi != null ? { lo: r.lo, hi: r.hi } : {}),
    patient: true, onWait: r.onWait,
  }, signal);
}

export interface SarImageParams {
  enabled: boolean;
  granuleId: string;
  layerKey: string;
  bbox: [number, number, number, number] | null;
  scale?: string;
  cmap?: string;
  /** explicit colour range (both or neither) */
  lo?: number | null;
  hi?: number | null;
  maxPx?: number;
  /** fade pixels with low coherence (engine-side; off = every valid pixel opaque) */
  validate?: boolean;
  /** Phase 3: render a correction diagnostic instead of the layer (engine-side conversion) */
  corr?: string;
  /** bump to ask again after a failure (a saved token, a rate limit) */
  nonce?: number;
  /** the transport: defaults to the single-granule preview; the Lab's diff passes its own */
  fetcher?: typeof bg.previewBlob;
}

export interface SarImage {
  url: string | null;
  corners: Corners | null;
  meta: PreviewMeta | null;
  busy: boolean;
  message: string | null;
  /** while busy: why the engine is still working / being retried ("the engine is busy with another read"); no time limit */
  wait: string | null;
}

const IDLE: SarImage = { url: null, corners: null, meta: null, busy: false, message: null, wait: null };

export function useSarImage(p: SarImageParams): SarImage {
  const [state, setState] = useState<SarImage>(IDLE);
  const urlRef = useRef<string | null>(null);
  const bboxKey = p.bbox ? p.bbox.join(",") : "";

  const dropUrl = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };
  useEffect(() => dropUrl, []);   // unmount: revoke whatever is still held

  useEffect(() => {
    if (!p.enabled || !p.layerKey || !p.granuleId || !p.bbox) {
      dropUrl();
      setState(IDLE);
      return;
    }
    const box = p.bbox;
    const ctrl = new AbortController();
    // A new request means a different picture (another layer, scale, coherence option ...): drop the previous image,
    // its corners and its legend NOW. Keeping them showed layer A's picture under layer B's name for as long as B
    // took to read from NASA, which looked exactly like "I pick other layers and always get the same image".
    dropUrl();
    setState({ ...IDLE, busy: true });
    const fetchImg = p.fetcher ?? bg.previewBlob;
    fetchImg({
      id: p.granuleId, layer: p.layerKey, west: box[0], south: box[1], east: box[2], north: box[3],
      maxPx: p.maxPx ?? 512, scale: p.scale ?? "auto", cmap: p.cmap ?? "auto",
      ...(p.lo != null && p.hi != null ? { lo: p.lo, hi: p.hi } : {}),
      ...(p.validate ? { quality: "coherence" as const } : {}),
      ...(p.corr ? { corr: p.corr as "iono" } : {}),
      patient: true,                         // no time limit: keep trying until it is drawn or the person moves on
      onWait: (why) => { if (!ctrl.signal.aborted) setState((s) => ({ ...s, wait: why })); },
    }, ctrl.signal)
      .then(({ blob, meta }) => {
        if (ctrl.signal.aborted) return;
        dropUrl();
        if (!blob || !meta.corners_lonlat) {     // never draw an image the engine could not place
          setState({ ...IDLE, meta,
            message: meta.corners_note ?? "the engine returned no image corners for this layer, so it is not drawn" });
          return;
        }
        urlRef.current = URL.createObjectURL(blob);
        setState({ ...IDLE, url: urlRef.current, corners: meta.corners_lonlat, meta });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        dropUrl();
        setState({ ...IDLE, message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
    // p.* are read through the dependency list below on purpose (primitives only); the fetcher is
    // read from p at call time for the same reason (callers pass a stable module-level function)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.enabled, p.granuleId, p.layerKey, bboxKey, p.scale, p.cmap, p.lo, p.hi, p.maxPx, p.validate, p.corr, p.nonce]);

  return state;
}

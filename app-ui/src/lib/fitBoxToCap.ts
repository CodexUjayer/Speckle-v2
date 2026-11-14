/** When a requested Range box touches more engine tiles than the cap allows, shrink it to the
 *  largest box that still fits — using /api/tiles-for-box as the sole source of truth. No tiling
 *  math is duplicated here (the engine owns that; see no-science-guard): each step just asks the
 *  engine "does this size fit?" and narrows in on the biggest size for which the answer is yes.
 *  Zero science: transport + search only. */
import { api } from "./api";
import { boxFromCenter, type Box } from "./boxFromCenter";
import type { TileInfo } from "./types";

const CAP_RE = /touches (\d+) tiles of \d+ km; one area scan is capped at (\d+)/;

export type FitResult =
  | { ok: true; box: Box; tiles: TileInfo[]; usedKm: number; shrunk: boolean }
  | { ok: false; error: string };

/** At most 6 round-trips to the engine: the first call is the happy path (the requested size
 *  already fits, done in one call); every later call narrows toward the largest size that fits,
 *  reading the touched-tile count and the cap straight out of the engine's own 400 message. */
export async function fitBoxToCap(lat: number, lon: number, requestedKm: number): Promise<FitResult> {
  let okKm: number | null = null;
  let okBox: Box | null = null;
  let okTiles: TileInfo[] | null = null;
  let badKm: number | null = null;
  let tryKm = requestedKm;

  for (let i = 0; i < 6; i++) {
    const box = boxFromCenter(lat, lon, tryKm);
    if (!box) {
      return { ok: false, error: "That box doesn't fit on the map (too close to a pole or the antimeridian)." };
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- each step depends on the previous engine answer
      const r = await api.tilesForBox(box);
      okKm = tryKm;
      okBox = box;
      okTiles = r.tiles;
      if (tryKm >= requestedKm - 0.25) break;                   // the requested size already fits — done
      tryKm = badKm != null ? (tryKm + badKm) / 2 : Math.min(requestedKm, tryKm * 1.2);
      if (badKm != null && badKm - tryKm < 0.5) break;          // converged to within ~0.5 km
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = CAP_RE.exec(msg);
      if (!m) return { ok: false, error: msg };                 // a different failure: surface it verbatim
      badKm = tryKm;
      const [, nStr, capStr] = m;
      const n = Number(nStr);
      const cap = Number(capStr);
      tryKm = okKm != null
        ? (okKm + badKm) / 2
        : Math.max(1, tryKm * Math.sqrt(cap / n) * 0.92);        // first guess: scale by sqrt(area ratio), with margin
    }
  }
  if (!okBox || !okTiles || okKm == null) {
    return { ok: false, error: `No box up to ${requestedKm} km fits inside the engine's tile cap.` };
  }
  return { ok: true, box: okBox, tiles: okTiles, usedKm: Number(okKm.toFixed(1)), shrunk: okKm < requestedKm - 0.25 };
}

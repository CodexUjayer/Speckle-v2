/** Raster layer rendering — turns the engine's b64 evidence grids into
 *  canvas images for the map, using the engine's OWN colormap names
 *  (diverging_teal_terracotta | sequential | binary) and the engine's OWN
 *  vmin/vmax and category labels. Presentation only: no resampling, no
 *  interpolation, no statistics — each pixel is the engine's value. */

import type { LayerPayload } from "@/lib/engine/types";

/* ------------------------------------------------------------------ */
/* colormaps (the landing's palette, matching the engine's names)        */
/* ------------------------------------------------------------------ */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** teal (toward sensor, +) ↔ neutral ↔ terracotta (away, −) */
function divergingTealTerracotta(v: number): [number, number, number, number] {
  // v in [-1, 1]
  const a = Math.abs(v);
  if (a < 0.04) return [8, 15, 24, 0]; // near zero — transparent over the dark basemap
  if (v > 0) {
    // teal ramp: #4a8f81 → #8fd8c8
    const r = lerp(74, 143, a);
    const g = lerp(143, 216, a);
    const b = lerp(129, 200, a);
    return [r, g, b, Math.min(1, 0.35 + a * 0.65)];
  }
  // terracotta ramp: #8f5a4c → #c98d7e
  const r = lerp(143, 201, a);
  const g = lerp(90, 141, a);
  const b = lerp(76, 126, a);
  return [r, g, b, Math.min(1, 0.35 + a * 0.65)];
}

/** dark → steel-blue sequential ramp for thresholds */
function sequentialSteel(v: number): [number, number, number, number] {
  // v in [0, 1]
  const r = lerp(10, 169, v);
  const g = lerp(16, 191, v);
  const b = lerp(26, 214, v);
  return [r, g, b, 0.28 + v * 0.5];
}

/* ------------------------------------------------------------------ */
/* the renderer                                                          */
/* ------------------------------------------------------------------ */

export interface RasterImage {
  dataUrl: string;
  /** [W, S, E, N] — the engine's own bounds for this layer */
  bounds: [number, number, number, number];
  width: number;
  height: number;
}

export function renderLayer(layer: LayerPayload): RasterImage | null {
  try {
    const [h, w] = layer.shape;
    if (!h || !w) return null;
    const bytes = Uint8Array.from(atob(layer.data_b64), (c) => c.charCodeAt(0));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(w, h);

    if (layer.dtype === "<f4") {
      const f = new Float32Array(bytes.buffer, bytes.byteOffset, h * w);
      // vmin/vmax come from the engine; fall back to a symmetric view ONLY
      // for display when the engine omitted them (flagged in the note)
      let lo = layer.vmin ?? -0.05;
      let hi = layer.vmax ?? 0.05;
      let symmetric = false;
      if (layer.vmin === null || layer.vmin === undefined || layer.vmax === null || layer.vmax === undefined) {
        symmetric = true;
      }
      if (layer.colormap === "diverging_teal_terracotta" && symmetric) {
        const m = Math.max(Math.abs(lo), Math.abs(hi)) || 0.05;
        lo = -m;
        hi = m;
      }
      const span = hi - lo || 1;
      for (let i = 0; i < h * w; i++) {
        const v = f[i];
        const o = i * 4;
        if (!Number.isFinite(v)) {
          img.data[o + 3] = 0;
          continue;
        }
        let rgba: [number, number, number, number];
        if (layer.colormap === "diverging_teal_terracotta") {
          rgba = divergingTealTerracotta(((v - lo) / span) * 2 - 1);
        } else {
          rgba = sequentialSteel((v - lo) / span);
        }
        img.data[o] = rgba[0];
        img.data[o + 1] = rgba[1];
        img.data[o + 2] = rgba[2];
        img.data[o + 3] = Math.round(rgba[3] * 255);
      }
    } else if (layer.dtype === "<u1") {
      const u = new Uint8Array(bytes.buffer, bytes.byteOffset, h * w);
      for (let i = 0; i < h * w; i++) {
        const v = u[i];
        const o = i * 4;
        if (v === 0) {
          img.data[o + 3] = 0;
          continue;
        }
        if (layer.colormap === "binary") {
          // the engine's categories: 1 = toward sensor, 2 = away
          if (v === 1) {
            img.data[o] = 143;
            img.data[o + 1] = 216;
            img.data[o + 2] = 200;
            img.data[o + 3] = 225;
          } else if (v === 2) {
            img.data[o] = 201;
            img.data[o + 1] = 141;
            img.data[o + 2] = 126;
            img.data[o + 3] = 225;
          } else {
            img.data[o] = 169;
            img.data[o + 1] = 191;
            img.data[o + 2] = 214;
            img.data[o + 3] = 200;
          }
        } else {
          const rgba = sequentialSteel(v / 255);
          img.data[o] = rgba[0];
          img.data[o + 1] = rgba[1];
          img.data[o + 2] = rgba[2];
          img.data[o + 3] = Math.round(rgba[3] * 255);
        }
      }
    } else {
      return null;
    }

    ctx.putImageData(img, 0, 0);
    const bounds = layer.bounds_lonlat ?? [0, 0, 0, 0];
    return {
      dataUrl: canvas.toDataURL("image/png"),
      bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
      width: w,
      height: h,
    };
  } catch {
    return null;
  }
}

/** The legend entries for a layer — built from the engine's own metadata. */
export function layerLegend(layer: LayerPayload): { color: string; label: string }[] {
  if (layer.colormap === "binary" && layer.categories) {
    return layer.categories.map((c) => ({
      color: c.value === 1 ? "#8fd8c8" : c.value === 2 ? "#c98d7e" : "#a9bfd6",
      label: c.label,
    }));
  }
  if (layer.colormap === "diverging_teal_terracotta") {
    const lo = layer.vmin ?? -0.05;
    const hi = layer.vmax ?? 0.05;
    return [
      { color: "#c98d7e", label: `${(Math.min(lo, hi) * 1000).toFixed(0)} mm (away)` },
      { color: "#0a0f18", label: "0" },
      { color: "#8fd8c8", label: `${(Math.max(Math.abs(lo), Math.abs(hi)) * 1000).toFixed(0)} mm (toward)` },
    ];
  }
  const lo = layer.vmin ?? 0;
  const hi = layer.vmax ?? 1;
  const unit = layer.units.startsWith("m") ? "m" : "";
  return [
    { color: "#0a101a", label: `${lo.toFixed(unit === "m" ? 3 : 1)} ${unit}` },
    { color: "#a9bfd6", label: `${hi.toFixed(unit === "m" ? 3 : 1)} ${unit}` },
  ];
}

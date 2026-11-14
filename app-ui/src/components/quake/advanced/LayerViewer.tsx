"use client";

/** Interactive evidence-raster viewer. Decodes the engine's b64 grid and
 *  paints it with the engine's own colormap / vmin / vmax. Hovering reads
 *  back the ENGINE'S VALUE at that cell — the viewer never computes
 *  anything beyond locating the cell under the cursor. */

import { useEffect, useMemo, useRef, useState } from "react";
import type { LayerPayload } from "@/lib/engine/types";
import { layerLegend } from "../raster";

export default function LayerViewer({ layer }: { layer: LayerPayload }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ i: number; j: number; v: number } | null>(null);

  const grid = useMemo(() => {
    const [h, w] = layer.shape;
    const bytes = Uint8Array.from(atob(layer.data_b64), (c) => c.charCodeAt(0));
    if (layer.dtype === "<f4") return { f: new Float32Array(bytes.buffer, bytes.byteOffset, h * w), u: null, h, w };
    return { f: null, u: new Uint8Array(bytes.buffer, bytes.byteOffset, h * w), h, w };
  }, [layer]);

  /* paint — nearest-neighbour upscale (the engine's posting, unsmoothed) */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { f, u, h, w } = grid;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    let lo = layer.vmin ?? -0.05;
    let hi = layer.vmax ?? 0.05;
    if (
      layer.colormap === "diverging_teal_terracotta" &&
      (layer.vmin === null || layer.vmin === undefined || layer.vmax === null || layer.vmax === undefined)
    ) {
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 0.05;
      lo = -m;
      hi = m;
    }
    const span = hi - lo || 1;
    const put = (i: number, rgba: [number, number, number, number]) => {
      const o = i * 4;
      img.data[o] = rgba[0];
      img.data[o + 1] = rgba[1];
      img.data[o + 2] = rgba[2];
      img.data[o + 3] = Math.round(rgba[3] * 255);
    };
    if (f) {
      for (let i = 0; i < h * w; i++) {
        const v = f[i];
        if (!Number.isFinite(v)) {
          put(i, [0, 0, 0, 0]);
          continue;
        }
        const t = (v - lo) / span;
        if (layer.colormap === "diverging_teal_terracotta") {
          const s = t * 2 - 1;
          const a = Math.abs(s);
          if (a < 0.04) put(i, [0, 0, 0, 0]);
          else if (s > 0) put(i, [74 + 69 * a, 143 + 73 * a, 129 + 71 * a, Math.min(1, 0.4 + a * 0.6)]);
          else put(i, [143 + 58 * a, 90 + 51 * a, 76 + 50 * a, Math.min(1, 0.4 + a * 0.6)]);
        } else {
          put(i, [10 + 159 * t, 16 + 175 * t, 26 + 188 * t, 0.3 + t * 0.55]);
        }
      }
    } else if (u) {
      for (let i = 0; i < h * w; i++) {
        const v = u[i];
        if (v === 0) {
          put(i, [0, 0, 0, 0]);
          continue;
        }
        if (layer.colormap === "binary") {
          if (v === 1) put(i, [143, 216, 200, 235]);
          else if (v === 2) put(i, [201, 141, 126, 235]);
          else put(i, [169, 191, 214, 210]);
        } else {
          const t = v / 255;
          put(i, [10 + 159 * t, 16 + 175 * t, 26 + 188 * t, 0.3 + t * 0.55]);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [grid, layer]);

  const legend = layerLegend(layer);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const j = Math.min(grid.w - 1, Math.max(0, Math.floor(x * grid.w)));
    const i = Math.min(grid.h - 1, Math.max(0, Math.floor(y * grid.h)));
    const v = grid.f ? grid.f[i * grid.w + j] : grid.u ? grid.u[i * grid.w + j] : Number.NaN;
    setHover({ i, j, v });
  };

  const fmtVal = (v: number) => {
    if (!Number.isFinite(v)) return "NaN (off-mask)";
    if (layer.dtype === "<f4") return `${(v * 1000).toFixed(2)} mm (${v.toFixed(5)} m)`;
    const cat = layer.categories?.find((c) => c.value === v);
    return cat ? `${v} = ${cat.label}` : String(v);
  };

  return (
    <div>
      <div className="relative overflow-hidden rounded-md border border-[var(--qp-edge)] bg-[#070b12]">
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          className="block w-full cursor-crosshair"
          style={{ imageRendering: "pixelated", aspectRatio: `${grid.w} / ${grid.h}` }}
          aria-label={`${layer.name} raster, ${grid.w} by ${grid.h} engine grid`}
        />
        {hover ? (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)]/95 px-3 py-2 font-mono text-[10px] leading-relaxed text-[var(--qp-ink)]">
            <p>
              cell [{hover.i},{hover.j}]
            </p>
            <p className="text-[var(--qp-red)]">{fmtVal(hover.v)}</p>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {legend.map((l) => (
          <p key={l.label} className="flex items-center gap-2 font-mono text-[10px] text-[var(--qp-ink-2)]">
            <span className="inline-block h-2.5 w-5 rounded-[2px]" style={{ background: l.color }} aria-hidden />
            {l.label}
          </p>
        ))}
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--qp-ink-3)]">
          {layer.dtype} · {grid.w}×{grid.h} · {layer.units}
        </p>
      </div>
      {layer.note ? (
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-[var(--qp-ink-3)]">{layer.note}</p>
      ) : null}
    </div>
  );
}

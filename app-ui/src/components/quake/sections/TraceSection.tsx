"use client";

/**
 * CH·04 — THE TRACE. The station's signature readout: a real seismogram-style
 * strip drawn from the engine's own displacement raster — the centre row of
 * the tile, in millimetres of line-of-sight motion, exactly as the engine
 * computed it. Below it, the same row of the detected layer marks where the
 * engine's detector fired (toward / away). No smoothing, no interpolation —
 * every point is the engine's value for that pixel.
 */

import { useMemo, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLayer } from "@/components/quake/engineHooks";
import type { LayerPayload } from "@/lib/engine/types";
import { useQuakeVerdict } from "../useVerdict";
import { fmtMm, LOS_CONVENTION, type Target } from "../shared";
import { Chip, EmptyPanel, ErrorPanel, LoadingPanel, Mono, Panel, PanelHead, QuakeSection, Readout } from "../ui";

/* ------------------------------------------------------------------ */
/* layer fetch                                                          */
/* ------------------------------------------------------------------ */

function useLayer(runId: string | null, name: "displacement" | "detected") {
  return useQuery({
    queryKey: ["quake-layer", runId, name],
    queryFn: () => fetchLayer(runId as string, name),
    enabled: runId !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

function decodeF32(layer: LayerPayload): Float32Array | null {
  try {
    const [h, w] = layer.shape;
    const bytes = Uint8Array.from(atob(layer.data_b64), (c) => c.charCodeAt(0));
    return new Float32Array(bytes.buffer, bytes.byteOffset, h * w);
  } catch {
    return null;
  }
}

function decodeU8(layer: LayerPayload): Uint8Array | null {
  try {
    const [h, w] = layer.shape;
    const bytes = Uint8Array.from(atob(layer.data_b64), (c) => c.charCodeAt(0));
    return new Uint8Array(bytes.buffer, bytes.byteOffset, h * w);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* the strip canvas — real values, ink on paper                         */
/* ------------------------------------------------------------------ */

function TraceStrip({
  values,
  detected,
  vmin,
  vmax,
}: {
  values: Float32Array | null;
  detected: Uint8Array | null;
  vmin: number | null;
  vmax: number | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !values) return;
    const parent = cv.parentElement;
    const W = Math.max(320, parent?.clientWidth ?? 640);
    const H = 132;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const padL = 46;
    const padR = 14;
    const padY = 16;
    const plotW = W - padL - padR;
    const plotH = H - padY * 2;
    const n = values.length;
    const row = values;

    /* display scale: symmetric around 0 from the row's own extent — a chart
       axis choice, nothing more; the values themselves are untouched */
    let ext = 0;
    for (let i = 0; i < n; i++) {
      const v = row[i];
      if (Number.isFinite(v)) ext = Math.max(ext, Math.abs(v));
    }
    if (ext === 0) ext = Math.max(Math.abs(vmin ?? 0), Math.abs(vmax ?? 0), 0.001);
    const y0 = padY + plotH / 2;
    const yOf = (v: number) => y0 - (v / ext) * (plotH / 2) * 0.92;

    /* night grid: horizontal mm rules */
    ctx.strokeStyle = "rgba(236,229,211,0.08)";
    ctx.lineWidth = 1;
    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const v = -ext + (2 * ext * s) / steps;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(179,170,149,0.85)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.fillText(`${(v * 1000).toFixed(0)}`, padL - 8, y + 3);
    }
    /* zero line — the red baseline */
    ctx.strokeStyle = "rgba(232,92,58,0.55)";
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(y0) + 0.5);
    ctx.lineTo(W - padR, Math.round(y0) + 0.5);
    ctx.stroke();

    /* pixel ticks along the bottom */
    ctx.strokeStyle = "rgba(236,229,211,0.18)";
    const tickEvery = Math.max(1, Math.floor(n / 48));
    for (let i = 0; i < n; i += tickEvery) {
      const x = padL + (i / (n - 1)) * plotW;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, H - padY);
      ctx.lineTo(Math.round(x) + 0.5, H - padY + 4);
      ctx.stroke();
    }

    /* the trace — pale ink on night paper */
    ctx.strokeStyle = "#ece5d3";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    let started = false;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = row[i];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = padL + (i / (n - 1)) * plotW;
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    /* detected marks — the same row of the detected layer */
    if (detected && detected.length === n) {
      for (let i = 0; i < n; i++) {
        const c = detected[i];
        if (!c) continue;
        const x = padL + (i / (n - 1)) * plotW;
        ctx.fillStyle = c === 1 ? "#3ecf9a" : c === 2 ? "#ff5d55" : "rgba(165,178,200,0.85)";
        ctx.fillRect(x - 1, H - padY + 6, 2.4, 5);
      }
    }
  }, [values, detected, vmin, vmax]);

  if (!values) return null;
  return (
    <div className="w-full">
      <canvas ref={ref} role="img" aria-label="Line-of-sight displacement across the centre row of the tile, in millimetres" />
      {detected ? (
        <p className="qp-readout mt-1 pl-[46px] text-[9px] tracking-[0.14em] text-[var(--qp-ink-3)]">
          ▲ detector marks on the same row — <span className="text-[#3ecf9a]">toward</span> /{" "}
          <span className="text-[#ff5d55]">away</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the section                                                          */
/* ------------------------------------------------------------------ */

export default function TraceSection({
  target,
  runId,
  onGoto,
}: {
  target: Target | null;
  runId: string | null;
  onGoto: (anchor: string) => void;
}) {
  const verdict = useQuakeVerdict(target, runId);
  const effectiveRunId = runId ?? verdict.runId;
  const disp = useLayer(effectiveRunId, "displacement");
  const det = useLayer(effectiveRunId, "detected");

  const layersListed = useMemo(() => {
    const d = verdict.result?.detail as { layers?: Record<string, unknown> } | undefined;
    return Object.keys(d?.layers ?? {});
  }, [verdict.result]);

  const strip = useMemo(() => {
    const layer = disp.data?.layer;
    if (!layer) return null;
    const f = decodeF32(layer);
    if (!f) return null;
    const [, w] = layer.shape;
    const rowIdx = Math.floor(layer.shape[0] / 2);
    return { values: f.subarray(rowIdx * w, (rowIdx + 1) * w), rowIdx, width: w };
  }, [disp.data]);

  const detRow = useMemo(() => {
    const layer = det.data?.layer;
    if (!layer || !strip) return null;
    const u = decodeU8(layer);
    if (!u || u.length !== layer.shape[0] * layer.shape[1]) return null;
    return u.subarray(strip.rowIdx * strip.width, (strip.rowIdx + 1) * strip.width);
  }, [det.data, strip]);

  const pairInfo = useMemo(() => {
    const inp = (verdict.result?.detail as { inputs?: { selected_pair?: Record<string, unknown> } } | undefined)?.inputs;
    const p = inp?.selected_pair;
    if (!p) return null;
    return p as { stack?: string; ref_time?: string; sec_time?: string };
  }, [verdict.result]);

  return (
    <QuakeSection
      id="trace"
      channel="04"
      kicker="the strip"
      title="The radar trace"
      body="The station's own readout: line-of-sight ground motion across the middle of the tile, drawn straight from the engine's displacement raster — one ink line, every value the engine's. The marks underneath are where its detector fired on the same row."
    >
      {!target ? (
        <EmptyPanel title="no target set">
          Pick an earthquake in channel 01 — the strip fills as soon as a scan produces layers for
          its tile.
        </EmptyPanel>
      ) : !effectiveRunId ? (
        <EmptyPanel title="no layers yet">
          No scan result for this tile yet. {onGoto ? (
            <button
              type="button"
              onClick={() => onGoto("scan")}
              className="qp-readout ml-1 underline decoration-dotted underline-offset-4 text-[var(--qp-red)]"
            >
              Run the analysis (CH·03)
            </button>
          ) : null}{" "}
          — or an earlier verdict may exist for this tile, which the station picks up automatically.
        </EmptyPanel>
      ) : disp.isLoading ? (
        <LoadingPanel label="pulling the displacement raster from the engine" />
      ) : disp.isError ? (
        <ErrorPanel
          title="layer unreachable"
          message="The engine's displacement layer could not be fetched for this run."
          hint={disp.error instanceof Error ? disp.error.message : undefined}
        />
      ) : !strip ? (
        <EmptyPanel title="no displacement layer on this verdict">
          The engine produced no displacement raster for this run{layersListed.length ? ` (layers present: ${layersListed.join(", ")})` : ""}.
        </EmptyPanel>
      ) : (
        <Panel>
          <PanelHead
            title="LOS displacement · centre row profile"
            right={
              <span className="flex items-center gap-2">
                <Chip tone="accent">{strip.width} px</Chip>
                <Chip>row {strip.rowIdx}</Chip>
              </span>
            }
          />
          <div className="qp-trace-strip px-4 py-5">
            <TraceStrip
              values={strip.values}
              detected={detRow}
              vmin={disp.data?.layer.vmin ?? null}
              vmax={disp.data?.layer.vmax ?? null}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-[var(--qp-edge)] px-5 py-4 sm:grid-cols-4">
            <Readout
              label="pair"
              value={pairInfo ? `${pairInfo.stack ?? "?"} · ${String(pairInfo.ref_time ?? "").slice(0, 10)} → ${String(pairInfo.sec_time ?? "").slice(0, 10)}` : "—"}
              hint="The interferometric pair the engine selected for this verdict"
            />
            <Readout label="engine scale" value={`${fmtMm(disp.data?.layer.vmin ?? null, 0)} … ${fmtMm(disp.data?.layer.vmax ?? null, 0)}`} hint="The engine's own vmin/vmax for the full raster" />
            <Readout label="units" value={disp.data?.layer.units ?? "m (LOS)"} />
            <Readout label="full rasters" value={<span>on the map · CH·06</span>} hint="Displacement, threshold, detected and residual overlays" />
          </div>
          <p className="border-t border-[var(--qp-edge)] px-5 py-3 text-[11.5px] leading-relaxed text-[var(--qp-ink-2)]">
            {LOS_CONVENTION} Profile scale is a display axis around zero — the trace itself is
            untouched engine output. <Mono>{det.isError ? "detector layer unavailable for this run" : det.data ? "detector marks shown" : ""}</Mono>
          </p>
        </Panel>
      )}
    </QuakeSection>
  );
}

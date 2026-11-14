"use client";

/** LabLegend — the live colour bar + one-line legend for one engine image. Every number comes
 *  from the engine's metadata (cmap, scale, lo/hi, unit, data min/max, no-data share, dates for
 *  a diff); this component only paints them. The bar itself is the same gradient the engine's
 *  colour map produces, drawn as CSS from the two endpoints — the ENGINE chose the mapping, the
 *  browser just shows the ramp. Display only. */
import { previewLegend } from "@/lib/format";
import { dash } from "@/lib/explainCache";
import type { PreviewMeta } from "@/lib/types";

/** endpoint colours of the engine's colour maps (background_img.py anchors, first/last stop) */
const CMAP_ENDS: Record<string, [string, string]> = {
  viridis: ["rgb(68,1,84)", "rgb(253,231,37)"],
  diverging: ["rgb(45,80,190)", "rgb(178,24,43)"],
  magma: ["rgb(0,0,4)", "rgb(252,253,191)"],
  gray: ["rgb(15,15,15)", "rgb(240,240,240)"],
};
const MID: Record<string, string> = { diverging: "rgb(238,238,238)" };

function n(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(3)));
}

export default function LabLegend({ meta, label }: { meta: PreviewMeta | null; label?: string }) {
  if (!meta) return null;
  const ends = CMAP_ENDS[meta.cmap];
  const mid = MID[meta.cmap];
  const background = ends
    ? (mid
        ? `linear-gradient(90deg, ${ends[0]}, ${mid} 50%, ${ends[1]})`
        : `linear-gradient(90deg, ${ends[0]}, ${ends[1]})`)
    : "linear-gradient(90deg, #1c222b, #4a5462)";
  const d = meta.diff;
  return (
    <div className="rounded border border-[#262c36] bg-[#12161d] p-2 text-[10px] text-[#8b949e]" aria-label="layer legend">
      {label && <p className="mb-1 font-medium text-[#d9dee4]">{label}</p>}
      <div
        className="h-2.5 w-full rounded-sm border border-[#262c36]"
        style={{ background }}
        role="img"
        aria-label={`colour bar ${meta.cmap} from ${n(meta.lo)} to ${n(meta.hi)}`}
      />
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#aab3bd]">
        <span>{n(meta.lo)}</span>
        {d && <span className="text-[#7fd8e6]">{d.mode_label}</span>}
        <span>{n(meta.hi)}</span>
      </div>
      <p className="mt-1 leading-relaxed">{previewLegend(meta)}</p>
      {d && (
        <p className="mt-0.5 font-mono">
          {dash(d.date_a)} → {dash(d.date_b)} · gap {dash(d.gap_days)} d
          {!d.same_grid && d.resampled ? ` · ${d.resampled}` : ""}
        </p>
      )}
      {/* Phase 3 — line-of-sight referencing: stated whenever the values are converted phase */}
      {meta.los && (
        <p className="mt-0.5 font-mono text-[#7fd8e6]">
          LOS · ref {dash(meta.los.ref_time)} → sec {dash(meta.los.sec_time)}
          {meta.los.pair_flipped ? " · pair stored secondary-first (sign normalised)" : ""}
          {" · λ "}{dash(meta.los.wavelength_m)} m
        </p>
      )}
      {meta.los?.cc_gate && (
        <p className="mt-0.5 text-[#d9c98a]">{meta.los.cc_gate}</p>
      )}
      {d?.referencing && (
        <p className={"mt-0.5 " + (d.referencing.shared_reference_date ? "text-[#7fd8e6]" : "text-[#d9c98a]")}>
          {d.referencing.note}
        </p>
      )}
      {meta.notes?.slice(0, 3).map((note, i) => (
        <p key={i} className="mt-0.5 text-[#d9c98a]">{note}</p>
      ))}
    </div>
  );
}

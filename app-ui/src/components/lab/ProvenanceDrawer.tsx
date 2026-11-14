"use client";

/** ProvenanceDrawer — everything one engine image states about itself, in one collapsible
 *  drawer: granule id(s), layer path, what it is (explain.yaml, engine-served), unit, scale,
 *  colour range + whether it was fixed, grid/stride/epsg, no-data rule, the diff's pair facts
 *  (dates, gap, validation, same-grid), cache hit and generation time. Honesty rules: unknown
 *  is "—" (never "null"), assumptions and reasons are shown verbatim, and no sentence claims
 *  what changed. Pure display over the engine's own metadata. */
import { dash } from "@/lib/explainCache";
import { fmtUtc } from "@/lib/format";
import type { PreviewMeta } from "@/lib/types";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#1c222b] py-1">
      <dt className="shrink-0 text-[#8b949e]">{k}</dt>
      <dd className="text-right font-mono text-[10px] break-all text-[#e6eaee]">{v ?? "—"}</dd>
    </div>
  );
}

export default function ProvenanceDrawer({ meta, whatItIs, howToRead }: {
  meta: PreviewMeta | null;
  /** engine-served teaching text (explain.yaml) for this layer's role, when it has one */
  whatItIs?: string | null;
  howToRead?: string | null;
}) {
  if (!meta) {
    return <p className="p-2 text-[10px] text-[#5a636e]">no image loaded — nothing to describe yet.</p>;
  }
  const d = meta.diff;
  return (
    <div className="text-[10px]">
      <dl>
        <Row k="granule" v={d ? `${d.id_a} → ${d.id_b}` : meta.id} />
        <Row k="layer" v={meta.layer} />
        <Row k="what it is" v={whatItIs ?? "—"} />
        {howToRead && <Row k="how to read" v={howToRead} />}
        <Row k="unit" v={dash(meta.unit)} />
        <Row k="scale" v={dash(meta.scale)} />
        <Row k="colour range" v={`${dash(meta.lo)} … ${dash(meta.hi)}${meta.range_fixed ? " (fixed)" : " (stretched)"}`} />
        <Row k="grid" v={`epsg ${dash(meta.epsg)} · stride ${dash(meta.shown_stride)} · ${dash(meta.shown_shape?.join("×"))}`} />
        <Row k="no-data rule" v={dash(meta.nodata_rule)} />
        <Row k="no-data share" v={dash(meta.nan_fraction != null ? `${Math.round(meta.nan_fraction * 100)}%` : null)} />
        {d && <>
          <Row k="pair dates" v={`${dash(d.date_a)} → ${dash(d.date_b)}`} />
          <Row k="temporal gap" v={`${dash(d.gap_days)} days (${dash(d.gap_rule)})`} />
          <Row k="validated" v={`product ${dash(d.validation?.product)} · track ${dash(d.validation?.track)} · frame ${dash(d.validation?.frame)} · ${dash(d.validation?.direction)}`} />
          <Row k="grids" v={d.same_grid ? "same grid (pixel-for-pixel)" : dash(d.resampled)} />
        </>}
        <Row k="engine data min…max" v={`${dash(meta.stats?.min)} … ${dash(meta.stats?.max)}`} />
        <Row k="engine data mean" v={dash(meta.stats?.mean)} />
        <Row k="cache" v={meta.cache_hit ? "hit" : "miss (fresh render)"} />
        <Row k="generated" v={fmtUtc(meta.generated_at ?? null)} />
        <Row k="render version" v={dash(meta.render_version)} />
      </dl>
      {meta.notes?.length ? (
        <div className="mt-2">
          <p className="mb-1 text-[#8b949e]">engine notes</p>
          <ul className="list-outside list-disc pl-4 text-[#d9c98a]">
            {meta.notes.map((note, i) => <li key={i} className="mb-0.5">{note}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

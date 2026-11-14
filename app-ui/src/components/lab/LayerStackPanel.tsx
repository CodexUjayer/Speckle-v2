"use client";

/** LayerStackPanel — the Data Lab's left panel: the granule picker (via the engine's granule
 *  endpoint, same as the Explorer), the previewable layer list of the SELECTED granule, and
 *  "compare this layer" which arms the pair. Phase 1 scope: the compare pair IS the layer
 *  stack's active content (one layer at a time on the map); the many-overlays stack, reorder
 *  and per-layer opacity land with the layer-registry phase (D). Engine-decided only: the
 *  list comes from the inventory (previewable + diff_modes + what_it_is); this renders it. */
import { useEffect, useMemo, useState } from "react";
import { Layers } from "lucide-react";
import { bg } from "@/lib/bg";
import { dash } from "@/lib/explainCache";
import { fmtUtc } from "@/lib/format";
import type { ExplorerGranule, GranuleDetailResponse } from "@/lib/types";

type InvLayer = NonNullable<GranuleDetailResponse["inventory"]>["grids"][number]["layers"][number];

export default function LayerStackPanel({
  candidates, selectedId, layerKey, onSelect, onLayer, busy,
}: {
  candidates: ExplorerGranule[];
  selectedId: string;
  layerKey: string;
  onSelect: (id: string) => void;
  onLayer: (key: string) => void;
  busy: boolean;
}) {
  const [detail, setDetail] = useState<GranuleDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // the inventory of the selected granule (metadata only — the engine's own layer list)
  useEffect(() => {
    if (!selectedId) return;
    const ctrl = new AbortController();
    setError(null);
    setLoading(true);
    bg.granule(selectedId, ctrl.signal)
      .then((d) => { if (!ctrl.signal.aborted) { setDetail(d); setError(null); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [selectedId]);

  const layers = useMemo(
    () => (detail?.inventory?.grids ?? []).flatMap((g) => g.layers).filter((l) => l.previewable),
    [detail]);

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3 text-[11px]">
      {/* ---- granule picker ---- */}
      <label className="block">
        <span className="text-[#8b949e]">granule (the stack&apos;s acquisitions, oldest first)</span>
        <select
          aria-label="granule"
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          className="mt-0.5 w-full rounded border border-[#333b47] bg-[#0e1116] px-1.5 py-1 font-mono text-[10px] text-[#e6eaee] focus:border-[#3fb6c9] focus:outline-none"
        >
          {candidates.map((g) => (
            <option key={g.id} value={g.id}>{g.id} · {fmtUtc(g.start ?? g.ref_time ?? null)}</option>
          ))}
        </select>
      </label>

      {/* ---- layer list ---- */}
      <div>
        <p className="mb-1 flex items-center gap-1 text-[#8b949e]"><Layers size={11} aria-hidden /> layers (engine inventory)</p>
        {loading && <p role="status" className="text-[10px] text-[#8b949e]">reading the layer list (the engine reads the granule&apos;s HDF5 index)…</p>}
        {error && <p role="alert" className="text-[10px] text-[#e8a087]">{error}</p>}
        {!loading && !error && layers.length === 0 && (
          <p className="text-[10px] text-[#5a636e]">no previewable layer in this granule&apos;s inventory.</p>
        )}
        <ul className="space-y-1">
          {layers.map((l: InvLayer) => {
            const diff = l.diff_modes;
            const canDiff = Object.values(diff ?? {}).some((m) => m.valid);
            return (
              <li key={l.key}>
                <button
                  type="button"
                  aria-pressed={layerKey === l.key}
                  onClick={() => onLayer(l.key)}
                  title={l.what_it_is ?? undefined}
                  className={`w-full rounded border px-2 py-1 text-left font-mono text-[10px] break-all ${
                    layerKey === l.key
                      ? "border-[#3fb6c9] bg-[#12333a] text-[#7fd8e6]"
                      : "border-[#262c36] text-[#aab3bd] hover:border-[#4a5462]"
                  }`}
                >
                  {l.key.replace(/^science__LSAR__\w+__grids__frequency[AB]__/, "")}
                  <span className="ml-1 text-[9px] text-[#5a636e]">{dash(l.kind)}</span>
                  {canDiff && <span className="ml-1 text-[9px] text-[#e6c977]" title="this layer has a difference mode">∆</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {busy && <p role="status" className="text-[10px] text-[#8b949e]">the engine is drawing…</p>}
    </div>
  );
}

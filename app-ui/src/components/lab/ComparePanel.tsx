"use client";

/** ComparePanel — the Data Lab's compare controls: which two granules, which layer, which mode
 *  (before/after toggle · swipe · flicker · engine-computed difference), which difference mode.
 *  The ENGINE decides what is possible: diff modes arrive per-layer from the granule inventory
 *  (engine-annotated), and a disabled button shows its reason rather than silently vanishing.
 *  The range lock keeps two diffs on one colour range (the same rule the Explorer's Before/After
 *  applies to its two images): "lock to this" freezes lo/hi; the engine then draws with them. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Unlock } from "lucide-react";
import type { ExplorerGranule, GranuleDetailResponse } from "@/lib/types";
import { LAB_CORRS, LAB_DIFF_MODES, type LabCompareMode, type LabDiffMode, type LabCorr } from "@/lib/urlstate";
import { dash } from "@/lib/explainCache";
import { fmtUtc } from "@/lib/format";

type InvLayer = NonNullable<GranuleDetailResponse["inventory"]>["grids"][number]["layers"][number];

const MODES: { key: LabCompareMode; label: string; hint: string }[] = [
  { key: "before-after", label: "Before / After", hint: "toggle the two images in place (one fixed colour range)" },
  { key: "swipe", label: "Swipe", hint: "drag the divider: first date west, second date east" },
  { key: "flicker", label: "Flicker", hint: "alternate the two images automatically" },
  { key: "difference", label: "Difference", hint: "the engine subtracts the raw values and renders the result" },
];

export interface DiffRange { lo: number; hi: number }

export default function ComparePanel({
  candidates, beforeId, afterId, layerKey, invLayer, meta, lockedRange, compareMode, diffMode, corr,
  onBefore, onAfter, onLayer, onCompareMode, onDiffMode, onCorr, onLockRange, busy,
}: {
  candidates: ExplorerGranule[];
  beforeId: string;
  afterId: string;
  layerKey: string;
  /** the inventory row of the compared layer (engine-annotated: diff_modes, what_it_is, ...) */
  invLayer: InvLayer | null;
  /** the CURRENT image's engine metadata (the range inputs' source of truth) */
  meta: { lo: number; hi: number; unit?: string | null } | null;
  lockedRange: DiffRange | null;
  compareMode: LabCompareMode;
  diffMode: LabDiffMode;
  /** Phase 3: the active correction diagnostic (off = the layer itself) */
  corr: LabCorr;
  onBefore: (id: string) => void;
  onAfter: (id: string) => void;
  onLayer: (key: string) => void;
  onCompareMode: (m: LabCompareMode) => void;
  onDiffMode: (m: LabDiffMode) => void;
  onCorr: (c: LabCorr) => void;
  onLockRange: (r: DiffRange | null) => void;
  busy: boolean;
}) {
  const modes = invLayer?.diff_modes ?? null;
  const layers = [invLayer];      // the caller passes the layer it compared; the picker stays focused
  const [loText, setLoText] = useState("");
  const [hiText, setHiText] = useState("");
  const syncFromMeta = useRef(true);

  // the range inputs follow the engine's current range unless the person is typing; a partial
  // meta (still loading) has no finite lo/hi and is skipped — never NaN into an input
  useEffect(() => {
    if (!syncFromMeta.current || !meta) return;
    if (!Number.isFinite(meta.lo) || !Number.isFinite(meta.hi)) return;
    setLoText(String(Number(meta.lo.toPrecision(4))));
    setHiText(String(Number(meta.hi.toPrecision(4))));
  }, [meta]);
  const editRange = useCallback((setter: (v: string) => void, v: string) => {
    syncFromMeta.current = false;
    setter(v);
  }, []);
  const applyTyped = useCallback(() => {
    syncFromMeta.current = true;
    const lo = Number(loText), hi = Number(hiText);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) onLockRange({ lo, hi });
  }, [loText, hiText, onLockRange]);

  // what a lock would capture RIGHT NOW: the typed values when they form a range, else the
  // engine's current one. Nothing finite yet (no image loaded) = nothing to lock — the button
  // waits rather than pinning a nonsense 0..0 stretch onto the engine.
  const lockTarget: DiffRange | null = (() => {
    const lo = Number(loText), hi = Number(hiText);
    if (loText !== "" && hiText !== "" && Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return { lo, hi };
    if (meta && Number.isFinite(meta.lo) && Number.isFinite(meta.hi) && meta.lo < meta.hi)
      return { lo: meta.lo, hi: meta.hi };
    return null;
  })();
  const toggleLock = useCallback(() => {
    onLockRange(lockedRange ? null : lockTarget);
  }, [lockedRange, lockTarget, onLockRange]);

  return (
    <div className="space-y-3 p-3 text-[11px]">
      {/* ---- the pair ---- */}
      <div className="grid grid-cols-1 gap-2">
        <label className="block">
          <span className="text-[#8b949e]">first date (before)</span>
          <select
            aria-label="first date (before)"
            value={beforeId}
            onChange={(e) => onBefore(e.target.value)}
            className="mt-0.5 w-full rounded border border-[#333b47] bg-[#0e1116] px-1.5 py-1 font-mono text-[10px] text-[#e6eaee] focus:border-[#3fb6c9] focus:outline-none"
          >
            {candidates.map((g) => (
              <option key={g.id} value={g.id}>{g.id} · {fmtUtc(g.start ?? g.ref_time ?? null)}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[#8b949e]">second date (after)</span>
          <select
            aria-label="second date (after)"
            value={afterId}
            onChange={(e) => onAfter(e.target.value)}
            className="mt-0.5 w-full rounded border border-[#333b47] bg-[#0e1116] px-1.5 py-1 font-mono text-[10px] text-[#e6eaee] focus:border-[#3fb6c9] focus:outline-none"
          >
            {candidates.map((g) => (
              <option key={g.id} value={g.id}>{g.id} · {fmtUtc(g.start ?? g.ref_time ?? null)}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ---- compare mode ---- */}
      <fieldset>
        <legend className="mb-1 text-[#8b949e]">compare mode</legend>
        <div className="grid grid-cols-2 gap-1">
          {MODES.map((m) => {
            const needsDiff = m.key === "difference";
            const diffOk = !needsDiff || (modes?.[diffMode]?.valid ?? false);
            const reason = needsDiff && !diffOk ? (modes?.[diffMode]?.reason ?? "the engine has not said which differences this layer allows") : null;
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={compareMode === m.key}
                disabled={!diffOk}
                title={reason ?? m.hint}
                onClick={() => onCompareMode(m.key)}
                className={`rounded border px-2 py-1 text-[10px] ${
                  compareMode === m.key
                    ? "border-[#3fb6c9] bg-[#12333a] text-[#7fd8e6]"
                    : "border-[#333b47] text-[#aab3bd] hover:border-[#4a5462]"
                } ${!diffOk ? "cursor-not-allowed opacity-40" : ""}`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {compareMode === "difference" && modes?.[diffMode] && !modes[diffMode].valid && (
          <p role="alert" className="mt-1 text-[10px] text-[#e8a087]">{modes[diffMode].reason}</p>
        )}
      </fieldset>

      {/* ---- difference mode (engine-decided validity, reason on the disabled button) ---- */}
      {compareMode === "difference" && (
        <fieldset>
          <legend className="mb-1 text-[#8b949e]">difference the engine computes</legend>
          <div className="flex flex-wrap gap-1">
            {LAB_DIFF_MODES.map((m) => {
              const ok = modes?.[m]?.valid ?? false;
              const reason = modes?.[m]?.reason ?? null;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={diffMode === m}
                  disabled={!ok}
                  title={reason ?? undefined}
                  onClick={() => onDiffMode(m)}
                  className={`rounded border px-2 py-1 font-mono text-[10px] ${
                    diffMode === m
                      ? "border-[#e6c977] bg-[#2a2212] text-[#e6c977]"
                      : "border-[#333b47] text-[#aab3bd] hover:border-[#4a5462]"
                  } ${!ok ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  {m}
                </button>
              );
            })}
          </div>
          {modes?.[diffMode]?.reason && (
            <p className="mt-1 text-[10px] text-[#8b949e]">{modes[diffMode].reason}</p>
          )}
        </fieldset>
      )}

      {/* ---- Phase 3: correction diagnostics (engine-converted phase→LOS; GUNW phase layers) ---- */}
      {compareMode !== "difference" && (
        <fieldset>
          <legend className="mb-1 text-[#8b949e]">correction diagnostic (line-of-sight, engine-converted)</legend>
          <div className="flex flex-wrap gap-1">
            {LAB_CORRS.map((c) => {
              const label = c === "off" ? "off (the layer)" : c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={corr === c}
                  onClick={() => onCorr(c)}
                  title={c === "off" ? "show the layer itself"
                    : "the engine converts the product's own correction screen the same way it converts phase — a diagnostic, never removed from los_m"}
                  className={`rounded border px-2 py-1 font-mono text-[10px] ${
                    corr === c
                      ? "border-[#7fd8e6] bg-[#12333a] text-[#7fd8e6]"
                      : "border-[#333b47] text-[#aab3bd] hover:border-[#4a5462]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {corr !== "off" && (
            <p className="mt-1 text-[10px] text-[#8b949e]">
              diagnostic only: how much apparent LOS displacement this effect contributes — it is NOT removed from the converted layer
            </p>
          )}
        </fieldset>
      )}

      {/* ---- fixed range + lock ---- */}
      <div>
        <p className="mb-1 text-[#8b949e]">
          colour range {meta?.unit ? `(${dash(meta.unit)})` : ""}
          {lockedRange && <span className="text-[#e6c977]"> · locked</span>}
        </p>
        <div className="flex items-center gap-1">
          <label className="flex-1">
            <span className="sr-only">low end of the colour range</span>
            <input
              suppressHydrationWarning
              aria-label="low end of the colour range"
              value={loText}
              onChange={(e) => editRange(setLoText, e.target.value)}
              onBlur={applyTyped}
              onKeyDown={(e) => { if (e.key === "Enter") applyTyped(); }}
              className="w-full rounded border border-[#333b47] bg-[#0e1116] px-1.5 py-1 font-mono text-[10px] text-[#e6eaee] focus:border-[#3fb6c9] focus:outline-none"
            />
          </label>
          <span className="text-[#5a636e]">…</span>
          <label className="flex-1">
            <span className="sr-only">high end of the colour range</span>
            <input
              suppressHydrationWarning
              aria-label="high end of the colour range"
              value={hiText}
              onChange={(e) => editRange(setHiText, e.target.value)}
              onBlur={applyTyped}
              onKeyDown={(e) => { if (e.key === "Enter") applyTyped(); }}
              className="w-full rounded border border-[#333b47] bg-[#0e1116] px-1.5 py-1 font-mono text-[10px] text-[#e6eaee] focus:border-[#3fb6c9] focus:outline-none"
            />
          </label>
          <button
            type="button"
            aria-pressed={lockedRange != null}
            disabled={!lockedRange && !lockTarget}
            aria-label={lockedRange ? "unlock the colour range (stretch each image again)" : "lock the colour range to these values (two images stay comparable)"}
            title={lockedRange ? "unlock: each image stretches itself again"
              : lockTarget ? "lock: both images keep this exact range"
                : "nothing to lock yet — wait for the engine's first image"}
            onClick={toggleLock}
            className={`rounded border px-1.5 py-1 ${
              lockedRange ? "border-[#e6c977] text-[#e6c977]" : "border-[#333b47] text-[#8b949e] hover:border-[#4a5462]"
            } ${!lockedRange && !lockTarget ? "cursor-not-allowed opacity-40" : ""}`}
          >
            {lockedRange ? <Lock size={11} aria-hidden /> : <Unlock size={11} aria-hidden />}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-[#5a636e]">
          {busy ? "the engine is drawing…" : "type a range and press Enter to fix it; the lock keeps it across changes"}
        </p>
      </div>

      {/* ---- the layer (read-only line; picking happens in the stack panel) ---- */}
      <div>
        <p className="mb-0.5 text-[#8b949e]">layer</p>
        <p className="font-mono text-[10px] break-all text-[#e6eaee]">{dash(layers[0]?.key ?? layerKey)}</p>
        {invLayer?.what_it_is && <p className="mt-0.5 text-[10px] text-[#8b949e]">{invLayer.what_it_is}</p>}
      </div>
    </div>
  );
}

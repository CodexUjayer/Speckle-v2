"use client";

/** VerdictDock: the map's bottom sheet. It leads with the verdict in the engine's own sentence, kept to a size that
 *  leaves the map visible; under it sit the pictures the engine can draw for this tile (one chip each, loaded by
 *  themselves the moment a place is pinned) and the acquisition timeline (GCOV passes as dots, GUNW pairs as bars).
 *  "See why" folds the verdict down to one line and plays every difference between the passes around the verdict's
 *  pair on the map, with the engine's boxes marking the spots it flagged. Picking two marks on the timeline, or one of
 *  the bundle's other comparisons from the menu, shows those two instead. The sheet can be minimised to one line.
 *  Thin client: every sentence, picture, box and tier comes from the engine; this file arranges them. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GranulesState } from "@/lib/useGranules";
import type { TimelinePicks } from "@/lib/useTimelinePicks";
import type { VerdictUse } from "@/lib/verdictUse";
import { planWhy, type WhyPair } from "@/lib/whyPlan";
import { AUTOLOAD_DIFFS } from "@/lib/config";
import { usePairDifferences } from "@/lib/usePairDifferences";
import { useAreaDiffPictures, type AreaBox } from "@/lib/useAreaDiffPictures";
import { otherPairs, type PairChoice } from "@/lib/otherPairs";
import { PRODUCT_SHORT, shortDay } from "@/lib/diffModes";
import { modeRank } from "@/lib/diffModes";
import { tierTone, type Hotspot, type VerdictView } from "@/lib/verdictView";
import type { LayerPayload } from "@/lib/types";
import type { OverlaySpec } from "../GlobeMap";
import type { TimelineSelection } from "../GranuleTimeline";
import DockTimeline from "./DockTimeline";
import WhyPlayer from "./WhyPlayer";
import OverlayStrip, { chipKey, type StripGroup } from "./OverlayStrip";
import "./verdict-dock.css";
import { ScanStatusStrip, type ScanStatusInfo } from "../ScanStatus";
import { Dots } from "@/components/BigLoader";

export type DockMode = "verdict" | "why" | "compare";

export interface ScanOffer {
  canScan: boolean;
  /** why scanning is off, in the engine's words, when it is */
  reason: string | null;
  running: boolean;
  /** the engine's own stage text while a scan runs */
  stage: string | null;
  /** live facts about the running scan (tile n of m, step, elapsed, bytes): drawn as a strip at the top of the dock */
  status?: ScanStatusInfo | null;
  error: string | null;
  onScan: () => void;
}

export interface VerdictDockProps {
  pinned: boolean;
  /** the lead finding for this tile; null = none known yet */
  verdict: VerdictView | null;
  /** cached rows for the tile are still loading */
  verdictLoading: boolean;
  scan: ScanOffer;
  granules: GranulesState;
  picks: TimelinePicks;
  verdictUse: VerdictUse[];
  tileBbox: [number, number, number, number] | null;
  reducedMotion: boolean;
  /** phones: the timeline lives in the sheet's Data tab, the dock shows the verdict and the player */
  narrow: boolean;
  onOverlay: (o: OverlaySpec | null) => void;
  /** the other tiles of the scan box (the pinned one excluded, nearest the pin first): the chosen picture is drawn on them too */
  areaBoxes?: AreaBox[];
  onAreaOverlays?: (specs: OverlaySpec[]) => void;
  /** draw one result layer alone on the map (the previous one fades out); resolves to an error message, or null when drawn */
  showLayer: (pipeline: string, layer: string) => Promise<string | null>;
  loadLayer: (pipeline: string, layer: string) => Promise<LayerPayload>;
  clearLayers: () => void;
  onHotspots: (spots: Hotspot[]) => void;
  onFocusSpot: (id: string | null) => void;
  onFit: (bbox: [number, number, number, number]) => void;
  /** open the full result for a summary-only verdict so its boxes and pair facts exist (quiet = do not switch the side panel) */
  onLoadFull: (opts?: { quiet?: boolean }) => void;
  /** the engine answers (the pictures come from it) */
  engineOnline: boolean;
  /** load the pictures as soon as a place is pinned; defaults to NEXT_PUBLIC_AUTOLOAD_DIFFS (on) */
  autoload?: boolean;
  onOpenEvidence: () => void;
  onModeChange: (mode: DockMode) => void;
  onHeight: (px: number) => void;
}

const lsGet = (k: string): string | null => { try { return window.localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } };

/** keep the same plan object while its pairs are the same, so reloading the timeline window never restarts the pictures */
function useStablePlan(plan: WhyPair[]): WhyPair[] {
  const ref = useRef<{ sig: string; plan: WhyPair[] }>({ sig: "", plan: [] });
  const sig = plan.map((p) => `${p.kind}|${p.pair.a.id}|${p.pair.b.id}`).join(";");
  if (sig !== ref.current.sig) ref.current = { sig, plan };
  return ref.current.plan;
}

const settledOrAbsent = (d: { finished: boolean; invError: unknown }, has: boolean) =>
  !has || d.finished || !!d.invError;

export default function VerdictDock(props: VerdictDockProps) {
  const { verdict, granules, picks } = props;
  const autoload = props.autoload ?? AUTOLOAD_DIFFS;
  const [mode, setMode] = useState<DockMode>("verdict");
  const [wantWhy, setWantWhy] = useState(false);
  const [plan, setPlan] = useState<WhyPair[]>([]);               // the two the person picked on the timeline (compare mode)
  const [highlight, setHighlight] = useState<{ a: TimelineSelection; b: TimelineSelection } | null>(null);
  const [focus, setFocus] = useState<{ from: number; to: number; key: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // the dock's own size choices, remembered in this browser (a phone-sized or short window starts with the timeline folded)
  const [minimized, setMinimized] = useState(false);
  const [tlOpen, setTlOpen] = useState(true);
  useEffect(() => {
    if (lsGet("dock-min") === "1") setMinimized(true);
    const t = lsGet("dock-tl");
    if (t === "0") setTlOpen(false);
    else if (t === null && window.innerHeight < 860) setTlOpen(false);
  }, []);
  const toggleMin = () => setMinimized((v) => { lsSet("dock-min", v ? "0" : "1"); return !v; });
  const toggleTl = () => setTlOpen((v) => { lsSet("dock-tl", v ? "0" : "1"); return !v; });

  // report the dock's height so the map and the side panels can keep clear of it
  useEffect(() => {
    const el = rootRef.current;
    if (!el) { props.onHeight(0); return; }
    const ro = new ResizeObserver(() => props.onHeight(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => { ro.disconnect(); props.onHeight(0); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pinned]);

  const setModeBoth = useCallback((m: DockMode) => { setMode(m); props.onModeChange(m); }, [props]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the pictures: planned from the granule list and loaded by themselves once a place has settled ------------------
  const tileKey = props.tileBbox ? props.tileBbox.join(",") : "";
  const autoPlan = useStablePlan(useMemo(() => planWhy(granules.data, props.verdictUse).pairs, [granules.data, props.verdictUse]));
  const activePlan = mode === "compare" ? plan : autoPlan;
  const [extra, setExtra] = useState<PairChoice | null>(null);   // one of the bundle's other comparisons, picked from the menu
  const [manual, setManual] = useState(false);                    // "Load the pictures" when autoload is switched off
  const [settled, setSettled] = useState(false);                  // the pin stayed put for a moment: now start reading
  useEffect(() => {
    setSettled(false);
    if (!tileKey) return;
    const t = setTimeout(() => setSettled(true), 1200);
    return () => clearTimeout(t);
  }, [tileKey]);
  const wantDiffs = props.pinned && props.engineOnline && !!props.tileBbox
    && (mode !== "verdict" || wantWhy || manual || !!extra || (autoload && settled));
  const [prio, setPrio] = useState<{ idx: number; id: string }>({ idx: -1, id: "" });
  const prioFor = (i: number) => (prio.idx === i ? prio.id : "");
  const pairA = activePlan[0]?.pair ?? null;
  const pairB = activePlan[1]?.pair ?? null;
  // the engine reads one file at a time, so the sets go in turn: the first pair, the extra comparison if one is picked, then the second pair
  const dA = usePairDifferences(pairA, props.tileBbox, wantDiffs && !!pairA, prioFor(0));
  const dC = usePairDifferences(extra?.pair ?? null, props.tileBbox, wantDiffs && !!extra && settledOrAbsent(dA, !!pairA), prioFor(2));
  const dB = usePairDifferences(pairB, props.tileBbox, wantDiffs && !!pairB && settledOrAbsent(dA, !!pairA) && (!extra || settledOrAbsent(dC, true)), prioFor(1));
  const choices = useMemo(() => otherPairs(granules.data, autoPlan), [granules.data, autoPlan]);

  // the summary-only verdict is opened in full on its own (quietly: the side panel stays where it is), so the pictures the
  // verdict was built from and its boxes are there for "See why" without a click
  const fullRequested = useRef("");
  useEffect(() => {
    if (!props.pinned || !autoload || !verdict || verdict.full || !verdict.bundleId) return;
    if (fullRequested.current === verdict.bundleId) return;
    fullRequested.current = verdict.bundleId;
    props.onLoadFull({ quiet: true });
  }, [props.pinned, autoload, verdict, props]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- which picture the dock keeps on the map while the verdict is showing ----------------------------------------------
  const groups = useMemo<StripGroup[]>(() => {
    const out: StripGroup[] = [];
    const cap = (kind: "gcov" | "gunw", stackKey: string, d: typeof dA) =>
      `${stackKey} ${PRODUCT_SHORT[kind]}${d.first && d.second ? `, ${shortDay(d.first.time)} to ${shortDay(d.second.time)}` : ""}`;
    activePlan.slice(0, 2).forEach((p, idx) => out.push({ idx, caption: cap(p.kind, p.stackKey, idx === 0 ? dA : dB), d: idx === 0 ? dA : dB }));
    if (extra) out.push({ idx: 2, caption: cap(extra.kind, extra.stackKey, dC), d: dC });
    return out;
  }, [activePlan, extra, dA, dB, dC]);
  const chips = useMemo(() => groups.flatMap((g) => g.d.tiles
    .filter((t) => g.d.thumbs[t.id]?.status === "ok")
    .sort((x, y) => modeRank(x.mode) - modeRank(y.mode))
    .map((t) => ({ key: chipKey(g.idx, t.id), idx: g.idx, g, t }))), [groups]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [overlayOn, setOverlayOn] = useState(true);
  const touched = useRef(false);                 // the person chose (or switched pictures off): never pick for them again on this tile
  const wantExtraPick = useRef(false);
  useEffect(() => {
    if (mode !== "verdict") return;
    if (wantExtraPick.current) {
      const first = chips.find((c) => c.idx === 2);
      if (first) { wantExtraPick.current = false; setChosen(first.key); setOverlayOn(true); touched.current = true; }
      return;
    }
    if (touched.current || (chosen && chips.some((c) => c.key === chosen))) return;
    if (chips.length > 0) setChosen(chips[0].key);          // the first picture that is ready goes on the map by itself
  }, [chips, chosen, mode]);
  const chip = chips.find((c) => c.key === chosen) ?? null;
  const thumb = chip ? chip.g.d.thumbs[chip.t.id] : undefined;
  const drew = useRef(false);
  const overlayRef = useRef(props.onOverlay);
  overlayRef.current = props.onOverlay;
  useEffect(() => {
    if (mode !== "verdict") return;
    const c = thumb?.meta?.corners_lonlat;
    if (overlayOn && chip && thumb?.status === "ok" && thumb.url && c) {
      const lons = c.map((q) => q[0]), lats = c.map((q) => q[1]);
      overlayRef.current({
        id: `overlay:dock:${chip.key}:${thumb.url.slice(-10)}`, dataUrl: thumb.url, opacity: 0.86, corners: c,
        bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      });
      drew.current = true;
    } else if (drew.current) { overlayRef.current(null); drew.current = false; }
  }, [mode, overlayOn, chosen, thumb?.url]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the same picture on every other tile of the scan box: same pair, layer and mode as the chosen chip, the pinned tile's colour range.
  // It starts once this chip's own pair has finished loading, so the engine is not asked for two things at once.
  const areaOn = mode === "verdict" && overlayOn && !!chip && thumb?.status === "ok" && (chip.g.d.finished || !!chip.g.d.invError);
  const areaDiff = useAreaDiffPictures({
    enabled: areaOn, firstId: chip?.g.d.first?.id ?? null, secondId: chip?.g.d.second?.id ?? null,
    layerKey: chip?.t.layerKey ?? null, mode: chip?.t.mode ?? null,
    range: thumb?.meta && Number.isFinite(thumb.meta.lo) && Number.isFinite(thumb.meta.hi) ? { lo: thumb.meta.lo, hi: thumb.meta.hi } : null,
    boxes: props.areaBoxes ?? [],
  });
  const areaCb = useRef(props.onAreaOverlays);
  areaCb.current = props.onAreaOverlays;
  useEffect(() => { areaCb.current?.(areaDiff.specs); }, [areaDiff.specs]);
  useEffect(() => () => { areaCb.current?.([]); }, []);

  const choose = (key: string | null) => {
    touched.current = true;
    if (key === null) { setOverlayOn(false); return; }
    setChosen(key); setOverlayOn(true);
  };
  const chooseExtra = (key: string | null) => {
    const c = key ? choices.find((x) => x.key === key) ?? null : null;
    setExtra(c);
    if (c) { wantExtraPick.current = true; touched.current = false; }
    else { wantExtraPick.current = false; if (chosen?.startsWith("2:")) { setChosen(null); touched.current = false; } }
  };

  const leave = useCallback(() => {
    setWantWhy(false);
    setModeBoth("verdict");
    setPlan([]); setHighlight(null); setFocus(null);
    props.onOverlay(null); props.clearLayers(); props.onHotspots([]); props.onFocusSpot(null);
    picks.clear();
    drew.current = false;
  }, [picks, props, setModeBoth]);

  // a new tile starts over
  useEffect(() => {
    setMode("verdict"); setWantWhy(false); setPlan([]); setHighlight(null); setFocus(null);
    setExtra(null); setManual(false); setChosen(null); setOverlayOn(true); touched.current = false; wantExtraPick.current = false; drew.current = false;
    setPrio({ idx: -1, id: "" });
    props.onModeChange("verdict"); props.onHotspots([]); props.onOverlay(null);
  }, [tileKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- See why: wait for the full result and the granule list, then start (the pictures are usually loaded by now) -------
  const startWhy = useCallback(() => {
    if (!verdict) return;
    if (!verdict.full && verdict.bundleId) props.onLoadFull();
    setWantWhy(true);
  }, [verdict, props]);
  useEffect(() => {
    if (!wantWhy || mode !== "verdict" || !verdict) return;
    if (!verdict.full && verdict.bundleId) return;          // still opening the full result
    if (!granules.data) return;                              // still listing the passes
    setWantWhy(false);
    setModeBoth("why");
    if (props.tileBbox) props.onFit(props.tileBbox);
  }, [wantWhy, mode, verdict, granules.data, props, setModeBoth]);

  const startCompare = useCallback(() => {
    if (!picks.picked || !picks.selection || !picks.selectionB) return;
    setPlan([{ kind: picks.picked.kind, stackKey: picks.picked.stackKey, a: picks.selection, b: picks.selectionB, pair: picks.picked, basis: "the two you picked" }]);
    setModeBoth("compare");
    props.onHotspots([]);
    if (props.tileBbox) props.onFit(props.tileBbox);
  }, [picks, props, setModeBoth]);

  const onTimeline = useCallback((h: { a: TimelineSelection; b: TimelineSelection } | null, f: { from: number; to: number; key: string } | null) => {
    setHighlight(h); setFocus(f);
  }, []);

  // Escape leaves the player
  useEffect(() => {
    if (mode === "verdict") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); leave(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, leave]);

  const used = useMemo(() => props.verdictUse.find((u) => u.selected) ?? null, [props.verdictUse]);

  if (!props.pinned) {
    return (
      <div className="vd-root" ref={rootRef} style={{ textAlign: "center" }}>
        <span className="vd-hint" data-testid="dock-hint">Tap anywhere on the map to see what the radar saw there.</span>
      </div>
    );
  }

  const compact = mode !== "verdict";
  const isMin = minimized && !compact;
  const tone = verdict ? tierTone(verdict.tier) : "unknown";
  const scanning = props.scan.running;
  const sentence = verdict
    ? verdict.sentence
    : scanning ? "Reading the radar passes over this tile."
      : props.verdictLoading ? "Checking for a saved verdict."
        : "No verdict for this tile yet.";

  const showTimeline = !props.narrow;
  const tl = granules;
  const hasStacks = !!tl.data && Object.keys(tl.data.stacks).length > 0;
  const dayTxt = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const nPasses = tl.data ? Object.values(tl.data.stacks).reduce((n, st) => n + st.gcov.length, 0) : 0;
  const nPairs = tl.data ? Object.values(tl.data.stacks).reduce((n, st) => n + st.gunw.length, 0) : 0;

  return (
    <div className="vd-root" ref={rootRef}>
      <section className={`vd-sheet${compact ? " vd-compact" : ""}${isMin ? " vd-min" : ""}`} aria-label="Verdict" data-mode={mode} data-testid="verdict-dock">
        {props.scan.status && (
          <ScanStatusStrip
            s={props.scan.status} tone="dark"
            note={verdict ? "The verdict below is from an earlier scan; it updates when this one finishes." : undefined}
          />
        )}
        <div className="vd-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {(compact || isMin) && verdict && <span className="vd-tier" data-tone={tone}><span className="vd-tier-dot" /></span>}
              <p className="vd-sentence" data-testid="verdict-sentence" aria-live="polite" title={isMin ? sentence : undefined}>
                {sentence}
                {!verdict && (props.verdictLoading || scanning) && <Dots className="ml-2 align-middle text-[10px] text-[var(--vd-ink-3)]" />}
              </p>
            </div>
            <div className="vd-meta">
              {verdict ? (
                <>
                  <span className="vd-tier" data-tone={tone}><span className="vd-tier-dot" />{verdict.tierLabel}</span>
                  <span>{verdict.hazard}</span>
                  {used && <span>Based on the pair {dayTxt(used.ref_time)} to {dayTxt(used.sec_time)}</span>}
                  {verdict.alsoNotable > 0 && <span>{verdict.alsoNotable} other check{verdict.alsoNotable === 1 ? "" : "s"} flagged too</span>}
                </>
              ) : scanning && props.scan.stage ? (
                <span>{props.scan.stage}</span>
              ) : !props.verdictLoading ? (
                <span>{props.scan.canScan ? "A scan reads the radar passes over this tile and checks them for changes." : props.scan.reason ?? "Scanning is not available right now."}</span>
              ) : null}
              {props.scan.error && <span role="alert">{props.scan.error}</span>}
            </div>
          </div>
          <div className="vd-actions" style={{ visibility: compact ? "hidden" : "visible", height: compact ? 0 : undefined }}>
            {verdict ? (
              <button type="button" className="vd-btn" onClick={startWhy} disabled={wantWhy} data-testid="see-why">
                {wantWhy ? "Getting ready" : "See why"}
              </button>
            ) : (
              <button type="button" className="vd-btn" onClick={props.scan.onScan} disabled={!props.scan.canScan || scanning || props.verdictLoading}>
                {scanning ? "Scanning" : "Scan this tile"}
              </button>
            )}
            <button type="button" className="vd-btn" data-quiet="1" onClick={toggleMin} aria-expanded={!isMin}
                    aria-label={isMin ? "Show the full panel" : "Fold the panel to one line"} data-testid="dock-min">
              {isMin ? "Expand" : "Fold"}
            </button>
          </div>
        </div>

        <div className="vd-stage" data-open={compact ? "1" : "0"}>
          <div>
            {compact && (
              <WhyPlayer
                key={mode}
                plan={activePlan}
                diffs={[dA, dB]}
                onPriority={(idx, id) => setPrio({ idx, id })}
                verdict={mode === "why" ? verdict : null}
                bbox={props.tileBbox}
                reducedMotion={props.reducedMotion}
                onOverlay={props.onOverlay}
                showLayer={props.showLayer}
                loadLayer={props.loadLayer}
                clearLayers={props.clearLayers}
                onHotspots={props.onHotspots}
                onTimeline={onTimeline}
                onFocusSpot={props.onFocusSpot}
                onExit={leave}
                onEvidence={mode === "why" ? () => { props.onOpenEvidence(); leave(); } : undefined}
              />
            )}
          </div>
        </div>

        {!compact && !isMin && hasStacks && (
          (wantDiffs || autoload) ? (groups.length > 0 || choices.length > 0) && (
            <OverlayStrip
              groups={groups} chosen={chosen} overlayOn={overlayOn} onChoose={choose}
              choices={choices} extra={extra} onExtra={chooseExtra} area={areaDiff}
            />
          ) : props.engineOnline && !!props.tileBbox ? (
            <div className="vd-ov"><div className="vd-ov-row">
              <button type="button" className="vd-btn" data-quiet="1" onClick={() => setManual(true)} data-testid="load-pictures">Load the pictures for this tile</button>
            </div></div>
          ) : null
        )}

        {showTimeline && !isMin && (
          <div className="vd-tl-wrap">
            {tl.loading && !tl.data && (
              <>
                <div className="vd-skel" aria-busy="true" aria-label="Looking for radar passes" />
                <p className="vd-note vd-loading" style={{ marginTop: 8 }}>Looking for radar passes over this tile <Dots className="text-[8px]" /></p>
              </>
            )}
            {tl.error && <p className="vd-note" role="alert">{tl.error}</p>}
            {tl.data && !hasStacks && (
              <p className="vd-note">No GUNW or GCOV passes were found over this tile in the search window.</p>
            )}
            {hasStacks && tl.data && tlOpen && (
              <DockTimeline
                data={tl.data}
                verdictUse={props.verdictUse}
                selection={picks.selection}
                selectionB={picks.selectionB}
                onSelect={picks.onSelect}
                highlight={highlight}
                focus={focus}
                reducedMotion={props.reducedMotion}
              />
            )}
            {hasStacks && (
              <div className="vd-legend">
                {tlOpen ? (
                  <>
                    <span><i className="k-dot" />GCOV pass</span>
                    <span><i className="k-bar" />GUNW pair</span>
                    {props.verdictUse.length > 0 && <span><i className="k-use" />Used by the verdict</span>}
                  </>
                ) : (
                  <span>Timeline: {nPasses} pass{nPasses === 1 ? "" : "es"}, {nPairs} pair{nPairs === 1 ? "" : "s"}</span>
                )}
                <span className="grow" />
                {tlOpen && mode === "verdict" && picks.picked ? (
                  <button type="button" className="vd-btn" onClick={startCompare} data-testid="compare-two">Compare these two</button>
                ) : tlOpen && mode === "verdict" ? (
                  <span>{picks.selection ? "Now pick a second one in the same row to compare" : "Click two marks in a row to compare them"}</span>
                ) : null}
                <button type="button" className="vd-link" data-hl={tlOpen ? "0" : "1"} onClick={toggleTl} aria-expanded={tlOpen} data-testid="timeline-toggle">
                  {tlOpen ? "Hide timeline" : "Show timeline"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

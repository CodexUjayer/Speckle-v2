"use client";

/** WhyPlayer: the "See why" walk-through. One tour, three kinds of step, all of it the engine's own material:
 *   1. the pictures the verdict was built from (its result layers, with the engine's note and the boxes it drew on each);
 *   2. every difference the engine defines between the passes either side of the verdict's pair (backscatter, coherence,
 *      ground movement), drawn one at a time as the engine serves them;
 *   3. "What it points to": the hazard, the engine's sentence and what the status means, with every flagged spot boxed.
 *  Steps 1 and 3 need nothing beyond the open result, so the tour works on cached verdicts;
 *  step 2 is added as pictures arrive and is skipped, with one quiet line, when the layers are missing.
 *  A switch (Merged / Ascending / Descending) picks which radar geometry the result layers show: one geometry only
 *  sees part of the ground, so Merged is the default and the single-pass pictures are one tap away.
 *  Auto-advances; any tap pauses. Keys: arrows step, space plays or pauses, Esc leaves (handled by the dock). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewLegend } from "@/lib/format";
import type { DiffTile, PairDifferences } from "@/lib/usePairDifferences";
import { MODE_NAME, modeRank, PRODUCT_NAME, shortDay } from "@/lib/diffModes";
import { buildLayerSteps, familyOf, fromName, geometryViews, VIEW_LABEL, type GeometryView, type LayerStep } from "@/lib/whyLayers";
import type { WhyPair } from "@/lib/whyPlan";
import { tidy, type Hotspot, type VerdictView } from "@/lib/verdictView";
import type { LayerPayload } from "@/lib/types";
import type { OverlaySpec } from "../GlobeMap";
import type { TimelineSelection } from "../GranuleTimeline";

const DWELL_MS = 5200;
/** a layer counts as drawn once the map has had time to take the picture and finish its fade-in (GlobeMap's OVERLAY_FADE_MS is 420) */
const SETTLE_MS = 480;

const gapDays = (a: string | null, b: string | null) => {
  const x = Date.parse(a ?? ""), y = Date.parse(b ?? "");
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round(Math.abs(y - x) / 86_400_000) : null;
};
const describeLayer = (pl: LayerPayload) =>
  [pl.note ? tidy(pl.note) : "", pl.units ? `Shown in ${pl.units}.` : ""].filter(Boolean).join(" ");

type Step =
  | { type: "layer" | "text"; key: string; label: string; ls: LayerStep }
  | { type: "diff"; key: string; label: string; pairIdx: number; tile: DiffTile }
  | { type: "outro"; key: string; label: string };
const OUTRO = "outro";

export interface WhyPlayerProps {
  plan: WhyPair[];
  /** the differences for plan[0] and plan[1]: the dock loads them (from the moment a place is pinned), the player plays them */
  diffs: [PairDifferences, PairDifferences];
  /** which picture the player wants drawn next (pair 0 or 1, tile id) */
  onPriority: (pairIdx: number, tileId: string) => void;
  verdict: VerdictView | null;
  bbox: [number, number, number, number] | null;
  reducedMotion: boolean;
  /** a SAR difference picture (corners from the engine), or null */
  onOverlay: (o: OverlaySpec | null) => void;
  /** draw one result layer alone on the map; resolves to an error message, or null when it is drawn */
  showLayer: (pipeline: string, layer: string) => Promise<string | null>;
  loadLayer: (pipeline: string, layer: string) => Promise<LayerPayload>;
  clearLayers: () => void;
  onHotspots: (spots: Hotspot[]) => void;
  onTimeline: (h: { a: TimelineSelection; b: TimelineSelection } | null, focus: { from: number; to: number; key: string } | null) => void;
  onFocusSpot: (id: string | null) => void;
  onExit: () => void;
  onEvidence?: () => void;
}

export default function WhyPlayer(props: WhyPlayerProps) {
  const { plan, verdict } = props;
  const live = useRef(props);
  live.current = props;
  const [currentKey, setCurrentKey] = useState("");
  const [paused, setPaused] = useState(false);
  const [pictureOn, setPictureOn] = useState(true);
  const [layerState, setLayerState] = useState<Record<string, { ready: boolean; body?: string; err?: string }>>({});

  // ---- the two SAR difference sets: loaded by the dock, so they are usually already drawn when the tour starts ----
  const pairA = plan[0] ?? null;
  const pairB = plan[1] ?? null;
  const [dA, dB] = props.diffs;
  const hooks = [dA, dB];
  const settled = (d: typeof dA, has: boolean) => !has || d.finished || !!d.invError;
  const diffsSettled = settled(dA, !!pairA) && settled(dB, !!pairB);

  // ---- the ordered steps ----------------------------------------------------------------------------------------
  const views = useMemo(() => geometryViews(verdict), [verdict]);
  const [viewPick, setViewPick] = useState<GeometryView | null>(null);
  const view: GeometryView | null = views.length === 0 ? null : (viewPick && views.includes(viewPick) ? viewPick : views[0]);   // merged is listed first: the default
  const layerSteps = useMemo(() => (verdict ? buildLayerSteps(verdict, view) : []), [verdict, view]);
  const steps: Step[] = useMemo(() => {
    const out: Step[] = layerSteps.map((ls) => ({ type: ls.kind, key: ls.key, label: ls.title, ls }));
    [dA, dB].forEach((d, pairIdx) => {
      const tiles = d.tiles.filter((t) => d.thumbs[t.id]?.status !== "err").sort((x, y) => modeRank(x.mode) - modeRank(y.mode));
      for (const t of tiles) {
        const same = tiles.filter((q) => q.mode === t.mode).length;
        const base = MODE_NAME[t.mode] ?? d.thumbs[t.id]?.meta?.diff?.mode_label ?? t.mode;
        out.push({ type: "diff", key: `d${pairIdx}:${t.id}`, label: `${base}${same > 1 ? `, ${t.layerKey.split("/").pop()}` : ""}`, pairIdx, tile: t });
      }
    });
    if (verdict) out.push({ type: "outro", key: OUTRO, label: "What it points to" });
    return out;
  }, [layerSteps, verdict, dA.tiles, dA.thumbs, dB.tiles, dB.thumbs]);  // eslint-disable-line react-hooks/exhaustive-deps

  const lastIdx = useRef(0);
  useEffect(() => {
    if (steps.length === 0) return;
    if (!steps.some((s) => s.key === currentKey)) {
      // first step, or the current picture failed: move to whatever now sits at its place
      setCurrentKey((steps[Math.min(lastIdx.current, steps.length - 1)] ?? steps[0]).key);
    }
  }, [steps, currentKey]);

  // switching geometry keeps the person on the same kind of picture (threshold stays threshold)
  const switchView = useCallback((next: GeometryView) => {
    if (next === view) return;
    const cur = steps.find((s) => s.key === currentKey);
    const fam = cur && (cur.type === "layer" || cur.type === "text") ? familyOf(cur.ls.layer) : null;
    if (fam) {
      const nextSteps = verdict ? buildLayerSteps(verdict, next) : [];
      const hit = nextSteps.find((s) => familyOf(s.layer) === fam);
      if (hit) setCurrentKey(hit.key);
    }
    setViewPick(next);
  }, [view, steps, currentKey, verdict]);

  const idx = steps.findIndex((s) => s.key === currentKey);
  lastIdx.current = Math.max(0, idx);
  const step = idx >= 0 ? steps[idx] : null;
  useEffect(() => { if (step?.type === "diff") live.current.onPriority(step.pairIdx, step.tile.id); }, [step?.key]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- readiness of the step on screen ---------------------------------------------------------------------------
  const thumb = step?.type === "diff" ? hooks[step.pairIdx].thumbs[step.tile.id] : undefined;
  const diffReady = thumb?.status === "ok";
  const ls = step && (step.type === "layer" || step.type === "text") ? layerState[step.key] : undefined;
  const ready = !step ? false
    : step.type === "diff" ? diffReady
      : step.type === "layer" ? !!ls?.ready
        : true;

  // ---- layer steps: draw the result layer alone (the previous one fades out as this one fades in) -----------------
  useEffect(() => {
    if (!step || step.type !== "layer" || !step.ls.pipeline || !step.ls.layer) return;
    const { pipeline, layer } = step.ls as { pipeline: string; layer: string };
    const key = step.key;
    let alive = true;
    live.current.onOverlay(null);
    void (async () => {
      // coming back to a step: it is not drawn until it has been drawn again (no skeleton-free caption, no early boxes)
      setLayerState((m) => (m[key]?.ready ? { ...m, [key]: { ready: false, body: m[key].body } } : m));
      const err = await live.current.showLayer(pipeline, layer);
      if (!alive) return;
      if (err) { setLayerState((m) => ({ ...m, [key]: { ready: true, err } })); return; }
      let body: string | undefined;
      try { body = describeLayer(await live.current.loadLayer(pipeline, layer)) || undefined; } catch { /* the caption stays empty: nothing is invented */ }
      if (!alive) return;
      if (!live.current.reducedMotion) await new Promise<void>((r) => setTimeout(r, SETTLE_MS));   // let the map draw it before boxes and the timer start
      if (!alive) return;
      setLayerState((m) => ({ ...m, [key]: { ready: true, body } }));
    })();
    return () => { alive = false; };
  }, [step?.key]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- diff steps: the engine's placed picture on the map ----------------------------------------------------------
  useEffect(() => {
    if (step?.type === "diff") {
      live.current.clearLayers();
      const c = thumb?.meta?.corners_lonlat;
      if (diffReady && thumb?.url && c && pictureOn) {
        const lons = c.map((p) => p[0]), lats = c.map((p) => p[1]);
        live.current.onOverlay({
          id: `overlay:diff:${step.key}:${thumb.url.slice(-10)}`,
          dataUrl: thumb.url, opacity: 0.86, corners: c,
          bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        });
      } else live.current.onOverlay(null);
    } else if (step && step.type !== "layer") {                // a text step or the conclusion: the map shows the plain imagery
      live.current.clearLayers();
      live.current.onOverlay(null);
    }
  }, [step?.key, diffReady, thumb?.url, pictureOn]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    const p = live.current;
    p.onOverlay(null); p.clearLayers(); p.onHotspots([]); p.onTimeline(null, null); p.onFocusSpot(null);
  }, []);

  // ---- boxes: after the picture is up, the ones that belong to this step ------------------------------------------
  const shownBoxes = useRef("");
  useEffect(() => {
    let boxes: Hotspot[] = [];
    if (step && ready) {
      if (step.type === "layer" || step.type === "text") boxes = step.ls.boxes;
      else boxes = verdict?.hotspots ?? [];
    }
    const sig = boxes.map((b) => b.id).join("|");
    if (sig === shownBoxes.current) return;
    shownBoxes.current = sig;
    live.current.onHotspots(boxes);
  }, [step?.key, ready, verdict]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the timeline follows the compared pair ----------------------------------------------------------------------
  const activePair = step?.type === "diff" ? plan[step.pairIdx] : null;
  const activePairKey = activePair ? `${activePair.a.kind}${activePair.a.index}-${activePair.b.index}` : "";
  useEffect(() => {
    if (!activePair || !step || step.type !== "diff") { live.current.onTimeline(null, null); return; }
    const d = hooks[step.pairIdx];
    const f = Date.parse(d.first?.time ?? ""), s = Date.parse(d.second?.time ?? "");
    live.current.onTimeline(
      { a: activePair.a, b: activePair.b },
      Number.isFinite(f) && Number.isFinite(s) ? { from: Math.min(f, s), to: Math.max(f, s), key: activePairKey } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePairKey, dA.first?.time, dB.first?.time]);

  // conclusion: bring the first box into view
  useEffect(() => {
    live.current.onFocusSpot(step?.type === "outro" && verdict?.hotspots[0] ? verdict.hotspots[0].id : null);
  }, [step?.type, verdict]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- moving between steps ------------------------------------------------------------------------------------------
  const go = useCallback((n: number, user: boolean) => {
    if (user) setPaused(true);
    const target = steps[Math.max(0, Math.min(steps.length - 1, n))];
    if (target) setCurrentKey(target.key);
  }, [steps]);
  useEffect(() => {
    if (paused || !step || !ready || step.type === "outro") return;
    const t = setTimeout(() => {
      const next = steps[idx + 1];
      if (next) setCurrentKey(next.key);
      else if (!diffsSettled) { /* pictures are still being drawn: hold here, the step list grows */ }
      else setPaused(true);                                       // the tour has finished
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [paused, step, ready, idx, steps, diffsSettled]);

  // keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1, true); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1, true); }
      else if (e.key === " " && !(t && t.tagName === "BUTTON")) { e.preventDefault(); setPaused((p) => !p); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, idx]);

  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-current="step"]')
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: props.reducedMotion ? "auto" : "smooth" });
  }, [currentKey, props.reducedMotion]);

  // ---- words ----------------------------------------------------------------------------------------------------------
  const hardError = dA.invError ?? dB.invError;
  const d = step?.type === "diff" ? hooks[step.pairIdx] : null;
  const pairInfo = step?.type === "diff" && d?.first && d.second
    ? `${PRODUCT_NAME[plan[step.pairIdx].kind]}. Before ${shortDay(d.first.time)}, after ${shortDay(d.second.time)}${gapDays(d.first.time, d.second.time) != null ? `, ${gapDays(d.first.time, d.second.time)} days apart` : ""}.`
    : null;
  const teach = step?.type === "diff" && d ? d.explain?.diff_modes?.[step.tile.mode] : undefined;
  const meta = thumb?.status === "ok" ? thumb.meta : undefined;
  const nSkipped = hooks.reduce((n, h) => n + h.tiles.filter((t) => h.thumbs[t.id]?.status === "err").length, 0);
  const loadingFirst = !step && !hardError;
  const hasPicture = step?.type === "layer" || step?.type === "diff";
  const groupStart = (i: number) => i > 0 && steps[i - 1].type !== steps[i].type && !(steps[i - 1].type === "text" && steps[i].type === "layer");

  return (
    <div className="vd-player" data-testid="why-player">
      {view && (
        <div className="vd-steps" role="group" aria-label="Which radar pass the result pictures show" data-testid="why-geometry">
          {views.map((g) => (
            <button key={g} type="button" className="vd-chip" aria-pressed={g === view} data-testid={`why-geometry-${g}`}
                    onClick={() => switchView(g)}>{VIEW_LABEL[g]}</button>
          ))}
          <span className="vd-note" aria-live="polite">
            {view === "merged" ? "Both passes together: a slope one pass cannot see is filled in by the other."
              : `${VIEW_LABEL[view]} pass only: the slopes facing away from it are missing, not quiet.`}
          </span>
        </div>
      )}
      <div className="vd-steps" ref={stripRef} role="group" aria-label="Steps, in the order they play">
        {steps.map((s, i) => {
          const on = s.key === currentKey;
          const st = s.type === "diff" ? hooks[s.pairIdx].thumbs[s.tile.id]?.status : s.type === "layer" ? (layerState[s.key]?.ready ? "ok" : on ? "busy" : "wait") : "ok";
          return (
            <button key={s.key} type="button" className="vd-chip" aria-current={on ? "step" : undefined}
                    data-state={st === "ok" ? "ok" : st === "busy" ? "busy" : "wait"}
                    onClick={() => go(i, true)} style={groupStart(i) ? { marginLeft: 10 } : undefined}>
              {s.label}
              {on && !paused && ready && s.type !== "outro" && (
                <span key={`${s.key}-${paused}`} className="vd-chip-bar" style={{ width: "100%", animation: `vd-fill ${DWELL_MS}ms linear both` }} />
              )}
            </button>
          );
        })}
        {!diffsSettled && steps.length > 0 && <span className="vd-chip" data-state="busy" aria-live="polite">More differences coming</span>}
        {loadingFirst && <span className="vd-chip" data-state="busy" aria-live="polite">Getting the pictures</span>}
      </div>

      {hardError && <p role="alert" className="vd-note">{hardError}</p>}
      {(dA.mismatch || dB.mismatch) && <p role="alert" className="vd-note">{dA.mismatch ?? dB.mismatch}</p>}
      {steps.length === 0 && diffsSettled && !hardError && (
        <p role="status" className="vd-note">The engine has nothing to draw for this selection.</p>
      )}

      {step && step.type !== "outro" && (
        <div className="vd-caption vd-swap" key={step.key} data-testid="why-caption">
          <div>
            <h3 className="vd-cap-title">{step.label}</h3>
            {step.type === "diff" && pairInfo && <p className="vd-cap-when">{pairInfo}</p>}
            {step.type !== "diff" && step.ls.pipeline && <p className="vd-cap-when">From the {fromName(step.ls.pipeline).toLowerCase()} check.</p>}
          </div>
          <div>
            {step.type === "text" ? <p className="vd-cap-body">{step.ls.body}</p>
              : step.type === "layer" ? (
                !ls?.ready ? <div className="vd-skel" aria-busy="true" aria-label="Drawing this on the map" />
                  : ls.err ? <p className="vd-cap-body">This picture could not be drawn: {ls.err}</p>
                    : ls.body ? <p className="vd-cap-body">{ls.body}</p> : null
              ) : diffReady ? (
                <>
                  {teach?.what_it_is && <p className="vd-cap-body">{teach.what_it_is}</p>}
                  {teach?.how_to_read && <p className="vd-cap-body"><b>How to read it.</b> {teach.how_to_read}</p>}
                  {meta && <p className="vd-cap-body vd-note">{meta.diff?.mode_label ? `${meta.diff.mode_label}. ` : ""}{previewLegend(meta).replace(/\u2014/g, "n/a")}</p>}
                  {meta?.diff?.referencing && <p className="vd-cap-body vd-note">{meta.diff.referencing.note}</p>}
                </>
              ) : thumb?.status === "busy" ? <div className="vd-skel" aria-busy="true" aria-label="Drawing this difference" />
                : <p className="vd-cap-body">Queued. The engine draws one picture at a time.</p>}
          </div>
        </div>
      )}

      {step?.type === "outro" && verdict && (
        <div className="vd-caption vd-swap" key="outro" data-testid="why-outro">
          <div>
            <h3 className="vd-cap-title">{verdict.hazard}</h3>
            <p className="vd-cap-when">{verdict.tierLabel}{verdict.alsoNotable > 0 ? `. ${verdict.alsoNotable} other check${verdict.alsoNotable === 1 ? "" : "s"} also flagged something.` : "."}</p>
          </div>
          <div>
            <p className="vd-cap-body">{verdict.sentence}</p>
            {verdict.statusMeaning && <p className="vd-cap-body vd-note">{verdict.statusMeaning}</p>}
            {verdict.reliability && <p className="vd-cap-body vd-note">{verdict.reliability}</p>}
            {verdict.hotspots.length > 0 ? (
              <div className="vd-spots" aria-label="Marked spots">
                {verdict.hotspots.map((h) => (
                  <button key={h.id} type="button" className="vd-spot" onClick={() => live.current.onFocusSpot(h.id)}>{h.label}</button>
                ))}
              </div>
            ) : (
              <p className="vd-cap-body vd-note">{verdict.full ? "No single spot stood out, so nothing is boxed on the map." : "Open the full result to see the spots the engine boxed."}</p>
            )}
          </div>
        </div>
      )}

      <div className="vd-foot">
        <button type="button" className="vd-btn" data-quiet="1" onClick={() => go(idx - 1, true)} disabled={idx <= 0}>Back</button>
        <button type="button" className="vd-btn" data-quiet="1" onClick={() => setPaused((p) => !p)}>{paused ? "Play" : "Pause"}</button>
        <button type="button" className="vd-btn" data-quiet="1" onClick={() => go(idx + 1, true)} disabled={idx < 0 || idx >= steps.length - 1}>Next</button>
        {steps.length > 0 && <span className="vd-note" aria-live="off">{idx + 1} of {steps.length}</span>}
        {hasPicture && (
          <button type="button" className="vd-btn" data-quiet="1" onClick={() => setPictureOn((v) => !v)} aria-pressed={!pictureOn}>
            {pictureOn ? "Hide picture" : "Show picture"}
          </button>
        )}
        <p className="vd-note grow" role="status">
          {nSkipped > 0 ? `${nSkipped} difference${nSkipped === 1 ? "" : "s"} could not be drawn and ${nSkipped === 1 ? "is" : "are"} skipped.`
            : meta && step?.type === "diff" ? "Preview picture, reduced from the full-resolution values." : ""}
        </p>
        {props.onEvidence && <button type="button" className="vd-btn" data-quiet="1" onClick={props.onEvidence}>Full evidence</button>}
        <button type="button" className="vd-btn" data-quiet="1" onClick={props.onExit}>Back to verdict</button>
      </div>
    </div>
  );
}

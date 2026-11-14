"use client";

/** ScanStatus: the one always-visible answer to "is my scan working?".
 *  `scanStatusFrom` turns what the page already knows (the polled run, the area queue, the moment between the click
 *  and the engine's first answer) into plain facts; nothing here is estimated or invented. When the engine has not
 *  reported a number yet, the bar says so (it slides, it does not pretend to a percentage).
 *  `ScanStatusStrip` draws it, in the light left panel or on the dark dock. */
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDur, plainStage } from "./ScanPanel";
import type { RunState } from "@/lib/types";
import type { AreaTile } from "./ScanPanel";

export interface ScanStatusInfo {
  /** "starting" = clicked, the engine has not answered with a run yet */
  phase: "starting" | "running";
  tileId: string | null;
  /** 1-based position of the tile being scanned, and how many tiles this scan has */
  tileNo: number;
  tileTotal: number;
  /** the engine's own stage, in plain words */
  stage: string;
  stepIndex: number | null;
  stepTotal: number | null;
  /** overall progress 0..100 across every tile, or null when nothing measurable has been reported yet */
  pct: number | null;
  elapsedS: number | null;
  mb: number | null;
  /** MB that ended up in the tile window (the rest was overhead) */
  mbUseful: number | null;
  requests: number | null;
  inflight: number | null;
  mbps: number | null;
  /** seconds since the last byte arrived; null = no bytes yet */
  idleS: number | null;
  stalled: boolean;
  granulesDone: number | null;
  granulesTotal: number | null;
  /** filled in by useScanTraffic: MB downloaded by the whole scan so far (every tile), and the recent MB/s samples */
  totalMb?: number;
  history?: number[];
}

type Progress = {
  stage?: string; step_index?: number; step_total?: number; elapsed_s?: number;
  net?: { mb: number; mb_useful?: number; requests?: number; inflight?: number | null; mbps_now: number; idle_s: number | null };
  granules?: { total: number; done: number };
};

/** a stall is the same threshold the detailed card uses (no byte for 30 s) */
const STALL_S = 30;

export function scanStatusFrom(input: {
  runState: RunState | null;
  queue: AreaTile[] | null;
  /** the Scan button was pressed and the engine has not named a run yet */
  starting: boolean;
}): ScanStatusInfo | null {
  const { runState, queue, starting } = input;
  const queueActive = !!queue?.some((t) => t.status === "running" || t.status === "waiting");
  const runLive = !!runState && (runState.status === "queued" || runState.status === "running");
  if (!runLive && !queueActive && !starting) return null;

  const tileTotal = queue?.length ?? 1;
  const doneN = queue?.filter((t) => t.status === "ok" || t.status === "error" || t.status === "skipped").length ?? 0;
  const runningIdx = queue ? queue.findIndex((t) => t.status === "running") : -1;
  const tileNo = queue ? Math.min(tileTotal, (runningIdx >= 0 ? runningIdx : doneN) + 1) : 1;
  const tileId = (runningIdx >= 0 ? queue?.[runningIdx].tile.id : undefined)
    ?? (queue && !runLive ? queue[Math.min(tileTotal - 1, doneN)]?.tile.id : undefined)
    ?? runState?.tile ?? null;

  const pr = (runLive ? runState?.progress : null) as Progress | null;
  const stepIndex = pr?.step_index ?? null;
  const stepTotal = pr?.step_total ?? null;
  const g = pr?.granules && pr.granules.total > 0 ? pr.granules : null;
  let tileFrac: number | null = null;
  if (stepIndex && stepTotal) tileFrac = Math.min(1, (stepIndex - 1 + (g ? g.done / g.total : 0)) / stepTotal);
  const pct = tileFrac == null && !(queue && doneN > 0) ? null
    : Math.max(2, Math.min(99, Math.round(((doneN + (tileFrac ?? 0)) / tileTotal) * 100)));
  const net = pr?.net;
  const idle = net ? net.idle_s : null;
  return {
    phase: runLive ? "running" : "starting",
    tileId, tileNo, tileTotal,
    stage: pr?.stage ? plainStage(String(pr.stage)) : runLive ? "Queued on the engine" : "Asking the engine to start",
    stepIndex, stepTotal, pct,
    elapsedS: typeof pr?.elapsed_s === "number" ? Math.round(pr.elapsed_s) : null,
    mb: net ? net.mb : null,
    mbUseful: net && typeof net.mb_useful === "number" ? net.mb_useful : null,
    requests: net && typeof net.requests === "number" ? net.requests : null,
    inflight: net ? (net.inflight ?? null) : null,
    mbps: net ? net.mbps_now : null,
    idleS: idle,
    stalled: idle != null && idle > STALL_S,
    granulesDone: g ? g.done : null,
    granulesTotal: g ? g.total : null,
  };
}

/** Adds "MB downloaded by the whole scan" (every tile, summed) and the recent MB/s samples to a status.
 *  The engine reports bytes per tile run; when the scan moves on to the next tile the finished tile's last figure is
 *  carried forward, so the total only ever counts what the engine itself reported. Resets when the scan ends. */
export function useScanTraffic(raw: ScanStatusInfo | null): ScanStatusInfo | null {
  const mem = useRef({ tileNo: 0, lastMb: 0, carry: 0, hist: [] as number[] });
  const [out, setOut] = useState<{ totalMb: number; history: number[] }>({ totalMb: 0, history: [] });
  useEffect(() => {
    const m = mem.current;
    if (!raw) {
      mem.current = { tileNo: 0, lastMb: 0, carry: 0, hist: [] };
      setOut((o) => (o.history.length || o.totalMb ? { totalMb: 0, history: [] } : o));
      return;
    }
    if (raw.tileNo !== m.tileNo) {
      if (m.tileNo !== 0) m.carry += m.lastMb;
      m.lastMb = 0;
      m.tileNo = raw.tileNo;
    }
    if (raw.mb != null) {
      m.lastMb = raw.mb;
      m.hist = [...m.hist, raw.mbps ?? 0].slice(-40);
    }
    setOut({ totalMb: m.carry + m.lastMb, history: m.hist });
  }, [raw]);
  return useMemo(() => (raw ? { ...raw, totalMb: out.totalMb, history: out.history } : null), [raw, out]);
}

const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`);

/** counts up to the new value instead of jumping, so a download that is moving is visibly moving */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || Math.abs(value - from.current) < 0.05) { from.current = value; setShown(value); return; }
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const v = a + (value - a) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmtMb(shown)}</>;
}

/** four little bars that dance while bytes are arriving, sit flat when nothing is, and go red when stalled */
function Activity({ flowing, stalled }: { flowing: boolean; stalled: boolean }) {
  return (
    <span className="ss-eq" data-flow={flowing ? "1" : "0"} data-stalled={stalled ? "1" : "0"} aria-hidden>
      <i /><i /><i /><i />
    </span>
  );
}

/** MB/s over the last samples (the engine's own "now" figure at each update) */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 64, h = 18, max = Math.max(0.5, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 3)).toFixed(1)}`).join(" ");
  return (
    <svg className="ss-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ScanStatusStrip(props: {
  s: ScanStatusInfo;
  tone: "light" | "dark";
  /** a note under the numbers, e.g. that the verdict shown is from an earlier scan */
  note?: string;
  /** "Stop after the current tile" (area scans only) */
  onStop?: () => void;
}) {
  const { s, tone } = props;
  const dark = tone === "dark";
  const head = s.phase === "starting"
    ? "Starting the scan…"
    : s.tileTotal > 1 ? `Scanning tile ${s.tileNo} of ${s.tileTotal}${s.tileId ? ` · ${s.tileId}` : ""}` : `Scanning${s.tileId ? ` ${s.tileId}` : ""}…`;
  const steps = s.stepIndex != null && s.stepTotal != null ? `step ${s.stepIndex} of ${s.stepTotal}` : null;
  const flowing = s.mb != null && s.idleS != null && s.idleS < 5 && (s.mbps ?? 0) > 0;
  const wire = s.mb == null ? null
    : s.stalled ? `no data for ${fmtDur(s.idleS ?? 0)}, the engine is retrying`
      : s.idleS == null ? "connecting to the radar archive, no data yet"
        : flowing ? `${(s.mbps ?? 0).toFixed(1)} MB/s` : "waiting for the next bytes";
  const extra = s.mb == null ? null
    : [s.mbUseful != null ? `${fmtMb(s.mbUseful)} of it used` : null, s.requests != null ? `${s.requests} requests` : null,
       s.inflight != null && s.inflight > 0 ? `${s.inflight} in flight` : null].filter(Boolean).join(" · ") || null;
  const grans = s.granulesDone != null && s.granulesTotal != null ? `${s.granulesDone}/${s.granulesTotal} granules` : null;
  const facts = [s.stage, steps, s.elapsedS != null ? `${fmtDur(s.elapsedS)} elapsed` : null].filter(Boolean).join(" · ");
  return (
    <div
      role="status" aria-live="polite" data-testid="scan-status" data-phase={s.phase}
      className={`ss-box ${dark ? "ss-dark" : "ss-light"}`}
    >
      <p className="ss-head">
        <span className="ss-pulse" aria-hidden />
        <span className="ss-title">{head}</span>
        {props.onStop && s.tileTotal > 1 && (
          <button type="button" className="ss-stop" onClick={props.onStop}>Stop after this tile</button>
        )}
      </p>
      <p className="ss-facts">{facts}</p>
      <div
        className="ss-track" role="progressbar" aria-label="Scan progress"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.pct ?? undefined}
        aria-valuetext={s.pct == null ? "working, no measurable progress yet" : `${s.pct} percent`}
      >
        {s.pct == null ? <span className="ss-indet" /> : <span className="ss-fill" style={{ width: `${s.pct}%` }} />}
      </div>
      {s.mb != null && (
        <div className="ss-data" data-testid="scan-data">
          <Activity flowing={flowing} stalled={s.stalled} />
          <span className="ss-mb"><CountUp value={s.mb} /></span>
          <span className="ss-mbl">downloaded</span>
          <span className="ss-grow" />
          {s.history && <Spark values={s.history} />}
        </div>
      )}
      {(wire || grans) && (
        <p className={`ss-wire${s.stalled ? " ss-warn" : ""}`}>{[wire, grans].filter(Boolean).join(" · ")}</p>
      )}
      {s.tileTotal > 1 && s.totalMb != null && s.totalMb > (s.mb ?? 0) + 0.05 && (
        <p className="ss-wire" data-testid="scan-total">Whole scan so far: <b>{fmtMb(s.totalMb)}</b> across {s.tileNo} tile{s.tileNo === 1 ? "" : "s"}</p>
      )}
      {extra && <p className="ss-note">{extra}</p>}
      {props.note && <p className="ss-note">{props.note}</p>}
    </div>
  );
}

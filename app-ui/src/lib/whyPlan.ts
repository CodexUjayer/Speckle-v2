/** Which two acquisitions "See why" compares. Display choice only: it reads the verdict's own pair (the engine's
 *  detail.inputs.selected_pair, via verdictUse) and the engine's granule listing, and picks the passes that sit
 *  on either side of it. It never reads a pixel and never decides what changed. */
import type { GranuleSearchResponse } from "./types";
import type { VerdictUse } from "./verdictUse";
import type { PickedPair } from "@/components/globe/MapPairDifferences";
import type { TimelineSelection } from "@/components/globe/GranuleTimeline";
import { idAndTime } from "./useTimelinePicks";

export interface WhyPair {
  kind: "gcov" | "gunw";
  stackKey: string;
  a: TimelineSelection;
  b: TimelineSelection;
  pair: PickedPair;
  /** how the choice was made, in plain words, so the player can say it */
  basis: string;
}

export interface WhyPlan {
  pairs: WhyPair[];
  /** the verdict's own pair when the engine reported one; null = the plan fell back to the latest passes */
  usedVerdictPair: boolean;
}

const ms = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : NaN; };

export function planWhy(data: GranuleSearchResponse | null, use: VerdictUse[]): WhyPlan {
  if (!data) return { pairs: [], usedVerdictPair: false };
  const sel = use.find((u) => u.selected) ?? null;
  const stackKeys = Object.keys(data.stacks);
  if (stackKeys.length === 0) return { pairs: [], usedVerdictPair: false };

  const stackKey = sel && data.stacks[sel.stack]
    ? sel.stack
    : [...stackKeys].sort((x, y) => (data.stacks[y].gcov.length + data.stacks[y].gunw.length)
        - (data.stacks[x].gcov.length + data.stacks[x].gunw.length))[0];
  const stack = data.stacks[stackKey];
  const refMs = sel ? ms(sel.ref_time) : NaN;
  const secMs = sel ? ms(sel.sec_time) : NaN;
  const usedVerdictPair = !!sel && Number.isFinite(refMs) && Number.isFinite(secMs);
  const out: WhyPair[] = [];

  // ---- backscatter: the pass nearest the start of the verdict's pair, and the one nearest its end ----
  const epochs = stack.gcov
    .map((e, index) => ({ index, t: ms(e.time) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((p, q) => p.t - q.t);
  if (epochs.length >= 2) {
    const nearest = (target: number) => epochs.reduce((best, e) => (Math.abs(e.t - target) < Math.abs(best.t - target) ? e : best), epochs[0]);
    let before = usedVerdictPair ? nearest(refMs) : epochs[epochs.length - 2];
    let after = usedVerdictPair ? nearest(secMs) : epochs[epochs.length - 1];
    if (before.index === after.index) { before = epochs[epochs.length - 2]; after = epochs[epochs.length - 1]; }
    const a: TimelineSelection = { stackKey, kind: "gcov", index: before.index };
    const b: TimelineSelection = { stackKey, kind: "gcov", index: after.index };
    const ia = idAndTime(data, a), ib = idAndTime(data, b);
    if (ia && ib) {
      out.push({
        kind: "gcov", stackKey, a, b, pair: { kind: "gcov", stackKey, a: ia, b: ib },
        basis: usedVerdictPair ? "the passes either side of the pair the verdict used" : "the two most recent passes",
      });
    }
  }

  // ---- interferometry: the pair just before the verdict's pair, against the verdict's pair ----
  const pairs = stack.gunw
    .map((p, index) => ({ index, start: ms(p.ref_time), end: ms(p.sec_time) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end))
    .sort((p, q) => p.end - q.end);
  if (pairs.length >= 2) {
    let earlier = pairs[pairs.length - 2];
    let later = pairs[pairs.length - 1];
    if (usedVerdictPair) {
      const mine = pairs.find((p) => Math.abs(p.start - refMs) < 36e5 * 12 && Math.abs(p.end - secMs) < 36e5 * 12);
      if (mine) {
        const prior = [...pairs].filter((p) => p.end <= mine.start + 36e5 * 12 && p.index !== mine.index).pop();
        const next = pairs.find((p) => p.start >= mine.end - 36e5 * 12 && p.index !== mine.index);
        if (prior) { earlier = prior; later = mine; }
        else if (next) { earlier = mine; later = next; }
      }
    }
    if (earlier.index !== later.index) {
      const a: TimelineSelection = { stackKey, kind: "gunw", index: earlier.index };
      const b: TimelineSelection = { stackKey, kind: "gunw", index: later.index };
      const ia = idAndTime(data, a), ib = idAndTime(data, b);
      if (ia && ib) {
        out.push({
          kind: "gunw", stackKey, a, b, pair: { kind: "gunw", stackKey, a: ia, b: ib },
          basis: usedVerdictPair ? "the pair before the verdict's pair, against the verdict's pair" : "the two most recent pairs",
        });
      }
    }
  }
  return { pairs: out, usedVerdictPair };
}

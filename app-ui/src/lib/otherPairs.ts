/** The other comparisons a scene bundle holds, beyond the one pair the verdict used: for every orbit stack, the
 *  passes (GCOV) and the interferometric pairs (GUNW) lined up in time order and compared neighbour to neighbour, plus
 *  the oldest against the newest. Display choice only: it reads the engine's own granule listing, never a pixel, and
 *  never decides which comparison matters. The engine decides what each pair can be differenced into. */
import type { GranuleSearchResponse, GranuleStack } from "./types";
import type { TimelineSelection } from "@/components/globe/GranuleTimeline";
import type { PickedPair } from "@/components/globe/MapPairDifferences";
import type { WhyPair } from "./whyPlan";
import { idAndTime } from "./useTimelinePicks";

export interface PairChoice {
  key: string;
  kind: "gcov" | "gunw";
  stackKey: string;
  /** short line for a menu: "A112 · backscatter · 14 Sep to 28 Sep" */
  label: string;
  /** what kind of comparison it is, in words */
  what: string;
  pair: PickedPair;
  a: TimelineSelection;
  b: TimelineSelection;
}

const NEIGHBOURS_PER_ROW = 4;
const MAX_CHOICES = 30;
const ms = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : NaN; };
const day = (iso: string | null) => {
  const t = ms(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "?";
};
interface Item { index: number; t: number }
const sig = (kind: string, stackKey: string, x: number, y: number) => `${kind}|${stackKey}|${Math.min(x, y)}|${Math.max(x, y)}`;

export function otherPairs(data: GranuleSearchResponse | null, alreadyShown: WhyPair[]): PairChoice[] {
  if (!data) return [];
  const taken = new Set(alreadyShown.map((p) => sig(p.kind, p.stackKey, p.a.index, p.b.index)));
  const out: PairChoice[] = [];
  const stackKeys = Object.keys(data.stacks).sort((p, q) => (p[0] === "D" ? 1 : 0) - (q[0] === "D" ? 1 : 0) || p.localeCompare(q));

  for (const stackKey of stackKeys) {
    const stack: GranuleStack = data.stacks[stackKey];
    for (const kind of ["gcov", "gunw"] as const) {
      const items: Item[] = kind === "gcov"
        ? stack.gcov.map((e, index) => ({ index, t: ms(e.time) }))
        : stack.gunw.map((p, index) => ({ index, t: ms(p.sec_time ?? p.ref_time) }));
      const sorted: Item[] = items.filter((x) => Number.isFinite(x.t)).sort((p, q) => p.t - q.t);
      if (sorted.length < 2) continue;
      const couples: [Item, Item][] = [];
      for (let i = Math.max(0, sorted.length - 1 - NEIGHBOURS_PER_ROW); i < sorted.length - 1; i++) couples.push([sorted[i], sorted[i + 1]]);
      if (sorted.length > NEIGHBOURS_PER_ROW + 1) couples.push([sorted[0], sorted[sorted.length - 1]]);
      for (const [x, y] of couples.reverse()) {                    // newest first
        if (taken.has(sig(kind, stackKey, x.index, y.index))) continue;
        const a: TimelineSelection = { stackKey, kind, index: x.index };
        const b: TimelineSelection = { stackKey, kind, index: y.index };
        const ia = idAndTime(data, a), ib = idAndTime(data, b);
        if (!ia || !ib || ia.id === ib.id) continue;
        const what = kind === "gcov" ? "backscatter" : "interferometry";
        out.push({
          key: sig(kind, stackKey, x.index, y.index), kind, stackKey, a, b,
          what, label: `${stackKey} · ${what} · ${day(ia.time)} to ${day(ib.time)}`,
          pair: { kind, stackKey, a: ia, b: ib },
        });
      }
    }
  }
  return out.slice(0, MAX_CHOICES);
}

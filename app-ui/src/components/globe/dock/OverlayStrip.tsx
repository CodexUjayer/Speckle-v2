"use client";

/** OverlayStrip: the row of pictures the dock has already loaded for the pinned tile, one chip each, so any of them
 *  goes on the map with a single tap. It also lists the scene bundle's other comparisons (other tracks, neighbouring
 *  passes, the oldest against the newest) in a menu; picking one loads its differences the same way.
 *  Display only: the pictures, their names' modes, their order of validity all come from the engine via
 *  usePairDifferences; this file lays them out. */
import { useMemo } from "react";
import { Dots } from "@/components/BigLoader";
import type { DiffTile, PairDifferences } from "@/lib/usePairDifferences";
import { MODE_NAME, modeRank } from "@/lib/diffModes";
import type { PairChoice } from "@/lib/otherPairs";

export interface StripGroup {
  idx: number;
  /** "Backscatter, 14 Sep to 28 Sep" */
  caption: string;
  d: PairDifferences;
}

export const chipKey = (idx: number, tileId: string) => `${idx}:${tileId}`;

export function chipLabel(d: PairDifferences, t: DiffTile, siblings: DiffTile[]): string {
  const base = MODE_NAME[t.mode] ?? d.thumbs[t.id]?.meta?.diff?.mode_label ?? t.mode;
  const same = siblings.filter((q) => q.mode === t.mode).length;
  return `${base}${same > 1 ? `, ${t.layerKey.split("/").pop()}` : ""}`;
}

export default function OverlayStrip(props: {
  groups: StripGroup[];
  chosen: string | null;
  overlayOn: boolean;
  onChoose: (key: string | null) => void;
  choices: PairChoice[];
  extra: PairChoice | null;
  onExtra: (key: string | null) => void;
  /** the chosen picture for the scan box's other tiles: how many are drawn (null = not asked for) */
  area?: { total: number; drawn: number; failed: number; busy: boolean } | null;
}) {
  const { groups } = props;
  const hardError = groups.map((g) => g.d.invError).find(Boolean) ?? null;
  const reading = groups.some((g) => g.d.reading);
  const totals = useMemo(() => groups.reduce((a, g) => ({ n: a.n + g.d.tiles.length, done: a.done + g.d.nDone }), { n: 0, done: 0 }), [groups]);
  // a set that has not started (it waits its turn, or the pin has not settled yet) and has nothing to show
  const pending = groups.some((g) => !g.d.reading && g.d.tiles.length === 0 && !g.d.finished && !g.d.invError);
  const allFinished = groups.length > 0 && groups.every((g) => g.d.finished || !!g.d.invError);

  // one optgroup per orbit stack in the menu
  const byStack = useMemo(() => {
    const m = new Map<string, PairChoice[]>();
    for (const c of props.choices) m.set(c.stackKey, [...(m.get(c.stackKey) ?? []), c]);
    return [...m.entries()];
  }, [props.choices]);

  return (
    <div className="vd-ov" role="group" aria-label="Pictures on the map" data-testid="overlay-strip">
      <div className="vd-ov-row">
        <button type="button" className="vd-chip" aria-pressed={!props.overlayOn || props.chosen === null}
                onClick={() => props.onChoose(null)}>Map only</button>

        {groups.map((g) => {
          const ok = g.d.tiles.filter((t) => g.d.thumbs[t.id]?.status === "ok").sort((x, y) => modeRank(x.mode) - modeRank(y.mode));
          if (ok.length === 0) return null;
          return (
            <span key={g.idx} className="vd-ov-group">
              <span className="vd-ov-cap">{g.caption}</span>
              {ok.map((t) => {
                const k = chipKey(g.idx, t.id);
                return (
                  <button key={k} type="button" className="vd-chip" aria-pressed={props.overlayOn && props.chosen === k}
                          onClick={() => props.onChoose(k)}>{chipLabel(g.d, t, ok)}</button>
                );
              })}
            </span>
          );
        })}

        {(reading || totals.done < totals.n || pending) && !hardError && (
          <span className="vd-chip" data-state="busy" aria-live="polite">
            {reading ? "Reading the passes" : totals.done < totals.n ? `Drawing ${totals.done} of ${totals.n}` : "Getting ready"}
            <Dots className="ml-2 text-[8px]" />
          </span>
        )}

        {props.area && props.area.total > 0 && (
          <span className="vd-chip" data-state={props.area.busy ? "busy" : undefined} aria-live="polite" data-testid="area-diff-status">
            {`Other tiles: ${props.area.drawn} of ${props.area.total} drawn`}
            {props.area.failed > 0 ? ` · ${props.area.failed} not covered by these passes` : ""}
            {props.area.busy && <Dots className="ml-2 text-[8px]" />}
          </span>
        )}

        {props.choices.length > 0 && (
          <select
            className="vd-select" aria-label="Other comparisons in this scene bundle"
            value={props.extra?.key ?? ""} data-testid="other-pairs"
            onChange={(e) => props.onExtra(e.target.value || null)}
          >
            <option value="">{props.extra ? "Remove the extra comparison" : "More comparisons…"}</option>
            {byStack.map(([stack, list]) => (
              <optgroup key={stack} label={`Track ${stack}`}>
                {list.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </optgroup>
            ))}
          </select>
        )}
      </div>

      {hardError && <p className="vd-note" role="alert">{hardError}</p>}
      {allFinished && totals.n === 0 && !hardError && (
        <p className="vd-note" role="status">The engine defines no picture for these passes yet.</p>
      )}
    </div>
  );
}

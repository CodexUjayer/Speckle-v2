"use client";

/** Which dots on the timeline are picked (A, then B), shared by the dock and the Data panel.
 *  A pair is resolved to granule ids the moment B is clicked, so panning or zooming the timeline (which reloads
 *  the listing and shifts its indices) can never silently swap the two acquisitions being compared. */
import { useCallback, useEffect, useState } from "react";
import type { GranuleSearchResponse } from "./types";
import type { TimelineSelection } from "@/components/globe/GranuleTimeline";
import type { PickedPair } from "@/components/globe/MapPairDifferences";

/** the first granule id + the date that places a dot in time (a GCOV epoch's time, a GUNW pair's secondary) */
export function idAndTime(data: GranuleSearchResponse, sel: TimelineSelection): { id: string; time: string | null } | null {
  const stack = data.stacks[sel.stackKey];
  if (!stack) return null;
  if (sel.kind === "gunw") {
    const p = stack.gunw[sel.index];
    return p && p.granule_ids[0] ? { id: p.granule_ids[0], time: p.sec_time ?? p.ref_time } : null;
  }
  const e = stack.gcov[sel.index];
  return e && e.granule_ids[0] ? { id: e.granule_ids[0], time: e.time } : null;
}

export interface TimelinePicks {
  selection: TimelineSelection | null;
  selectionB: TimelineSelection | null;
  picked: PickedPair | null;
  onSelect: (sel: TimelineSelection | null) => void;
  clear: () => void;
}

export function useTimelinePicks(
  data: GranuleSearchResponse | null,
  onFootprint: (ring: [number, number][] | null, fit?: boolean) => void,
  resetKey: string | null,
): TimelinePicks {
  const [selection, setSelection] = useState<TimelineSelection | null>(null);
  const [selectionB, setSelectionB] = useState<TimelineSelection | null>(null);
  const [picked, setPicked] = useState<PickedPair | null>(null);

  useEffect(() => { setSelection(null); setSelectionB(null); setPicked(null); }, [resetKey]);

  const clear = useCallback(() => {
    setSelection(null); setSelectionB(null); setPicked(null);
    onFootprint(null);
  }, [onFootprint]);

  const onSelect = useCallback((sel: TimelineSelection | null) => {
    if (!sel || !data) { clear(); return; }
    // a 2nd click on a DIFFERENT dot of the same row is the second dot; anything else starts over with this dot
    if (selection && !selectionB && sel.kind === selection.kind && sel.stackKey === selection.stackKey
        && sel.index !== selection.index) {
      const first = idAndTime(data, selection);
      const second = idAndTime(data, sel);
      if (first && second) {
        setSelectionB(sel);
        setPicked({ kind: sel.kind, stackKey: sel.stackKey, a: first, b: second });
        return;
      }
    }
    setSelection(sel); setSelectionB(null); setPicked(null);
    const stack = data.stacks[sel.stackKey];
    if (!stack) return;
    const ring = sel.kind === "gunw" ? stack.gunw[sel.index]?.footprint : stack.gcov[sel.index]?.footprint;
    onFootprint(ring ?? null);
  }, [data, selection, selectionB, clear, onFootprint]);

  return { selection, selectionB, picked, onSelect, clear };
}

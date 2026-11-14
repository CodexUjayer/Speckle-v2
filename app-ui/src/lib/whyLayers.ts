/** The layer part of the "See why" tour: the pictures the verdict itself was built from, straight from the engine's
 *  result (its raster layers, its detection boxes, its evidence sentences). Adapted from the other build of the dock:
 *  these need no extra engine calls and work on cached verdicts as well as live runs.
 *  Nothing is measured or decided here: this only lists what the engine already put in the result. */
import type { PipelineResult } from "./types";
import { hazardName, tidy, type Hotspot, type VerdictView } from "./verdictView";

export interface LayerStep {
  kind: "layer" | "text";
  key: string;
  title: string;
  /** text steps only (an evidence sentence); layer steps get their caption from the layer's own note */
  body: string | null;
  pipeline: string | null;
  layer: string | null;
  boxes: Hotspot[];
}

const MAX_LAYER_STEPS = 10;

/** Which radar geometry the layer steps draw. One geometry (ascending or descending) only sees part of the ground, so
 *  the default is the merge of both; the single-pass pictures stay one tap away. */
export type GeometryView = "merged" | "ascending" | "descending";
export const VIEW_LABEL: Record<GeometryView, string> = { merged: "Merged", ascending: "Ascending", descending: "Descending" };

/** The result layers that exist in more than one geometry. `base` is the single-best-pair layer older results carry. */
const FAMILIES: Record<string, { base: string; merged: string[]; ascending: string; descending: string }> = {
  detected: { base: "detected", merged: ["detected_merged"], ascending: "detected_ascending", descending: "detected_descending" },
  threshold: { base: "threshold", merged: ["threshold_merged"], ascending: "threshold_ascending", descending: "threshold_descending" },
  displacement: { base: "displacement", merged: ["displacement_up", "displacement_east"],
                  ascending: "displacement_los_ascending", descending: "displacement_los_descending" },
};
/** only meaningful when both passes are merged: where each pass measured */
const MERGED_ONLY = new Set(["geometry_coverage"]);
const NAMES: Record<string, string> = {
  geometry_coverage: "Where each pass measured",
  detected_merged: "Detected, merged", threshold_merged: "Threshold, merged",
  detected_ascending: "Detected, ascending", detected_descending: "Detected, descending",
  threshold_ascending: "Threshold, ascending", threshold_descending: "Threshold, descending",
  displacement_up: "Up movement", displacement_east: "East movement",
  displacement_los_ascending: "Line of sight, ascending", displacement_los_descending: "Line of sight, descending",
};
/** family of a layer name (base or any variant), so a step can follow the person across a switch */
export function familyOf(layer: string | null): string | null {
  if (!layer) return null;
  if (MERGED_ONLY.has(layer)) return "geometry_coverage";
  for (const [k, f] of Object.entries(FAMILIES)) {
    if (layer === f.base || f.merged.includes(layer) || layer === f.ascending || layer === f.descending) return k;
  }
  return null;
}

const layerNames = (v: VerdictView): string[] =>
  ((v.result?.layers ?? []) as unknown as { name?: string; kind?: string }[])
    .filter((l) => l && l.kind === "raster" && l.name).map((l) => l.name as string);

/** The views this result can show: only those whose layers the engine actually made. Older or one-geometry results
 *  give an empty list, and the player then shows no switch. */
export function geometryViews(v: VerdictView | null): GeometryView[] {
  if (!v?.result) return [];
  const have = new Set(layerNames(v));
  const out: GeometryView[] = [];
  if (have.has("detected_merged") || have.has("threshold_merged")) out.push("merged");
  if (have.has("detected_ascending") || have.has("threshold_ascending")) out.push("ascending");
  if (have.has("detected_descending") || have.has("threshold_descending")) out.push("descending");
  return out.length >= 2 ? out : [];
}

/** which layer names the lead result shows in a view: a family's base layer is swapped for the view's own layer(s);
 *  variants of other views are left out; anything else passes through in the engine's order */
function leadLayerNames(v: VerdictView, view: GeometryView | null): string[] {
  const names = layerNames(v);
  if (!view) return names;
  const have = new Set(names);
  const variants = new Set<string>();
  for (const f of Object.values(FAMILIES)) [...f.merged, f.ascending, f.descending].forEach((n) => variants.add(n));
  const out: string[] = [];
  for (const n of names) {
    const fam = Object.values(FAMILIES).find((f) => f.base === n);
    if (fam) {
      const want = view === "merged" ? fam.merged : [view === "ascending" ? fam.ascending : fam.descending];
      const present = want.filter((w) => have.has(w));
      out.push(...(present.length ? present : [n]));     // no such layer (e.g. no east/up in scan mode): the engine's own pair layer
    } else if (variants.has(n)) {
      continue;                                          // reached through its family above
    } else if (MERGED_ONLY.has(n) && view !== "merged") {
      continue;
    } else out.push(n);
  }
  return out;
}
const human = (s: string) => {
  const t = s.replace(/[_.:/]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

export function buildLayerSteps(v: VerdictView, view: GeometryView | null = null): LayerStep[] {
  if (!v.result) return [];
  const steps: LayerStep[] = [];
  outer: for (const r of [v.result, ...v.others] as PipelineResult[]) {
    const mine = r === v.result;
    const names = mine ? leadLayerNames(v, view)
      : ((r.layers ?? []) as unknown as { name?: string; kind?: string }[]).filter((l) => l && l.kind === "raster" && l.name).map((l) => l.name as string);
    for (const name of names) {
      if (steps.length >= MAX_LAYER_STEPS) break outer;
      // boxes belong to the lead result: the ones drawn on this layer, else the ones tied to no layer
      const forLayer = mine ? v.hotspots.filter((h) => h.layer === name) : [];
      const boxes = mine ? (forLayer.length ? forLayer : v.hotspots.filter((h) => !h.layer)) : [];
      steps.push({
        kind: "layer", key: `layer:${r.pipeline}:${name}`,
        title: NAMES[name] ?? human(name), body: null,
        pipeline: r.pipeline, layer: name, boxes,
      });
    }
  }
  if (steps.length === 0) {
    // nothing drawable: walk through the evidence sentences instead
    for (const [n, e] of (v.result.evidence ?? []).slice(0, 4).entries()) {
      if (!e.claim) continue;
      steps.push({ kind: "text", key: `evidence:${n}`, title: human(e.id ?? e.kind), body: tidy(e.claim),
                   pipeline: v.result.pipeline, layer: null, boxes: v.hotspots });
    }
  }
  return steps;
}

export const fromName = (pipeline: string) => hazardName(pipeline);

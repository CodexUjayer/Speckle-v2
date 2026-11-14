/** URL state (§7.7) — pure parse/format, validated and ignorable. A pasted link restores the same
 *  view; unknown/invalid values fall back to the default view without crashing. */

export type PanelMode = "explore" | "cached" | "pin" | "results" | "granules";

export interface UrlState {
  lat?: number;
  lon?: number;
  z?: number;
  tile?: string;
  bundle?: string;
  pipeline?: string;
  layer?: string;
  scan?: string;
  panel: PanelMode;
  /** the separate Data panel (right side on desktop) is open; `panel=granules` is the older way to say the same */
  data?: true;
}

const PANELS: PanelMode[] = ["explore", "cached", "pin", "results", "granules"];
const TILE_RE = /^\d{1,2}[C-X][A-HJ-NP-Z]{2}\d*$/; // same grammar as engine/tiling/mgrs.py::_ID

export function parseUrlState(params: URLSearchParams | Record<string, string | string[] | undefined>): UrlState {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const num = (k: string, lo: number, hi: number): number | undefined => {
    const raw = get(k);
    if (raw === undefined || raw === "") return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) return undefined;
    return v;
  };
  const id = (k: string, re: RegExp): string | undefined => {
    const raw = get(k);
    if (!raw) return undefined;
    try {
      const decoded = decodeURIComponent(raw);
      return re.test(decoded) ? decoded : undefined;
    } catch {
      return undefined;
    }
  };
  const panelRaw = get("panel");
  const panel: PanelMode = panelRaw && (PANELS as string[]).includes(panelRaw) ? (panelRaw as PanelMode) : "explore";
  return {
    lat: num("lat", -90, 90),
    lon: num("lon", -180, 180),
    z: num("z", 0, 22),
    tile: id("tile", TILE_RE),
    bundle: id("bundle", /^[A-Za-z0-9_-]{1,128}$/),
    pipeline: id("pipeline", /^[a-z0-9_]{1,64}$/),
    layer: id("layer", /^[A-Za-z0-9_-]{1,64}$/),
    scan: id("scan", /^run-[0-9a-f]{12}$/),
    panel,
    data: get("data") === "1" ? true : undefined,
  };
}

/** apply the state to a URLSearchParams in place (debounced router.replace feeds this) */
export function writeUrlState(params: URLSearchParams, state: UrlState): void {
  const setOrDrop = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  };
  setOrDrop("lat", state.lat);
  setOrDrop("lon", state.lon);
  setOrDrop("z", state.z);
  setOrDrop("tile", state.tile);
  setOrDrop("bundle", state.bundle);
  setOrDrop("pipeline", state.pipeline);
  setOrDrop("layer", state.layer);
  setOrDrop("scan", state.scan);
  setOrDrop("panel", state.panel === "explore" ? undefined : state.panel);
  setOrDrop("data", state.data ? "1" : undefined);
}

// ---------------------------------------------------------------------------------------------
// §7.8 Granule Explorer URL state (/granules?west=&south=&east=&north=&level=&from=&to=&track=&dir=&sel=)
// Validated and ignorable: invalid values fall back to defaults without crashing.
// ---------------------------------------------------------------------------------------------

export interface ExplorerUrlState {
  west?: number;
  south?: number;
  east?: number;
  north?: number;
  level?: string;      // comma list of GUNW|GCOV|GOFF
  from?: string;       // ISO date (UTC)
  to?: string;
  track?: number;
  dir?: "A" | "D";
  sel?: string;        // selected granule id
}

const LEVEL_RE = /^(GUNW|GCOV|GOFF)(,(GUNW|GCOV|GOFF))*$/;

export function parseExplorerState(params: URLSearchParams | Record<string, string | string[] | undefined>): ExplorerUrlState {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const num = (k: string, lo: number, hi: number): number | undefined => {
    const raw = get(k);
    if (raw === undefined || raw === "") return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) return undefined;
    return v;
  };
  const levelRaw = get("level");
  const level = levelRaw && LEVEL_RE.test(levelRaw.toUpperCase()) ? levelRaw.toUpperCase() : undefined;
  const isoDate = (k: string): string | undefined => {
    const raw = get(k);
    if (!raw || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?Z?$/.test(raw)) return undefined;
    const norm = raw.replace(" ", "T");              // "2026-10-01 12:00" is accepted by the pattern above
    const t = Date.parse(norm.includes("T") ? (norm.endsWith("Z") ? norm : `${norm}Z`) : `${norm}T00:00:00Z`);
    return Number.isFinite(t) ? norm : undefined;
  };
  const dirRaw = get("dir");
  return {
    west: num("west", -180, 180),
    south: num("south", -90, 90),
    east: num("east", -180, 180),
    north: num("north", -90, 90),
    level,
    from: isoDate("from"),
    to: isoDate("to"),
    track: num("track", 1, 400),
    dir: dirRaw === "A" || dirRaw === "D" ? dirRaw : undefined,
    sel: get("sel") || undefined,
  };
}

export function writeExplorerState(params: URLSearchParams, state: ExplorerUrlState): void {
  const setOrDrop = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  };
  setOrDrop("west", state.west);
  setOrDrop("south", state.south);
  setOrDrop("east", state.east);
  setOrDrop("north", state.north);
  setOrDrop("level", state.level);
  setOrDrop("from", state.from);
  setOrDrop("to", state.to);
  setOrDrop("track", state.track);
  setOrDrop("dir", state.dir);
  setOrDrop("sel", state.sel);
}

// ---------------------------------------------------------------------------------------------
// Data Lab URL state (/lab?west=&south=&east=&north=&level=&from=&to=&a=&b=&layer=&cmp=&mode=)
// Shares the Explorer's box/level/window vocabulary so a box found there opens here, and adds
// the compare pair (a = before/first, b = after/second), the layer, the compare mode and the
// diff mode. Validated and ignorable: a pasted link restores the same view; invalid values
// fall back to the defaults without crashing. Granule ids are validated by shape only (the
// ENGINE owns existence: an unknown id answers 404 with its own text).
// ---------------------------------------------------------------------------------------------

export type LabCompareMode = "before-after" | "swipe" | "flicker" | "difference";
export const LAB_DIFF_MODES = ["db_diff", "ratio", "coh_diff", "los_m", "los_mm"] as const;
export type LabDiffMode = (typeof LAB_DIFF_MODES)[number];

/** Phase 3 — the correction diagnostics a GUNW layer can show instead of itself (engine-converted
 *  phase→LOS on the product's own screen; a diagnostic, never removed from los_m). */
export const LAB_CORRS = ["off", "iono", "tropo_hydrostatic", "tropo_wet", "solid_earth_tide"] as const;
export type LabCorr = (typeof LAB_CORRS)[number];

/** Phase 4 — a drawn ROI in the URL: "box:lon,lat;lon,lat" or "polygon:lon,lat;lon,lat;…".
 *  Validation is shape-only (>= 3 vertices for a polygon, 2 for a box, numbers in range);
 *  the ENGINE owns every further rule. Invalid values fall back to undefined (ignorable links). */
export interface LabRoi {
  kind: "box" | "polygon";
  ring: [number, number][];
}

export function parseRoiParam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const kind = raw.split(":", 1)[0];
  const rest = raw.slice(kind.length + 1);
  if (kind !== "box" && kind !== "polygon") return undefined;
  const ring: [number, number][] = [];
  for (const pair of rest.split(";")) {
    const [lonS, latS] = pair.split(",");
    const lon = Number(lonS), lat = Number(latS);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
    if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) return undefined;
    ring.push([lon, lat]);
  }
  if (kind === "box" ? ring.length !== 2 : ring.length < 3) return undefined;
  return raw;
}

export function roiToParam(roi: LabRoi | null | undefined): string | undefined {
  if (!roi) return undefined;
  const body = roi.ring.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(";");
  return `${roi.kind}:${body}`;
}

export function roiFromParam(raw: string | undefined): LabRoi | null {
  if (!parseRoiParam(raw) || !raw) return null;
  const kind = raw.split(":", 1)[0] as "box" | "polygon";
  const ring = raw.slice(kind.length + 1).split(";").map((pair) => {
    const [lon, lat] = pair.split(",").map(Number);
    return [lon, lat] as [number, number];
  });
  return { kind, ring };
}

export interface LabUrlState {
  west?: number;
  south?: number;
  east?: number;
  north?: number;
  level?: string;
  from?: string;
  to?: string;
  /** Phase 3: the correction diagnostic shown instead of the layer (off = the layer itself) */
  corr?: string;
  /** Phase 4: the drawn ROI ("box:lon,lat;lon,lat" | "polygon:lon,lat;…" | absent) */
  roi?: string;
  /** the compare pair: granule ids (a = first/before, b = second/after) */
  a?: string;
  b?: string;
  /** the flat layer key being compared */
  layer?: string;
  /** how the pair is shown on the map */
  cmp?: LabCompareMode;
  /** the engine's difference mode (only meaningful when cmp = difference) */
  dmode?: string;
}

const LAB_CMP: LabCompareMode[] = ["before-after", "swipe", "flicker", "difference"];
const GRANULE_ID_RE = /^[A-Za-z0-9_-]{1,400}$/;
const LAYER_KEY_RE = /^[A-Za-z0-9_-]{1,300}$/;

export function parseLabState(params: URLSearchParams | Record<string, string | string[] | undefined>): LabUrlState {
  const base = parseExplorerState(params);            // box / level / window share the Explorer grammar
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const gid = (k: string): string | undefined => {
    const raw = get(k);
    return raw && GRANULE_ID_RE.test(raw) ? raw : undefined;
  };
  const cmpRaw = get("cmp");
  const dmodeRaw = get("dmode");
  return {
    west: base.west, south: base.south, east: base.east, north: base.north,
    level: base.level, from: base.from, to: base.to,
    a: gid("a"),
    b: gid("b"),
    layer: (() => { const raw = get("layer"); return raw && LAYER_KEY_RE.test(raw) ? raw : undefined; })(),
    cmp: cmpRaw && (LAB_CMP as string[]).includes(cmpRaw) ? (cmpRaw as LabCompareMode) : undefined,
    dmode: dmodeRaw && (LAB_DIFF_MODES as readonly string[]).includes(dmodeRaw) ? dmodeRaw : undefined,
    corr: (() => { const raw = get("corr"); return raw && (LAB_CORRS as readonly string[]).includes(raw) ? raw : undefined; })(),
    roi: parseRoiParam(get("roi")),
  };
}

export function writeLabState(params: URLSearchParams, state: LabUrlState): void {
  const setOrDrop = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  };
  setOrDrop("west", state.west);
  setOrDrop("south", state.south);
  setOrDrop("east", state.east);
  setOrDrop("north", state.north);
  setOrDrop("level", state.level);
  setOrDrop("from", state.from);
  setOrDrop("to", state.to);
  setOrDrop("a", state.a);
  setOrDrop("b", state.b);
  setOrDrop("layer", state.layer);
  setOrDrop("cmp", state.cmp);
  setOrDrop("dmode", state.dmode);
  setOrDrop("corr", state.corr);
  setOrDrop("roi", state.roi);
}

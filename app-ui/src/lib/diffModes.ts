/** Plain, neutral names for the engine's difference modes, and the order they are shown in. Shared by the "See why"
 *  player and the dock's overlay strip, so both say the same thing. The engine's own label stays in the footnote. */
export const MODE_NAME: Record<string, string> = {
  db_diff: "Brightness change",
  ratio: "Brightness ratio",
  z_db: "Change against normal noise",
  coh_diff: "Change in surface match",
  los_m: "Ground movement along the line of sight",
  los_mm: "Ground movement along the line of sight",
};
export const MODE_ORDER = ["db_diff", "ratio", "z_db", "coh_diff", "los_m", "los_mm"];
export const modeRank = (m: string) => { const i = MODE_ORDER.indexOf(m); return i < 0 ? 99 : i; };

export const PRODUCT_NAME: Record<"gcov" | "gunw", string> = {
  gcov: "Radar brightness, pass against pass",
  gunw: "Interferometry, pair against pair",
};
export const PRODUCT_SHORT: Record<"gcov" | "gunw", string> = {
  gcov: "Backscatter",
  gunw: "Interferometry",
};

export const shortDay = (iso: string | null) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "unknown date";
};

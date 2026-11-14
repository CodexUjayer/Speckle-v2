/** Build-time settings for the map, read from .env.local (see .env.example) so nothing is tied to one machine or one
 *  folder. NEXT_PUBLIC_* values are inlined by Next at build/dev start: restart `npm run dev` after editing them. */

const flag = (v: string | undefined, fallback: boolean): boolean => {
  if (v == null || v.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

/** Load the SAR pictures (the differences between the passes) the moment a place is pinned, without any click.
 *  Set NEXT_PUBLIC_AUTOLOAD_DIFFS=0 to go back to loading only when asked. */
export const AUTOLOAD_DIFFS = flag(process.env.NEXT_PUBLIC_AUTOLOAD_DIFFS, true);

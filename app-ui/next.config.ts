import type { NextConfig } from "next";

/** UI-build-2 §1 compatibility redirects — the old base paths keep working with their query
 *  strings. `has` conditions keep the Landing page at "/" while ANY legacy globe query goes to
 *  /map. Next.js forwards the original query string when the destination has none of its own. */
const LEGACY_MAP_KEYS = ["lat", "lon", "z", "tile", "bundle", "pipeline", "layer", "scan", "panel"];

const legacyMapRedirects = LEGACY_MAP_KEYS.map((key) => ({
  source: "/",
  has: [{ type: "query" as const, key }],
  destination: "/map",
  permanent: false,
}));

const nextConfig: NextConfig = {
  /* The dev-only "N" badge (bottom-left by default) sat on top of the map panel's last controls — it covered the
     "show a SAR layer" checkbox. Every corner of the map UI is in use (nav top-left, zoom top-right, attribution
     bottom-right, the panel bottom-left), so the badge is OFF by default. It never exists in `next build`/`next start`.
     Want it back while developing?  NEXT_DEV_INDICATOR=1 npm run dev  (parked bottom-right). Runtime error overlays
     are not affected. */
  devIndicators: process.env.NEXT_DEV_INDICATOR === "1" ? { position: "bottom-right" } : false,
  /* The landing page uses next/image with quality 78 and 82; Next 16 requires every quality to be listed. */
  images: { qualities: [75, 78, 82] },
  /* The engine API base URL (FastAPI). Overridable via env. */
  env: {
    NEXT_PUBLIC_ENGINE_API: process.env.NEXT_PUBLIC_ENGINE_API ?? "http://127.0.0.1:8900",
    /* Supabase verdict cache read side (the Cached/Map views, lib/cache.ts). The publishable
       (anon) key is public by design — RLS allows reads only; only the engine's service key
       can write. Override both with real env vars when hosting elsewhere. */
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://onirsspdleznadqosekz.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_iLiy5s0CHF7CwNatk1kI0w_StMOcwGy",
    /* Speckle landing wiring: where the landing's "Go and play" entry and the
       finale CTA lead (LINKS.app in src/components/speckle/data.ts). Defaults to
       the Map (/map); override with a deployed URL when hosting elsewhere. The
       Earthquake room is its own page at /earthquakes. */
    NEXT_PUBLIC_SPECKLE_APP_URL: process.env.NEXT_PUBLIC_SPECKLE_APP_URL ?? "/map",
  },
  async redirects() {
    return [
      ...legacyMapRedirects,
      { source: "/granules", destination: "/background/retrieval", permanent: false },
      /* the Data Lab is gone as a place: pick two dots on the Map's bottom timeline and every difference is drawn on the map */
      { source: "/lab", destination: "/map", permanent: false },
      { source: "/workbench", destination: "/background/pipelines", permanent: false },
    ];
  },
};

export default nextConfig;

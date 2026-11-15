/**
 * The Speckle front door: the cinematic landing film, nothing else.
 *
 * "Go and play" (nav) and "Start exploring" (finale) lead to the real
 * application, the Map at /map. The Earthquake investigation room is a
 * separate page at /earthquakes (see (landing)/earthquakes/page.tsx); it is
 * no longer swapped in over this route via a #quake hash.
 */

import Experience from "@/components/speckle/Experience";

export default function Page() {
  return <Experience />;
}

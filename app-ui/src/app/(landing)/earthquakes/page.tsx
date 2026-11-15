"use client";

/**
 * /earthquakes: the Earthquake investigation room, as its own page.
 *
 * It lives inside the (landing) group so it keeps the Speckle fonts and the
 * scoped .speckle-page styling, but it is a separate route: the landing
 * film at "/" and the Map at "/map" are untouched by it. Reached from the
 * "Explore earthquakes" sector card on the landing.
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import EarthquakePage from "@/components/quake/EarthquakePage";

export default function EarthquakesRoute() {
  const router = useRouter();
  const back = useCallback(() => router.push("/"), [router]);

  return (
    <div className="quake-view-in">
      <EarthquakePage onExit={back} />
    </div>
  );
}

"use client";

/**
 * The Speckle front door — one route, two views.
 *
 * `/`          the cinematic landing film (components/speckle/Experience)
 * `/ #quake`   the Earthquake investigation room (components/quake), the
 *              landing's child page, reachable from the nav CTA, the
 *              "Explore earthquakes" sector card and the finale CTA.
 *
 * The hash acts as the child-page URL (shareable, back-button safe) while the
 * app keeps this single route for the landing. The (globe)/map console and
 * the (site) pages stay exactly where they were — this only ADDS the in-page
 * observatory to the film.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Experience from "@/components/speckle/Experience";
import EarthquakePage from "@/components/quake/EarthquakePage";
import { Providers } from "@/app/providers";

type View = "film" | "quake";

function viewOfHash(hash: string): View {
  return hash === "#quake" ? "quake" : "film";
}

export default function Page() {
  const [view, setView] = useState<View>("film");
  const filmScroll = useRef(0);
  const firstApply = useRef(true);

  useEffect(() => {
    const apply = () => {
      const next = viewOfHash(window.location.hash);
      setView((cur) => {
        if (cur === next) return cur;
        if (cur === "film") filmScroll.current = window.scrollY;
        return next;
      });
    };
    apply();
    firstApply.current = false;
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // scroll hand-off: entering the quake view starts at the top; returning
  // to the film restores where the visitor left the story
  useEffect(() => {
    if (view === "quake") {
      window.scrollTo({ top: 0, behavior: "auto" });
    } else if (!firstApply.current) {
      window.scrollTo({ top: filmScroll.current, behavior: "auto" });
    }
  }, [view]);

  const back = useCallback(() => {
    window.location.hash = "";
  }, []);

  return (
    <>
      {view === "film" ? (
        <Experience />
      ) : (
        <div key="quake" className="quake-view-in">
          <Providers>
            <EarthquakePage onExit={back} />
          </Providers>
        </div>
      )}
    </>
  );
}

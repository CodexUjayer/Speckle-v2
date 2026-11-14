"use client";

/**
 * Minimal navigation — the quietest possible header. The wordmark on the
 * left, the "Go and play" button (the way into the Map) on the right. Nothing else: the story
 * speaks for itself, the chapter compass lives on the right edge of the
 * stage, and this bar never competes with either.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Github, Play } from "lucide-react";
import { LINKS } from "./data";

function jumpToTop() {
  const spacer = document.getElementById("speckle-story-spacer");
  const storyH = spacer?.offsetHeight ?? window.innerHeight * 9.5;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
        scrolled
          ? "border-b border-white/[0.06] bg-[#04070d]/60 backdrop-blur-md"
          : "border-b border-transparent"
      }`}
    >
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5 sm:px-8"
      >
        <button
          type="button"
          onClick={jumpToTop}
          className="font-display text-lg font-medium tracking-[0.34em] text-white transition-opacity hover:opacity-70"
        >
          SPECKLE
        </button>

        <div className="flex items-center gap-5 sm:gap-7">
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="GitHub repository"
            className="text-white/50 transition-colors hover:text-white"
          >
            <Github className="h-[15px] w-[15px]" aria-hidden />
          </a>
          <Link
            href={LINKS.app}
            aria-label="Go and play: open the map"
            className="play-btn group relative inline-flex items-center gap-2.5 rounded-full bg-white py-2 pl-2 pr-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0a1220] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent,#7dd3fc)] sm:pr-5"
          >
            <span aria-hidden className="play-halo" />
            <span className="play-icon relative flex h-7 w-7 items-center justify-center rounded-full bg-[#0a1220] text-white">
              <Play className="h-3 w-3 translate-x-[1px] fill-current" aria-hidden />
            </span>
            <span className="relative">Go and play</span>
            <ArrowRight
              className="relative h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1"
              aria-hidden
            />
          </Link>
        </div>
      </nav>
    </header>
  );
}

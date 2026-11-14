"use client";

/**
 * The Earthquake OBSERVATORY — the landing's child page, as its own
 * instrument. Where the film is a dark cinema, this is mission control:
 * deep-space navy, one signal orange, a living 3D night-Earth, and an
 * investigation told as numbered chapters. Everything renders EXISTING
 * engine capability (live USGS ComCat events, live ASF/NISAR granule
 * availability, real scans, real earthquake_coseismic verdicts); no
 * science is computed client-side.
 *
 * The story, one continuous scroll:
 *   hero (the question + the globe) → how it works →
 *   CH·01 target → CH·02 coverage → CH·03 scan → CH·04 trace →
 *   CH·05 verdict → CH·06 map → CH·07 evidence → CH·08 archive
 * with a fixed chapter rail (scroll-spy) on the left and a scroll
 * progress hairline up top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamicImport from "next/dynamic";
import {
  ArrowDown,
  ArrowUpRight,
  Crosshair,
  FileCheck2,
  Github,
  Radar,
} from "lucide-react";
import TargetSection from "./sections/TargetSection";
import CoverageSection from "./sections/CoverageSection";
import ScanSection from "./sections/ScanSection";
import TraceSection from "./sections/TraceSection";
import VerdictSection from "./sections/VerdictSection";
import EvidenceSection from "./sections/EvidenceSection";
import AdvancedPanel from "./advanced/AdvancedPanel";
import { useEngineHealth, useEvents } from "@/components/quake/engineHooks";
import { REPO_URL } from "@/components/speckle/data";
import { fmtMagnitude } from "./shared";
import type { Target } from "./shared";
import { cn } from "@/components/quake/utils";

const MapSection = dynamicImport(() => import("./sections/MapSection"), {
  ssr: false,
  loading: () => (
    <div className="qp-card h-[420px] animate-pulse" aria-label="Loading map" />
  ),
});

const QuakeGlobe = dynamicImport(() => import("./QuakeGlobe"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse rounded-full bg-[var(--qp-paper-3)]" aria-label="Loading globe" />
  ),
});

/* ------------------------------------------------------------------ */
/* the chapters — the investigation's table of contents                 */
/* ------------------------------------------------------------------ */

const CHANNELS = [
  { id: "target", n: "01", label: "Event" },
  { id: "coverage", n: "02", label: "Coverage" },
  { id: "scan", n: "03", label: "Scan" },
  { id: "trace", n: "04", label: "Trace" },
  { id: "verdict", n: "05", label: "Verdict" },
  { id: "map", n: "06", label: "Map" },
  { id: "evidence", n: "07", label: "Evidence" },
  { id: "deep", n: "08", label: "Archive" },
] as const;

/* ------------------------------------------------------------------ */
/* engine status chip                                                   */
/* ------------------------------------------------------------------ */

function EngineChip() {
  const health = useEngineHealth();
  let dot = "bg-[var(--qp-ink-3)]";
  let label = "engine · connecting";
  let title = "Probing the hazard engine on port 8900…";
  if (health.isError) {
    dot = "bg-[#e2574e]";
    label = "engine · offline";
    title = health.error?.message ?? "The engine is unreachable.";
  } else if (health.data?.ok) {
    const busy = health.data.busy;
    dot = busy ? "bg-[#d9a13f] qx-pulse-dot" : "bg-[#4fae7f]";
    label = busy ? `engine · busy: ${String(busy.step ?? busy.kind)}` : "engine · online";
    title = busy
      ? `The engine is running ${busy.kind} ${busy.run_id ?? ""} (${String(busy.step ?? "")})`
      : `Engine online — scans ${health.data.scans_enabled ? "enabled" : "disabled"}, Earthdata ${
          health.data.earthdata_credentials ?? "?"
        }`;
  }
  return (
    <span
      title={title}
      className="qp-readout inline-flex items-center gap-2 rounded-full border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)]/90 px-3 py-1.5 backdrop-blur"
    >
      <span className={cn("block h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--qp-ink-2)]">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* the chapter rail — fixed scroll-spy on the left                      */
/* ------------------------------------------------------------------ */

function ChapterRail({ active }: { active: string }) {
  return (
    <nav aria-label="Investigation chapters" className="qp-rail hidden xl:block">
      <div aria-hidden className="qp-rail-line" />
      <ul className="relative">
        {CHANNELS.map((c) => (
          <li key={c.id} className="qp-rail-item" data-active={active === c.id}>
            <a
              href={`#${c.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(c.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="flex items-center gap-3"
              aria-current={active === c.id ? "true" : undefined}
            >
              <span aria-hidden className="qp-rail-dot" />
              <span className="qp-rail-label">
                {c.n} · {c.label}
              </span>
              <span className="sr-only">chapter {c.n} — {c.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* the live ticker — a quiet marquee of real events (Japan preset)      */
/* ------------------------------------------------------------------ */

function LiveTicker({ onPick }: { onPick: (t: Target) => void }) {
  const q = useEvents(139.5, 35.7, 60, 5.5);
  const events = q.data?.events?.slice(0, 8) ?? [];
  if (events.length === 0) return null;
  const items = [...events, ...events]; // duplicate for the seamless loop
  return (
    <div className="qp-card mt-6 flex items-center gap-4 overflow-hidden py-2.5 pl-4 pr-2">
      <span className="qp-readout flex shrink-0 items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--qp-red)]">
        <span aria-hidden className="qx-pulse-dot block h-1.5 w-1.5 rounded-full bg-[var(--qp-red)]" />
        Live
      </span>
      <div className="qx-ticker min-w-0 flex-1">
        <div className="qx-ticker-track">
          {items.map((e, i) => (
            <button
              key={`${e.id}-${i}`}
              type="button"
              onClick={() =>
                onPick({
                  lon: e.lon,
                  lat: e.lat,
                  label: e.place ?? `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`,
                  source: "live",
                  event: e,
                })
              }
              className="group flex shrink-0 items-baseline gap-2.5 text-left"
              title={`Investigate ${e.place ?? e.id}`}
            >
              <span className="qp-readout text-[12px] font-semibold text-[var(--qp-ink)] transition-colors group-hover:text-[var(--qp-red-2)]">
                {fmtMagnitude(e.magnitude)}
              </span>
              <span className="max-w-[220px] truncate text-[12px] text-[var(--qp-ink-2)]">
                {e.place ?? "unnamed event"}
              </span>
              <span className="qp-readout text-[10px] tracking-[0.12em] text-[var(--qp-ink-3)]">
                {e.time ? new Date(e.time).toISOString().slice(0, 10) : "—"}
              </span>
              <span
                aria-hidden
                className="qp-readout text-[10px] tracking-[0.14em] text-[var(--qp-ink-3)] transition-colors group-hover:text-[var(--qp-red)]"
              >
                →
              </span>
            </button>
          ))}
        </div>
      </div>
      <span className="qp-readout hidden shrink-0 pr-2 text-[9px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)] sm:block">
        USGS ComCat · Japan region
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the story steps — how the investigation works                        */
/* ------------------------------------------------------------------ */

const STEPS = [
  {
    n: "01",
    icon: Crosshair,
    title: "Choose an earthquake",
    body: "Live from the USGS catalogue, from the project's curated list, or any coordinates you point at.",
    foot: "R1 · ComCat events",
  },
  {
    n: "02",
    icon: Radar,
    title: "Let the radar watch",
    body: "The engine pulls NISAR L-band interferogram pairs that span the quake and screens them for coseismic motion.",
    foot: "M1 · GUNW pairs over the tile",
  },
  {
    n: "03",
    icon: FileCheck2,
    title: "Read the verdict",
    body: "One honest sentence — supported, quiet, or not enough evidence — with every claim traceable to the data.",
    foot: "R2 · evidence tiers",
  },
] as const;

function StorySteps() {
  const { ref, shown } = useRevealSection();
  return (
    <section id="story" ref={ref} aria-labelledby="story-title" className="relative px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <div className="qp-reveal" data-shown={shown}>
          <div className="flex items-end justify-between gap-4">
            <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--qp-red)]">
              How it works
            </p>
            <span aria-hidden className="qp-readout hidden text-[10px] tracking-[0.3em] text-[var(--qp-ink-3)] sm:block">
              THREE MOVES
            </span>
          </div>
          <div aria-hidden className="qp-channel-rule mt-2" />
          <h2
            id="story-title"
            className="mt-6 max-w-3xl font-display text-3xl font-normal leading-[1.06] text-[var(--qp-ink)] sm:text-4xl"
          >
            An investigation in three moves.
          </h2>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-3 sm:mt-10">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className="qp-reveal"
              data-shown={shown}
              style={{ animationDelay: `${120 + i * 110}ms` }}
            >
              <div className="qx-step h-full">
                <div className="flex items-start justify-between gap-4">
                  <span aria-hidden className="qx-step-num">
                    {s.n}
                  </span>
                  <s.icon className="mt-1.5 h-[18px] w-[18px] text-[var(--qp-red)]" aria-hidden />
                </div>
                <h3 className="mt-5 font-display text-xl font-normal text-[var(--qp-ink)]">{s.title}</h3>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-[var(--qp-ink-2)]">{s.body}</p>
                <p className="qp-readout mt-5 text-[10px] uppercase tracking-[0.18em] text-[var(--qp-ink-3)]">
                  {s.foot}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function useRevealSection() {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = setTimeout(() => setShown(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, shown };
}

/* ------------------------------------------------------------------ */
/* the page                                                             */
/* ------------------------------------------------------------------ */

export default function EarthquakePage({ onExit }: { onExit: () => void }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [active, setActive] = useState<string>("target");
  const progressRef = useRef<HTMLDivElement>(null);

  const feed = useEvents(139.5, 35.7, 60, 5.5);
  const heroEvents = feed.data?.events?.slice(0, 8) ?? [];

  const goto = useCallback((anchor: string) => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /* scroll-spy for the rail — the chapter whose section owns the viewport */
  useEffect(() => {
    const ids = CHANNELS.map((c) => c.id);
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const id = e.target.getAttribute("data-channel-id") ?? e.target.id;
            if (ids.includes(id as (typeof ids)[number])) setActive(id);
          }
        }
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: 0 },
    );
    for (const c of CHANNELS) {
      const el = document.getElementById(c.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  /* the scroll progress hairline — fluent feedback, cheap on the main thread */
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
        if (p !== last && progressRef.current) {
          progressRef.current.style.transform = `scaleX(${p})`;
          last = p;
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const back = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onExit();
    },
    [onExit],
  );

  const pickAndGo = useCallback(
    (t: Target) => {
      setTarget(t);
      goto("target");
    },
    [goto],
  );

  const headline = useMemo(
    () => (target ? `● ${target.label}` : "○ no target set"),
    [target],
  );

  return (
    <div className="quake-paper relative flex min-h-screen flex-col">
      {/* scroll progress */}
      <div ref={progressRef} aria-hidden className="qx-progress" />

      {/* ---------------- header ---------------- */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-[var(--qp-edge)] bg-[var(--qp-paper)]/80 backdrop-blur-xl">
        <nav
          aria-label="Earthquake observatory"
          className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-5 sm:px-8"
        >
          <div className="flex min-w-0 items-center gap-4">
            <button
              type="button"
              onClick={back}
              className="font-display text-lg font-medium tracking-[0.34em] text-[var(--qp-ink)] transition-colors hover:text-[var(--qp-red)]"
              title="Return to the film"
            >
              SPECKLE
            </button>
            <span aria-hidden className="hidden h-4 w-px bg-[var(--qp-edge-2)] sm:block" />
            <p className="qp-readout hidden truncate text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-red-2)] sm:block">
              Earthquake observatory
            </p>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <p className="qp-readout hidden max-w-[220px] truncate text-[10px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)] md:block">
              {headline}
            </p>
            <EngineChip />
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="GitHub repository"
              className="text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
            >
              <Github className="h-[15px] w-[15px]" aria-hidden />
            </a>
          </div>
        </nav>
      </header>

      <ChapterRail active={active} />

      <main className="quake-view-in">
        {/* ---------------- hero ---------------- */}
        <section className="relative overflow-hidden px-5 pb-14 pt-28 sm:px-8 sm:pb-20 sm:pt-36">
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.02fr_0.98fr] lg:gap-6">
            <div>
              <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--qp-red)]">
                Speckle · earthquake observatory · coseismic desk
              </p>
              <h1 className="mt-5 font-display text-[clamp(2.7rem,6.2vw,4.9rem)] font-normal leading-[1.02] tracking-[-0.01em] text-[var(--qp-ink)]">
                Did the ground
                <br />
                move <span className="italic text-[var(--qp-red)]">here</span>?
              </h1>
              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-[var(--qp-ink-2)] sm:text-base">
                When an earthquake strikes, radar remembers. Point the hazard engine at any
                epicentre and it reads NISAR&apos;s interferometric memory of the ground — then
                answers in one honest sentence, with the physics to back it.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => goto("target")}
                  className="qp-readout group inline-flex min-h-11 items-center gap-2.5 rounded-full bg-[var(--qp-red)] px-7 py-3.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-[#140a06] shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-colors duration-300 hover:bg-[var(--qp-red-2)]"
                >
                  Open the investigation
                  <ArrowDown
                    className="h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5"
                    aria-hidden
                  />
                </button>
                <button
                  type="button"
                  onClick={() => goto("story")}
                  className="qp-readout inline-flex min-h-11 items-center gap-2.5 rounded-full border border-[var(--qp-edge-2)] px-7 py-3.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--qp-ink)] transition-all duration-300 hover:border-[var(--qp-red)]/60 hover:text-[var(--qp-red-2)]"
                >
                  How it works
                </button>
              </div>
              <p className="qp-readout mt-8 text-[11px] uppercase tracking-[0.16em] text-[var(--qp-ink-3)]">
                {target ? (
                  <span className="text-[var(--qp-red-2)]">
                    ● investigating · {target.label} · {target.lat.toFixed(2)}°, {target.lon.toFixed(2)}°
                  </span>
                ) : (
                  <>
                    ○ no target set · 23 curated events · live USGS feed · NISAR L-band
                  </>
                )}
              </p>
              <LiveTicker onPick={pickAndGo} />
            </div>

            {/* the globe — Earth at night, the quakes as embers */}
            <div className="relative mx-auto w-full max-w-[520px] lg:mx-0 lg:justify-self-end">
              <div className="qx-globe-stage relative aspect-square w-full">
                <QuakeGlobe target={target} events={heroEvents} className="absolute inset-0" />
              </div>
              <p className="qp-readout mt-2 flex items-center justify-center gap-2 text-center text-[10px] uppercase tracking-[0.22em] text-[var(--qp-ink-3)]">
                <span aria-hidden className="qx-pulse-dot block h-1.5 w-1.5 rounded-full bg-[var(--qp-red)]" />
                night side · {target ? "target locked" : "the watch continues"}
              </p>
            </div>
          </div>
        </section>

        <div aria-hidden className="qx-wave mx-auto max-w-6xl px-5 sm:px-8" />

        {/* ---------------- the story, in chapters ---------------- */}
        <StorySteps />

        <div aria-hidden className="qx-wave mx-auto max-w-6xl px-5 sm:px-8" />

        <TargetSection target={target} onTarget={setTarget} />
        <CoverageSection target={target} />
        <ScanSection target={target} runId={runId} onRunId={setRunId} />
        <TraceSection target={target} runId={runId} onGoto={goto} />
        <VerdictSection target={target} runId={runId} onGoto={goto} />
        <MapSection target={target} runId={runId} />
        <EvidenceSection target={target} runId={runId} />

        {/* the archive — the technical annex, still part of the scroll */}
        <div id="deep">
          <AdvancedPanel
            target={target}
            onTarget={setTarget}
            runId={runId}
            onRunId={setRunId}
            onExit={onExit}
          />
        </div>
      </main>

      {/* ---------------- footer ---------------- */}
      <footer className="relative mt-auto border-t border-[var(--qp-edge)] bg-[var(--qp-paper-2)]/40">
        <div className="mx-auto max-w-7xl px-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-10 sm:px-8">
          <div className="grid gap-12 md:grid-cols-12">
            <div className="md:col-span-6">
              <p className="font-display text-2xl font-normal tracking-[0.3em] text-[var(--qp-ink)]">SPECKLE</p>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-[var(--qp-ink-2)]">
                The Earthquake observatory of the Dancing with the SARs hazard engine — NISAR
                interferometry, forward-model physics, and verdicts that only claim what the
                evidence supports.
              </p>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="qp-readout mt-5 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
              >
                <Github className="h-3.5 w-3.5" aria-hidden />
                Dancing with the SARs
                <ArrowUpRight className="h-3 w-3" aria-hidden />
              </a>
            </div>
            <nav aria-label="Investigation" className="md:col-span-3">
              <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-3)]">
                Chapters
              </p>
              <ul className="mt-4 space-y-3">
                {CHANNELS.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => goto(c.id)}
                      className="text-sm text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
                    >
                      <span className="qp-readout mr-2 text-[10px] text-[var(--qp-ink-3)]">CH·{c.n}</span>
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Project" className="md:col-span-3">
              <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--qp-ink-3)]">
                Project
              </p>
              <ul className="mt-4 space-y-3">
                <li>
                  <a
                    href="https://github.com/Tech-Doomsday/Dancing_With_SARs/blob/main/docs/ARCHITECTURE.md"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
                  >
                    Architecture
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.spaceappschallenge.org/"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
                  >
                    NASA Space Apps
                  </a>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={onExit}
                    className="text-sm text-[var(--qp-ink-2)] transition-colors hover:text-[var(--qp-red)]"
                  >
                    Return to the film
                  </button>
                </li>
              </ul>
            </nav>
          </div>
          <div className="mt-14 border-t border-[var(--qp-edge)] pt-7 text-xs leading-relaxed text-[var(--qp-ink-2)]">
            <p>
              Event context: USGS ComCat via the engine&apos;s R1 adapter · Radar data: NASA
              ISRO NISAR products via ASF (Alaska Satellite Facility) · Earthdata credentials stay
              server-side.
            </p>
            <p className="mt-1.5">
              Verdicts are evidence tiers, not probabilities. Not affiliated with or endorsed by
              NASA or ISRO.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

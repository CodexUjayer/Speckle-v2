"use client";

/** Shared UI atoms for the Earthquake OBSERVATORY page.
 *
 *  Clean, minimal, modern: deep-space navy, hairline edges, one signal
 *  orange, generous air. Sections reveal on scroll (IntersectionObserver)
 *  with a fluent rise. Presentation only — no science.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { TONE_DOT, TONE_TEXT, toneOf, tierLine } from "./shared";
import type { PipelineResult } from "@/lib/engine/types";
import { cn } from "@/components/quake/utils";

/* ------------------------------------------------------------------ */
/* scroll reveal — one observer, sections rise into place               */
/* ------------------------------------------------------------------ */

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
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
/* section shell — a numbered chapter of the investigation              */
/* ------------------------------------------------------------------ */

export function QuakeSection({
  id,
  kicker,
  title,
  body,
  children,
  className,
  narrow,
  channel,
}: {
  id: string;
  kicker: string;
  title: string;
  body?: string;
  children: ReactNode;
  className?: string;
  narrow?: boolean;
  /** chapter number, e.g. "01" — the story's numbering */
  channel?: string;
}) {
  const { ref, shown } = useReveal<HTMLElement>();
  return (
    <section
      id={id}
      ref={ref}
      aria-labelledby={`${id}-title`}
      data-channel={channel}
      className={cn("relative px-5 py-16 sm:px-8 sm:py-24", className)}
    >
      <div
        className={cn("relative mx-auto", narrow ? "max-w-3xl" : "max-w-6xl")}
      >
        <div className="qp-reveal" data-shown={shown}>
          {/* chapter head: ghost number + kicker on a hairline */}
          <div className="flex items-end justify-between gap-4">
            <div className="flex items-baseline gap-4">
              {channel ? (
                <span
                  aria-hidden
                  className="font-display text-[2.6rem] font-light italic leading-none text-transparent sm:text-[3rem]"
                  style={{ WebkitTextStroke: "1px var(--qp-edge-2)" }}
                >
                  {channel}
                </span>
              ) : null}
              <p className="qp-readout pb-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--qp-red)]">
                {kicker}
              </p>
            </div>
            <span
              aria-hidden
              className="qp-readout hidden pb-1 text-[10px] tracking-[0.3em] text-[var(--qp-ink-3)] sm:block"
            >
              CH·{channel ?? "--"}
            </span>
          </div>
          <div aria-hidden className="qp-channel-rule mt-2" />
          <h2
            id={`${id}-title`}
            className="mt-7 max-w-3xl font-display text-3xl font-normal leading-[1.06] tracking-[-0.01em] text-[var(--qp-ink)] sm:text-4xl lg:text-[2.9rem]"
          >
            {title}
          </h2>
          {body ? (
            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--qp-ink-2)]">
              {body}
            </p>
          ) : null}
        </div>
        <div className="qp-reveal mt-8 sm:mt-12" data-shown={shown} style={{ animationDelay: "90ms" }}>
          {children}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* panels — quiet dark surfaces                                         */
/* ------------------------------------------------------------------ */

export function Panel({
  children,
  className,
  id,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return (
    <As id={id} className={cn("qp-card", className)}>
      {children}
    </As>
  );
}

export function PanelHead({
  title,
  right,
  className,
}: {
  title: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-[var(--qp-edge)] px-5 py-3.5",
        className,
      )}
    >
      <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--qp-ink-2)]">
        {title}
      </p>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* tier badge — the engine's status vocabulary                          */
/* ------------------------------------------------------------------ */

export function TierBadge({
  result,
  className,
}: {
  result: Pick<PipelineResult, "status" | "tier" | "tier_label">;
  className?: string;
}) {
  const tone = toneOf(result);
  return (
    <span
      className={cn(
        "qp-readout inline-flex items-center gap-2 rounded-full border border-[var(--qp-edge-2)] bg-[var(--qp-paper-3)]/60 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
        TONE_TEXT[tone],
        className,
      )}
    >
      <span className={cn("block h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} aria-hidden />
      {tierLine(result)}
    </span>
  );
}

/** The verdict seal — the engine's tier, sealed across the record. */
export function StampBadge({
  result,
  className,
}: {
  result: Pick<PipelineResult, "status" | "tier" | "tier_label">;
  className?: string;
}) {
  const tone = toneOf(result);
  const text = (result.tier_label ?? result.tier ?? result.status).replaceAll("_", " ").toUpperCase();
  return (
    <span
      className={cn("qp-stamp", TONE_TEXT[tone], className)}
      role="img"
      aria-label={`verdict: ${tierLine(result)}`}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* mono readouts — the instrument voice                                 */
/* ------------------------------------------------------------------ */

export function Mono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("qp-readout text-[11px] tracking-[0.08em] text-[var(--qp-ink-2)]", className)}>
      {children}
    </span>
  );
}

export function Readout({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0" title={hint}>
      <p className="qp-readout text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">{label}</p>
      <p className="qp-readout mt-1 truncate text-[12.5px] font-medium tracking-[0.04em] text-[var(--qp-ink)]">{value}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* key/value rows — dense technical listing                             */
/* ------------------------------------------------------------------ */

export function KeyValue({
  rows,
  className,
}: {
  rows: { k: string; v: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-[var(--qp-edge)]", className)}>
      {rows.map((r) => (
        <div key={r.k} className="grid grid-cols-[minmax(120px,34%)_1fr] gap-3 px-5 py-2.5">
          <dt className="qp-readout text-[10.5px] uppercase tracking-[0.14em] text-[var(--qp-ink-3)]">{r.k}</dt>
          <dd
            className={cn(
              "min-w-0 text-[13px] leading-relaxed text-[var(--qp-ink)]",
              r.mono && "qp-readout text-[12px] tracking-[0.04em]",
            )}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* states — loading / empty / error, all honest                         */
/* ------------------------------------------------------------------ */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border border-[var(--qp-edge-2)] border-t-[var(--qp-red)]",
        className,
      )}
    />
  );
}

export function LoadingPanel({ label = "Loading" }: { label?: string }) {
  return (
    <Panel className="flex items-center gap-3 px-5 py-8">
      <Spinner />
      <Mono>{label}…</Mono>
    </Panel>
  );
}

export function ErrorPanel({
  title = "The engine could not answer",
  message,
  hint,
  onRetry,
}: {
  title?: string;
  message: string;
  hint?: string;
  onRetry?: () => void;
}) {
  return (
    <Panel className="border-[var(--qp-red)]/40 bg-[var(--qp-red-wash)] px-5 py-5">
      <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-red)]">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--qp-ink)]">{message}</p>
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-[var(--qp-ink-2)]">{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="qp-readout mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--qp-ink)]/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--qp-ink)] transition-colors hover:border-[var(--qp-red)] hover:text-[var(--qp-red)]"
        >
          Try again
        </button>
      ) : null}
    </Panel>
  );
}

export function EmptyPanel({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Panel className="border-dashed px-5 py-8 text-center">
      <p className="qp-readout text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--qp-ink-3)]">{title}</p>
      <div className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--qp-ink-2)]">
        {children}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* pills — the page's actions                                           */
/* ------------------------------------------------------------------ */

export function PrimaryPill({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "qp-readout group inline-flex min-h-11 items-center gap-2.5 rounded-full bg-[var(--qp-red)] px-7 py-3.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-[#140a06] shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-colors duration-300 hover:bg-[var(--qp-red-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--qp-red)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostPill({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "qp-readout inline-flex min-h-11 items-center gap-2.5 rounded-full border border-[var(--qp-edge-2)] px-7 py-3.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--qp-ink)] transition-all duration-300 hover:border-[var(--qp-red)]/60 hover:text-[var(--qp-red-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--qp-red)] disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* chips — small categorical tags                                       */
/* ------------------------------------------------------------------ */

export function Chip({
  children,
  tone = "dim",
  className,
}: {
  children: ReactNode;
  tone?: "dim" | "ok" | "mid" | "off" | "accent";
  className?: string;
}) {
  const tones = {
    dim: "border-[var(--qp-edge-2)] text-[var(--qp-ink-2)]",
    ok: "border-[#3ecf9a]/45 text-[#3ecf9a]",
    mid: "border-[#e8b74e]/45 text-[#e8b74e]",
    off: "border-[var(--qp-red)]/45 text-[var(--qp-red)]",
    accent: "border-[var(--qp-red)]/60 text-[var(--qp-red-2)]",
  } as const;
  return (
    <span
      className={cn(
        "qp-readout inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-[0.14em] uppercase",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

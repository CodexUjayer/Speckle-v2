"use client";

/** BigLoader — a plain "working on it" notice: a headline, three bouncing dots, an optional one-line explanation.
 *  When the caller knows `done` / `total` it also shows "3 of 12" and a thin real progress bar. It never estimates time.
 *  Presentation only. The dots stop bouncing for people who asked for reduced motion. */

/** Three bouncing dots. `className` sets the colour (they use currentColor) and, via text size, how big they are. */
export function Dots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex items-end gap-1 ${className}`}>
      {[0, 150, 300].map((d) => (
        <span key={d} className="h-[0.55em] w-[0.55em] rounded-full bg-current motion-safe:animate-bounce"
              style={{ animationDelay: `${d}ms`, animationDuration: "0.9s" }} />
      ))}
    </span>
  );
}

export default function BigLoader({
  title, hint, done, total, tone = "light", size = "md", testId,
}: {
  title: string;
  hint?: string;
  done?: number;
  total?: number;
  tone?: "light" | "dark";
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  const dark = tone === "dark";
  const known = typeof done === "number" && typeof total === "number" && total > 0;
  const pct = known ? Math.max(3, Math.min(100, Math.round((done! / total!) * 100))) : 0;
  const box = dark ? "border-[#2c5f58]/60 bg-[#12201e] text-[#a7d9cd]" : "border-[#e7e2da] bg-[#faf9f6] text-[#1c1a17]";
  const sub = dark ? "text-[#8fc2b6]" : "text-[#8a837b]";
  const dots = size === "lg" ? "text-[18px]" : size === "md" ? "text-[14px]" : "text-[11px]";
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid={testId}
         className={`rounded-lg border px-3 py-3 ${box}`}>
      <p className={`flex items-center gap-2.5 font-medium ${size === "sm" ? "text-[12px]" : "text-[13px]"}`}>
        <span>{title.replace(/…$/, "")}</span>
        <Dots className={`${dots} ${dark ? "text-[#3fb6c9]" : "text-[#2c5f58]"}`} />
      </p>
      {hint && <p className={`mt-1 text-[11px] leading-snug ${sub}`}>{hint}</p>}
      {known && (
        <>
          <div className={`mt-2 h-1 overflow-hidden rounded-full ${dark ? "bg-[#1d3a35]" : "bg-[#e7e2da]"}`}>
            <div className="h-full rounded-full bg-[#2c5f58] transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <p className={`mono mt-1 text-[10px] ${sub}`}>{done} of {total}</p>
        </>
      )}
    </div>
  );
}

/** Small inline version for a tile or a one-line status. */
export function MiniSpinner({ className = "" }: { className?: string }) {
  return <Dots className={`text-[9px] ${className}`} />;
}

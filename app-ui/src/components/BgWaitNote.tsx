"use client";

/** BgWaitNote — one quiet line while reads from NASA are still going. There is no time limit on those reads, so this
 *  says what is happening instead of a "timed out": how long, whether the engine had to retry a network failure (and why),
 *  and whether the engine itself is momentarily out of reach (the read keeps running there). Nothing is estimated. */
import { useEffect, useState } from "react";
import { useBgWaits } from "@/lib/bgWait";
import { Dots } from "@/components/BigLoader";

export default function BgWaitNote({ dark = false }: { dark?: boolean }) {
  const waits = useBgWaits();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (waits.length === 0) return;
    setNow(performance.now());
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, [waits.length]);
  if (waits.length === 0) return null;

  const oldest = waits.reduce((a, b) => (b.since < a.since ? b : a));
  const secs = Math.max(0, Math.round((now - oldest.since) / 1000));
  const retrying = waits.find((w) => w.attempt > 1 && w.lastError);
  const link = waits.find((w) => w.linkError);
  const cls = dark
    ? "border-[#2c5f58]/60 bg-[#12201e] text-[#a7d9cd]"
    : "border-[#b9d6cf] bg-[#eef6f3] text-[#2c5f58]";
  return (
    <div role="status" aria-live="polite" className={`rounded-xl border px-3 py-2 text-[12px] ${cls}`}>
      <p className="flex items-center gap-2 font-semibold">
        Still reading from NASA{waits.length > 1 ? ` (${waits.length} reads)` : ""} — {secs} s so far
        <Dots className="text-[11px]" />
      </p>
      <p className="mt-0.5 text-[11px] opacity-90">It keeps going until it has the data — nothing is stuck.</p>
      {retrying && (
        <p className="mt-1 text-[11px]">
          Attempt {retrying.attempt}: <span className="mono">{retrying.lastError}</span>
          {retrying.retryInS != null ? `, trying again in ${Math.round(retrying.retryInS)} s` : ""}.
        </p>
      )}
      {link && (
        <p className="mt-1 text-[11px]">
          The engine did not answer just now (<span className="mono">{link.linkError}</span>); the read is still running there, asking again.
        </p>
      )}
    </div>
  );
}

"use client";

/** InlineTokenPrompt: the one-line way to hand the map the Background token when the engine still has its gate on.
 *  It replaces the old trip to the Background tab. The usual way never shows it: with NISAR_BACKGROUND_OPEN=1 on a
 *  local engine, or NEXT_PUBLIC_BACKGROUND_TOKEN in .env.local, the map does not ask at all. The token is kept in
 *  sessionStorage for this tab only (see lib/bgToken) and never placed in a URL. */
import { useState } from "react";
import { setToken } from "@/lib/bgToken";

export default function InlineTokenPrompt({ kind, onSaved, tone = "light" }: {
  kind: "unauthorized" | "unconfigured";
  onSaved: () => void;
  tone?: "light" | "dark";
}) {
  const [value, setValue] = useState("");
  const dark = tone === "dark";
  if (kind === "unconfigured") {
    return (
      <span role="alert" className={dark ? "vd-note" : "text-[10px] text-[#9e3b2c]"}>
        The engine has no access key set. For a local engine start it with NISAR_BACKGROUND_OPEN=1; otherwise set
        NISAR_BACKGROUND_TOKEN and put the same value in NEXT_PUBLIC_BACKGROUND_TOKEN in .env.local.
      </span>
    );
  }
  return (
    <form
      className="inline-flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) { setToken(value.trim()); onSaved(); } }}
    >
      <span className={dark ? "vd-note" : "text-[10px] text-[#9e3b2c]"}>The engine wants its access key once:</span>
      <input
        suppressHydrationWarning type="password" value={value} onChange={(e) => setValue(e.target.value)}
        aria-label="Engine access key" placeholder="access key"
        className={dark
          ? "w-36 rounded-full border border-[rgba(244,239,230,0.25)] bg-transparent px-3 py-1 font-mono text-[12px] text-[#f4efe6] focus:outline-none"
          : "w-32 rounded border border-[#e7e2da] px-1.5 py-0.5 font-mono text-[10px]"}
      />
      <button type="submit" className={dark ? "vd-btn" : "rounded border border-[#9e3b2c] px-1 text-[10px] text-[#9e3b2c]"}
              data-quiet={dark ? "1" : undefined}>Save</button>
    </form>
  );
}

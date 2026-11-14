"use client";

/** Background token storage — the legacy prompt components' sessionStorage helpers.
 *
 *  bgApi.ts dropped its token functions when the engine removed the background access
 *  gate (engine/api/routes_background.py: "NO KEY: these routes need no access key and
 *  no Authorization header" — the data are public). Two legacy prompt components
 *  (components/background/TokenGate.tsx, components/globe/InlineTokenPrompt.tsx) still
 *  compile against that old surface, so the helpers live here: sessionStorage for this
 *  tab session only, try/catch around every access (private mode / blocked storage),
 *  never in a URL, never logged. Nothing sends the token anymore — bgFetch builds no
 *  Authorization header — so this is purely compatibility for code that renders only
 *  if an importer ever mounts it (none currently does). */

const KEY = "speckle_bg_token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null; // storage blocked (private mode &c.) — same as "no token"
  }
}

export function setToken(value: string): void {
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked — the prompt's save is simply not persisted */
  }
}

"use client";

/** Background API client. The engine no longer has an access gate (the data are public), so there is no token to
 *  store, send or ask for. This module turns a 503 from the engine into a typed EngineUnavailableError carrying
 *  the engine's own text, and follows the engine's 202 + job id for reads that outlast its answer window. */

import { engineBase } from "./engineUrl";
import { engineErrorText, engineFetch, ENGINE_LONG_MS, ENGINE_TIMEOUT_MS } from "./engineFetch";
import { bgWaitEnd, bgWaitStart, bgWaitUpdate } from "./bgWait";

/** A 503 from the engine (e.g. no Earthdata credentials on the engine): the views show `message` — the engine's
 *  own `detail.error` — in their normal error state. */
export class EngineUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

async function engineText(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const t = body?.detail?.error ?? body?.error;
    return typeof t === "string" && t ? t : fallback;
  } catch {
    return fallback;
  }
}

/** 503 -> EngineUnavailableError with the engine's verbatim text. Anything else passes. */
async function unavailableCheck(res: Response): Promise<void> {
  if (res.status === 503) {
    throw new EngineUnavailableError(await engineText(res.clone(), "the engine answered 503 (service unavailable)"));
  }
}

/** a read the engine could not finish inside its answer window: 202 + a job id (see engine/api/bg_jobs.py) */
interface JobInfo {
  pending: true;
  job_id: string;
  attempt?: number;
  last_error?: string | null;
  retry_in_s?: number | null;
  poll_interval_s?: number;
  retry_backoff_s?: number[];
}

function isJob(b: unknown): b is JobInfo {
  return !!b && typeof b === "object" && (b as JobInfo).pending === true && typeof (b as JobInfo).job_id === "string";
}

function abortError(): Error {
  return typeof DOMException !== "undefined" ? new DOMException("aborted", "AbortError") : Object.assign(new Error("aborted"), { name: "AbortError" });
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** fetch from the engine; a 503 becomes EngineUnavailableError with the engine's verbatim text.
 *
 *  NO TIME LIMIT on a read from NASA: when the engine answers 202 + job id (the read is still going), this keeps
 *  asking for the answer until there is one — through slow providers, engine-side retries and tunnel blips — and returns
 *  the same Response the route would have sent. It stops only when the caller aborts (the engine is told to cancel). */
export async function bgFetch(path: string, init?: RequestInit & { signal?: AbortSignal },
                              opts?: { timeoutMs?: number }): Promise<Response> {
  const headers = new Headers(init?.headers);
  // paths are engine-relative ("/api/..."); resolve them against the engine in use
  const url = /^https?:\/\//i.test(path) ? path : `${engineBase()}${path}`;
  // transport failures / timeouts become an EngineError that says what failed and what to do. The limit covers ONE
  // request (the engine answers within its window or hands back a job id), never the read itself.
  const res = await engineFetch(url, { ...init, headers }, { timeoutMs: opts?.timeoutMs ?? ENGINE_LONG_MS });
  await unavailableCheck(res);
  if (res.status !== 202 || !path.startsWith("/api/background/")) return res;
  const first: unknown = await res.clone().json().catch(() => null);
  if (!isJob(first)) return res;
  return awaitJob(path, init, opts, headers, first);
}

async function awaitJob(path: string, init: (RequestInit & { signal?: AbortSignal }) | undefined,
                        opts: { timeoutMs?: number } | undefined, headers: Headers, first: JobInfo): Promise<Response> {
  const signal = init?.signal;
  const jobUrl = `${engineBase()}/api/background/jobs/${encodeURIComponent(first.job_id)}`;
  const wid = bgWaitStart(path);
  let info: JobInfo = first;
  let linkFails = 0;
  let linkError: string | null = null;
  try {
    for (;;) {
      bgWaitUpdate(wid, info, linkError);
      await sleep(Math.max(250, (info.poll_interval_s ?? 1) * 1000), signal);
      let r: Response;
      try {
        r = await engineFetch(jobUrl, { headers, signal }, { timeoutMs: ENGINE_TIMEOUT_MS });
      } catch (err) {
        if (signal?.aborted) throw err;
        // this poll got no answer (tunnel blip, engine busy): the read is still running on the engine — keep asking
        linkFails += 1;
        linkError = err instanceof Error ? err.message : String(err);
        const steps = info.retry_backoff_s?.length ? info.retry_backoff_s : [5];
        await sleep(steps[Math.min(linkFails - 1, steps.length - 1)] * 1000, signal);
        continue;
      }
      linkFails = 0;
      linkError = null;
      await unavailableCheck(r);
      if (r.status === 202) {
        const b: unknown = await r.json().catch(() => null);
        if (isJob(b)) info = b;
        continue;
      }
      if (r.status === 404) {
        const msg = engineErrorText(await r.clone().json().catch(() => ({})));
        if (msg.includes("unknown or expired background job")) {   // the engine restarted / forgot it: ask again, still no limit
          bgWaitEnd(wid);
          return bgFetch(path, init, opts);
        }
      }
      return r;                                                    // 200 = the route's own body; an error keeps the engine's own text
    }
  } catch (err) {
    if (signal?.aborted) {
      void fetch(jobUrl, { method: "DELETE", headers, keepalive: true }).catch(() => undefined);   // best effort: free the engine
    }
    throw err;
  } finally {
    bgWaitEnd(wid);
  }
}

/** bgFetch + the engine's {ok:false,error} envelope unwrap (same shapes as lib/api.ts). */
export async function bgGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await bgFetch(path, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(extractError(body, res));
  }
  return res.json() as Promise<T>;
}

function extractError(body: unknown, res: Response): string {
  return engineErrorText(body) || `${res.status} ${res.statusText}`;
}

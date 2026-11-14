"use client";

/** The granule listing for the pinned point, lifted out of the Data panel so the verdict dock and the Data panel
 *  read ONE copy. Same engine call, same behaviour as before: an initial load per pin, then a debounced reload
 *  when the timeline's visible window changes. Stale requests are aborted. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { GranuleSearchResponse } from "./types";

export interface GranulesState {
  data: GranuleSearchResponse | null;
  loading: boolean;
  error: string | null;
  /** the timeline's visible window; the listing reloads for it (debounced) */
  setWindow: (from: string, to: string) => void;
}

export function useGranules(lon: number | null, lat: number | null, enabled: boolean): GranulesState {
  const [data, setData] = useState<GranuleSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<{ from?: string; to?: string }>({});
  const querySig = useRef("");
  const key = lon !== null && lat !== null ? `${lon},${lat}` : null;

  useEffect(() => {
    if (!key || lon === null || lat === null || !enabled) { setData(null); return; }
    querySig.current = "";
    setQuery({});
    setData(null);
    setError(null);
    setLoading(true);
    const ctrl = new AbortController();
    api.granules(lon, lat, {}, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setData(r); })
      .catch((e) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data || lon === null || lat === null) return;
    const sig = `${query.from ?? ""}|${query.to ?? ""}`;
    if (sig === querySig.current) return;
    const timer = setTimeout(() => {
      querySig.current = sig;
      const ctrl = new AbortController();
      setLoading(true);
      api.granules(lon, lat, { from: query.from, to: query.to }, ctrl.signal)
        .then((r) => { if (!ctrl.signal.aborted) setData(r); })
        .catch((e) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, 600);
    return () => clearTimeout(timer);
  }, [query, data, lon, lat]);

  const setWindow = useCallback((from: string, to: string) => setQuery({ from, to }), []);
  return { data, loading, error, setWindow };
}

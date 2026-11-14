"use client";

/** Floating search pill (§7.2): explicit Latitude / Longitude numeric fields, a paste-friendly
 *  parser, "Center on my location" (DEC2), and a Globe/Flat toggle. The map is never the only
 *  way to do anything: every action here is keyboard operable. */
import { useEffect, useRef, useState } from "react";
import { parseCoordinates } from "@/lib/geo-input";
import { currentPosition, geoState, type GeoState } from "@/lib/geolocation";

export interface SearchBarProps {
  lat: string;
  lon: string;
  onLat: (v: string) => void;
  onLon: (v: string) => void;
  /** side length (km) of the square box drawn around the pin; "" = the engine's own tile */
  range?: string;
  onRange?: (v: string) => void;
  /** one honest line about what the range does / why it is not usable */
  rangeNote?: string | null;
  rangeBad?: boolean;
  onSubmit: (lat: number, lon: number) => void;
  onLocate: (lat: number, lon: number) => void;
  flat: boolean;
  onToggleFlat: () => void;
  /** 3D terrain (relief, hillshade, tilt) and its vertical exaggeration; omitted = no 3D controls */
  terrain3d?: boolean;
  onToggleTerrain?: () => void;
  terrainExaggeration?: number;
  onTerrainExaggeration?: (v: number) => void;
  /** extruded OSM buildings and the camera presets of the 3D controls */
  buildings3d?: boolean;
  onToggleBuildings?: () => void;
  onView?: (cmd: { pitch?: number; rotateBy?: number }) => void;
  reducedMotion: boolean;
}

export default function SearchBar(props: SearchBarProps) {
  const latRef = useRef<HTMLInputElement | null>(null);
  const [geo, setGeo] = useState<GeoState>("unavailable");
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    geoState(navigator as never).then((s) => alive && setGeo(s));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        latRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const parsed = parseCoordinates(`${props.lat}, ${props.lon}`);
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }
    setErr(null);
    props.onSubmit(parsed.value.lat, parsed.value.lon);
  };

  const locate = async () => {
    setBusy(true);
    setGeoMsg(null);
    const state = await geoState(navigator as never);
    if (state === "denied" || state === "unavailable") {
      setBusy(false);
      setGeoMsg(
        state === "denied"
          ? "Location permission was denied. You can still type coordinates."
          : "This browser cannot provide your location. You can still type coordinates.",
      );
      return;
    }
    const out = await currentPosition(navigator as never);
    setBusy(false);
    if (out.ok) {
      props.onLocate(out.position.lat, out.position.lon);
    } else {
      setGeoMsg(out.message);
    }
  };

  const field = "mono mt-0.5 w-full rounded-lg border border-[#e2ddd2] bg-[#f3efe7] px-2.5 py-1.5 text-sm text-[#1c1a17] outline-none focus:border-[#2c5f58]";
  const chip = "rounded-full border border-[#e2ddd2] bg-[#f3efe7] px-3 py-1 text-[11px] text-[#4a443c] hover:border-[#2c5f58] disabled:cursor-not-allowed disabled:text-[#8a837b]";
  const chipOn = "rounded-full border border-[#1c1a17] bg-[#1c1a17] px-3 py-1 text-[11px] text-[#faf9f6]";
  return (
    <div className="pointer-events-auto w-full rounded-2xl border border-[#e7e2da] bg-[#faf9f6]/95 p-3 backdrop-blur">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-end gap-2">
        <label className="flex-1 text-[11px] font-medium text-[#4a443c]">
          Latitude
          <input suppressHydrationWarning ref={latRef} value={props.lat} onChange={(e) => props.onLat(e.target.value)}
            inputMode="decimal" autoComplete="off" placeholder="34.05" className={field} aria-label="Latitude (-90 to 90)" />
        </label>
        <label className="flex-1 text-[11px] font-medium text-[#4a443c]">
          Longitude
          <input suppressHydrationWarning value={props.lon} onChange={(e) => props.onLon(e.target.value)}
            inputMode="decimal" autoComplete="off" placeholder="-118.25" className={field} aria-label="Longitude (-180 to 180)" />
        </label>
        <button type="submit" className="h-[34px] rounded-lg bg-[#1c1a17] px-3.5 text-xs font-semibold text-[#faf9f6] hover:bg-[#2c5f58]">Go</button>
      </form>
      {err && <p role="alert" className="mt-2 text-[11px] text-[#9e3b2c]">{err}</p>}
      {props.rangeNote && (props.rangeBad || props.rangeNote.length <= 90 ? (
        <p role={props.rangeBad ? "alert" : undefined}
           className={`mt-2 text-[11px] ${props.rangeBad ? "text-[#9e3b2c]" : "text-[#6b655d]"}`}>{props.rangeNote}</p>
      ) : (
        /* a long note folds to its first sentence so it cannot push the scan controls out of a narrow panel */
        <details className="mt-2 text-[11px] text-[#6b655d]">
          <summary className="cursor-pointer select-none">{props.rangeNote.split(/(?<=[.:])\s/)[0]} <span className="underline">more</span></summary>
          <p className="mt-1">{props.rangeNote}</p>
        </details>
      ))}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={locate} disabled={busy || geo === "unavailable" || geo === "denied"}
          title={geo === "denied" ? "Location permission was denied" : undefined} className={chip}>
          Use my location
        </button>
        {props.onToggleTerrain && (
          <button type="button" onClick={props.onToggleTerrain} aria-pressed={!!props.terrain3d}
            title="3D terrain: real relief under the imagery. Right-drag (or Ctrl-drag) to tilt and rotate."
            className={props.terrain3d ? chipOn : chip}>3D</button>
        )}
        <button type="button" onClick={props.onToggleFlat} aria-pressed={props.flat} className={chip}>
          {props.flat ? "Show globe" : "Show flat map"}
        </button>
      </div>
      {props.onRange && (
        <label className="mt-2.5 block text-[11px] font-medium text-[#4a443c]"
               title="Side length of the square box around the pin, in km. Empty means the engine's own tile (about 10 km).">
          Scan box size in km
          <input suppressHydrationWarning value={props.range ?? ""} onChange={(e) => props.onRange?.(e.target.value)}
            inputMode="decimal" autoComplete="off" placeholder="the engine's tile" className={field} aria-label="Box range in km (side length)" />
        </label>
      )}
      <details className="mt-2 text-[11px] text-[#4a443c]">
        <summary className="cursor-pointer select-none py-0.5 text-[#6b655d]">More options (camera, 3D)</summary>
        <div className="mt-2 space-y-2">
          {props.terrain3d && props.onView && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="3D camera">
              <button type="button" onClick={() => props.onView?.({ pitch: 0 })} className={chip}>Top-down</button>
              <button type="button" onClick={() => props.onView?.({ pitch: 55 })} className={chip}>Tilt</button>
              <button type="button" onClick={() => props.onView?.({ pitch: 72 })} className={chip}>Low</button>
              <button type="button" onClick={() => props.onView?.({ rotateBy: -30 })} className={chip}>Rotate left</button>
              <button type="button" onClick={() => props.onView?.({ rotateBy: 30 })} className={chip}>Rotate right</button>
              {props.onToggleBuildings && (
                <label className="ml-auto flex items-center gap-1" title="OpenStreetMap buildings from zoom 13. Many have no height tag and show as 5 m blocks.">
                  <input type="checkbox" checked={!!props.buildings3d} onChange={props.onToggleBuildings} /> buildings
                </label>
              )}
            </div>
          )}
          {props.terrain3d && props.onTerrainExaggeration && (
            <label className="flex items-center gap-2" title="Vertical exaggeration of the relief. 1 is true scale; flat deltas need more to be visible.">
              Relief x{(props.terrainExaggeration ?? 1.5).toFixed(1)}
              <input type="range" min={1} max={5} step={0.5} value={props.terrainExaggeration ?? 1.5}
                onChange={(e) => props.onTerrainExaggeration?.(Number(e.target.value))} aria-label="Relief exaggeration" className="flex-1" />
            </label>
          )}
        </div>
      </details>
      {geoMsg && <p role="status" className="mt-2 text-[11px] text-[#7a6438]">{geoMsg}</p>}
    </div>
  );
}

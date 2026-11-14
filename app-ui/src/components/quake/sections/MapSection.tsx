"use client";

/** Chapter V — the geography. Leaflet over the dark Carto basemap with:
 *  · the target epicentre (custom marker)
 *  · the engine-resolved MGRS tile footprint
 *  · the engine's per-detection geometries (detail.detections), when a
 *    verdict exists
 *  · the engine's own evidence rasters (displacement / threshold /
 *    detected / residual) rendered with the engine's colormaps
 *  Every coordinate on this map came from the engine — nothing is computed
 *  client-side. */

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Polygon, Rectangle, ImageOverlay, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { QuakeSection, Panel, PanelHead, Chip, Mono, EmptyPanel, Spinner } from "../ui";
import { useQuakeVerdict } from "../useVerdict";
import { useTileAt } from "@/components/quake/engineHooks";
import { renderLayer, layerLegend } from "../raster";
import { fmtArea, fmtMagnitude, fmtDate, type Target } from "../shared";
import type { LayerPayload } from "@/lib/engine/types";
import { cn } from "@/components/quake/utils";

/* CARTO basemaps key (client-side by design — cb1_ keys are publishable).
 *  Override per environment with NEXT_PUBLIC_CARTO_API_KEY. */
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY ?? "cb1_4plb_2_44269ffa192773cca04eb4a0";

/* ------------------------------------------------------------------ */
/* markers                                                             */
/* ------------------------------------------------------------------ */

const epicentreIcon = L.divIcon({
  className: "",
  html: `<div style="position:relative;width:18px;height:18px">
    <div style="position:absolute;inset:0;border-radius:999px;background:#3ecf9a;box-shadow:0 0 10px rgba(62,207,154,.9)"></div>
    <div style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:999px;background:#04070d"></div>
  </div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const detectionIcon = L.divIcon({
  className: "",
  html: `<div style="width:10px;height:10px;border-radius:999px;background:#e8b74e;box-shadow:0 0 8px rgba(232,183,78,.8);border:1px solid rgba(4,7,13,.8)"></div>`,
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

function FitBounds({ bounds }: { bounds: [number, number, number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    const b = L.latLngBounds([bounds[1], bounds[0]], [bounds[3], bounds[2]]);
    map.fitBounds(b, { padding: [48, 48], maxZoom: 13 });
  }, [map, bounds]);
  return null;
}

/* ------------------------------------------------------------------ */
/* layer raster (memoised canvas render)                                */
/* ------------------------------------------------------------------ */

function useRaster(layer: LayerPayload | null) {
  return useMemo(() => (layer ? renderLayer(layer) : null), [layer]);
}

/* ------------------------------------------------------------------ */
/* the section                                                          */
/* ------------------------------------------------------------------ */

const LAYER_ORDER = ["displacement", "detected", "threshold", "residual"] as const;

export default function MapSection({ target, runId }: { target: Target | null; runId: string | null }) {
  const tile = useTileAt(target?.lon ?? null, target?.lat ?? null);
  const verdict = useQuakeVerdict(target, runId);
  const layers = verdict.result?.detail?.layers ?? {};
  const available = LAYER_ORDER.filter((n) => layers[n]?.data_b64);
  const [pickedLayer, setPickedLayer] = useState<string | null>(null);
  const [showDetections, setShowDetections] = useState(true);

  /* derive during render: a picked layer that no longer exists falls back
     to the first available — no state-sync effect needed */
  const activeLayer =
    pickedLayer && available.includes(pickedLayer as (typeof available)[number])
      ? pickedLayer
      : (available[0] ?? null);

  const layer = activeLayer ? layers[activeLayer] ?? null : null;
  const raster = useRaster(layer);
  const detections = verdict.result?.detail?.detections ?? [];
  const tileBounds = tile.data?.tile.bbox_lonlat ?? null;

  const legend = layer ? layerLegend(layer) : [];

  return (
    <QuakeSection
      id="map"
      channel="06"
      kicker="the geography"
      title="Where, exactly."
      body="The tile, the epicentre, the engine's detection geometries and its evidence rasters — one dark map. The raster colours follow the engine's own colormaps and its vmin/vmax; the sign convention is the engine's (positive LOS = toward the satellite)."
    >
      {!target ? (
        <EmptyPanel title="Waiting for a target">
          Choose an earthquake to pin its epicentre and tile on the map.
        </EmptyPanel>
      ) : (
        <Panel className="overflow-hidden">
          <PanelHead
            title="Investigation map"
            right={
              available.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {available.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setPickedLayer(n)}
                      className={cn(
                        "rounded-full border px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                        activeLayer === n
                          ? "border-[var(--qp-red)]/60 bg-[var(--qp-red)]/10 text-[var(--qp-red)]"
                          : "border-[var(--qp-edge-2)] text-[var(--qp-ink-2)] hover:text-[var(--qp-ink)]",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowDetections((v) => !v)}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                      showDetections && detections.length
                        ? "border-[#e8b74e]/50 bg-[#e8b74e]/10 text-[#e8b74e]"
                        : "border-[var(--qp-edge-2)] text-[var(--qp-ink-2)] hover:text-[var(--qp-ink)]",
                    )}
                  >
                    detections {detections.length ? `(${detections.length})` : ""}
                  </button>
                </div>
              ) : (
                <Chip>no rasters yet</Chip>
              )
            }
          />
          <div className="relative h-[420px] sm:h-[520px]">
            <MapContainer
              center={[target.lat, target.lon]}
              zoom={10}
              className="h-full w-full [&_.leaflet-container]:bg-transparent"
              style={{ background: "#04070d" }}
              scrollWheelZoom
              attributionControl
            >
              <TileLayer
                url={`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                subdomains={["a", "b", "c", "d"]}
                maxZoom={18}
              />

              {/* the engine-resolved tile footprint */}
              {tileBounds ? (
                <Rectangle
                  bounds={[
                    [tileBounds[1], tileBounds[0]],
                    [tileBounds[3], tileBounds[2]],
                  ]}
                  pathOptions={{ color: "#93a1b8", weight: 1.2, opacity: 0.7, fill: false, dashArray: "4 4" }}
                >
                  <Popup>
                    <div className="font-mono text-[11px]">
                      MGRS tile {tile.data?.tile.id} · {(tile.data?.tile.size_m ?? 10000) / 1000} km · EPSG:
                      {tile.data?.tile.epsg}
                    </div>
                  </Popup>
                </Rectangle>
              ) : null}

              {/* the epicentre */}
              <Marker position={[target.lat, target.lon]} icon={epicentreIcon}>
                <Popup>
                  <div className="text-[12px] leading-relaxed">
                    <strong>{target.label}</strong>
                    <br />
                    {target.event
                      ? `${fmtMagnitude(target.event.magnitude)} · ${fmtDate(target.event.time)} · ${
                          target.event.depth_km != null ? `${target.event.depth_km.toFixed(0)} km deep` : "depth unknown"
                        }`
                      : target.curated
                        ? `${target.curated.size} · ${target.curated.dateText}`
                        : "manual coordinates"}
                    <br />
                    <span className="font-mono text-[10px] opacity-70">
                      USGS {target.event?.id ?? "—"}
                    </span>
                  </div>
                </Popup>
              </Marker>

              {/* the engine's detection geometries */}
              {showDetections &&
                detections.map((d) => (
                  <span key={d.id}>
                    <Rectangle
                      bounds={[
                        [d.bbox_lonlat[1], d.bbox_lonlat[0]],
                        [d.bbox_lonlat[3], d.bbox_lonlat[2]],
                      ]}
                      pathOptions={{
                        color: d.polarity === "toward" ? "#3ecf9a" : d.polarity === "away" ? "#ff5d55" : "#e8b74e",
                        weight: 1,
                        opacity: 0.8,
                        fillOpacity: 0.06,
                      }}
                    >
                      <Popup>
                        <div className="text-[12px] leading-relaxed">
                          <strong>{d.label}</strong>
                          <br />
                          {fmtArea(d.area_km2, 2)} · polarity {d.polarity ?? "—"}
                          {d.metrics?.peak_abs_los_m ? (
                            <>
                              <br />
                              peak |LOS| {(d.metrics.peak_abs_los_m.value * 1000).toFixed(1)} mm
                            </>
                          ) : null}
                        </div>
                      </Popup>
                    </Rectangle>
                    <Marker position={[d.centroid_lonlat[1], d.centroid_lonlat[0]]} icon={detectionIcon} />
                  </span>
                ))}

              {/* the engine's evidence raster */}
              {raster ? (
                <ImageOverlay
                  url={raster.dataUrl}
                  bounds={[
                    [raster.bounds[1], raster.bounds[0]],
                    [raster.bounds[3], raster.bounds[2]],
                  ]}
                  opacity={0.85}
                />
              ) : null}

              <FitBounds bounds={tileBounds} />
            </MapContainer>

            {/* legend */}
            {layer ? (
              <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-md border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)]/90 px-3 py-2.5 backdrop-blur-sm">
                <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--qp-ink-2)]">
                  {layer.name} · {layer.units}
                </p>
                <div className="mt-1.5 space-y-1">
                  {legend.map((l) => (
                    <p key={l.label} className="flex items-center gap-2 font-mono text-[9px] text-[var(--qp-ink-2)]">
                      <span
                        className="inline-block h-2 w-4 rounded-[2px]"
                        style={{ background: l.color }}
                        aria-hidden
                      />
                      {l.label}
                    </p>
                  ))}
                </div>
                {layer.note ? (
                  <p className="mt-1.5 max-w-52 font-mono text-[8px] leading-relaxed text-[var(--qp-ink-3)]">
                    {layer.note}
                  </p>
                ) : null}
              </div>
            ) : null}

            {tile.isPending ? (
              <div className="absolute right-3 top-3 z-[500] flex items-center gap-2 rounded-full border border-[var(--qp-edge-2)] bg-[var(--qp-paper-2)]/90 px-3 py-1.5">
                <Spinner />
                <Mono>resolving tile…</Mono>
              </div>
            ) : null}
          </div>
          <div className="border-t border-[var(--qp-edge)] px-5 py-3">
            <Mono>
              {tile.data?.tile.id ?? "tile pending"}
              {raster ? ` · raster ${raster.width}×${raster.height} px (engine grid)` : ""}
              {detections.length
                ? ` · ${detections.length} engine detection${detections.length > 1 ? "s" : ""}${
                    verdict.result?.detail?.detections_truncated ? " (truncated at 50)" : ""
                  }`
                : ""}
            </Mono>
          </div>
        </Panel>
      )}
    </QuakeSection>
  );
}

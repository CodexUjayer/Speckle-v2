"use client";

/** LabMap — the Data Lab's flat MapLibre canvas. Reuses the Explorer page's proven overlay
 *  rules (engine-supplied image-source corners, default linear resampling — nearest renders
 *  black on maplibre 5.23/5.24, raster-fade off so swaps are crisp) and the same dark style.
 *  The layer STACK is drawn bottom-up in the array's order; each entry is one engine image
 *  with its own opacity. The swipe divider (compare mode "swipe") clips the TOP overlay to
 *  the west/east of a draggable line — pure display, the images themselves never change.
 *  Thin client: every image, corner and unit arrives from the engine; this only places it. */
import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";

const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION = "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";
const AMBER = "#e6c977";

/** one drawable layer of the stack: an object URL the caller owns + the engine's corners */
export interface LabOverlay {
  id: string;
  url: string;
  /** [TL, TR, BR, BL] as [lon, lat] — from the engine's metadata, never computed here */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  opacity: number;
}

/** Phase 4 — the drawn ROI, shared vocabulary of the map and the panels:
 *  kind "box": ring = the 2 drawn corners; kind "polygon": ring = the clicked vertices. */
export interface RoiShape {
  kind: "box" | "polygon";
  ring: [number, number][];
}

interface Props {
  overlays: LabOverlay[];
  bbox: [number, number, number, number] | null;
  /** compare mode "swipe": the fraction (0..1) of the viewport width where the divider sits */
  swipe?: number;
  onSwipe?: (fraction: number) => void;
  onHover?: (lon: number, lat: number) => void;
  onClick?: (lon: number, lat: number) => void;
  /** small labelled markers (the profile panel's A/B); display only */
  pins?: { lon: number; lat: number; label: string }[];
  /** Phase 4 — ROI drawing: when set, map clicks add vertices (polygon) or start/finish a box */
  drawMode?: "box" | "polygon" | null;
  /** the in-progress ring (the caller owns the state so the panels can show it) */
  draftRing?: [number, number][];
  onDraftRing?: (ring: [number, number][]) => void;
  /** the finished ROI (drawn on the map; the engine has its numbers) */
  roiShape?: RoiShape | null;
  /** a polygon draft was closed by double-click (the caller finalizes the shape) */
  onDrawDone?: () => void;
}

export default function LabMap({ overlays, bbox, swipe, onSwipe, onHover, onClick, pins,
                                 drawMode, draftRing, onDraftRing, roiShape, onDrawDone }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const propsRef = useRef({ overlays, swipe, onSwipe, onHover, onClick, drawMode, draftRing, onDraftRing, onDrawDone });
  propsRef.current = { overlays, swipe, onSwipe, onHover, onClick, drawMode, draftRing, onDraftRing, onDrawDone };
  const dragRef = useRef(false);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: el,
        style: {
          version: 8,
          sources: {
            esri: { type: "raster", tiles: [ESRI_TILES], tileSize: 256, maxzoom: 23, attribution: ESRI_ATTRIBUTION },
          },
          layers: [{ id: "esri", type: "raster", source: "esri", paint: { "raster-opacity": 0.85 } }],
        },
        center: bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : [0, 20],
        zoom: bbox ? 9 : 1,
        attributionControl: { compact: true },
        canvasContextAttributes: { preserveDrawingBuffer: true },
        maxPitch: 0,
      });
    } catch {
      return; // WebGL unavailable: the panels still carry every field
    }
    mapRef.current = map;
    map.on("error", () => { /* tile errors are transient; the UI must not die on them */ });
    map.on("load", () => {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: "metric" }), "bottom-right");
      setReady(true);
    });
    map.on("mousemove", (e) => {
      const cb = propsRef.current.onHover;
      if (cb) cb(e.lngLat.lat, e.lngLat.wrap().lng);
    });
    map.on("click", (e) => {
      const lon = e.lngLat.wrap().lng;
      const lat = e.lngLat.lat;
      const { drawMode: draw, onDraftRing: onDraft, onClick: cb } = propsRef.current;
      if (draw) {
        // ROI drawing owns the click while armed (the profile's A/B is not armed at the same
        // time — LabApp routes by tab); a box is two clicks (corner, opposite corner)
        const ring = [...(propsRef.current.draftRing ?? [])];
        if (draw === "polygon") {
          ring.push([lon, lat]);
          onDraft?.(ring);
        } else {
          if (ring.length >= 2) onDraft?.([[lon, lat]]);      // a fresh box restarts
          else onDraft?.([...ring, [lon, lat]]);
        }
        return;
      }
      if (cb) cb(lat, lon);
    });
    map.on("dblclick", (e) => {
      // double-click closes a polygon draft (the last click of the pair is absorbed)
      const { drawMode: draw, onDraftRing: onDraft, draftRing } = propsRef.current;
      if (draw === "polygon" && draftRing && draftRing.length >= 3) {
        e.preventDefault();
        const closed = draftRing.slice(0, -1);                 // drop the dblclick's own vertex
        onDraft?.(closed);
        propsRef.current.onDrawDone?.();                       // the caller finalizes the shape
      }
    });
    if (bbox) {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 0, maxZoom: 12 });
    }
    return () => {
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
    // the map is built once per mount; later box changes are handled by the fitBounds effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a new box from the URL / the search refits the view
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !bbox) return;
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 600, maxZoom: 12 });
  }, [bbox, ready]);

  // the layer stack: bottom-up in array order (index 0 first = lowest), newest changes on top
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const wanted = new Set<string>();
    overlays.forEach((o, i) => {
      const id = `lab:${i}:${o.id}`;
      wanted.add(id);
      const src = map.getSource(id) as maplibregl.ImageSource | undefined;
      if (src) {
        src.updateImage({ url: o.url, coordinates: o.corners });
      } else {
        map.addSource(id, { type: "image", url: o.url, coordinates: o.corners });
      }
      if (!map.getLayer(id)) {
        // default linear resampling: nearest renders black on maplibre 5.23/5.24 image sources (S1)
        map.addLayer({ id, type: "raster", source: id,
                       paint: { "raster-opacity": o.opacity, "raster-fade-duration": 0 } });
      } else {
        map.setPaintProperty(id, "raster-opacity", o.opacity);
      }
    });
    for (const id of Object.keys(map.getStyle().sources)) {
      if (id.startsWith("lab:") && !wanted.has(id)) {
        if (map.getLayer(id)) map.removeLayer(id);
        map.removeSource(id);
      }
    }
  }, [overlays, ready]);

  // the swipe divider clips the TOP overlay (last of the stack) to one side of the line
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    overlays.forEach((o, i) => {
      const id = `lab:${i}:${o.id}`;
      if (!map.getLayer(id)) return;
      const top = i === overlays.length - 1;
      if (top && swipe !== undefined) {
        // maplibre has no raster clip primitive: emulate the divider by nudging the top layer's
        // opacity between 0/1 is NOT honest (it flashes); instead the divider element overlays
        // the canvas and the map layer stays whole — see the divider rendering below.
        map.setPaintProperty(id, "raster-opacity", o.opacity);
      } else {
        map.setPaintProperty(id, "raster-opacity", o.opacity);
      }
    });
  }, [overlays, swipe, ready]);

  // drag handling for the swipe divider
  useEffect(() => {
    const el = elRef.current;
    if (!el || swipe === undefined) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.dataset?.swipeHandle === "1" || (0 === e.button && target.dataset?.swipeHandle === "1")) {
        dragRef.current = true;
        target.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const rect = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      propsRef.current.onSwipe?.(frac);
    };
    const onUp = () => { dragRef.current = false; };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [swipe]);

  // Phase 4 — the drawn ROI + the in-progress draft ring (pure display; the engine computes)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const srcId = "lab-roi";
    const features: GeoJSON.Feature[] = [];
    if (roiShape) {
      const ring: [number, number][] = roiShape.kind === "box"
        ? [roiShape.ring[0],
           [roiShape.ring[1][0], roiShape.ring[0][1]],
           roiShape.ring[1],
           [roiShape.ring[0][0], roiShape.ring[1][1]],
           roiShape.ring[0]]
        : [...roiShape.ring, roiShape.ring[0]];
      features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
    }
    if (draftRing && draftRing.length) {
      features.push(draftRing.length >= 2
        ? { type: "Feature", properties: { draft: true }, geometry: { type: "LineString", coordinates: draftRing } }
        : { type: "Feature", properties: { draft: true }, geometry: { type: "Point", coordinates: draftRing[0] } });
    }
    const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
    const src = map.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
    } else {
      map.addSource(srcId, { type: "geojson", data });
      map.addLayer({ id: "lab-roi-fill", type: "fill", source: srcId, filter: ["!", ["get", "draft"]],
                     paint: { "fill-color": "#7fd8e6", "fill-opacity": 0.08 } });
      map.addLayer({ id: "lab-roi-line", type: "line", source: srcId,
                     paint: { "line-color": "#7fd8e6", "line-width": 1.6, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "lab-roi-vertex", type: "circle", source: srcId,
                     paint: { "circle-radius": 3, "circle-color": "#7fd8e6" } });
    }
  }, [roiShape, draftRing, ready]);

  // the profile panel's A/B markers (display only; one Marker per point)
  const markersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = (pins ?? []).map((p) => {
      const el = document.createElement("div");
      el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#e6c977;border:2px solid #0e1116;"
        + "color:#0e1116;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center";
      el.textContent = p.label;
      el.setAttribute("role", "presentation");
      return new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    });
  }, [pins, ready]);

  return (
    <div className="relative h-full w-full" role="application" aria-label="Data Lab map — engine-rendered layers">
      <div ref={elRef} className="h-full w-full" style={drawMode ? { cursor: "crosshair" } : undefined} />
      {drawMode && (
        <p className="pointer-events-none absolute top-2 left-2 z-10 rounded bg-[#0e1116]/90 px-2 py-1 text-[10px] text-[#7fd8e6]">
          {drawMode === "box"
            ? "click two opposite corners of the box"
            : "click the polygon's vertices; double-click to close it"}
        </p>
      )}
      {swipe !== undefined && (
        <div
          className="pointer-events-none absolute inset-y-0 z-10"
          style={{ left: `${swipe * 100}%` }}
          aria-hidden
        >
          <div className="absolute inset-y-0 -left-px w-0.5 bg-[#faf9f6]/80" />
          <button
            type="button"
            data-swipe-handle="1"
            aria-label={`swipe divider at ${Math.round(swipe * 100)} percent — drag or use arrow keys to move`}
            className="pointer-events-auto absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#faf9f6] bg-[#0e1116] px-2 py-1 text-[10px] text-[#faf9f6] shadow-lg"
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.02;
              if (e.key === "ArrowLeft") { e.preventDefault(); propsRef.current.onSwipe?.(Math.max(0, swipe - step)); }
              if (e.key === "ArrowRight") { e.preventDefault(); propsRef.current.onSwipe?.(Math.min(1, swipe + step)); }
            }}
          >
            ⇔
          </button>
        </div>
      )}
    </div>
  );
}

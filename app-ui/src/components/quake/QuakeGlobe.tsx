"use client";

/**
 * The Observatory globe — the earthquake page's 3D centrepiece.
 *
 * Presentation only, zero science: a night-lights Earth that slowly turns,
 * the curated earthquakes as dim embers, the live catalogue as brighter
 * pulses, the active target as a lit pin with its own halo, and a thin
 * satellite ring that keeps passing over the investigated latitude —
 * the radar's own geometry of watching. Falls back to a static image
 * when WebGL is unavailable; freezes gracefully on reduced motion.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { CURATED_QUAKES, type Target } from "./shared";
import type { EventItem } from "@/lib/engine/types";

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function latLonToVec3(lon: number, lat: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function webglSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* the world: night-lights sphere + atmosphere + graticule              */
/* ------------------------------------------------------------------ */

const NIGHT_TEX = "/textures/earth-night.jpg";

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color("#ffb08a") } },
        vertexShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float rim = pow(1.0 - abs(dot(vNormal, vView)), 3.2);
            gl_FragColor = vec4(uColor, rim * 0.55);
          }
        `,
      }),
    [],
  );
  return (
    <mesh material={material} scale={1.18}>
      <sphereGeometry args={[1, 48, 48]} />
    </mesh>
  );
}

function Graticule({ radius }: { radius: number }) {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const R = radius;
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = 0; lon < 360; lon += 4) {
        const a = latLonToVec3(lon, lat, R);
        const b = latLonToVec3(lon + 4, lat, R);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    for (let lon = 0; lon < 360; lon += 30) {
      for (let lat = -88; lat < 88; lat += 4) {
        const a = latLonToVec3(lon, lat, R);
        const b = latLonToVec3(lon, lat + 4, R);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [radius]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color="#a5b2c8"
        transparent
        opacity={0.08}
        depthWrite={false}
      />
    </lineSegments>
  );
}

function NightEarth() {
  const tex = useLoader(THREE.TextureLoader, NIGHT_TEX);
  const material = useMemo(() => {
    const t = tex.clone();
    t.needsUpdate = true;
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color("#24303f"),
      map: t,
      emissiveMap: t,
      emissive: new THREE.Color("#ffca96"),
      emissiveIntensity: 1.35,
      roughness: 0.9,
      metalness: 0,
    });
  }, [tex]);
  return (
    <mesh material={material}>
      <sphereGeometry args={[1, 64, 64]} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* quake markers                                                        */
/* ------------------------------------------------------------------ */

interface MarkerDef {
  key: string;
  lon: number;
  lat: number;
  tone: "curated" | "live" | "target";
}

function QuakeMarker({ def, t }: { def: MarkerDef; t: number }) {
  const halo = useRef<THREE.Mesh>(null);
  const pin = useRef<THREE.Mesh>(null);
  const pos = useMemo(
    () => latLonToVec3(def.lon, def.lat, 1.012),
    [def.lon, def.lat],
  );
  const color =
    def.tone === "target"
      ? "#d95f33"
      : def.tone === "live"
        ? "#ffc79e"
        : "#b7794f";
  const size = def.tone === "target" ? 0.024 : def.tone === "live" ? 0.017 : 0.012;

  useFrame((state) => {
    if (reducedMotion()) return;
    const p = (state.clock.elapsedTime + t) % 2.6;
    const k = p / 2.6;
    if (halo.current) {
      const s = 1 + k * (def.tone === "target" ? 2.6 : 1.9);
      halo.current.scale.setScalar(s);
      (halo.current.material as THREE.MeshBasicMaterial).opacity =
        (def.tone === "target" ? 0.5 : 0.34) * (1 - k);
    }
    if (pin.current) {
      pin.current.scale.setScalar(
        1 + Math.sin(state.clock.elapsedTime * 2.2 + t) * 0.12,
      );
    }
  });

  return (
    <group position={pos}>
      <mesh ref={pin}>
        <sphereGeometry args={[size, 12, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[size * 2.2, 12, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.3}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* the satellite ring — the radar's watch                              */
/* ------------------------------------------------------------------ */

function OrbitRing({ lat }: { lat: number }) {
  const ring = useRef<THREE.Group>(null);
  const sat = useRef<THREE.Mesh>(null);
  const inc = Math.min(Math.abs(lat), 78) * (lat < 0 ? -1 : 1);
  const R = 1.34;
  useFrame((state) => {
    if (reducedMotion()) return;
    const t = state.clock.elapsedTime;
    if (ring.current) ring.current.rotation.y = t * 0.04;
    if (sat.current) {
      const a = t * 0.3;
      sat.current.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
    }
  });
  return (
    <group rotation={[0, 0, 0]}>
      <group ref={ring} rotation={[(inc * Math.PI) / 180, 0, 0]}>
        <mesh>
          <torusGeometry args={[R, 0.0028, 8, 200]} />
          <meshBasicMaterial
            color="#ffb08a"
            transparent
            opacity={0.3}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={sat}>
          <sphereGeometry args={[0.013, 10, 10]} />
          <meshBasicMaterial color="#ffe9dc" toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* the rotating world assembly                                          */
/* ------------------------------------------------------------------ */

function World({
  markers,
  target,
  spinRef,
  pauseRef,
}: {
  markers: MarkerDef[];
  target: Target | null;
  spinRef: { current: number };
  pauseRef: { current: boolean };
}) {
  const group = useRef<THREE.Group>(null);
  const tilt = useRef(0);

  /* start facing the target's longitude (or the Pacific ring by default) */
  const initialY = useMemo(() => {
    const lon = target?.lon ?? 138;
    return ((-lon - 12) * Math.PI) / 180;
  }, [target?.lon]);

  useFrame((_, delta) => {
    if (pauseRef.current) return;
    if (group.current) {
      if (!reducedMotion()) {
        spinRef.current += delta * 0.055;
        group.current.rotation.y = initialY + spinRef.current;
      } else {
        group.current.rotation.y = initialY;
      }
      /* a gentle axial breathing tilt — the world feels alive, never busy */
      const goal = 0.14 + Math.sin(spinRef.current * 0.35) * 0.05;
      tilt.current += (goal - tilt.current) * Math.min(1, delta * 2.2);
      group.current.rotation.x = tilt.current;
    }
  });

  return (
    <group ref={group} rotation={[0, initialY, 0]}>
      <Suspense fallback={null}>
        <NightEarth />
      </Suspense>
      <Graticule radius={1.004} />
      {markers.map((m, i) => (
        <QuakeMarker key={m.key} def={m} t={i * 0.37} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* the exported component                                               */
/* ------------------------------------------------------------------ */

export default function QuakeGlobe({
  target,
  events,
  className,
}: {
  target: Target | null;
  events: EventItem[];
  className?: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(false);
  const spinRef = useRef(0);
  const [supported] = useState(webglSupported);

  /* pause the render loop when the globe is offscreen */
  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) pauseRef.current = !e.isIntersecting;
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const markers = useMemo<MarkerDef[]>(() => {
    const out: MarkerDef[] = CURATED_QUAKES.map((q) => ({
      key: `c-${q.id}`,
      lon: q.lon,
      lat: q.lat,
      tone: "curated",
    }));
    for (const ev of events.slice(0, 8)) {
      out.push({ key: `l-${ev.id}`, lon: ev.lon, lat: ev.lat, tone: "live" });
    }
    if (target) {
      out.push({
        key: "target",
        lon: target.lon,
        lat: target.lat,
        tone: "target",
      });
    }
    return out;
  }, [events, target]);

  if (!supported) {
    return (
      <div
        ref={wrapper}
        className={className}
        role="img"
        aria-label="Earth with earthquake epicentres"
      >
        <img
          src="/fallback/hero-earth.png"
          alt=""
          className="h-full w-full rounded-full object-contain"
        />
      </div>
    );
  }

  return (
    <div ref={wrapper} className={className}>
      <Canvas
        camera={{ position: [0, 0.1, 2.72], fov: 40 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.22} />
        <directionalLight position={[-4, 2, 3]} intensity={0.5} color="#cdd9ec" />
        <World
          markers={markers}
          target={target}
          spinRef={spinRef}
          pauseRef={pauseRef}
        />
        <OrbitRing lat={target?.lat ?? 28} />
        <Atmosphere />
      </Canvas>
    </div>
  );
}

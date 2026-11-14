import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * DEV-ONLY engine keepalive (not needed in production — start uvicorn yourself).
 *
 * The hazard engine (FastAPI, port 8900) must outlive any single dev-server
 * restart. Spawned as a DETACHED child of the dev server (a long-lived
 * process), it survives; if the dev server itself restarts, the engine is
 * orphaned and keeps running. GET this route any time to verify or
 * (re)start it.
 *
 *   GET /api/engine-keepalive           -> {running, pid, health}
 *
 * Works in any checkout: the engine directory is resolved from ENGINE_DIR
 * when set, else from the known layouts (the sandbox's GitHub repo clone at
 * /home/z/Speckle — the repo's own engine/, the retired engine-v2 mini-service,
 * or the merged repo's ../engine from app-ui), and the interpreter from
 * ENGINE_PYTHON, else the sandbox venv, else `python3` on PATH. The engine's
 * own env comes from <engine-dir>/.env (EARTHDATA_TOKEN, NISAR_* tuning,
 * SUPABASE_* mirror keys); its log appends to <engine-dir>/engine.log.
 */

const ENGINE_DIR = resolveEngineDir();
const ENGINE_LOG = process.env.ENGINE_LOG || path.join(ENGINE_DIR, "engine.log");
const PID_FILE = "/tmp/engine-keepalive.pid";
const HEALTH_URL = "http://127.0.0.1:8900/api/health";
const PYTHON =
  process.env.ENGINE_PYTHON ||
  (fs.existsSync("/home/z/.venv/bin/python3") ? "/home/z/.venv/bin/python3" : "python3");

function resolveEngineDir(): string {
  const candidates = [
    process.env.ENGINE_DIR,
    "/home/z/Speckle", // the GitHub repo clone — its engine/ is THE backend (repo engine on :8900)
    "/home/z/my-project/mini-services/engine", // legacy: the retired engine-v2 sandbox deployment
    path.join(process.cwd(), "..", "engine"), // merged repo: app-ui/../engine
    path.join(process.cwd(), "mini-services", "engine"), // standalone layout
  ].filter((p): p is string => Boolean(p));
  return (
    candidates.find((p) => fs.existsSync(path.join(p, "engine", "api", "main.py"))) ??
    candidates[0]
  );
}

export const dynamic = "force-dynamic";

function engineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const text = fs.readFileSync(`${ENGINE_DIR}/.env`, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2];
    }
  } catch {
    // no .env — engine falls back to its own defaults
  }
  return env;
}

async function health(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killStale(): void {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no pidfile */
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* nothing to remove */
  }
}

function spawnEngine(): number {
  const out = fs.openSync(ENGINE_LOG, "a");
  const err = fs.openSync(ENGINE_LOG, "a");
  const child = spawn(
    PYTHON,
    ["-m", "uvicorn", "engine.api.main:app", "--host", "127.0.0.1", "--port", "8900"],
    {
      cwd: ENGINE_DIR,
      env: engineEnv(),
      detached: true,
      stdio: ["ignore", out, err],
    },
  );
  child.unref();
  try {
    fs.writeFileSync(PID_FILE, String(child.pid));
  } catch {
    /* pidfile is best-effort */
  }
  return child.pid ?? -1;
}

export async function GET() {
  const before = await health();
  if (before && before.ok === true) {
    let pid: number | null = null;
    try {
      pid = Number(fs.readFileSync(PID_FILE, "utf8").trim()) || null;
    } catch {
      /* engine started outside this route */
    }
    return NextResponse.json({ running: true, pid, health: before, note: "engine already up" });
  }
  killStale();
  const pid = spawnEngine();
  // wait for the engine to answer health (boot + imports can take a few seconds)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await health();
    if (h && h.ok === true) {
      return NextResponse.json({ running: true, pid, health: h, note: "engine started" });
    }
    if (pid > 0 && !pidAlive(pid)) {
      return NextResponse.json(
        { running: false, pid, error: `engine process exited during boot — see ${ENGINE_LOG}` },
        { status: 500 },
      );
    }
  }
  return NextResponse.json(
    { running: false, pid, error: `engine did not answer /api/health within 40 s — see ${ENGINE_LOG}` },
    { status: 504 },
  );
}

# Deploying Speckle — frontend on Vercel, engine on Render (100% free)

One repo, two deployments:

| Piece | Code | Host | Free plan | Public URL |
|---|---|---|---|---|
| Website (Next.js 16) | `app-ui/` | Vercel Hobby | free | `https://<project>.vercel.app` |
| Hazard engine (FastAPI) | repo root `engine/` | Render Web Service | free (750 h/month) | `https://<service>.onrender.com` |

The two are tied together by exactly **three settings**:

1. Vercel env `NEXT_PUBLIC_ENGINE_API` = the Render URL — the site's engine client
   calls that base URL directly (build-time inlined, so set it *before* the first deploy).
2. Render env `NISAR_UI_ORIGINS` = the Vercel URL — the engine's CORS allow-list.
   No wildcard is accepted by design (the engine can start scans), so this must be exact.
3. Optional `EARTHDATA_TOKEN` on Render — a free NASA Earthdata bearer token that
   unlocks real SAR byte retrieval (search/catalogue work anonymously without it).

---

## Step 0 — make sure GitHub is up to date

The deployable state is commit `64abe0a` ("Add the Earthquake observatory — the
landing's #quake view, wired to the repo's own engine"). On your machine:

```bash
git clone https://github.com/Tech-Doomsday/Speckle.git
cd Speckle
git log --oneline -1        # want: 64abe0a ...
```

If you do not see `64abe0a`, unzip `Speckle-complete.zip` (it matches that commit
exactly) over the clone, then:

```bash
git add -A
git commit -m "Add the Earthquake observatory — the landing's #quake view, wired to the repo's own engine"
git push origin main
```

---

## Part A — the engine on Render (do this first; the frontend needs its URL)

1. Sign up / log in at **https://render.com** with **GitHub** as the login method.
2. Dashboard → **New +** → **Web Service**.
3. Click **Connect** next to `Tech-Doomsday/Speckle`.
4. Fill the form:
   - **Name**: `speckle-engine` (this becomes `https://speckle-engine.onrender.com`)
   - **Region**: Singapore (closest to Bangladesh; Frankfurt also fine)
   - **Branch**: `main`
   - **Root Directory**: **leave EMPTY** — the engine package and `requirements.txt`
     live at the repo root. Setting this wrong is the #1 deploy failure.
   - **Runtime**: Python 3 (auto-detected from `requirements.txt`)
   - **Build Command**: `pip install --upgrade pip && pip install -r requirements.txt`
   - **Start Command**: `python -m uvicorn engine.api.main:app --host 0.0.0.0 --port $PORT`
     (`$PORT` and `0.0.0.0` are mandatory — Render assigns the port dynamically)
   - **Instance Type**: **Free**
5. Before creating, open **Environment** (or add right after creation — both fine) and set:

   | Key | Value | Required? |
   |---|---|---|
   | `PYTHON_VERSION` | `3.12.6` | recommended (engine tested on 3.12) |
   | `NISAR_UI_ORIGINS` | *(add after Part B — the Vercel URL)* | **required for the site to work** |
   | `EARTHDATA_TOKEN` | your NASA token (see Part E) | optional, unlocks real data downloads |
   | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | free Supabase project keys (see Part E) | optional, survives restarts |

6. Optionally set **Health Check Path** to `/api/health`.
7. **Create Web Service**. First build takes ~3–6 min (numpy/scipy/h5py/zarr wheels).
8. When it goes live, verify in a browser:
   - `https://speckle-engine.onrender.com/api/health` → JSON with `"ok": true`
   - `https://speckle-engine.onrender.com/docs` → the engine's interactive API docs
9. Copy the URL — you need it in Part B.

## Part B — the website on Vercel

1. Sign up / log in at **https://vercel.com** → **Continue with GitHub**.
2. **Add New… → Project** → **Import** next to `Tech-Doomsday/Speckle`.
   (If the repo is not listed: **Adjust GitHub App Permissions** and grant access.)
3. Configure:
   - **Project Name**: e.g. `speckle` → future URL `https://speckle.vercel.app`
   - **Framework Preset**: Next.js (auto-detected)
   - **Root Directory**: click **Edit** → set to **`app-ui`** ← critical; Vercel then
     builds `app-ui/package.json` (`next build`, npm).
   - Build/Install commands: leave the defaults.
4. **Environment Variables** (add for **Production and Preview**):

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_ENGINE_API` | `https://speckle-engine.onrender.com` (no trailing slash) |

   Without this the site silently calls `127.0.0.1:8900` in the visitor's browser
   and the engine panel stays "unreachable". `NEXT_PUBLIC_*` values are baked in at
   build time — if you change it later you must **Redeploy**.
5. **Deploy** (~2–3 min). Open the URL: the cinematic landing should play, and the
   nav **Go and play** button should open the Map (`/map`); the earthquake sector card opens `/earthquakes`.
6. Copy the production URL (e.g. `https://speckle.vercel.app`) — you need it in Part C.

## Part C — tie them together (CORS)

1. Render → `speckle-engine` → **Environment** → add:
   `NISAR_UI_ORIGINS` = `https://speckle.vercel.app`
   (comma-separated for several origins; exact scheme+host, **no** trailing slash, **no** `*`.)
2. **Save Changes** — Render redeploys automatically (~1 min).
3. Hard-refresh the Vercel site (Ctrl/Cmd+Shift+R) → the quake view's engine status
   should turn green (wake the engine first if it slept: hit `/api/health` once, wait ~50 s).

## Part D — verify the golden path

1. `https://speckle-engine.onrender.com/api/health` → `"ok": true`
2. `https://speckle.vercel.app` → landing plays
3. Click **Go and play** → the Map loads. Then open `/earthquakes` → the observatory loads, engine status green
4. Pick an event → **Run scan** → pipelines progress → verdict renders
5. Reload → stored verdicts list under `/api/tiles` (until the Render container restarts — see below)

## Part E — free-tier facts and fixes

- **Render spins down after 15 min without traffic.** First request then takes ~50 s
  (the site's health poll retries automatically; a refresh after a minute also works).
  Fix for free: a monitor on **https://cron-job.org** or **https://uptimerobot.com**
  hitting `https://speckle-engine.onrender.com/api/health` every 10 min keeps it awake.
  24/7 uptime ≈ 730 h/month — inside the 750 free instance-hours.
- **The Render disk is ephemeral.** `verdicts.db`, `jobs.sqlite` and the retrieval
  cache are wiped on every deploy/restart. The engine degrades gracefully (it
  recreates them). To keep verdicts across restarts for free: create a project at
  **https://supabase.com** (free), copy the project URL and `service_role` key into
  Render env `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — the engine has a built-in
  cloud cache and picks it up on the next restart.
- **`EARTHDATA_TOKEN`** (optional): free account at **https://urs.earthdata.nasa.gov**
  → log in → *Generate Token* → paste into Render env. Search and the catalogue are
  anonymous; actual SAR byte retrieval wants the token.
- **Cost: $0.** Vercel Hobby (personal, non-commercial) + Render Free.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Site says engine unreachable, browser console shows CORS error | `NISAR_UI_ORIGINS` missing/typo'd on Render — must match the Vercel origin exactly (scheme + host, no slash) |
| Engine asleep (site shows "did not answer within 10 s") | Render free spin-down — open `/api/health` once, wait ~50 s, refresh |
| Site calls `127.0.0.1:8900` (check the Network tab) | `NEXT_PUBLIC_ENGINE_API` not set in Vercel → set it, then **Redeploy** |
| Render build fails on h5py/zarr | pin `PYTHON_VERSION=3.12.6`; keep the `pip install --upgrade pip &&` prefix |
| Render gives 502 after build | start command must use `--host 0.0.0.0 --port $PORT` |
| Verdicts vanish after a redeploy | ephemeral disk — expected; add the Supabase cache (Part E) |
| Granule search works, downloads fail | `EARTHDATA_TOKEN` missing or expired |

"""§1 gating + §4.5/§5/§6 — the gated Background routes under /api/background/*.

NO KEY: these routes need no access key and no Authorization header. They read public NISAR data through the engine's
own Earthdata credentials. If you ever expose the engine to the internet (a tunnel, a public host), put your own gate
in front of it: anyone who can reach it can make it fetch data with your credentials.

Envelope convention (the engine's own): success {ok: true, ...}; failure an HTTPException whose
detail is {ok: false, error: "<verbatim reason>"}. Rate limits answer 429 + Retry-After.

EXECUTION MODEL (two helpers, chosen per route):
  _run_bg    provider-backed routes (granule, preview, probe, diff, inspect, timeseries, stack-pair).
             Rate limit, then the
             Earthdata-credentials check (503 NO_EARTHDATA_MESSAGE), then the SAME single worker pool
             (`runner._pool`, max_workers=1) that runs scans and the granule search.
  _run_local the four local-data routes (runs/{id}/preprocessing, runs/{id}/arrays/{aid},
             .../arrays/{aid}/probe, runs/{id}/pipelines/{name}). They read in-memory traces or cached
             bundles only: NO Earthdata check and NOT on `runner._pool`, so they work without provider
             credentials and never queue behind a running scan. They run inline in the request's own
             threadpool thread (the handlers are plain `def`, so the event loop is not blocked).
Both share the `_BG_HITS` rate limit (60/min).

NO TIME LIMIT: a provider-backed read is never cut off. It answers within `api.meta_wait_s` (config/retrieval.yaml) or
returns 202 + {pending, job_id, attempt, last_error}; the UI polls GET /api/background/jobs/{id} (200 = the same body
the route would have sent, 202 = still working, 404 = unknown/expired) and DELETE cancels. Network failures are retried
for ever with backoff (engine/api/bg_jobs.py); definite answers (404, 400, 422) are final.

Endpoints (all read-only; the first seven run on the shared single worker pool, the rest do not):
  GET /api/background/granule?id=                       decoded fields + layer inventory + group
  GET /api/background/preview?id=&layer=&box&max_px&cmap(auto|…)&scale(auto|db|linear)[&lo=&hi=][&quality=off|coherence][&format=json]   PNG (+ X-Img-Meta) or meta JSON
  GET /api/background/probe?id=&layer=&lon=&lat=        value at a point
  GET /api/background/diff?id_a=&id_b=&layer=&box&max_px&mode(auto|db_diff|ratio|coh_diff)[&cmap=&lo=&hi=][&format=json]   pair difference (engine-computed on raw values) + pair facts
  GET /api/background/inspect?id=&layer=&box&scale(auto|db|linear)[&bins=][&a_lon=&a_lat=&b_lon=&b_lat=]   stats (+ histogram, + A->B profile) of the legend's values, JSON
  GET /api/background/timeseries?ids=a,b,…(max 24)&layer=&box&scale&stat(mean|median|p98)   one engine-computed value per date, same-stack only
  GET /api/background/roi?id=&layer=&kind=box|polygon&ring=lon,lat;lon,lat;…&scale(auto|db|linear|los_m|los_mm)[&corr=][&bins=]   stats + histogram of the legend's values INSIDE a drawn shape (Phase 4; the mask is engine-side, at pixel centres of the layer's own grid), JSON
  GET /api/background/pair-network?west=&south=&east=&north=&level=&from=&to=   the interferometric pair network over the box: nodes = stack epochs, edges = pair products (Phase 5; grouped by the Explorer's own clustering), JSON
  GET /api/background/lab-runs?west=&south=&east=&north=   the pipeline bridge: runs whose tile overlaps the box + their placeable trace arrays (local state only), JSON
  GET /api/background/stack-pair?id=                    the GCOV granules at a GUNW's two ends
  GET|DELETE /api/background/jobs/{job_id}              poll / cancel a read that answered 202
  GET /api/background/runs/{id}/preprocessing[?bundle_id=]   §5 chain trace / bundle records
  GET /api/background/runs/{id}/arrays/{aid}[?cmap=&lo=&hi=&max_px=]   §5 array PNG
  GET /api/background/runs/{id}/arrays/{aid}/probe?fx=&fy=             §5 pixel probe
  GET /api/background/runs/{id}/pipelines/{name}        §6 input/process/output
  GET /api/background/explain                           plain-language copy (config/explain.yaml) + live pipeline counts
  GET /api/background/overview                          the end-to-end chain with live chips (local state only)
  GET /api/background/health[/network]                  environment / dependency / stub checks (network = on demand)

Tests inject a fake source through _SOURCE_FACTORY (the same seam pattern the granule search
uses) and a fake registry through the runner; production always builds the real NisarSource.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path


from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import JSONResponse

from . import background as bg
from .background import BackgroundError
from . import bg_jobs as _bg_jobs
from .bg_jobs import JOBS, Cancelled, link_cancel
from .jobs import NO_EARTHDATA_MESSAGE, earthdata_present
from .state import get_runner

router = APIRouter(prefix="/api/background")

# rate limits (sliding windows, the bbox-search pattern): metadata reads are cheap-ish, previews
# and probes each move real bytes from the provider, so they get their own tighter window.
_BG_RATE = {"max": 60, "window_s": 60.0}
_BG_HITS: list[float] = []
_PREVIEW_RATE = {"max": 12, "window_s": 60.0}
_PREVIEW_HITS: list[float] = []
# the handlers run in a threadpool; the check-and-append below must be atomic (one lock for both
# windows — the windows themselves stay global, there is no per-client logic)
_RATE_LOCK = threading.Lock()

# the retriever seam (§0 honesty: production builds the real client; tests inject a fake)
_SOURCE_FACTORY = bg.NisarSource


def _rate_limited(hits: list[float], rate: dict) -> int | None:
    import time as _time
    with _RATE_LOCK:
        now = _time.monotonic()
        while hits and now - hits[0] > rate["window_s"]:
            hits.pop(0)
        if len(hits) >= rate["max"]:
            return max(1, int(rate["window_s"] - (now - hits[0])) + 1)
        hits.append(now)
    return None


def _raise_429(retry_after: int):
    raise HTTPException(status_code=429, detail={
        "ok": False,
        "error": ("background endpoint rate limit hit — these routes read real provider data; "
                  "retry after the window resets")},
        headers={"Retry-After": str(retry_after)})


def _default_source():
    return _SOURCE_FACTORY()


def _http_from(ex: BaseException) -> BaseException:
    """The HTTP form of a finished read's exception (BackgroundError keeps its status; a cancelled read is 410)."""
    if isinstance(ex, BackgroundError):
        return HTTPException(status_code=ex.status, detail={"ok": False, "error": str(ex)})
    if isinstance(ex, Cancelled):
        return HTTPException(status_code=410, detail={"ok": False, "error": str(ex)})
    return ex


def _pending_body(job_id: str, info: dict) -> dict:
    return {"ok": True, "pending": True, "job_id": job_id, **info}


def _run_bg(fn, *args, preview_window: bool = False, finalize=None, wait_s: float | None = None, **kwargs):
    """Rate limit + credentials check + metadata-pool execution shared by the data routes.

    No deadline: a first read of a granule from NASA can take minutes and the person wants the result, not a "try
    again" (it used to give up after 25 s with a 504). The read answers in this request when it is quick; otherwise
    the answer is 202 + a job id and it keeps going, so no tunnel or proxy has to hold one request open for minutes
    and a retry never starts the same read twice. Network failures are retried (bg_jobs). `finalize` turns the
    worker's result into the HTTP body (a PNG, say) and is applied both here and when the job is polled."""
    retry = _rate_limited(_PREVIEW_HITS if preview_window else _BG_HITS,
                          _PREVIEW_RATE if preview_window else _BG_RATE)
    if retry is not None:
        _raise_429(retry)
    if not earthdata_present():
        raise HTTPException(status_code=503, detail={"ok": False, "error": NO_EARTHDATA_MESSAGE})
    runner = get_runner()
    try:
        res = JOBS.submit(runner._meta_pool, fn, *args, finalize=finalize, wait_s=wait_s, **kwargs)   # metadata lane: never behind a scan
    except (BackgroundError, Cancelled) as ex:
        raise _http_from(ex) from ex
    if res[0] == "done":
        return res[1]
    return JSONResponse(status_code=202, content=_pending_body(res[1], res[2]))


def _run_local(fn, *args, **kwargs):
    """Rate limit + inline execution for routes that only read in-memory traces / cached bundles.

    No Earthdata check (nothing here touches the provider) and NOT `runner._pool` (a running scan
    would otherwise starve a read of its own trace). The work is light: trace arrays are bounded
    in-memory thumbnails (<=512 px), a probe is one pixel, and the two bundle-reading routes do a
    JSON read + read-only mmap + a manifest scan — not scan-class work. Inline in the request thread
    therefore needs no executor and no timeout.
    """
    retry = _rate_limited(_BG_HITS, _BG_RATE)
    if retry is not None:
        _raise_429(retry)
    try:
        return fn(*args, **kwargs)
    except BackgroundError as ex:
        raise HTTPException(status_code=ex.status, detail={"ok": False, "error": str(ex)}) from ex
    except TimeoutError as ex:
        raise HTTPException(status_code=504, detail={
            "ok": False, "error": "the background worker did not answer in time"}) from ex


# --------------------------------------------------------------------------- #
# §4.5 data endpoints
# --------------------------------------------------------------------------- #
@router.get("/granule")
def background_granule(id: str = Query(..., min_length=1, max_length=400)):
    return _run_bg(_granule_worker, id)


def _granule_worker(id: str):
    source = _default_source()
    try:
        return bg.granule_detail(source, id)
    finally:
        source.close()


@router.get("/preview")
def background_preview(id: str = Query(..., min_length=1, max_length=400),
                       layer: str = Query(..., min_length=1, max_length=300),
                       west: float = Query(...), south: float = Query(...),
                       east: float = Query(...), north: float = Query(...),
                       max_px: int = Query(256), cmap: str = Query("auto"),
                       scale: str = Query("auto"),
                       lo: float | None = Query(None), hi: float | None = Query(None),
                       quality: str = Query("off"), corr: str = Query("off"),
                       fmt: str | None = Query(None, alias="format")):
    if quality not in bg._QUALITY_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"quality {quality!r} not in {'|'.join(bg._QUALITY_CHOICES)}"})
    if corr not in bg._CORR_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"corr {corr!r} not in {'|'.join(bg._CORR_CHOICES)}"})
    if scale not in bg._SCALE_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"scale {scale!r} not in {'|'.join(bg._SCALE_CHOICES)}"})
    if cmap not in bg._CMAP_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"cmap {cmap!r} not in {'|'.join(bg._CMAP_CHOICES)}"})
    # NB: the loop variables must NOT be called lo / hi: those are this route's colour-range query
    # parameters, and reusing them overwrote the caller's range with the last latitude bound (-90 / 90),
    # so every preview was drawn on a fixed -90..90 stretch (one flat colour for most layers).
    for name, v, v_min, v_max in (("west", west, -180.0, 180.0), ("east", east, -180.0, 180.0),
                                  ("south", south, -90.0, 90.0), ("north", north, -90.0, 90.0)):
        if not (v_min <= v <= v_max):
            raise HTTPException(status_code=400, detail={
                "ok": False, "error": f"{name} {v} outside [{v_min}, {v_max}]"})
    if west >= east:
        raise HTTPException(status_code=400, detail={
            "ok": False,
            "error": ("box crosses the antimeridian (west > east); split it at ±180 — "
                      "the preview clip takes west < east")})
    if south >= north:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"south {south} must be below north {north}"})
    try:
        bg.check_range(lo, hi)
    except bg.BackgroundError as err:
        raise HTTPException(status_code=err.status, detail={"ok": False, "error": str(err)})
    json_only = fmt == "json"

    def finalize(out):
        if json_only:
            return {"ok": True, "meta": out["meta"]}
        import json as _json
        return Response(content=out["png"], media_type="image/png",
                        headers={"X-Img-Meta": _json.dumps(out["meta"]),
                                 "Cache-Control": "private, max-age=300"})

    return _run_bg(_preview_worker, id=id, layer=layer, bbox=(west, south, east, north),
                   max_px=max_px, cmap=cmap, scale=scale, lo=lo, hi=hi, quality=quality, corr=corr,
                   preview_window=True, finalize=finalize, wait_s=_bg_jobs.api_config()["preview_wait_s"])


def _preview_worker(*, id: str, layer: str, bbox: tuple, max_px: int, cmap: str, scale: str = "auto",
                    lo: float | None = None, hi: float | None = None, quality: str = "off",
                    corr: str = "off"):
    source = _default_source()
    # a cancelled job (the person picked another layer) also stops this read between chunk batches, so it frees the
    # preview lock quickly instead of pulling the rest of an abandoned layer from NASA
    link_cancel(getattr(getattr(source, "client", None), "cancel_event", None))
    try:
        return bg.preview(source, gid=id, layer=layer, bbox=bbox, max_px=max_px, cmap=cmap, scale=scale,
                          lo=lo, hi=hi, quality=quality, corr=corr)
    finally:
        source.close()


@router.get("/probe")
def background_probe(id: str = Query(..., min_length=1, max_length=400),
                     layer: str = Query(..., min_length=1, max_length=300),
                     lon: float = Query(...), lat: float = Query(...)):
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": "lon must be in [-180, 180] and lat in [-90, 90]"})
    return _run_bg(_probe_worker, id=id, layer=layer, lon=lon, lat=lat, preview_window=True)


def _probe_worker(*, id: str, layer: str, lon: float, lat: float):
    source = _default_source()
    try:
        return bg.probe(source, gid=id, layer=layer, lon=lon, lat=lat)
    finally:
        source.close()


@router.get("/roi")
def background_roi(id: str = Query(..., min_length=1, max_length=400),
                   layer: str = Query(..., min_length=1, max_length=300),
                   kind: str = Query(...),
                   ring: str = Query(..., min_length=3, max_length=4096),
                   scale: str = Query("auto"), corr: str = Query("off"),
                   bins: int | None = Query(None)):
    """The Data Lab's drawn-region statistics (Phase 4): the person draws a box or a polygon on
    the map; the ENGINE masks the layer's pixel centres against the projected ring and computes
    stats + histogram on the legend's values (same scale resolution, same LOS/corr/cc-gate rules
    as the preview). The UI carries no polygon math."""
    if kind not in ("box", "polygon"):
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"kind {kind!r} not in box|polygon"})
    # ring: "lon,lat;lon,lat;..." — parsed defensively; every further rule is the engine's own
    try:
        pts = []
        for pair in ring.split(";"):
            lon_s, _, lat_s = pair.partition(",")
            pts.append([float(lon_s), float(lat_s)])
    except ValueError:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": "ring must be semicolon-separated lon,lat pairs, e.g. -118.4,34.1;-118.1,34.1;-118.1,34.3"})
    return _run_bg(_roi_worker, id=id, layer=layer, shape={"kind": kind, "ring": pts},
                   scale=scale, corr=corr, bins=bins, preview_window=True,
                   finalize=lambda out: out, wait_s=_bg_jobs.api_config()["preview_wait_s"])


def _roi_worker(*, id: str, layer: str, shape: dict, scale: str, corr: str, bins: int | None):
    from . import background_roi
    source = _default_source()
    link_cancel(getattr(getattr(source, "client", None), "cancel_event", None))
    try:
        return background_roi.roi(source, gid=id, layer=layer, shape=shape, scale=scale,
                                  corr=corr, bins=bins)
    finally:
        source.close()


@router.get("/pair-network")
def background_pair_network(west: float = Query(...), south: float = Query(...),
                            east: float = Query(...), north: float = Query(...),
                            level: str = Query("GUNW"), frm: str | None = Query(default=None, alias="from"),
                            to: str | None = Query(default=None)):
    """Phase 5 — the interferometric pair network over the box. Runs the SAME search + grouping
    the Explorer's /api/granules bbox mode runs (one clustering everywhere), then derives the
    graph engine-side: nodes are stack epochs, edges are pair products. The UI only draws."""
    from engine.api.routes_scanner import _bbox_granules
    out = _bbox_granules(west, south, east, north, level, frm, to, None, False)
    if isinstance(out, JSONResponse):        # 202 pending: the search is still running
        return out
    from . import background_pairs_network
    return {"ok": True, **background_pairs_network.pair_network(out.get("groups") or [],
                                                                 out.get("stacks") or []),
            "search": {"bbox": out.get("bbox"), "window": out.get("window"),
                       "n_total": out.get("n_total"), "truncated": out.get("truncated"),
                       "degraded": out.get("degraded"),
                       "search_incomplete": out.get("search_incomplete"),
                       "search_incomplete_levels": out.get("search_incomplete_levels")}}


@router.get("/lab-runs")
def background_lab_runs(west: float = Query(...), south: float = Query(...),
                        east: float = Query(...), north: float = Query(...)):
    """Phase 5 — the pipeline bridge: which hazard-pipeline runs overlap this box, and which
    trace arrays they can place on the map (corners from the arrays route's own metadata).
    Local state only — no Earthdata, no provider bytes, no scan is started."""
    from . import background_pairs_network
    from .background import BackgroundError
    try:
        box = background_pairs_network.validate_box((west, south, east, north))
    except BackgroundError as err:
        raise HTTPException(status_code=err.status, detail={"ok": False, "error": str(err)}) from err
    return background_pairs_network.lab_runs(get_runner(), box)


@router.get("/stack-pair")
def background_stack_pair(id: str = Query(..., min_length=1, max_length=400)):
    return _run_bg(_stack_pair_worker, id)


def _stack_pair_worker(id: str):
    source = _default_source()
    try:
        return bg.stack_pair(source, gid=id)
    finally:
        source.close()


@router.get("/diff")
def background_diff(id_a: str = Query(..., min_length=1, max_length=400),
                    id_b: str = Query(..., min_length=1, max_length=400),
                    layer: str = Query(..., min_length=1, max_length=300),
                    west: float = Query(...), south: float = Query(...),
                    east: float = Query(...), north: float = Query(...),
                    max_px: int = Query(256), mode: str = Query("auto"),
                    cmap: str = Query("auto"),
                    lo: float | None = Query(None), hi: float | None = Query(None),
                    fmt: str | None = Query(None, alias="format")):
    """The Data Lab's pair difference: same layer, two granules, one engine-computed image.
    The science (dB, ratio, coherence and LOS subtraction, grid alignment) is engine-side on
    raw / converted values — the UI never subtracts pictures. Same response shape as /preview (PNG + X-Img-Meta with
    corners_lonlat) plus a `diff` block: dates, temporal gap, validation facts, per-mode validity."""
    from . import background_pairs
    if mode != "auto" and mode not in background_pairs.DIFF_MODES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"mode {mode!r} not in auto|{'|'.join(background_pairs.DIFF_MODES)}"})
    if cmap not in ("auto", "diverging", "viridis", "magma", "gray"):
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"cmap {cmap!r} not in auto|diverging|viridis|magma|gray"})
    for name, v, v_min, v_max in (("west", west, -180.0, 180.0), ("east", east, -180.0, 180.0),
                                  ("south", south, -90.0, 90.0), ("north", north, -90.0, 90.0)):
        if not (v_min <= v <= v_max):
            raise HTTPException(status_code=400, detail={
                "ok": False, "error": f"{name} {v} outside [{v_min}, {v_max}]"})
    if west >= east:
        raise HTTPException(status_code=400, detail={
            "ok": False,
            "error": ("box crosses the antimeridian (west > east); split it at ±180 — "
                      "the diff clip takes west < east")})
    if south >= north:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"south {south} must be below north {north}"})
    try:
        bg.check_range(lo, hi)
    except bg.BackgroundError as err:
        raise HTTPException(status_code=err.status, detail={"ok": False, "error": str(err)})
    json_only = fmt == "json"

    def finalize(out):
        if json_only:
            return {"ok": True, "meta": out["meta"]}
        import json as _json
        return Response(content=out["png"], media_type="image/png",
                        headers={"X-Img-Meta": _json.dumps(out["meta"]),
                                 "Cache-Control": "private, max-age=300"})

    return _run_bg(_diff_worker, id_a=id_a, id_b=id_b, layer=layer, bbox=(west, south, east, north),
                   max_px=max_px, mode=mode, cmap=cmap, lo=lo, hi=hi, preview_window=True,
                   finalize=finalize, wait_s=_bg_jobs.api_config()["preview_wait_s"])


def _diff_worker(*, id_a: str, id_b: str, layer: str, bbox: tuple, max_px: int, mode: str,
                 cmap: str, lo=None, hi=None):
    from . import background_pairs
    source = _default_source()
    # a cancelled job (the person picked another pair) also stops this read between chunk batches
    link_cancel(getattr(getattr(source, "client", None), "cancel_event", None))
    try:
        return background_pairs.diff(source, id_a=id_a, id_b=id_b, layer=layer, bbox=bbox,
                                     max_px=max_px, mode=mode, cmap=cmap, lo=lo, hi=hi)
    finally:
        source.close()


@router.get("/inspect")
def background_inspect(id: str = Query(..., min_length=1, max_length=400),
                       layer: str = Query(..., min_length=1, max_length=300),
                       west: float = Query(...), south: float = Query(...),
                       east: float = Query(...), north: float = Query(...),
                       scale: str = Query("auto"), corr: str = Query("off"),
                       bins: int | None = Query(None),
                       a_lon: float | None = Query(None), a_lat: float | None = Query(None),
                       b_lon: float | None = Query(None), b_lat: float | None = Query(None)):
    """The Lab's numeric panels over ONE granule/layer/box: stats (+ histogram) of the values the
    legend describes, and an optional A->B profile sampled at pixel centres (endpoints given as
    lon/lat, projected engine-side). JSON only — a box with no valid values answers honest nulls
    (nan_fraction = 1), never a 422 for emptiness."""
    from . import background_inspect
    from . import background as _bgmod
    if scale not in _bgmod._SCALE_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"scale {scale!r} not in {'|'.join(_bgmod._SCALE_CHOICES)}"})
    if corr not in _bgmod._CORR_CHOICES:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"corr {corr!r} not in {'|'.join(_bgmod._CORR_CHOICES)}"})
    for name, v, v_min, v_max in (("west", west, -180.0, 180.0), ("east", east, -180.0, 180.0),
                                  ("south", south, -90.0, 90.0), ("north", north, -90.0, 90.0)):
        if not (v_min <= v <= v_max):
            raise HTTPException(status_code=400, detail={
                "ok": False, "error": f"{name} {v} outside [{v_min}, {v_max}]"})
    if west >= east:
        raise HTTPException(status_code=400, detail={
            "ok": False,
            "error": ("box crosses the antimeridian (west > east); split it at ±180 — "
                      "the inspect clip takes west < east")})
    if south >= north:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": f"south {south} must be below north {north}"})
    profile = None
    if None not in (a_lon, a_lat, b_lon, b_lat):
        profile = (a_lon, a_lat, b_lon, b_lat)
    elif any(v is not None for v in (a_lon, a_lat, b_lon, b_lat)):
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": "a profile needs all four: a_lon, a_lat, b_lon, b_lat"})

    return _run_bg(_inspect_worker, gid=id, layer=layer, bbox=(west, south, east, north),
                   scale=scale, corr=corr, bins=bins, profile=profile, preview_window=True,
                   finalize=lambda out: out, wait_s=_bg_jobs.api_config()["preview_wait_s"])


def _inspect_worker(*, gid: str, layer: str, bbox: tuple, scale: str, corr: str,
                    bins: int | None, profile: tuple | None):
    from . import background_inspect
    source = _default_source()
    link_cancel(getattr(getattr(source, "client", None), "cancel_event", None))
    try:
        return background_inspect.inspect(source, gid=gid, layer=layer, bbox=bbox,
                                          scale=scale, corr=corr, bins=bins, profile=profile)
    finally:
        source.close()


@router.get("/timeseries")
def background_timeseries(ids: str = Query(..., min_length=1, max_length=400 * 25),
                          layer: str = Query(..., min_length=1, max_length=300),
                          west: float = Query(...), south: float = Query(...),
                          east: float = Query(...), north: float = Query(...),
                          scale: str = Query("auto"), stat: str = Query("mean")):
    """One engine-computed value per date (mean | median | p98 over the box) for a stack of up to
    24 granules that share product/track/frame/direction. A granule that cannot be read is listed
    in `missing` with its reason — the series is never silently shortened."""
    from . import background_inspect
    for name, v, v_min, v_max in (("west", west, -180.0, 180.0), ("east", east, -180.0, 180.0),
                                  ("south", south, -90.0, 90.0), ("north", north, -90.0, 90.0)):
        if not (v_min <= v <= v_max):
            raise HTTPException(status_code=400, detail={
                "ok": False, "error": f"{name} {v} outside [{v_min}, {v_max}]"})
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": "the series box needs west < east and south < north"})

    return _run_bg(_timeseries_worker, ids=[i for i in ids.split(",") if i], layer=layer,
                   bbox=(west, south, east, north), scale=scale, stat=stat, preview_window=True,
                   finalize=lambda out: out, wait_s=_bg_jobs.api_config()["preview_wait_s"])


def _timeseries_worker(*, ids: list[str], layer: str, bbox: tuple, scale: str, stat: str):
    from . import background_inspect
    source = _default_source()
    link_cancel(getattr(getattr(source, "client", None), "cancel_event", None))
    try:
        return background_inspect.timeseries(source, ids=ids, layer=layer, bbox=bbox,
                                             scale=scale, stat=stat)
    finally:
        source.close()


@router.get("/jobs/{job_id}")
def background_job(job_id: str):
    """Poll a read that answered 202. 200 = the route's own body, 202 = still working (with attempt / last_error),
    404 = unknown or expired (the UI asks again), 410 = it was cancelled. Not rate limited: it only looks."""
    res = JOBS.poll(job_id)
    if res[0] == "unknown":
        raise HTTPException(status_code=404, detail={
            "ok": False, "error": "unknown or expired background job (the engine restarted or nobody asked for it "
                                  "for a while) — the read is asked again"})
    if res[0] == "pending":
        return JSONResponse(status_code=202, content=_pending_body(job_id, res[1]))
    if res[0] == "error":
        raise _http_from(res[1])
    return res[1]


@router.delete("/jobs/{job_id}")
def background_job_cancel(job_id: str):
    return {"ok": True, "cancelled": JOBS.cancel(job_id)}


# --------------------------------------------------------------------------- #
# §5 preprocessing
# --------------------------------------------------------------------------- #
@router.get("/runs/{run_id}/preprocessing")
def run_preprocessing(run_id: str, bundle_id: str | None = Query(default=None)):
    return _run_local(_preprocessing_worker, run_id, bundle_id)


_BUNDLE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def _bundle_400(why: str, bundle_id: str):
    shown = bundle_id if len(bundle_id) <= 48 else bundle_id[:48] + "…"
    raise HTTPException(status_code=400, detail={
        "ok": False, "error": f"invalid bundle_id {shown!r}: {why}"})


def safe_bundle_dir(bundles_dir: Path, bundle_id: str) -> Path:
    """A user-supplied bundle id -> the bundle directory, or a 400. Never a path outside bundles_dir."""
    if not _BUNDLE_ID_RE.fullmatch(bundle_id) or ".." in bundle_id:
        _bundle_400("expected 1-128 characters of [A-Za-z0-9._-], starting with a letter or digit", bundle_id)
    root = Path(bundles_dir).resolve()
    resolved = (root / bundle_id).resolve()       # follows a symlink to its real target
    if resolved.parent != root or not resolved.is_relative_to(root):
        _bundle_400("it does not resolve to a directory directly inside the bundles store", bundle_id)
    return resolved


def _preprocessing_worker(run_id: str, bundle_id: str | None):
    runner = get_runner()
    if bundle_id:
        bundle_dir = safe_bundle_dir(runner.bundles_dir, bundle_id)
        try:
            from engine.common.bundle_io import load_bundle
            bundle = load_bundle(bundle_dir)
        except Exception as ex:
            raise HTTPException(status_code=404, detail={
                "ok": False, "error": f"bundle {bundle_id!r} could not be loaded: "
                                      f"{type(ex).__name__}: "
                                      f"{bg.scrub_paths(str(ex), runner.bundles_dir)}"}) from ex
        out = bg.bundle_preprocessing(bundle)
        return {"ok": True,
                "run": {"id": None, "bundle_id": bundle_id, "tile": bundle.tile.id,
                        "kind": "bundle", "status": "cached"},
                "trace": out, "trace_arrays": False,
                "note": "records read from the cached bundle itself"}
    state = runner.get_state(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail={"ok": False, "error": f"unknown run: {run_id}"})
    trace = runner.get_trace(run_id)
    if trace is None:
        return {
            "ok": True,
            "run": {"id": run_id, "status": state.get("status"), "tile": state.get("tile"),
                    "kind": state.get("kind"), "bundle_id": state.get("bundle_id")},
            "trace": None,
            "empty_reason": ("no recorded preprocessing trace for this run — runs started before "
                             "tracing (or restored from the store after a restart) carry none; "
                             "run a fresh scan to see one"),
        }
    return {"ok": True,
            "run": {"id": run_id, "status": state.get("status"), "tile": state.get("tile"),
                    "kind": state.get("kind"), "bundle_id": state.get("bundle_id")},
            "trace": trace, "trace_arrays": True}


@router.get("/runs/{run_id}/arrays/{aid}")
def run_trace_array(run_id: str, aid: str, cmap: str = Query("auto"),
                    lo: float | None = Query(default=None), hi: float | None = Query(default=None),
                    max_px: int = Query(320)):
    if cmap not in ("auto", "viridis", "diverging", "magma", "gray", "categorical"):
        raise HTTPException(status_code=400, detail={
            "ok": False,
            "error": f"cmap {cmap!r} not in auto|viridis|diverging|magma|gray|categorical"})
    try:
        bg.check_range(lo, hi)          # one-sided / non-finite / lo >= hi was silently accepted here
    except bg.BackgroundError as err:
        raise HTTPException(status_code=err.status, detail={"ok": False, "error": str(err)})
    import json as _json
    body, meta = _run_local(_trace_array_worker, run_id, aid, cmap, lo, hi, max_px)
    return Response(content=body, media_type="image/png",
                    headers={"X-Img-Meta": _json.dumps(meta), "Cache-Control": "private, max-age=300"})


def _trace_array_worker(run_id: str, aid: str, cmap: str, lo, hi, max_px: int):
    runner = get_runner()
    rec = runner.get_trace_array(run_id, aid)
    if rec is None:
        raise HTTPException(status_code=404, detail={
            "ok": False,
            "error": f"no trace array {aid!r} for run {run_id} (traces live in memory and are "
                     "evicted with the run)"})
    return bg.trace_array_png(rec, cmap, lo, hi, max_px)


@router.get("/runs/{run_id}/arrays/{aid}/probe")
def run_trace_array_probe(run_id: str, aid: str, fx: float = Query(...), fy: float = Query(...)):
    return _run_local(_trace_probe_worker, run_id, aid, fx, fy)


def _trace_probe_worker(run_id: str, aid: str, fx: float, fy: float):
    runner = get_runner()
    rec = runner.get_trace_array(run_id, aid)
    if rec is None:
        raise HTTPException(status_code=404, detail={
            "ok": False, "error": f"no trace array {aid!r} for run {run_id}"})
    return bg.trace_array_probe(rec, fx, fy)


# --------------------------------------------------------------------------- #
# §6 pipelines
# --------------------------------------------------------------------------- #
@router.get("/runs/{run_id}/pipelines/{name}")
def run_pipeline_detail(run_id: str, name: str):
    return _run_local(_pipeline_worker, run_id, name)


def _pipeline_worker(run_id: str, name: str):
    from engine.registry import Registry
    runner = get_runner()
    return bg.pipeline_detail(runner, Registry(bundles_dir=runner.bundles_dir), run_id, name)


# --------------------------------------------------------------------------- #
# explain / overview / health: local state only (no Earthdata, no provider bytes)
# --------------------------------------------------------------------------- #
@router.get("/explain")
def background_explain():
    return _run_local(_explain_worker)


def _explain_worker():
    from .explain import ExplainConfigError, explain_payload
    try:
        return explain_payload()
    except ExplainConfigError as err:
        raise BackgroundError(500, str(err))


@router.get("/overview")
def background_overview():
    return _run_local(_overview_worker)


def _overview_worker():
    """The chain, left to right. Titles / sentences / technical lines come from explain.yaml; the step list
    (names, order, needs) from engine/common/chain.STEPS; every chip is read live and an unreadable one is
    reported as null (the UI shows a dash), never guessed."""
    from .explain import ExplainConfigError, explain_payload
    try:
        ex = explain_payload()
    except ExplainConfigError as err:
        raise BackgroundError(500, str(err))
    runner = get_runner()
    retrievals = bundles = runs = None
    last_run = None
    try:
        from .routes_retrievals import manager
        retrievals = manager().list()
    except Exception:
        pass
    try:
        root = Path(runner.bundles_dir)
        bundles = sum(1 for d in root.iterdir() if d.is_dir() and (d / "bundle.json").exists()) if root.is_dir() else 0
    except Exception:
        pass
    try:
        runs = runner.list_states()
        last_run = runs[0] if runs else None
    except Exception:
        pass
    latest = retrievals[0] if retrievals else None
    counts = ex["counts"]

    def chip(label, value):
        return {"label": label, "value": value}

    chips = {
        "find": [chip("retrievals", len(retrievals) if retrievals is not None else None)],
        "plan": [chip("latest retrieval stage", (latest or {}).get("stage"))],
        "download": [chip("latest retrieval status", (latest or {}).get("status"))],
        "inspect": [chip("latest retrieval", (latest or {}).get("id"))],
        "preprocess": [chip("steps", len(ex["steps"]))],
        "bundle": [chip("cached bundles", bundles)],
        "routing": [chip("declared", counts["declared"]), chip("modelled", counts["modelled"])],
        "pipelines": [chip("declared", counts["declared"]), chip("modelled", counts["modelled"]),
                      chip("last result status", (last_run or {}).get("status"))],
        "verdict": [chip("runs", len(runs) if runs is not None else None)],
    }
    order = ["find", "plan", "download", "inspect", "preprocess", "bundle", "routing", "pipelines", "verdict"]
    nodes = []
    for key in order:
        row = ex["nodes"].get(key) or {}
        nodes.append({"key": key, "title": row.get("title"), "plain": row.get("plain"), "tech": row.get("tech"),
                      "page": row.get("page"), "chips": chips[key],
                      "run": {"retrieval_id": (latest or {}).get("id"), "run_id": (last_run or {}).get("id")}})
    return {"ok": True, "nodes": nodes, "steps": ex["steps"], "counts": counts,
            "featured_note": "declared = manifests on disk; modelled = those whose verdict module defines run()"}


@router.get("/health")
def background_health():
    return _run_local(_health_worker)


def _scrub(obj, repo: str, data: str):
    """Walk a JSON-able structure and replace the absolute repo / data prefixes (a path never leaves the engine)."""
    if isinstance(obj, str):
        out = obj
        for prefix, tag in sorted(((data, "<data>"), (repo, "<repo>")), key=lambda t: -len(t[0])):
            if prefix:
                out = out.replace(prefix, tag)
        return out
    if isinstance(obj, dict):
        return {k: _scrub(v, repo, data) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_scrub(v, repo, data) for v in obj]
    return obj


def _health_worker():
    from engine.common.debug import health as H
    from engine.retrieval.settings import load_settings
    from .state import get_runner as _gr
    settings = load_settings()
    snap = H.health_snapshot(settings)
    env = snap["environment"]
    env.pop("executable", None)                       # a filesystem path nobody needs
    env["dotenv_present"] = None                      # presence of a secrets file is not shown here
    env.pop("dotenv_gitignored", None)
    snap["generated"] = float(snap.get("generated") or 0)
    runner = _gr()
    out = _scrub(snap, str(H.REPO), str(settings.data_dir))
    out = bg.scrub_paths(_json_dumps(out), runner.bundles_dir)
    import json as _json
    return {"ok": True, "health": _json.loads(out), "note": "credentials: presence only; network and tests are on demand"}


def _json_dumps(o) -> str:
    import json as _json
    return _json.dumps(o, default=str)


@router.get("/health/network")
def background_health_network():
    return _run_local(_network_worker)


def _network_worker():
    from engine.common.debug import health as H
    return {"ok": True, "hosts": H.network_check()}


__all__ = ["router"]

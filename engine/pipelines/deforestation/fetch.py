"""3.08 deforestation - own_fetch: R7 GFW alerts, S4 loss year, R6 FIRMS, R4 IMERG, R10 IBTrACS.

Same seam as the earthquake pipeline (port design decision 6): `run(bundle, providers=None)` accepts injected providers so tests
run offline; the module-level seam (`set_provider`) is the historical test hook; production uses the REAL adapters and a
spawn-pool worker re-imports this module fresh, so the seam is empty there. When ANY provider is injected the run is offline:
sources that were not injected are reported "not provided", the network is never touched.

All five sources are CORROBORATION or ATTRIBUTION, never the measurement: a source that fails (no key, HTTP error, timeout) makes
the result say what it could not check - it never turns into "no fire" / "no alert" / "no storm" and never raises.
Every successful fetch carries provenance (adapter, url/id, retrieved_at, sha256) into PipelineResult.provenance.
"""
from __future__ import annotations

from datetime import timedelta

from .lib_local import iso, parse_time

_providers: dict = {}          # module-level seam (tests / debug)


def set_provider(name: str, fn) -> None:
    _providers[name] = fn


def reset_providers() -> None:
    _providers.clear()


def _prov(out: dict) -> list:
    p = out.get("provenance")
    return [p] if isinstance(p, dict) else list(p or [])


def _norm(out, key: str, source: str) -> dict:
    """Adapter-shaped dict (or an injected provider's) -> {"available", "items", "error", "source", "provenance", "extra"}."""
    if not isinstance(out, dict):
        return {"available": False, "items": [], "error": f"provider returned {type(out).__name__}, expected a dict", "source": source,
                "provenance": [], "extra": {}}
    degraded = bool(out.get("degraded"))
    return {"available": not degraded, "items": list(out.get(key) or []), "error": out.get("error"), "source": out.get("source", source),
            "provenance": _prov(out), "extra": {k: v for k, v in out.items() if k not in (key, "provenance", "source", "error", "degraded")}}


def _unavailable(source: str, why: str) -> dict:
    return {"available": False, "items": [], "error": why, "source": source, "provenance": [], "extra": {}}


def _call(fn, source: str, key: str, *args) -> dict:
    """Call a provider; whatever it does (raise, return junk) becomes a normalised result, never an exception."""
    try:
        return _norm(fn(*args), key, source)
    except Exception as ex:                                   # noqa: BLE001 - corroboration must never kill a run
        return _unavailable(source, f"{type(ex).__name__}: {ex}")


def _resolve(name: str, providers):
    inj = (providers or {}).get(name)
    if inj is not None:
        return inj
    return _providers.get(name)


def _offline(providers) -> bool:
    return bool(providers) or bool(_providers)


def fetch_context(bundle, times: list, P, providers: dict | None = None) -> dict:
    """-> {"alerts","fires","rain","tracks"} each a normalised dict; plus "rain_by_epoch" {epoch_index: mm | None}."""
    bbox = tuple(bundle.tile.bbox_lonlat)
    lon_c, lat_c = bundle.tile.center_lonlat
    t_first, t_last = min(times), max(times)
    res: dict = {}

    # R7 integrated alerts over the SAR window (+12 d: an alert can lag the pass that sees the loss)
    fn = _resolve("alerts", providers)
    if fn is not None:
        res["alerts"] = _call(fn, "injected", "alerts", bbox, iso(t_first), iso(t_last + timedelta(days=12)))
    elif _offline(providers):
        res["alerts"] = _unavailable("r7_gfw_alerts", "not provided (offline run)")
    else:
        from engine.retrieval.clients.adapters import r7_gfw_alerts
        res["alerts"] = _norm(r7_gfw_alerts.fetch_alerts(bbox, iso(t_first), iso(t_last + timedelta(days=12)), timeout_s=P.fetch_timeout_s),
                              "alerts", "r7_gfw_alerts")

    # R6 FIRMS: window padded by the fire-window used in attribution
    pad = timedelta(days=P.fire_window_days + 12)
    fn = _resolve("fires", providers)
    if fn is not None:
        res["fires"] = _call(fn, "injected", "fires", bbox, iso(t_first - pad), iso(t_last + pad))
    elif _offline(providers):
        res["fires"] = _unavailable("r6_firms", "not provided (offline run)")
    else:
        from engine.retrieval.clients.adapters import r6_firms
        res["fires"] = _norm(r6_firms.fetch_fires(bbox, iso(t_first - pad), iso(t_last + pad), timeout_s=P.fetch_timeout_s), "fires", "r6_firms")

    # R4 IMERG: the three UTC days up to each pass = the 48 h before it (daily totals, so conservative)
    days = sorted({(t - timedelta(days=k)).strftime("%Y-%m-%d") for t in times for k in (0, 1, 2)})
    fn = _resolve("rain", providers)
    if fn is not None:
        try:
            raw = fn(lat_c, lon_c, days)
            res["rain"] = _norm(raw, "daily_mm", "injected")
            daily = raw.get("daily_mm") if isinstance(raw, dict) else None
        except Exception as ex:                               # noqa: BLE001
            res["rain"], daily = _unavailable("injected", f"{type(ex).__name__}: {ex}"), None
    elif _offline(providers):
        res["rain"], daily = _unavailable("r4_imerg", "not provided (offline run)"), None
    else:
        from engine.retrieval.clients.adapters import r4_imerg
        raw = r4_imerg.fetch_daily(lat_c, lon_c, days)
        res["rain"], daily = _norm(raw, "daily_mm", "r4_imerg"), raw.get("daily_mm")
    rain_by_epoch = {}
    if daily and res["rain"]["available"]:
        for i, t in enumerate(times):
            vals = [daily.get((t - timedelta(days=k)).strftime("%Y-%m-%d")) for k in (0, 1, 2)]
            rain_by_epoch[i] = None if any(v is None for v in vals) else float(sum(vals))
    res["rain_by_epoch"] = rain_by_epoch

    # R10 IBTrACS
    fn = _resolve("tracks", providers)
    t0, t1 = iso(t_first - timedelta(days=P.storm_window_days)), iso(t_last)
    if fn is not None:
        res["tracks"] = _call(fn, "injected", "points", lat_c, lon_c, t0, t1, P.storm_max_distance_km)
    elif _offline(providers):
        res["tracks"] = _unavailable("r10_ibtracs", "not provided (offline run)")
    else:
        from engine.retrieval.clients.adapters import r10_ibtracs
        res["tracks"] = _norm(r10_ibtracs.fetch_tracks(lat_c, lon_c, t0, t1, P.storm_max_distance_km, timeout_s=max(P.fetch_timeout_s, 120.0)),
                              "points", "r10_ibtracs")
    return res


def fetch_loss_years(patches: list, P, providers: dict | None = None) -> dict:
    """S4: loss area by year for the largest patches (one query each, at most `s4_patch_queries`). Needs patches first."""
    polys = [(p["id"], tuple(p["bbox_lonlat"])) for p in patches[: max(0, P.s4_patch_queries)]]
    if not polys:
        return {"available": False, "results": {}, "error": "no patches to look up", "source": "s4_tree_loss", "provenance": []}
    fn = _resolve("loss", providers)
    if fn is not None:
        try:
            out = fn(polys)
        except Exception as ex:                               # noqa: BLE001
            return {"available": False, "results": {}, "error": f"{type(ex).__name__}: {ex}", "source": "s4_tree_loss", "provenance": []}
    elif _offline(providers):
        return {"available": False, "results": {}, "error": "not provided (offline run)", "source": "s4_tree_loss", "provenance": []}
    else:
        from engine.retrieval.clients.adapters import s4_tree_loss
        out = s4_tree_loss.fetch_loss_by_year(polys, max_queries=P.s4_patch_queries, timeout_s=P.fetch_timeout_s)
    if not isinstance(out, dict):
        return {"available": False, "results": {}, "error": "provider returned a non-dict", "source": "s4_tree_loss", "provenance": []}
    return {"available": not out.get("degraded"), "results": {int(k): v for k, v in (out.get("results") or {}).items()},
            "error": out.get("error"), "source": out.get("source", "s4_tree_loss"), "provenance": _prov(out)}

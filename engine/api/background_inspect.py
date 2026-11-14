"""Data Lab Phase 2 — numeric panels over one granule/layer/box (GET /api/background/inspect)
and over a stack of dates (GET /api/background/timeseries).

Same rules as the preview and the diff: the ENGINE computes every number on raw values and
states what it did; the UI only draws. Both routes reuse the preview machinery wholesale —
find_granule, one provider fetch, finite_view's integer-fill masking, the dB transform (the
SAME `scale=auto` resolution the legend used), the preview lock and the cache key material —
and both are JSON-only answers to "what is here": a panel that says nothing is honest
(nan_fraction = 1, null numbers), an image-less route never needs a 422 for empty pixels.

  inspect     stats (count/mean/min/max/p2/p50/p98 over the transformed values), an optional
              histogram (engine-chosen bin edges over the same values), an optional profile:
              a straight A->B transect sampled at pixel centres, A/B given as lon/lat and
              projected engine-side (engine/common/_geo), out-of-clip samples are null.
  timeseries  one value per date (mean | median | p98 of the transformed values over the box)
              for up to 24 granules of ONE stack (same product/track/frame/direction, or 422:
              their pixels do not measure the same ground). Dates come from the decoded ids;
              points are returned sorted by date; a granule that cannot be read is listed in
              `missing` with its reason — never silently dropped.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import background as _bg
from .background import (
    BackgroundError,
    _cache_paths,
    _take_preview_lock,
    find_granule,
)

MAX_SERIES = 24
MAX_BINS = 256
DEFAULT_BINS = 32
MAX_PROFILE_SAMPLES = 512
_SERIES_STATS = ("mean", "median", "p98")


# --------------------------------------------------------------------------- #
# shared transform (the legend's scale, applied to raw values)
# --------------------------------------------------------------------------- #
def _transformed(view, scale: str, dec: dict | None = None, corr: str = "off"):
    """The values the legend describes: dB for power (<= 0 / non-finite -> NaN), line-of-sight
    displacement for unwrapped phase (scale=los_m | los_mm), raw otherwise. The corr diagnostics
    are phase-carrying and convert the same way."""
    import numpy as np
    from . import background_img as bimg
    if scale == "db":
        return bimg.to_db(view)
    if scale in ("los_m", "los_mm") or corr != "off":
        if dec is None:
            raise BackgroundError(422, "the granule's decoded id is needed to reference a "
                                       "phase conversion (pair dates)")
        from . import background_los
        from engine.common.config import load_common_config
        conv, _facts = background_los.phase_to_los(np.asarray(view, np.float64), dec,
                                                   load_common_config().radar,
                                                   mm=(scale == "los_mm"))
        return conv
    return np.asarray(view, np.float64)


def _resolve_scale(scale: str, layer: str, cfg) -> str:
    from engine.common.layers import parse_layer_key
    if scale != "auto":
        if scale not in ("db", "linear", "los_m", "los_mm"):
            raise BackgroundError(400, f"scale {scale!r} not in auto|db|linear|los_m|los_mm")
        return scale
    kind = parse_layer_key(layer).info.kind if parse_layer_key(layer).info else None
    return cfg.resolve_scale("auto", kind)


def _unit_of(scale: str, cfg) -> str | None:
    return cfg.unit(scale)


def _date_of(dec: dict) -> str | None:
    """The date this granule sits at in a series (the pair's later end for GUNW/GOFF)."""
    if dec.get("product_decoded") in ("GUNW", "GOFF"):
        return dec.get("sec_time")
    return dec.get("start")


def _parse(iso: str):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _validate_same_stack(decs: list[dict]) -> dict:
    """Every granule of a series must be the same product/track/frame/direction (their pixels
    must measure the same ground — the same rule the diff enforces). -> the shared facts."""
    facts = {"product": decs[0].get("product_decoded"),
             "track": decs[0].get("track"), "frame": decs[0].get("frame"),
             "direction": decs[0].get("direction")}
    for field, want in facts.items():
        for i, dec in enumerate(decs):
            got = dec.get(field)
            if want is None or got is None:
                continue
            if got != want:
                raise BackgroundError(422, f"the series mixes granules with different {field} "
                                           f"({want} vs {got}, position {i + 1}) — their pixels do "
                                           "not measure the same ground")
    return facts


def _stat_over(values, stat: str):
    import numpy as np
    f = values[np.isfinite(values)]
    if f.size == 0:
        return None, 0
    if stat == "mean":
        return float(f.mean()), int(f.size)
    if stat == "median":
        return float(np.median(f)), int(f.size)
    if stat == "p98":
        return float(np.percentile(f, 98)), int(f.size)
    raise BackgroundError(400, f"stat {stat!r} not in {'|'.join(_SERIES_STATS)}")


# --------------------------------------------------------------------------- #
# GET /api/background/inspect
# --------------------------------------------------------------------------- #
def inspect(source, *, gid: str, layer: str, bbox: tuple, scale: str = "auto",
            bins: int | None = None, profile: tuple | None = None, corr: str = "off",
            use_cache: bool = True, cfg=None) -> dict:
    """-> {ok, stats, histogram, profile, ...} — JSON only, no image is rendered.
    scale=los_m | los_mm (Phase 3): the numbers describe the line-of-sight displacement the
    phase encodes; corr=<effect>: they describe that correction screen converted the same way."""
    import json

    import numpy as np
    from . import background_img as bimg
    from .preview_cfg import PreviewConfigError, load_preview_config
    try:
        cfg = cfg or load_preview_config()
    except PreviewConfigError as err:
        raise BackgroundError(500, str(err))
    use_scale = _resolve_scale(scale, layer, cfg)
    n_bins = DEFAULT_BINS if bins is None else max(2, min(int(bins), MAX_BINS))
    profile = tuple(float(v) for v in profile) if profile else None
    if profile is not None and len(profile) != 4:
        raise BackgroundError(400, "profile needs exactly four numbers: a_lon,a_lat,b_lon,b_lat")

    png_path, json_path = _cache_paths(
        gid, layer, bbox, max_px=0, cmap="json", scale=use_scale, render_version=cfg.render_version,
        extra=("kind=inspect", f"bins={n_bins}", f"corr={corr}",
               f"profile={profile if profile is None else ','.join(f'{v:.6f}' for v in profile)}"))
    if use_cache and json_path.exists():
        try:
            body = json.loads(json_path.read_text())
            body["cache_hit"] = True
            return body
        except Exception:
            pass                      # a corrupt cache entry is recomputed, never served

    _take_preview_lock()
    try:
        ref, dec = find_granule(source, gid, bbox)
        layers = layer.replace("__", "/")
        from .background import correction_candidates, _conn_comp_on_grid
        from . import background_los
        if corr != "off":
            if corr not in background_los.CORRECTIONS:
                raise BackgroundError(400, f"corr {corr!r} not in "
                                           + "|".join(background_los.CORRECTIONS))
            layers = "|".join([layers, *correction_candidates(corr)])
        elif scale in ("los_m", "los_mm"):
            layers = "|".join([layers,
                               r"/grids/frequency[A-Z]/unwrappedInterferogram/[HV]{2}/connectedComponents$"])
        fr = source.fetch(tuple(bbox), None, None, None, layers, granules=[ref])
        if fr.errors:
            why = next(iter(fr.errors.values()))
            raise BackgroundError(502, f"the engine could not read this granule: {gid}: {why}")
        clip = next((c for c in fr.clips if c.granule.granule_id == gid), None)
        if clip is None:
            raise BackgroundError(422, f"granule {gid} produced no clip for this box: "
                                       + (fr.skipped.get(gid) or "the bbox does not overlap its grids"))
        if corr != "off":
            role = background_los.CORRECTIONS[corr][0]
            grid, arr, layer = background_los.correction_layer_of(clip, None, (role,))
        grid_o, arr_o = None, None
        for g in clip.grids.values():
            if layer in g.layers:
                grid_o, arr_o = g, g.layers[layer]
                break
        if corr == "off":
            grid, arr = grid_o, arr_o
        if grid is None:
            raise BackgroundError(404, f"layer {layer!r} is not part of granule {gid} "
                                       "(the provider's clip did not include it)")

        from engine.common.layers import parse_layer_key
        info = parse_layer_key(layer).info
        if (scale in ("los_m", "los_mm") or corr != "off") and corr == "off" \
                and (info is None or info.role != "unw_phase"):
            raise BackgroundError(422, f"scale {scale!r} describes line-of-sight displacement "
                                       "converted from unwrapped phase; this layer is not an "
                                       "unwrapped phase layer")
        view = bimg.finite_view(arr, mask_int_fill=True)
        los_facts = None
        if corr != "off" and getattr(arr, "ndim", 2) == 3:
            from engine.common.config import load_common_config
            at_h = load_common_config().geometry.fallback_height_m
            heights = (getattr(grid, "extras", None) or {}).get("heightAboveEllipsoid")
            collapsed = background_los.collapse_correction_cube(arr, heights, at_h)[0]
            view = bimg.finite_view(collapsed, mask_int_fill=True)
        if use_scale in ("los_m", "los_mm") or corr != "off":
            from engine.common.config import load_common_config
            common_cfg = load_common_config()
            if corr == "off":
                cc = _conn_comp_on_grid(clip, grid, view.shape[-2:])
                if cc is not None:
                    import numpy as _np
                    keep = cc >= common_cfg.decode.cc_min
                    view = _np.where(keep, view, _np.float32(_np.nan)).astype(_np.float32)
            _conv, los_facts = background_los.phase_to_los(
                view, dec, common_cfg.radar, mm=(use_scale == "los_mm"))
            values = _conv
        else:
            values = _transformed(view, use_scale)
        finite = values[np.isfinite(values)]
        stats = bimg.stats(values, values)          # describes the VALID transformed pixels
        stats["scale"] = use_scale
        stats["unit"] = (("m (LOS, + toward sensor)" if use_scale == "los_m"
                          else "mm (LOS, + toward sensor)") if use_scale in ("los_m", "los_mm")
                         else _unit_of(use_scale, cfg))

        histogram: dict = {"bins": n_bins, "edges": [], "counts": [], "n": int(finite.size)}
        if finite.size:
            counts, edges = np.histogram(finite, bins=n_bins)
            histogram["edges"] = [float(e) for e in edges]
            histogram["counts"] = [int(c) for c in counts]

        prof: dict | None = None
        if profile is not None:
            prof = _profileAlong(grid, values, profile)

        if corr != "off":
            from engine.common.config import load_common_config
            corr_facts = background_los.correction_facts(corr, load_common_config().radar)
            los_facts = dict(los_facts or {})
            los_facts["correction"] = corr_facts
        body = {
            "ok": True,
            "id": gid, "layer": layer,
            "scale": use_scale, "scale_requested": scale,
            "unit": (("m (LOS, + toward sensor)" if use_scale == "los_m"
                      else "mm (LOS, + toward sensor)") if use_scale in ("los_m", "los_mm")
                     else _unit_of(use_scale, cfg)),
            "los": (dict(los_facts) if los_facts else None),
            "epsg": int(grid.epsg) if grid is not None else None,
            "clip_bbox_lonlat": _bg._extent_lonlat(grid, grid.epsg) if grid is not None else None,
            "requested_bbox": [float(v) for v in bbox],
            "stats": stats,
            "histogram": histogram,
            "profile": prof,
            "date": _date_of(dec),
            "notes": (["every value is no-data in this box at this scale — the numbers above are null, not zero"]
                      if finite.size == 0 else []),
            "cache_hit": False,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        try:
            json_path.parent.mkdir(parents=True, exist_ok=True)
            json_path.write_text(json.dumps(body))
        except Exception:
            pass                      # cache write failures never fail the answer
        return body
    finally:
        _bg._PREVIEW_LOCK.release()


def _profileAlong(grid, values, profile: tuple) -> dict:
    """A straight A->B transect sampled at pixel centres. A/B are lon/lat; the projection is
    engine-side (engine/common/_geo). Samples outside the clip are null — never skipped, so the
    gap the person sees on the chart is the gap that is in the data."""
    import numpy as np
    from engine.common._geo import transform_xy
    a_lon, a_lat, b_lon, b_lat = profile
    if grid is None or getattr(grid, "x", None) is None or getattr(grid, "y", None) is None:
        raise BackgroundError(422, "this layer has no grid axes — a profile cannot be placed")
    try:
        lon, lat = transform_xy(np.array([a_lon, b_lon]), np.array([a_lat, b_lat]),
                                "EPSG:4326", f"EPSG:{int(grid.epsg)}")
    except Exception as err:
        raise BackgroundError(422, f"the profile's endpoints could not be projected: {err}") from err
    ax, ay, bx, by = float(lon[0]), float(lat[0]), float(lon[1]), float(lat[1])
    length = float(np.hypot(bx - ax, by - ay))
    n = 2 if length == 0 else int(min(MAX_PROFILE_SAMPLES, max(2, round(length / (abs(float(grid.x[1]) - float(grid.x[0])) or 1.0)))))
    t = np.linspace(0.0, 1.0, n)
    xs = ax + (bx - ax) * t
    ys = ay + (by - ay) * t
    # nearest pixel centre on the regular axes (x ascending, y descending: row 0 = north);
    # samples OUTSIDE the clip become null — clamping them onto the edge pixel would invent values
    x_ax = np.asarray(grid.x, float)
    y_ax = np.asarray(grid.y, float)
    cols = np.searchsorted(x_ax, xs)
    rows = len(y_ax) - 1 - np.searchsorted(y_ax[::-1], ys)
    inside = (xs >= x_ax[0]) & (xs <= x_ax[-1]) & (ys >= y_ax[-1]) & (ys <= y_ax[0])
    cols = np.clip(cols, 0, len(x_ax) - 1)
    rows = np.clip(rows, 0, len(y_ax) - 1)
    vals = values[rows, cols].astype(np.float64, copy=True)
    vals[~inside] = np.nan
    plon, plat = transform_xy(xs, ys, f"EPSG:{int(grid.epsg)}", "EPSG:4326")
    samples = []
    for i in range(n):
        v = float(vals[i])
        samples.append({
            "i": i,
            "lon": float(plon[i]), "lat": float(plat[i]),
            "x": float(xs[i]), "y": float(ys[i]),
            "value": v if np.isfinite(v) else None,
        })
    n_valid = int(np.isfinite(vals).sum())
    return {"a_lonlat": [a_lon, a_lat], "b_lonlat": [b_lon, b_lat],
            "epsg": int(grid.epsg), "length_m": length, "n_samples": n,
            "n_valid": n_valid, "samples": samples}


# --------------------------------------------------------------------------- #
# GET /api/background/timeseries
# --------------------------------------------------------------------------- #
def timeseries(source, *, ids: list[str], layer: str, bbox: tuple, scale: str = "auto",
               stat: str = "mean", use_cache: bool = True, cfg=None) -> dict:
    """One value per date over the box, engine-computed on the transformed values."""
    import json

    import numpy as np
    from engine.common.granule_id import decode_granule_id
    from . import background_img as bimg
    from .preview_cfg import PreviewConfigError, load_preview_config
    try:
        cfg = cfg or load_preview_config()
    except PreviewConfigError as err:
        raise BackgroundError(500, str(err))
    if not ids:
        raise BackgroundError(400, "timeseries needs at least one granule id")
    seen: list[str] = []
    for gid in ids:
        if gid not in seen:
            seen.append(gid)
    if len(seen) > MAX_SERIES:
        raise BackgroundError(400, f"timeseries takes at most {MAX_SERIES} granules "
                                   f"(got {len(seen)}) — narrow the box or the window")
    if stat not in _SERIES_STATS:
        raise BackgroundError(400, f"stat {stat!r} not in {'|'.join(_SERIES_STATS)}")
    use_scale = _resolve_scale(scale, layer, cfg)

    key = "ts:" + "|".join(seen)
    png_path, json_path = _cache_paths(
        key, layer, bbox, max_px=0, cmap="json", scale=use_scale, render_version=cfg.render_version,
        extra=("kind=timeseries", f"stat={stat}"))
    if use_cache and json_path.exists():
        try:
            body = json.loads(json_path.read_text())
            body["cache_hit"] = True
            return body
        except Exception:
            pass

    _take_preview_lock()
    try:
        refs, decs, missing = [], [], []
        for gid in seen:
            try:
                ref, dec = find_granule(source, gid, bbox)
                refs.append(ref)
                decs.append(dec)
            except BackgroundError as err:
                missing.append({"id": gid, "reason": str(err)})
        if not refs:
            raise BackgroundError(404, "none of the granules could be found: "
                                       + "; ".join(m["reason"] for m in missing))
        facts = _validate_same_stack(decs)

        layers = layer.replace("__", "/")
        fr = source.fetch(tuple(bbox), None, None, None, layers, granules=refs)
        by_id = {c.granule.granule_id: c for c in fr.clips}
        points = []
        for ref, dec in zip(refs, decs):
            gid = ref.granule_id
            if gid in fr.errors:
                missing.append({"id": gid, "reason": f"read failed: {fr.errors[gid]}"})
                continue
            clip = by_id.get(gid)
            if clip is None:
                missing.append({"id": gid, "reason": fr.skipped.get(gid)
                                or "the bbox does not overlap this granule's grids"})
                continue
            grid = None
            arr = None
            for g in clip.grids.values():
                if layer in g.layers:
                    grid, arr = g, g.layers[layer]
                    break
            if grid is None:
                missing.append({"id": gid, "reason": f"layer {layer!r} is not part of this granule"})
                continue
            view = bimg.finite_view(arr, mask_int_fill=True)
            if use_scale in ("los_m", "los_mm"):
                from . import background_los
                from engine.common.config import load_common_config
                conv, _f = background_los.phase_to_los(view, dec, load_common_config().radar,
                                                       mm=(use_scale == "los_mm"))
                values = conv
            else:
                values = _transformed(view, use_scale)
            value, n_valid = _stat_over(values, stat)
            points.append({"id": gid, "date": _date_of(dec), "value": value,
                           "n_valid": n_valid, "nan_fraction": float(1.0 - np.isfinite(values).mean())})
        points.sort(key=lambda p: (p["date"] is None, p["date"] or ""))

        body = {
            "ok": True,
            "layer": layer, "scale": use_scale, "scale_requested": scale,
            "unit": (("m (LOS, + toward sensor)" if use_scale == "los_m"
                      else "mm (LOS, + toward sensor)") if use_scale in ("los_m", "los_mm")
                     else _unit_of(use_scale, cfg)),
            "stat": stat,
            "epsg": None,
            "requested_bbox": [float(v) for v in bbox],
            "stack": facts,
            "points": points, "missing": missing,
            "dates_span": {"first": points[0]["date"] if points else None,
                           "last": points[-1]["date"] if points else None},
            "notes": ([f"{len(missing)} of {len(seen)} granules could not be read (listed in 'missing')"]
                      if missing else []),
            "cache_hit": False,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        try:
            json_path.parent.mkdir(parents=True, exist_ok=True)
            json_path.write_text(json.dumps(body))
        except Exception:
            pass
        return body
    finally:
        _bg._PREVIEW_LOCK.release()

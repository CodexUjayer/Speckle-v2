"""Data Lab Phase 4 — region-of-interest statistics over a drawn shape (GET /api/background/roi).

The person draws a polygon (or a box) on the map; the ENGINE decides which pixels fall inside
it and computes every number. The UI never does point-in-polygon, never sees the array, never
computes a statistic — it sends the shape's lon/lat vertices and draws the answer.

Rules carried over from inspect/preview (§0 honesty rules):
  * the shape is validated first: >= 3 distinct vertices for a polygon (a box is 2 corners),
    every vertex in lon [-180, 180] / lat [-90, 90], no antimeridian crossing (the same refusal
    the preview makes), a bounded vertex count, and a bounding box that intersects the layer's
    grid (422 with the reason otherwise);
  * the mask is computed at PIXEL CENTRES of the layer's own grid, in the grid's own CRS
    (engine/common/_geo projects the vertices); a pixel is either in or out — no partial
    weighting, because the product's pixels are the measurement;
  * the values are the legend's values (the SAME scale resolution: db for power, LOS metres for
    unwrapped phase incl. the corr diagnostics and the cc gate) — a ROI number always matches
    the picture it sits on;
  * an empty ROI (no valid pixel inside) answers with null stats and a note, never zeros;
  * `area_km2` of the shape is computed on the projected polygon (engine-side, shapely), and
    the pixel pitch is stated so the resolution limit is visible;
  * answers are cached like the other JSON panels (the shape is hashed into the key).
"""
from __future__ import annotations

from datetime import datetime, timezone

from .background import BackgroundError, _cache_paths, _take_preview_lock, find_granule

MAX_VERTICES = 64
MAX_POINTS = 24              # same cap as the timeseries (one shape, not a farm)


def _shape_bbox(shape: dict) -> tuple:
    lons = [v[0] for v in shape["ring"]]
    lats = [v[1] for v in shape["ring"]]
    return min(lons), min(lats), max(lons), max(lats)


def validate_shape(shape) -> dict:
    """{"kind": "box"|"polygon", "ring": [[lon, lat], ...]} — validated, normalised to a
    COUNTER-clockwise? No: kept exactly as drawn (the winding does not change membership); a
    box arrives as 2 or 4 corners and is expanded to its 5-point ring here.
    Raises BackgroundError(400) with a plain reason."""
    if not isinstance(shape, dict):
        raise BackgroundError(400, "roi must be a JSON object: {kind, ring}")
    kind = shape.get("kind")
    ring = shape.get("ring")
    if kind not in ("box", "polygon"):
        raise BackgroundError(400, "roi kind must be 'box' or 'polygon'")
    if not isinstance(ring, list) or not ring:
        raise BackgroundError(400, "roi ring must be a non-empty list of [lon, lat] pairs")
    if len(ring) > MAX_VERTICES:
        raise BackgroundError(400, f"roi takes at most {MAX_VERTICES} vertices (got {len(ring)})")
    pts = []
    for v in ring:
        if not isinstance(v, (list, tuple)) or len(v) != 2:
            raise BackgroundError(400, "each roi vertex must be [lon, lat]")
        try:
            lon, lat = float(v[0]), float(v[1])
        except (TypeError, ValueError):
            raise BackgroundError(400, "roi vertices must be numbers")
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            raise BackgroundError(400, f"roi vertex ({lon}, {lat}) outside lon [-180,180] / lat [-90,90]")
        pts.append((lon, lat))
    if kind == "box":
        if len(pts) not in (2, 4):
            raise BackgroundError(400, "a box roi takes 2 corners (or 4); a free shape is kind=polygon")
        w, s = min(p[0] for p in pts[:2]), min(p[1] for p in pts[:2])
        e, n = max(p[0] for p in pts[:2]), max(p[1] for p in pts[:2])
        if w >= e or s >= n:
            raise BackgroundError(400, "a box roi needs west < east and south < north")
        pts = [(w, s), (e, s), (e, n), (w, n)]
    else:
        if len(pts) < 3:
            raise BackgroundError(400, "a polygon roi needs at least 3 vertices")
        # distinct vertices only (a doubled closing point is fine and dropped)
        dedup = [pts[0]] + [p for i, p in enumerate(pts[1:], 1) if p != pts[i - 1]]
        if len(dedup) < 3:
            raise BackgroundError(400, "a polygon roi needs at least 3 distinct vertices")
        pts = dedup
    lons = [p[0] for p in pts]
    if max(lons) - min(lons) > 180.0:
        raise BackgroundError(400, "this roi crosses the antimeridian (west > east by more than "
                                   "180 degrees); split it at ±180")
    return {"kind": kind, "ring": pts}


def _polygon_mask(grid, ring_proj_x, ring_proj_y):
    """Boolean mask (ny, nx): True where the layer's PIXEL CENTRES fall inside the projected
    ring. Uses shapely (a declared engine dependency) + its prepared contains_xy, vectorised."""
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import Polygon
    x_ax = np.asarray(grid.x, float)
    y_ax = np.asarray(grid.y, float)
    # the product grids' x/y arrays ARE the pixel centres (the profile's searchsorted treats
    # them so); a pixel is in when its centre is inside the projected ring
    poly = Polygon(np.column_stack([ring_proj_x, ring_proj_y]))
    ny, nx = len(y_ax), len(x_ax)
    mask = np.zeros((ny, nx), bool)
    step = 512                    # chunked over rows to bound memory on big grids
    for r0 in range(0, ny, step):
        r1 = min(ny, r0 + step)
        XX, YY = np.meshgrid(x_ax, y_ax[r0:r1])
        mask[r0:r1] = contains_xy(poly, XX, YY)
    return mask


def roi(source, *, gid: str, layer: str, shape, scale: str = "auto", corr: str = "off",
        bins: int | None = None, use_cache: bool = True, cfg=None) -> dict:
    """-> {ok, roi: {stats, histogram, area facts}, ...} — JSON only. `shape` is the drawn
    {kind, ring} (see validate_shape); every number is computed on the SAME transformed values
    the legend shows."""
    import json

    import numpy as np
    from . import background_img as bimg
    from . import background_inspect
    from . import background_los
    from .preview_cfg import PreviewConfigError, load_preview_config
    try:
        cfg = cfg or load_preview_config()
    except PreviewConfigError as err:
        raise BackgroundError(500, str(err))
    shape = validate_shape(shape)
    use_scale = background_inspect._resolve_scale(scale, layer, cfg)
    n_bins = background_inspect.DEFAULT_BINS if bins is None else max(2, min(int(bins), background_inspect.MAX_BINS))
    if corr != "off" and corr not in background_los.CORRECTIONS:
        raise BackgroundError(400, f"corr {corr!r} not in " + "|".join(background_los.CORRECTIONS))

    sb = _shape_bbox(shape)
    ring_key = ";".join(f"{p[0]:.6f},{p[1]:.6f}" for p in shape["ring"])
    png_path, json_path = _cache_paths(
        gid, layer, sb, max_px=0, cmap="json", scale=use_scale, render_version=cfg.render_version,
        extra=("kind=roi", f"shape={shape['kind']}:{ring_key}", f"corr={corr}", f"bins={n_bins}"))
    if use_cache and json_path.exists():
        try:
            body = json.loads(json_path.read_text())
            body["cache_hit"] = True
            return body
        except Exception:
            pass                      # a corrupt cache entry is recomputed, never served

    _take_preview_lock()
    try:
        ref, dec = find_granule(source, gid, sb)
        layers = layer.replace("__", "/")
        from .background import correction_candidates, _conn_comp_on_grid
        if corr != "off":
            layers = "|".join([layers, *correction_candidates(corr)])
        elif use_scale in ("los_m", "los_mm"):
            layers = "|".join([layers,
                               r"/grids/frequency[A-Z]/unwrappedInterferogram/[HV]{2}/connectedComponents$"])
        fr = source.fetch(tuple(sb), None, None, None, layers, granules=[ref])
        if fr.errors:
            why = next(iter(fr.errors.values()))
            raise BackgroundError(502, f"the engine could not read this granule: {gid}: {why}")
        clip = next((c for c in fr.clips if c.granule.granule_id == gid), None)
        if clip is None:
            raise BackgroundError(422, f"granule {gid} produced no clip for this roi: "
                                       + (fr.skipped.get(gid) or "the roi does not overlap its grids"))
        if corr != "off":
            role = background_los.CORRECTIONS[corr][0]
            grid, arr, layer = background_los.correction_layer_of(clip, None, (role,))
        else:
            grid = arr = None
            for g in clip.grids.values():
                if layer in g.layers:
                    grid, arr = g, g.layers[layer]
                    break
        if grid is None:
            raise BackgroundError(404, f"layer {layer!r} is not part of granule {gid} "
                                       "(the provider's clip did not include it)")

        # project the drawn ring into the grid's CRS (engine-side, engine/common/_geo)
        from engine.common._geo import transform_xy
        rlons = np.array([p[0] for p in shape["ring"]])
        rlats = np.array([p[1] for p in shape["ring"]])
        try:
            px, py = transform_xy(rlons, rlats, "EPSG:4326", f"EPSG:{int(grid.epsg)}")
        except Exception as err:
            raise BackgroundError(422, f"the roi could not be projected: {err}") from err
        px = np.asarray(px, float)
        py = np.asarray(py, float)

        from shapely.geometry import Polygon
        area_m2 = float(Polygon(np.column_stack([px, py])).area)

        # the values: the SAME transform pipeline the legend used (db / LOS / corr / cc gate)
        view = bimg.finite_view(arr, mask_int_fill=True)
        los_facts = None
        if corr != "off" and getattr(arr, "ndim", 2) == 3:
            from engine.common.config import load_common_config
            at_h = load_common_config().geometry.fallback_height_m
            heights = (getattr(grid, "extras", None) or {}).get("heightAboveEllipsoid")
            view = bimg.finite_view(background_los.collapse_correction_cube(arr, heights, at_h)[0],
                                    mask_int_fill=True)
        cc_gate_note = None
        if use_scale in ("los_m", "los_mm") or corr != "off":
            from engine.common.config import load_common_config
            common_cfg = load_common_config()
            if corr == "off":
                from engine.common.layers import parse_layer_key
                info = parse_layer_key(layer).info
                if info is None or info.role != "unw_phase":
                    raise BackgroundError(422, f"scale {scale!r} describes line-of-sight "
                                               "displacement converted from unwrapped phase; this "
                                               "layer is not an unwrapped phase layer")
                cc = _conn_comp_on_grid(clip, grid, view.shape[-2:])
                if cc is not None:
                    keep = cc >= common_cfg.decode.cc_min
                    n_dropped = int((~keep & np.isfinite(view)).sum())
                    view = np.where(keep, view, np.float32(np.nan)).astype(np.float32)
                    cc_gate_note = (f"pixels with connectedComponents < {common_cfg.decode.cc_min} "
                                    f"are no-data ({n_dropped} of {view.size} in this clip): the "
                                    "same unwrapping gate the hazard pipelines apply")
            values, los_facts = background_los.phase_to_los(view, dec, common_cfg.radar,
                                                            mm=(use_scale == "los_mm"))
            if cc_gate_note:
                los_facts["cc_gate"] = cc_gate_note
        else:
            values = background_inspect._transformed(view, use_scale)

        mask = _polygon_mask(grid, px, py)
        inside = values[mask]
        finite = inside[np.isfinite(inside)]
        stats = bimg.stats(values[mask], values[mask])
        stats["scale"] = use_scale
        stats["unit"] = (("m (LOS, + toward sensor)" if use_scale == "los_m"
                          else "mm (LOS, + toward sensor)") if use_scale in ("los_m", "los_mm")
                         else background_inspect._unit_of(use_scale, cfg))
        stats["n_pixels"] = int(mask.sum())
        stats["n_valid"] = int(finite.size)

        histogram: dict = {"bins": n_bins, "edges": [], "counts": [], "n": int(finite.size)}
        if finite.size:
            counts, edges = np.histogram(finite, bins=n_bins)
            histogram["edges"] = [float(e) for e in edges]
            histogram["counts"] = [int(c) for c in counts]

        if corr != "off":
            from engine.common.config import load_common_config
            corr_facts = background_los.correction_facts(corr, load_common_config().radar)
            los_facts = dict(los_facts or {})
            los_facts["correction"] = corr_facts

        dx = abs(float(grid.x[1]) - float(grid.x[0])) if len(grid.x) > 1 else 0.0
        dy = abs(float(grid.y[0]) - float(grid.y[1])) if len(grid.y) > 1 else 0.0
        body = {
            "ok": True,
            "id": gid, "layer": layer,
            "scale": use_scale, "scale_requested": scale,
            "unit": (("m (LOS, + toward sensor)" if use_scale == "los_m"
                      else "mm (LOS, + toward sensor)") if use_scale in ("los_m", "los_mm")
                     else background_inspect._unit_of(use_scale, cfg)),
            "los": (dict(los_facts) if los_facts else None),
            "epsg": int(grid.epsg),
            "roi": {
                "kind": shape["kind"],
                "ring": [[float(p[0]), float(p[1])] for p in shape["ring"]],
                "n_vertices": len(shape["ring"]),
                "area_km2": area_m2 / 1e6,
                "n_pixels": int(mask.sum()),
                "n_valid": int(finite.size),
                "pixel_pitch_m": [dx, dy],
                "mask_rule": "a pixel counts when its centre falls inside the projected ring",
                "stats": stats,
                "histogram": histogram,
            },
            "requested_bbox": [float(v) for v in sb],
            "date": background_inspect._date_of(dec),
            "notes": (["every pixel inside this roi is no-data at this scale — the numbers are null, not zero"]
                      if finite.size == 0 else
                      [f"{int(mask.sum())} pixel centres fall inside the shape at a {dx:.0f} x {dy:.0f} m pitch; "
                       "a pixel is either in or out — no partial weighting"]),
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
        from . import background as _bg
        _bg._PREVIEW_LOCK.release()

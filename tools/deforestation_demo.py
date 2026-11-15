"""Render the deforestation pipeline's hotspots for the synthetic known-truth scene: a map built ONLY from the pipeline's own output layers
(next to the injected truth), a ranked hotspot table and a GeoJSON. Needs matplotlib + pyproj (dev tools, not engine dependencies).

    python tools/deforestation_demo.py [out_dir]
"""
from __future__ import annotations

import base64
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    sys.path.insert(0, str(p))

import deforestation_scene as S                                   # noqa: E402
from engine.pipelines.deforestation.verdict import run            # noqa: E402

COL = {"fire": "#d1495b", "windthrow": "#edae49", "clearing": "#00798c", "unattributed": "#8d99ae"}


def decode(layer):
    a = np.frombuffer(base64.b64decode(layer["data_b64"]), dtype=layer["dtype"]).reshape(layer["shape"])
    return a.astype(np.float32) if layer["dtype"] == "<f4" else a


def main(out: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch, Rectangle

    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        b = S.build_forest_bundle(d, active_codes={"M2"})
    r = run(b, providers=S.providers(b))
    det = r.detail
    cause = decode(det["layers"]["cause"])
    cls = decode(det["layers"]["loss_class"])
    dens = decode(det["layers"]["loss_density_ha"])
    excl = decode(det["layers"]["exclusion"])
    W, Sx, E, N = det["layers"]["cause"]["bounds_lonlat"]
    ext = (W, E, Sx, N)
    tm = S.truth_masks_on(b)

    fig, ax = plt.subplots(1, 2, figsize=(15, 7.4), constrained_layout=True)
    base = np.where(excl == 0, 0.0, np.nan)
    for a in ax:
        a.imshow(np.where(excl == 0, 1.0, 0.0), extent=ext, cmap=ListedColormap(["#e9e4d8", "#cfe3cf"]), vmin=0, vmax=1, interpolation="nearest")
        a.set_xlabel("longitude"); a.set_ylabel("latitude")
    # truth
    lab = np.zeros(cls.shape, np.int32)
    for i, (k, m) in enumerate(tm.items(), 1):
        lab[m] = i
    tcol = ["#00000000"] + ["#5c5c5c"] * len(tm)
    ax[0].imshow(np.ma.masked_equal(lab, 0), extent=ext, cmap=ListedColormap(tcol[1:]), interpolation="nearest")
    H, Wd = cls.shape
    for i, (k, m) in enumerate(tm.items()):
        ys, xs = np.nonzero(m)
        ax[0].text(W + (xs.mean() + .5) / Wd * (E - W), N - (ys.mean() + .5) / H * (N - Sx), k, fontsize=9, ha="center", va="center", color="black", weight="bold")
    ax[0].set_title("Injected truth (what the scene really contains)\nP1,P2,P3,P4,P6,P7 = clearing / early-stage / road / small / fire / windthrow; "
                    "P5 tiny, P8 last pass only, P9 already cleared", fontsize=9)
    # detection
    cm = ListedColormap(["#00798c", "#edae49", "#d1495b", "#8d99ae"][::1])
    order = {"fire": 1, "windthrow": 2, "clearing": 3, "unattributed": 4}
    names = ["fire", "windthrow", "clearing", "unattributed"]
    cols = [COL[n] for n in names]
    ax[1].imshow(np.ma.masked_equal(cause, 0), extent=ext, cmap=ListedColormap(cols), vmin=1, vmax=4, interpolation="nearest")
    unc = (cls == 1)
    ax[1].imshow(np.ma.masked_where(~unc, unc.astype(float)), extent=ext, cmap=ListedColormap(["#444444"]), alpha=0.5, interpolation="nearest")
    for h in det["hotspots"]:
        w, s, e, n = h["bbox_lonlat"]
        ax[1].add_patch(Rectangle((w, s), e - w, n - s, fill=False, ec="black", lw=1.6, ls="--"))
        ax[1].text(w, n, f" #{h['rank']}  {h['loss_ha']:.1f} ha", fontsize=9, va="bottom", ha="left", weight="bold",
                   bbox=dict(fc="white", ec="none", alpha=0.75, pad=1))
    ax[1].legend(handles=[Patch(fc=COL[n], label=n) for n in names] + [Patch(fc="#444444", alpha=.5, label="unconfirmed candidate"),
                                                                       Patch(fc="none", ec="black", ls="--", label="hotspot cell (500 m)")], loc="lower right", fontsize=8)
    t = det["totals"]
    ax[1].set_title(f"Pipeline output: {r.status}, {t['loss_ha']:.1f} ha in {t['n_patches']} patches (injected truth ≈ 34 ha)\n"
                    "colour = attributed cause; dashed boxes = ranked hotspot cells", fontsize=9)
    for a in ax:
        a.set_xlim(W, E); a.set_ylim(Sx, N)
    fig.suptitle("Deforestation pipeline on a SYNTHETIC L-band scene with known truth (not real NISAR data)", fontsize=12, weight="bold")
    png = out / "deforestation_hotspots_synthetic.png"
    fig.savefig(png, dpi=130)

    feats = []
    for h in det["hotspots"]:
        w, s, e, n = h["bbox_lonlat"]
        feats.append({"type": "Feature", "properties": {"kind": "hotspot", "rank": h["rank"], "loss_ha": round(h["loss_ha"], 2), "dominant_cause": h["dominant_cause"],
                                                      "share_of_total": round(h["share_of_total"], 3)},
                      "geometry": {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}})
    for p in det["patches"]:
        w, s, e, n = p["bbox_lonlat"]
        feats.append({"type": "Feature", "properties": {"kind": "patch", "id": p["id"], "area_ha": round(p["area_ha"], 2), "first_confirmed": p["onset_time"][:10],
                                                      "stage": p["stage"], "hv_change_db": round(p["hv_drop_db"], 2), "cause": p["attribution"]["cause"],
                                                      "r7": p["r7"]["label"]},
                      "geometry": {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}})
    (out / "deforestation_hotspots_synthetic.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    print(r.summary)
    print(f"{'rank':>4} {'loss ha':>8} {'share':>6} {'cause':>10}  centre (lon, lat)")
    for h in det["hotspots"]:
        print(f"{h['rank']:>4} {h['loss_ha']:>8.2f} {100 * h['share_of_total']:>5.0f}% {h['dominant_cause']:>10}  {h['centroid_lonlat'][0]:.4f}, {h['centroid_lonlat'][1]:.4f}")
    print(f"\nwrote {png}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out")

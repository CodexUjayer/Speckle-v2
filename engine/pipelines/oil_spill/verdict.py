import sys
from pathlib import Path

if __name__ == "__main__":       
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import numpy as np
import matplotlib.pyplot as plt

from engine.common.result import EvidenceItem, PipelineResult
from engine.common.scene_bundle import SceneBundle     # the real type: hover/ctrl-click it in your editor

# ---- settings: edit these ----------------------------------------------------------------
POL = "HV"            # radar channel to look at
Z_DROP = 4.0          # a pixel "dropped" if its z-score <= -Z_DROP
MIN_FRACTION = 0.02   # SUPPORTED if at least this share of valid pixels dropped
# ------------------------------------------------------------------------------------------


def _skip(key, why):
    return EvidenceItem(id=f"insufficient.{key}", kind="insufficient",
                        claim=f"{key}: {why}", level="caveat")


def run(bundle: SceneBundle, providers=None):
    evidence, fractions = [], []

    # for key, stack in bundle.stacks.items():
    #     print(key, " ", stack)

    wedges = []

        
    stack = bundle.stack()

    back_scatter = stack.backscatter
    interf       = stack.interferometric

    pol = next(iter(back_scatter.gamma0_db))
    bs_stack  = back_scatter.gamma0_db[pol]   # (N, H, W), dB
    los_stack = interf.los_m                  # (N, H, W), meters

    # --- backscatter stats ---
    bs_mean   = np.nanmean(bs_stack, axis=0)
    bs_median = np.nanmedian(bs_stack, axis=0)
    bs_diffdb = bs_stack[-1] - bs_stack[0]              # dB diff
    bs_lin    = 10 ** (bs_stack / 10.0)
    bs_difflin = bs_lin[-1] - bs_lin[0]                 # linear power diff

    # --- LOS displacement stats ---
    los_mean    = np.nanmean(los_stack, axis=0)
    los_median  = np.nanmedian(los_stack, axis=0)
    los_diff    = los_stack[-1] - los_stack[0]
    los_logdiff = np.log10(np.abs(los_diff) + 1e-6)     # log-magnitude, diff can be negative

    fig, axs = plt.subplots(2, 4, figsize=(18, 9))

    row0 = [(bs_mean,   "Backscatter mean [dB]",      "gray"),
            (bs_median, "Backscatter median [dB]",    "gray"),
            (bs_difflin,"Backscatter diff (linear)",  "RdBu_r"),
            (bs_diffdb, "Backscatter diff [dB]",      "RdBu_r")]

    row1 = [(los_mean,    "LOS mean [m]",            "RdBu_r"),
            (los_median,  "LOS median [m]",          "RdBu_r"),
            (los_diff,    "LOS diff [m]",            "RdBu_r"),
            (los_logdiff, "LOS log|diff| [log10 m]", "viridis")]

    for row_axs, row in zip(axs, (row0, row1)):
        for ax, (data, title, cmap) in zip(row_axs, row):
            vmin, vmax = np.nanpercentile(data, [2, 98])
            im = ax.imshow(data, cmap=cmap, vmin=vmin, vmax=vmax)
            ax.set_title(title, fontsize=10)
            ax.set_xlabel("Range (px)")
            ax.set_ylabel("Azimuth (px)")
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    plt.tight_layout()
    plt.show()
    

    return PipelineResult(
        pipeline="_I_am_oil", tile=bundle.tile.id, epoch=bundle.epoch,
        status="good", summary="d", raw_p=12.2, evidence=evidence,
        diagnostics={"pol": POL, "z_drop": Z_DROP, "min_fraction": MIN_FRACTION},
        bundle_id=bundle.bundle_id,
    )


# ==========================================================================================
# Everything below is for running by hand. The engine ignores it.
# ==========================================================================================
def _cached_bundles():
    from engine.common.config import data_root
    d = data_root() / "bundles"
    found = [p for p in d.iterdir() if (p / "bundle.json").exists()] if d.is_dir() else []
    return d, sorted(found, key=lambda p: p.stat().st_mtime)        # newest last


def _peek(bundle):
    """Print the parts of the bundle this pipeline touches, so you can see the real structure."""
    print(f"bundle {bundle.bundle_id}  tile={bundle.tile.id}  newest epoch={bundle.epoch}  status={bundle.status}")
    for key, stack in bundle.stacks.items():
        bs = stack.backscatter
        if bs is None:
            print(f"  {key}: no backscatter")
        elif bs.z_prev is None:
            print(f"  {key}: {len(bs.epochs)} epochs, z_prev = None (bundle built before the z_prev change)")
        else:
            shapes = {pol: tuple(a.shape) for pol, a in bs.z_prev.items()}
            print(f"  {key}: {len(bs.epochs)} epochs, current_index={bs.current_index}, z_prev shapes={shapes}")
    print()


if __name__ == "__main__":
    from engine.common.bundle_io import load_bundle

    folder, found = _cached_bundles()
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if arg == "--list":
        print(f"{folder}  ({len(found)} bundles)")
        for p in found:
            print("  ", p.name)
        sys.exit(0)
    if arg:
        path = Path(arg) if (Path(arg) / "bundle.json").exists() else folder / arg
    elif found:
        path = found[-1]
    else:
        sys.exit(f"No cached bundles in {folder}. Set NISAR_DATA_DIR in .env, or pass a bundle folder path.")

    bundle = load_bundle(path)
    _peek(bundle)
    r = run(bundle)
    print(f"status:  {r.status}\nsummary: {r.summary}\nraw_p:   {r.raw_p}\n")
    for e in r.evidence:
        print(f"[{e.kind}] {e.claim}")
        if e.support:
            print(f"    {e.support}")

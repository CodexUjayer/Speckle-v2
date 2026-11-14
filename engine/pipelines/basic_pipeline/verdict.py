import sys
from pathlib import Path

if __name__ == "__main__":        # lets "Run file" work: put the repo root on the import path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import numpy as np

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

    for key, stack in bundle.stacks.items():              # key is like "A005"
        bs = stack.backscatter                            # BackscatterData
        if bs is None or bs.z_prev is None or POL not in bs.z_prev or bs.current_index < 1:
            evidence.append(_skip(key, f"no usable z_prev for {POL}"))
            continue

        i = bs.current_index                              # newest epoch
        z = bs.z_prev[POL][i]                             # (20, 20) z-scores vs the previous epoch
        ok = bs.valid[i] & np.isfinite(z)
        n_valid = int(ok.sum())
        if n_valid == 0:
            evidence.append(_skip(key, "no valid pixels in the newest epoch"))
            continue

        n_drop = int((z[ok] <= -Z_DROP).sum())
        frac = n_drop / n_valid
        fractions.append(frac)
        evidence.append(EvidenceItem(
            id=f"drop.{key}", kind="detection",
            claim=f"{100 * frac:.1f}% of valid pixels fell by {Z_DROP:g} sigma or more in {POL} ({key}).",
            support={"quantity": frac, "unit": "fraction", "n_valid": n_valid, "n_drop": n_drop},
            source_ref=f"stacks/{key}/backscatter/z_prev/{POL}",
        ))

    best = max(fractions, default=None)                   # rank score, not a probability
    if best is None:
        status, summary = "INSUFFICIENT_EVIDENCE", "No usable backscatter comparison for this tile."
    elif best >= MIN_FRACTION:
        status, summary = "SUPPORTED", f"Backscatter dropped over {100 * best:.1f}% of valid pixels."
    else:
        status, summary = "NOT_SUPPORTED", f"Backscatter dropped over only {100 * best:.1f}% of valid pixels."

    return PipelineResult(
        pipeline="basic_pipeline", tile=bundle.tile.id, epoch=bundle.epoch,
        status=status, summary=summary, raw_p=best, evidence=evidence,
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


import numpy as np

from engine.common.result import EvidenceItem, PipelineResult

POL, Z_DROP, MIN_FRACTION = "HV", 4.0, 0.02


def _skip(key, why):
    return EvidenceItem(id=f"insufficient.{key}", kind="insufficient",
                        claim=f"{key}: {why}", level="caveat")


def run(bundle, providers=None):
    evidence, fractions = [], []

    for key, stack in bundle.stacks.items():
        bs = stack.backscatter
        if bs is None or bs.z_prev is None or POL not in bs.z_prev or bs.current_index < 1:
            evidence.append(_skip(key, f"no usable z_prev for {POL}"))
            continue

        i = bs.current_index                                  # newest epoch
        z = bs.z_prev[POL][i]
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

    best = max(fractions, default=None)                       # rank score, not a probability
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

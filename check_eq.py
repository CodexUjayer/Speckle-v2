"""Re-run earthquake_coseismic on a SAVED bundle, straight from the code on disk.

Bypasses the UI, the engine process and every cache (Supabase / job cache), so the answer is whatever the
current source files produce. Run from the repo root:

    python check_eq.py                  # newest bundle in <data_dir>/bundles
    python check_eq.py <bundle_id>      # a specific bundle

The data dir comes from the engine's own settings (NISAR_DATA_DIR / config), nothing is hard-coded here.
"""
from __future__ import annotations

import sys

from engine.common.bundle_io import load_bundle
from engine.common.config import data_root
from engine.pipelines.earthquake_coseismic import verdict


def main() -> int:
    bundles_dir = data_root() / "bundles"
    found = sorted((p for p in bundles_dir.glob("*") if (p / "bundle.json").exists()),
                   key=lambda p: p.stat().st_mtime)
    if not found:
        print(f"no bundles under {bundles_dir}")
        return 1
    if len(sys.argv) > 1:
        path = bundles_dir / sys.argv[1]
    else:
        path = found[-1]
        print("newest bundles (oldest -> newest):", *[p.name for p in found[-4:]], sep="\n  ")
    print(f"\nrunning on: {path.name}")

    res = verdict.run(load_bundle(path, mmap=True)).to_dict()
    detail = res.get("detail") or {}
    print("status:   ", res["status"])
    print("decision: ", detail.get("decision"))
    for line in res.get("data_used") or []:
        if "ComCat" in line:
            print("data_used:", line)
    for w in res.get("warnings") or []:
        print("warning:  ", w)
    for s in detail.get("forward_screens") or []:
        keep = {k: s.get(k) for k in ("event_id", "magnitude", "plane", "skipped", "skip_reason",
                                      "amp_ratio", "pearson_r", "passes") if k in s}
        print("screen:   ", keep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

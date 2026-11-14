#!/usr/bin/env python3
"""Fill the screenshot galleries in README.md from the folders under docs/pics/.

    python dev_scripts/readme_gallery.py            # rewrite the gallery blocks in README.md
    python dev_scripts/readme_gallery.py --check    # exit 1 if README.md is out of date (no write)

README.md holds one block per folder, between two marker comments:

    <!-- GALLERY:docs/pics/debug_hub -->
    ...generated...
    <!-- /GALLERY -->

Every image in that folder (png, jpg, jpeg, gif, webp, svg) is listed in file-name order, so name files
01_..., 02_... to control the order. The caption is the file name without number prefix and extension.
Nothing outside the markers is touched. Paths are relative to README.md, so it works from any checkout."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
BLOCK = re.compile(r"(<!-- GALLERY:(?P<folder>[^ >]+) -->\n)(?P<body>.*?)(<!-- /GALLERY -->)", re.S)


def caption(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"^\d+[\s._-]*", "", stem)                 # leading order number
    return re.sub(r"[_-]+", " ", stem).strip() or Path(name).stem


def render(folder: str) -> str:
    d = ROOT / folder
    files = sorted((p for p in d.iterdir() if p.suffix.lower() in EXTS), key=lambda p: p.name.lower()) if d.is_dir() else []
    if not files:
        return f"_No screenshots in `{folder}/` yet._\n\n"
    out = []
    for p in files:
        rel = quote(f"{folder}/{p.name}")
        out.append(f"**{caption(p.name)}**\n\n![{caption(p.name)}]({rel})\n")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    text = README.read_text(encoding="utf-8")
    seen = []

    def sub(m):
        seen.append(m["folder"])
        return m[1] + render(m["folder"]) + m[4]

    new = BLOCK.sub(sub, text)
    if not seen:
        print("no GALLERY blocks found in README.md", file=sys.stderr)
        return 2
    if new == text:
        print("README.md galleries are up to date:", ", ".join(seen))
        return 0
    if a.check:
        print("README.md galleries are out of date; run: python dev_scripts/readme_gallery.py", file=sys.stderr)
        return 1
    README.write_text(new, encoding="utf-8")
    print("updated galleries:", ", ".join(seen))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

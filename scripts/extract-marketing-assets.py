#!/usr/bin/env python3
"""Extract the inlined images out of the Concept B marketing mockup.

The signed-off mockup (Concept B / "Race Day" / v2.6) ships every photograph as a
base64 `data:image/...` URI, which is ~3.3 MB of the 4.75 MB file. Serving that
from Next would put the whole payload in the HTML on every request, so the bytes
are lifted out to `public/marketing/` and referenced by path instead.

Rules (ENG-587 decision 5):
  * bytes are written through **verbatim** — the base64 is decoded and dumped, with
    no re-encode, no optimisation and no format change, so an extracted file is
    byte-identical to what the mockup carried;
  * each file is named `<md5-8>.<ext>` from the md5 of those bytes, so re-running
    this script over the same mockup is idempotent and verifiable — identical
    content lands on an identical filename;
  * duplicates collapse. The mockup references 43 images, 40 of them unique (the
    wordmark appears twice, and two photographs appear twice).

The favicon is skipped: it is a URL-encoded emoji SVG, not base64, and ENG-587
decision 7 drops it in favour of the repo's own `app/icon.png`.

Usage (from the repo root):

    python3 scripts/extract-marketing-assets.py
    python3 scripts/extract-marketing-assets.py --check      # verify, write nothing

`--check` exits non-zero if the extraction would change anything on disk, which is
what makes "re-running produces a byte-identical set" a machine-checkable claim.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The mockup lives in the sibling design tree, outside this repo. Its depth above
# the repo root is NOT fixed: from a normal checkout it is two levels up, but the
# implement loop runs in a worktree under .claude/worktrees/<ticket>/, which is two
# levels deeper. So search upward for it rather than hard-coding "../..".
SOURCE_SUFFIX = "10-marketing-site/deploy/src/mockup.html"
DEFAULT_OUT = "public/marketing"


def default_source() -> Path | None:
    for base in (REPO_ROOT, *REPO_ROOT.parents):
        candidate = base / SOURCE_SUFFIX
        if candidate.is_file():
            return candidate
    return None

# `data:image/<mime>;base64,<payload>` up to the closing quote or paren.
DATA_URI = re.compile(r"data:image/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)(?=[\"')])")

EXT_BY_MIME = {
    "jpeg": "jpg",
    "jpg": "jpg",
    "png": "png",
    "gif": "gif",
    "webp": "webp",
    "svg+xml": "svg",
}


def extract(source: Path) -> list[tuple[str, bytes]]:
    """Return [(filename, raw_bytes)] in first-appearance order, deduplicated."""
    html = source.read_text(encoding="utf-8")
    seen: dict[str, bytes] = {}
    order: list[str] = []
    total = 0

    for mime, payload in DATA_URI.findall(html):
        total += 1
        ext = EXT_BY_MIME.get(mime.lower())
        if ext is None:
            raise SystemExit(f"unhandled image mime type: image/{mime}")
        raw = base64.b64decode(re.sub(r"\s+", "", payload))
        name = f"{hashlib.md5(raw).hexdigest()[:8]}.{ext}"
        if name not in seen:
            seen[name] = raw
            order.append(name)
        elif seen[name] != raw:
            # An 8-hex-char prefix is 32 bits; a collision is not expected at 40
            # files but must never pass silently.
            raise SystemExit(f"md5-8 collision on {name} — widen the prefix")

    print(f"{source}: {total} image references, {len(order)} unique", file=sys.stderr)
    return [(name, seen[name]) for name in order]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", help=f"mockup HTML (default: nearest {SOURCE_SUFFIX} above the repo)")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"output dir (default: {DEFAULT_OUT})")
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    args = ap.parse_args()

    source = (REPO_ROOT / args.source).resolve() if args.source else default_source()
    if source is None:
        raise SystemExit(f"mockup not found: no {SOURCE_SUFFIX} above {REPO_ROOT} — pass --source")
    if not source.is_file():
        raise SystemExit(f"mockup not found: {source}")

    out_dir = (REPO_ROOT / args.out).resolve()
    # Keep a stray --out from scattering decoded bytes across the repo.
    if not out_dir.is_relative_to(REPO_ROOT / "public"):
        raise SystemExit(f"--out must live under public/: {out_dir}")

    assets = extract(source)
    if not args.check:
        out_dir.mkdir(parents=True, exist_ok=True)

    drift = 0
    for name, raw in assets:
        target = out_dir / name
        current = target.read_bytes() if target.is_file() else None
        if current == raw:
            state = "ok"
        elif args.check:
            state = "MISSING" if current is None else "DIFFERS"
            drift += 1
        else:
            target.write_bytes(raw)
            state = "wrote"
        print(f"{hashlib.md5(raw).hexdigest()}  {name:>14}  {len(raw):>8} bytes  {state}")

    expected = {name for name, _ in assets}
    for stray in sorted(p.name for p in out_dir.glob("*") if p.is_file()):
        if stray not in expected:
            print(f"stray file not produced by this script: {stray}", file=sys.stderr)
            drift += 1

    print(f"{len(assets)} files in {out_dir}", file=sys.stderr)
    if args.check and drift:
        print(f"FAIL: {drift} file(s) differ from the mockup", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

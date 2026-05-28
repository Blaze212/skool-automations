#!/usr/bin/env python3
"""
Extract the most recent image attachment from the current Cowork
session transcript and save it to disk.

Usage:
    python3 extract_latest_screenshot.py <output-dir>
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


def find_transcript():
    candidate_dirs = [
        Path("/sessions"),
        Path.home() / ".claude" / "projects",
    ]
    candidates = []
    for base in candidate_dirs:
        if not base.exists():
            continue
        for jsonl in base.rglob("*.jsonl"):
            try:
                candidates.append((jsonl.stat().st_mtime, jsonl))
            except OSError:
                pass
    if not candidates:
        return None
    return max(candidates)[1]


def walk_for_images(node, found):
    if isinstance(node, dict):
        if node.get("type") == "image" and "source" in node:
            src = node["source"]
            if src.get("type") == "base64":
                data = src.get("data", "")
                media = src.get("media_type", "image/png").split("/")[-1]
                if data:
                    try:
                        found.append((media, base64.b64decode(data)))
                    except Exception:
                        pass
        for v in node.values():
            walk_for_images(v, found)
    elif isinstance(node, list):
        for v in node:
            walk_for_images(v, found)


def main():
    if len(sys.argv) < 2:
        print("Usage: extract_latest_screenshot.py <output-dir>", file=sys.stderr)
        return 1
    out_dir = Path(sys.argv[1]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    transcript = find_transcript()
    if transcript is None:
        print("Could not locate session transcript JSONL.", file=sys.stderr)
        return 2

    images = []
    with transcript.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                walk_for_images(json.loads(line), images)
            except Exception:
                continue

    if not images:
        print("No image blocks found in transcript.", file=sys.stderr)
        return 3

    paths = []
    for i, (ext, blob) in enumerate(images, 1):
        p = out_dir / f"img_{i:02d}.{ext}"
        p.write_bytes(blob)
        paths.append(p)
        print(p)
    print(f"\nLatest image: {paths[-1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

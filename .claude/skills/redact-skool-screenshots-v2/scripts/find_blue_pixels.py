#!/usr/bin/env python3
"""
Scan an image for blue hyperlink-colored pixels (Skool @mention links)
and return their bounding boxes as JSON.

Usage:
    python3 find_blue_pixels.py <image.png> [y_start]

y_start defaults to 80 (skips the header row).
Prints a JSON array of [x0, y0, x1, y1] boxes to stdout — one per
contiguous cluster of blue pixels. These are raw pixel bounds with no
padding; the caller adds padding when inserting into spec.json.

Detection criteria (matches build_spec.py):
    R < 120  AND  B > 150  AND  B > G + 30
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    import subprocess
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "numpy", "pillow",
         "--break-system-packages", "-q"]
    )
    import numpy as np
    from PIL import Image

MERGE_X_GAP = 50   # px — merge clusters closer than this horizontally
MERGE_Y_GAP = 5    # px — merge clusters closer than this vertically
MIN_PIXELS  = 5    # discard clusters with fewer pixels (noise)


def find_blue_boxes(img_path: str, y_start: int = 80) -> list[list[int]]:
    img = Image.open(img_path).convert("RGB")
    arr = np.array(img)
    H, W = arr.shape[:2]

    y0 = max(0, y_start)
    body = arr[y0:H, :, :]

    blue = (
        (body[:, :, 0] < 120) &
        (body[:, :, 2] > 150) &
        (body[:, :, 2].astype(int) > body[:, :, 1].astype(int) + 30)
    )

    ys, xs = np.where(blue)
    if len(xs) < MIN_PIXELS:
        return []

    # Absolute coords
    points = sorted(zip(xs.tolist(), (ys + y0).tolist()))

    # Group into clusters by proximity
    clusters: list[list[tuple[int, int]]] = []
    for pt in points:
        placed = False
        for g in clusters:
            gxs = [p[0] for p in g]
            gys = [p[1] for p in g]
            if (pt[0] >= min(gxs) - MERGE_X_GAP and
                    pt[0] <= max(gxs) + MERGE_X_GAP and
                    pt[1] >= min(gys) - MERGE_Y_GAP and
                    pt[1] <= max(gys) + MERGE_Y_GAP):
                g.append(pt)
                placed = True
                break
        if not placed:
            clusters.append([pt])

    boxes = []
    for g in clusters:
        if len(g) < MIN_PIXELS:
            continue
        gxs = [p[0] for p in g]
        gys = [p[1] for p in g]
        boxes.append([min(gxs), min(gys), max(gxs), max(gys)])

    return boxes


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: find_blue_pixels.py <image.png> [y_start]", file=sys.stderr)
        return 1
    img_path = sys.argv[1]
    y_start = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    boxes = find_blue_boxes(img_path, y_start)
    print(json.dumps(boxes))
    return 0


if __name__ == "__main__":
    sys.exit(main())

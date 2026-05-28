#!/usr/bin/env python3
"""
Verify that a redacted screenshot is correct.

Usage:
    python3 verify_redactions.py <original.png> <redacted.png> <spec.json>
"""

from __future__ import annotations
import json, sys
import numpy as np
from PIL import Image

TEAL_RGB = (0x1F, 0x3E, 0x3E)
TEAL_TOLERANCE = 25
BODY_PROBE_OFFSET = 30
BODY_PROBE_COLS = 5


def is_teal(r, g, b):
    return (abs(r - TEAL_RGB[0]) <= TEAL_TOLERANCE and
            abs(g - TEAL_RGB[1]) <= TEAL_TOLERANCE and
            abs(b - TEAL_RGB[2]) <= TEAL_TOLERANCE)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def pixel_is_teal(arr, x, y):
    H, W = arr.shape[:2]
    x, y = clamp(x, 0, W - 1), clamp(y, 0, H - 1)
    return is_teal(int(arr[y, x, 0]), int(arr[y, x, 1]), int(arr[y, x, 2]))


def check_region_covered(out_arr, region):
    results = []
    label = region.get("label", region.get("type", "?"))
    rtype = region.get("type")

    if rtype == "header":
        cx, cy, _ = region["avatar"]
        covered = pixel_is_teal(out_arr, cx, cy)
        results.append((f"avatar covered [{label}]", covered, f"center pixel at ({cx},{cy})"))
        x0, y0, x1, y1 = region["name_bbox"]
        nx, ny = (x0 + x1) // 2, (y0 + y1) // 2
        covered = pixel_is_teal(out_arr, nx, ny)
        results.append((f"name covered [{label}]", covered, f"center pixel at ({nx},{ny})"))
    elif rtype == "mention":
        x0, y0, x1, y1 = region["bbox"]
        mx, my = (x0 + x1) // 2, (y0 + y1) // 2
        covered = pixel_is_teal(out_arr, mx, my)
        results.append((f"mention covered [{label}]", covered, f"center pixel at ({mx},{my})"))

    return results


def check_no_overcoverage(out_arr, orig_arr, region):
    """Verify body text below name_bbox is NOT teal in the redacted image,
    but also was NOT already teal-like in the original (avoids false positives
    from dark UI pixels that happen to fall within teal tolerance)."""
    if region.get("type") != "header":
        return []

    label = region.get("label", "?")
    _, _, x1_name, y1_name = region["name_bbox"]
    probe_y = y1_name + BODY_PROBE_OFFSET
    H, W = out_arr.shape[:2]
    if probe_y >= H:
        return []

    x_start = int(region["name_bbox"][0])
    x_probes = [clamp(x_start + i * 20, 0, W - 1) for i in range(BODY_PROBE_COLS)]

    teal_count = sum(
        1 for x in x_probes
        if pixel_is_teal(out_arr, x, probe_y) and not pixel_is_teal(orig_arr, x, probe_y)
    )
    ok = teal_count == 0
    detail = f"probed y={probe_y}, x={x_probes}, new teal hits={teal_count}/{len(x_probes)}"
    return [(f"body text NOT covered [{label}]", ok, detail)]


def main():
    if len(sys.argv) != 4:
        print("Usage: verify_redactions.py <original.png> <redacted.png> <spec.json>", file=sys.stderr)
        return 1

    orig_arr = np.array(Image.open(sys.argv[1]).convert("RGB"))
    out_arr  = np.array(Image.open(sys.argv[2]).convert("RGB"))

    with open(sys.argv[3]) as f:
        spec = json.load(f)

    all_results = []
    for region in spec.get("regions", []):
        all_results.extend(check_region_covered(out_arr, region))
        all_results.extend(check_no_overcoverage(out_arr, orig_arr, region))

    passed = [r for r in all_results if r[1]]
    failed = [r for r in all_results if not r[1]]

    print(f"\nVerification: {len(passed)} passed, {len(failed)} failed")
    print("-" * 60)
    for name, ok, detail in all_results:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")
        if not ok:
            print(f"         → {detail}")

    if failed:
        print("\nACTION REQUIRED: fix the spec and re-render before presenting to user.")
        return 1
    else:
        print("\nAll checks passed. Safe to present.")
        return 0


if __name__ == "__main__":
    sys.exit(main())

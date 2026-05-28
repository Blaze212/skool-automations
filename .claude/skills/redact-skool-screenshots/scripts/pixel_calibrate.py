#!/usr/bin/env python3
"""
Pixel-calibrate a rough redaction spec against the actual screenshot.
DEPRECATED — was used to refine vision-estimated coordinates.
No longer needed since build_spec.py derives all coordinates from pixels directly.
Kept for reference only.

Usage:
    python3 pixel_calibrate.py <input-image> <rough_spec.json> <out_spec.json>
"""

from __future__ import annotations
import json, sys
import numpy as np
from PIL import Image

WHITE_THRESH  = 220
DARK_THRESH   = 80
BLUE_B_MIN    = 120
BLUE_LEAD     = 30
AVATAR_H_PAD  = 5
AVATAR_V_PAD  = 30
NAME_Y_PAD    = 12
NAME_X_PAD    = 30
MENTION_PAD   = 30
MIN_DARK_PX   = 2


def is_white(r, g, b): return r > WHITE_THRESH and g > WHITE_THRESH and b > WHITE_THRESH
def brightness(r, g, b): return (r + g + b) / 3.0
def is_dark(r, g, b): return brightness(r, g, b) < DARK_THRESH
def is_blue(r, g, b):
    return b >= BLUE_B_MIN and b > r + BLUE_LEAD and b > g + 10 and brightness(r, g, b) < 200
def clamp(v, lo, hi): return max(lo, min(hi, v))


def calibrate_avatar(arr, rough_cx, rough_cy, rough_r):
    H, W = arr.shape[:2]
    y   = clamp(rough_cy, 0, H - 1)
    x_lo = clamp(rough_cx - rough_r - AVATAR_H_PAD, 0, W - 1)
    x_hi = clamp(rough_cx + rough_r + AVATAR_H_PAD, 0, W - 1)
    non_white_x = [x for x in range(x_lo, x_hi + 1)
                   if not is_white(int(arr[y,x,0]), int(arr[y,x,1]), int(arr[y,x,2]))]
    if not non_white_x:
        x_lo2 = clamp(rough_cx - rough_r - 15, 0, W - 1)
        x_hi2 = clamp(rough_cx + rough_r + 15, 0, W - 1)
        non_white_x = [x for x in range(x_lo2, x_hi2 + 1)
                       if not is_white(int(arr[y,x,0]), int(arr[y,x,1]), int(arr[y,x,2]))]
    if not non_white_x:
        return rough_cx, rough_cy, rough_r
    new_cx = (non_white_x[0] + non_white_x[-1]) // 2
    r_x    = (non_white_x[-1] - non_white_x[0]) // 2
    x   = clamp(new_cx, 0, W - 1)
    y_lo = clamp(rough_cy - rough_r - AVATAR_V_PAD, 0, H - 1)
    y_hi = clamp(rough_cy + rough_r + AVATAR_V_PAD, 0, H - 1)
    non_white_y = [yy for yy in range(y_lo, y_hi + 1)
                   if not is_white(int(arr[yy,x,0]), int(arr[yy,x,1]), int(arr[yy,x,2]))]
    if not non_white_y:
        return new_cx, rough_cy, r_x
    new_cy = (non_white_y[0] + non_white_y[-1]) // 2
    r_y    = (non_white_y[-1] - non_white_y[0]) // 2
    return new_cx, new_cy, max(r_x, r_y)


def calibrate_name_bbox(arr, rough, avatar_right):
    H, W = arr.shape[:2]
    x0_r, y0_r, x1_r, y1_r = rough
    sy0 = clamp(y0_r - NAME_Y_PAD, 0, H - 1)
    sy1 = clamp(y1_r + NAME_Y_PAD, 0, H - 1)
    sx0 = clamp(max(avatar_right, x0_r - NAME_X_PAD), 0, W - 1)
    sx1 = clamp(x1_r + NAME_X_PAD, 0, W - 1)
    found = []
    for y in range(sy0, sy1 + 1):
        xs = [x for x in range(sx0, sx1 + 1)
              if is_dark(int(arr[y,x,0]), int(arr[y,x,1]), int(arr[y,x,2]))]
        if len(xs) >= MIN_DARK_PX:
            found.append((y, xs[0], xs[-1]))
    if not found:
        return rough
    return [min(r[1] for r in found), found[0][0],
            max(r[2] for r in found), found[-1][0]]


def calibrate_mention_bbox(arr, rough):
    H, W = arr.shape[:2]
    x0_r, y0_r, x1_r, y1_r = rough
    sy0 = clamp(y0_r - MENTION_PAD, 0, H - 1)
    sy1 = clamp(y1_r + MENTION_PAD, 0, H - 1)
    sx0 = clamp(x0_r - MENTION_PAD, 0, W - 1)
    sx1 = clamp(x1_r + MENTION_PAD, 0, W - 1)
    def scan(matcher):
        rows = []
        for y in range(sy0, sy1 + 1):
            xs = [x for x in range(sx0, sx1 + 1)
                  if matcher(int(arr[y,x,0]), int(arr[y,x,1]), int(arr[y,x,2]))]
            if len(xs) >= MIN_DARK_PX:
                rows.append((y, xs[0], xs[-1]))
        return rows
    found = scan(is_blue) or scan(is_dark)
    if not found:
        return rough
    return [min(r[1] for r in found), found[0][0],
            max(r[2] for r in found), found[-1][0]]


def main():
    if len(sys.argv) != 4:
        print("Usage: pixel_calibrate.py <input-image> <rough_spec.json> <out_spec.json>", file=sys.stderr)
        return 1
    img = Image.open(sys.argv[1]).convert("RGB")
    arr = np.array(img)
    with open(sys.argv[2]) as f:
        spec = json.load(f)
    refined = []
    for region in spec.get("regions", []):
        rtype = region.get("type")
        if rtype == "header":
            r_cx, r_cy, r_r = region["avatar"]
            new_cx, new_cy, new_r = calibrate_avatar(arr, r_cx, r_cy, r_r)
            rough_name = region["name_bbox"]
            new_name = calibrate_name_bbox(arr, rough_name, new_cx + new_r + 5)
            label = region.get("label", "")
            print(f"  header '{label}':")
            print(f"    avatar  ({r_cx},{r_cy},r={r_r}) -> ({new_cx},{new_cy},r={new_r})")
            print(f"    name    {rough_name} -> {new_name}")
            refined.append({**region, "avatar": [new_cx, new_cy, new_r], "name_bbox": new_name})
        elif rtype == "mention":
            rough_bbox = region["bbox"]
            new_bbox = calibrate_mention_bbox(arr, rough_bbox)
            label = region.get("label", "")
            print(f"  mention '{label}': {rough_bbox} -> {new_bbox}")
            refined.append({**region, "bbox": new_bbox})
        else:
            refined.append(region)
    out_spec = {**spec, "regions": refined}
    with open(sys.argv[3], "w") as f:
        json.dump(out_spec, f, indent=2)
    print(f"\nCalibrated spec -> {sys.argv[3]}")
    return 0

if __name__ == "__main__":
    sys.exit(main())

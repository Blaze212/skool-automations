#!/usr/bin/env python3
"""
Pixel-scan a Skool screenshot and produce a redaction spec JSON.

Finds:
  - Post author header (top of screenshot)
  - Comment/reply author headers (indented cards below)
  - @mention links (blue hyperlink text in comment bodies)

Usage:
    python3 build_spec.py <input.png|jpeg> <output_spec.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image


# ── tuneable constants ──────────────────────────────────────────────────────

BG_THRESH = 230
AVATAR_X_MIN = 10
AVATAR_X_MAX = 80
NESTED_X_MIN = 80
NESTED_X_MAX = 130
NAME_LEFT_OFFSET = 5
NAME_RIGHT_MAX = 500
TEXT_DARK_THRESH = 80
MENTION_R_MAX = 120
MENTION_G_MAX = 160
MENTION_B_MIN = 150
MENTION_MIN_WIDTH = 20
CLUSTER_GAP_ROWS = 8
MIN_AVATAR_SPAN = 24  # clusters shorter than this are UI chrome, not profile photos

# ── helpers ─────────────────────────────────────────────────────────────────

def is_bg(r, g, b):
    return r > BG_THRESH and g > BG_THRESH and b > BG_THRESH

def is_dark(r, g, b):
    return r < TEXT_DARK_THRESH and g < TEXT_DARK_THRESH and b < TEXT_DARK_THRESH

def is_blue_link(r, g, b):
    return (r < MENTION_R_MAX and b > MENTION_B_MIN and b > g + 30)

# ── avatar detection ─────────────────────────────────────────────────────────

def find_avatar_rows(arr, x_min, x_max):
    H, W = arr.shape[:2]
    x_max = min(x_max, W)
    active_rows = []
    for y in range(H):
        strip = arr[y, x_min:x_max]
        non_bg = np.sum(~((strip[:, 0] > BG_THRESH) &
                          (strip[:, 1] > BG_THRESH) &
                          (strip[:, 2] > BG_THRESH)))
        if non_bg >= 5:
            active_rows.append(y)
    if not active_rows:
        return []
    clusters = []
    start = active_rows[0]
    prev = active_rows[0]
    for y in active_rows[1:]:
        if y - prev > CLUSTER_GAP_ROWS:
            clusters.append((start, prev))
            start = y
        prev = y
    clusters.append((start, prev))
    result = []
    for y0, y1 in clusters:
        if y1 - y0 < MIN_AVATAR_SPAN:
            continue
        cy = (y0 + y1) // 2
        r = max((y1 - y0) // 2, 18)
        result.append((cy, y0, y1))
    return result

# ── name bbox detection ──────────────────────────────────────────────────────

def find_name_bbox(arr, avatar_cx, avatar_r, row_y0, row_y1):
    H, W = arr.shape[:2]
    x_start = avatar_cx + avatar_r + NAME_LEFT_OFFSET
    x_end = min(NAME_RIGHT_MAX, W)
    scan_y0 = max(0, row_y0 - 5)
    scan_y1 = min(H, row_y0 + 30)
    region = arr[scan_y0:scan_y1, x_start:x_end]
    dark = ((region[:, :, 0] < TEXT_DARK_THRESH) &
            (region[:, :, 1] < TEXT_DARK_THRESH) &
            (region[:, :, 2] < TEXT_DARK_THRESH))
    ys, xs = np.where(dark)
    if len(xs) < 3:
        return None
    x0 = int(xs.min()) + x_start
    x1 = int(xs.max()) + x_start
    y0 = int(ys.min()) + scan_y0
    y1 = int(ys.max()) + scan_y0
    if x1 - x0 < 5 or y1 - y0 > 30:
        return None
    return [x0, y0, x1, y1]

# ── @mention detection ───────────────────────────────────────────────────────

def find_mentions(arr, body_y0, body_y1, x_start=60):
    H, W = arr.shape[:2]
    body_y0 = max(0, body_y0)
    body_y1 = min(H, body_y1)
    blue_mask = ((arr[body_y0:body_y1, x_start:, 0] < MENTION_R_MAX) &
                 (arr[body_y0:body_y1, x_start:, 2] > MENTION_B_MIN) &
                 (arr[body_y0:body_y1, x_start:, 2].astype(int) >
                  arr[body_y0:body_y1, x_start:, 1].astype(int) + 30))
    ys, xs = np.where(blue_mask)
    if len(xs) < 3:
        return []
    positions = set(zip((xs + x_start).tolist(), (ys + body_y0).tolist()))
    if not positions:
        return []
    groups = []
    for pt in sorted(positions):
        placed = False
        for g in groups:
            gxs = [p[0] for p in g]
            gys = [p[1] for p in g]
            if (pt[0] >= min(gxs) - 5 and pt[0] <= max(gxs) + 50 and
                    pt[1] >= min(gys) - 5 and pt[1] <= max(gys) + 5):
                g.add(pt)
                placed = True
                break
        if not placed:
            groups.append({pt})
    bboxes = []
    for g in groups:
        gxs = [p[0] for p in g]
        gys = [p[1] for p in g]
        bx0, bx1 = min(gxs), max(gxs)
        by0, by1 = min(gys), max(gys)
        if bx1 - bx0 >= MENTION_MIN_WIDTH:
            bboxes.append([bx0, by0, bx1, by1])
    bboxes.sort()
    merged = []
    for bb in bboxes:
        if merged and bb[0] <= merged[-1][2] + 20 and abs(bb[1] - merged[-1][1]) <= 5:
            merged[-1][2] = max(merged[-1][2], bb[2])
            merged[-1][3] = max(merged[-1][3], bb[3])
        else:
            merged.append(list(bb))
    return merged

# ── main ─────────────────────────────────────────────────────────────────────

def build_spec(img_path):
    img = Image.open(img_path).convert("RGB")
    arr = np.array(img)
    H, W = arr.shape[:2]
    regions = []

    post_rows = find_avatar_rows(arr, AVATAR_X_MIN, AVATAR_X_MAX)
    post_author = None
    for (cy, y0, y1) in post_rows:
        if cy > 120:
            break
        cx = (AVATAR_X_MIN + AVATAR_X_MAX) // 2
        r = max((y1 - y0) // 2, 18)
        nb = find_name_bbox(arr, cx, r, y0, y1)
        if nb is None:
            nb = [cx + r + 5, y0 + 2, cx + r + 200, y0 + 20]
        label = "Post author — add label"
        post_author = {"type": "header", "label": label,
                       "avatar": [cx, cy, r], "name_bbox": nb}
        regions.append(post_author)
        break

    comment_rows = [row for row in find_avatar_rows(arr, AVATAR_X_MIN, AVATAR_X_MAX)
                    if row[0] > 120]
    nested_rows = find_avatar_rows(arr, NESTED_X_MIN, NESTED_X_MAX)

    all_header_rows = []
    for (cy, y0, y1) in comment_rows:
        all_header_rows.append((cy, y0, y1, AVATAR_X_MIN, AVATAR_X_MAX, "comment"))
    for (cy, y0, y1) in nested_rows:
        dupe = any(abs(cy - oc[0]) < 20 for oc in comment_rows)
        if not dupe:
            all_header_rows.append((cy, y0, y1, NESTED_X_MIN, NESTED_X_MAX, "nested"))

    all_header_rows.sort(key=lambda x: x[0])

    header_ys = []
    for i, (cy, y0, y1, xmin, xmax, kind) in enumerate(all_header_rows):
        cx = (xmin + xmax) // 2
        r = max((y1 - y0) // 2, 18)
        nb = find_name_bbox(arr, cx, r, y0, y1)
        if nb is None:
            nb = [cx + r + 5, y0 + 2, cx + r + 200, y0 + 20]
        n = i + (2 if post_author else 1)
        label = f"Person {n} — add label"
        regions.append({"type": "header", "label": label,
                        "avatar": [cx, cy, r], "name_bbox": nb})
        header_ys.append((y0, y1, cx, r))

    all_header_top_ys = [hy[0] for hy in header_ys]
    for i, (hy0, hy1, hcx, _) in enumerate(header_ys):
        body_start = hy1 + 5
        body_end = (all_header_top_ys[i + 1] if i + 1 < len(header_ys) else H)
        if body_end - body_start < 5:
            continue
        mentions = find_mentions(arr, body_start, body_end, x_start=hcx - 10)
        for j, bbox in enumerate(mentions):
            regions.append({
                "type": "mention",
                "label": f"@mention {j+1} under Person — add label",
                "bbox": bbox
            })

    return {
        "color": "#1F3E3E",
        "radius": 12,
        "mention_radius": 8,
        "pad": 4,
        "regions": regions
    }


def main():
    if len(sys.argv) != 3:
        print("Usage: build_spec.py <input.png> <output_spec.json>", file=sys.stderr)
        return 1
    img_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    spec = build_spec(img_path)
    with out_path.open("w") as f:
        json.dump(spec, f, indent=2)
    n_headers = sum(1 for r in spec["regions"] if r["type"] == "header")
    n_mentions = sum(1 for r in spec["regions"] if r["type"] == "mention")
    print(f"Found {n_headers} header(s) and {n_mentions} @mention(s) → {out_path}")
    for r in spec["regions"]:
        if r["type"] == "header":
            print(f"  header: avatar={r['avatar']}, name_bbox={r['name_bbox']}, label={r['label']}")
        else:
            print(f"  mention: bbox={r['bbox']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

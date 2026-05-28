#!/usr/bin/env python3
"""
Render redaction blocks on a Skool screenshot from a JSON spec.

Usage:
    python3 render_redactions.py <input-image> <output-image> <spec.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def draw_rounded(draw, bbox, fill, radius):
    draw.rounded_rectangle(bbox, radius=radius, fill=fill)


def render(img_path, out_path, spec):
    img = Image.open(img_path).convert("RGB")
    W, H = img.size
    draw = ImageDraw.Draw(img)

    color = hex_to_rgb(spec.get("color", "#1F3E3E"))
    radius = int(spec.get("radius", 12))
    mention_radius = int(spec.get("mention_radius", 8))
    pad = int(spec.get("pad", 3))

    counts = {"header": 0, "mention": 0, "custom": 0}

    for region in spec.get("regions", []):
        rtype = region.get("type")
        if rtype == "header":
            cx, cy, r = region["avatar"]
            a_box = [
                clamp(cx - r - pad, 0, W), clamp(cy - r - pad, 0, H),
                clamp(cx + r + pad, 0, W), clamp(cy + r + pad, 0, H),
            ]
            draw_rounded(draw, a_box, color, radius)
            x0, y0, x1, y1 = region["name_bbox"]
            n_box = [
                clamp(x0 - pad, 0, W), clamp(y0 - pad, 0, H),
                clamp(x1 + pad, 0, W), clamp(y1 + pad, 0, H),
            ]
            draw_rounded(draw, n_box, color, radius)
            counts["header"] += 1
        elif rtype == "mention":
            x0, y0, x1, y1 = region["bbox"]
            box = [
                clamp(x0 - pad, 0, W), clamp(y0 - pad, 0, H),
                clamp(x1 + pad, 0, W), clamp(y1 + pad, 0, H),
            ]
            r = int(region.get("radius", mention_radius))
            draw_rounded(draw, box, color, r)
            counts["mention"] += 1
        elif rtype == "custom":
            x0, y0, x1, y1 = region["bbox"]
            box = [
                clamp(x0 - pad, 0, W), clamp(y0 - pad, 0, H),
                clamp(x1 + pad, 0, W), clamp(y1 + pad, 0, H),
            ]
            r = int(region.get("radius", radius))
            draw_rounded(draw, box, color, r)
            counts["custom"] += 1
        else:
            print(f"warn: unknown region type {rtype!r}", file=sys.stderr)

    img.save(out_path)
    return counts


def main():
    if len(sys.argv) != 4:
        print("Usage: render_redactions.py <input> <output> <spec.json>", file=sys.stderr)
        return 1
    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    spec_path = Path(sys.argv[3])
    with spec_path.open() as f:
        spec = json.load(f)
    counts = render(in_path, out_path, spec)
    print(
        f"Drew {counts['header']} header block(s), "
        f"{counts['mention']} @mention block(s), "
        f"{counts['custom']} custom block(s) -> {out_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

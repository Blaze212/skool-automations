#!/usr/bin/env python3
"""
Build a layered SVG from a Skool redaction spec.
Each teal block becomes a named <rect> — open in Affinity Designer or
Inkscape and every rect appears as a named, editable object.

Usage:
    python3 build_svg.py <input.png> <spec.json> <output.svg>
"""
import json, sys, base64, io
from pathlib import Path
from PIL import Image


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def build_svg(img_path, spec, out_path):
    img = Image.open(img_path).convert("RGB")
    W, H = img.size

    color  = spec.get("color", "#1F3E3E")
    radius = int(spec.get("radius", 12))
    m_rad  = int(spec.get("mention_radius", 8))
    pad    = int(spec.get("pad", 4))

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    data_uri = f"data:image/png;base64,{b64}"

    rects = []
    for region in spec.get("regions", []):
        rtype = region.get("type")
        label = region.get("label", rtype)

        if rtype == "header":
            cx, cy, r = region["avatar"]
            ax0 = clamp(cx - r - pad, 0, W)
            ay0 = clamp(cy - r - pad, 0, H)
            ax1 = clamp(cx + r + pad, 0, W)
            ay1 = clamp(cy + r + pad, 0, H)
            safe = label.replace(' ', '_').replace('(','').replace(')','').replace('@','')
            rects.append({
                "id": f"avatar__{safe}",
                "x": ax0, "y": ay0, "w": ax1 - ax0, "h": ay1 - ay0,
                "rx": radius, "fill": color, "label": f"Avatar – {label}"
            })
            x0, y0, x1, y1 = region["name_bbox"]
            nx0 = clamp(x0 - pad, 0, W); ny0 = clamp(y0 - pad, 0, H)
            nx1 = clamp(x1 + pad, 0, W); ny1 = clamp(y1 + pad, 0, H)
            rects.append({
                "id": f"name__{safe}",
                "x": nx0, "y": ny0, "w": nx1 - nx0, "h": ny1 - ny0,
                "rx": radius, "fill": color, "label": f"Name – {label}"
            })

        elif rtype in ("mention", "custom"):
            x0, y0, x1, y1 = region["bbox"]
            rx = int(region.get("radius", m_rad if rtype == "mention" else radius))
            bx0 = clamp(x0 - pad, 0, W); by0 = clamp(y0 - pad, 0, H)
            bx1 = clamp(x1 + pad, 0, W); by1 = clamp(y1 + pad, 0, H)
            safe = label.replace(' ', '_').replace('(','').replace(')','').replace('@','')
            rects.append({
                "id": f"{rtype}__{safe}",
                "x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0,
                "rx": rx, "fill": color, "label": label
            })

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
        f'     width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'  <image id="screenshot" x="0" y="0" width="{W}" height="{H}"',
        f'         href="{data_uri}" />',
    ]
    for rect in rects:
        safe_label = rect["label"].replace('"', '&quot;')
        lines.append(
            f'  <rect id="{rect["id"]}" inkscape:label="{safe_label}"'
            f' x="{rect["x"]}" y="{rect["y"]}"'
            f' width="{rect["w"]}" height="{rect["h"]}"'
            f' rx="{rect["rx"]}" ry="{rect["rx"]}"'
            f' fill="{rect["fill"]}" />'
        )
    lines.append('</svg>')

    out_path.write_text('\n'.join(lines), encoding='utf-8')
    print(f"SVG written: {out_path}  ({len(rects)} redaction rects)")


def main():
    if len(sys.argv) != 4:
        print("Usage: build_svg.py <input.png> <spec.json> <output.svg>", file=sys.stderr)
        return 1
    img_path  = Path(sys.argv[1])
    spec_path = Path(sys.argv[2])
    out_path  = Path(sys.argv[3])
    with spec_path.open() as f:
        spec = json.load(f)
    build_svg(img_path, spec, out_path)
    return 0

if __name__ == "__main__":
    sys.exit(main())

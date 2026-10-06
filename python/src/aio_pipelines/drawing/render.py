"""The drawing as a plan image (for tracing) and as GeoJSON vector layers in lon/lat."""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .dxf import Entity
from .place import Placement, local_to_lonlat

MAX_PX = 4096
MIN_PX = 512
PX_PER_M = 20.0  # 5 cm per pixel, up to MAX_PX on the long side
LINE_RGBA = (236, 236, 236, 255)
CIRCLE_SEGMENTS = 72

# AutoCAD colour index 1 to 9, lightened where needed for a dark map
ACI = {
    1: "#ff5c5c",
    2: "#ffe45c",
    3: "#5cff7a",
    4: "#5cf0ff",
    5: "#6b8cff",
    6: "#ff6bf0",
    7: "#e8e8e8",
    8: "#9a9a9a",
    9: "#c8c8c8",
}
PALETTE = ["#7fd1ff", "#ffcf6b", "#9cf29c", "#ff9c9c", "#d1a8ff", "#8cf0e0", "#f2b38c", "#e0e0e0"]


def drawing_bounds(entities: list[Entity]) -> tuple[float, float, float, float]:
    b = np.array([e.bounds() for e in entities], dtype=np.float64)
    return float(b[:, 0].min()), float(b[:, 1].min()), float(b[:, 2].max()), float(b[:, 3].max())


def _font(px: int):
    try:
        return ImageFont.load_default(size=max(8, px))
    except Exception:  # Pillow without FreeType
        return ImageFont.load_default()


def render_plan(
    entities: list[Entity], place: Placement, out: Path
) -> tuple[dict[str, list[float]], tuple[int, int]]:
    """Write the plan PNG; return its corners (local frame) and its size in pixels."""
    x0, y0, x1, y1 = drawing_bounds(entities)
    w, h = max(x1 - x0, 1e-9), max(y1 - y0, 1e-9)
    pad = 0.02 * max(w, h)
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    w, h = x1 - x0, y1 - y0
    long_m = max(w, h) * place.metres_per_unit
    long_px = int(min(MAX_PX, max(MIN_PX, math.ceil(long_m * PX_PER_M))))
    k = long_px / max(w, h)  # pixels per drawing unit
    W, H = max(1, round(w * k)), max(1, round(h * k))
    # the image covers exactly W x H pixels: move the right and bottom edges to match
    x1, y0 = x0 + W / k, y1 - H / k
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    lw = max(2, round(long_px / 1500))

    def px(pts) -> list[tuple[float, float]]:
        return [((x - x0) * k, (y1 - y) * k) for x, y in pts]

    for e in entities:
        if e.center is not None and e.radius is not None:
            (cx, cy), r = px([e.center])[0], e.radius * k
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=LINE_RGBA, width=lw)
        elif e.type in ("TEXT", "MTEXT") and e.text:
            bx0, by0, bx1, by1 = e.bounds()
            (ax, ay), (bx, by) = px([(bx0, by1), (bx1, by0)])
            draw.rectangle([ax, ay, max(ax + 1, bx), max(ay + 1, by)], outline=LINE_RGBA, width=1)
            size = int((e.height or 0) * k)
            if size >= 8:
                draw.multiline_text((ax, ay), e.text, fill=LINE_RGBA, font=_font(size))
        elif e.type == "POINT":
            (cx, cy) = px(e.points)[0]
            draw.ellipse([cx - lw, cy - lw, cx + lw, cy + lw], fill=LINE_RGBA)
        elif len(e.points) >= 2:
            pts = px(e.points)
            if e.closed:
                pts = [*pts, pts[0]]
            draw.line(pts, fill=LINE_RGBA, width=lw, joint="curve")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    c = place.apply(np.array([(x0, y1), (x1, y1), (x0, y0)]))
    y = place.base_y + 0.02
    corners = {
        "tl": [round(float(c[0, 0]), 4), round(y, 4), round(float(c[0, 1]), 4)],
        "tr": [round(float(c[1, 0]), 4), round(y, 4), round(float(c[1, 1]), 4)],
        "bl": [round(float(c[2, 0]), 4), round(y, 4), round(float(c[2, 1]), 4)],
    }
    return corners, (W, H)


def slug(s: str, fallback: str = "layer") -> str:
    out = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return out[:60].strip("-") or fallback


def layer_colour(name: str, entities: list[Entity]) -> str:
    for e in entities:
        if e.color in ACI:
            return ACI[e.color]
    return PALETTE[sum(name.encode("utf-8")) % len(PALETTE)]


def _geometry(e: Entity) -> tuple[str, list[np.ndarray]] | None:
    """GeoJSON type and drawing-unit coordinate arrays (rings closed) of an entity."""
    if e.center is not None and e.radius is not None:
        a = np.linspace(0, 2 * math.pi, CIRCLE_SEGMENTS + 1)
        ring = np.column_stack([e.center[0] + e.radius * np.cos(a), e.center[1] + e.radius * np.sin(a)])
        ring[-1] = ring[0]
        return "Polygon", [ring]
    pts = np.array(e.points, dtype=np.float64)
    if e.type in ("TEXT", "MTEXT", "POINT"):
        return "Point", [pts[:1]]
    if e.closed and len(pts) >= 3:
        if not np.allclose(pts[0], pts[-1]):
            pts = np.vstack([pts, pts[:1]])
        return "Polygon", [pts]
    if len(pts) >= 2:
        return "LineString", [pts]
    return None


def geojson_layers(
    entities: list[Entity], place: Placement, origin: list[float], epsg: int
) -> dict[str, dict[str, Any]]:
    """One FeatureCollection per DXF layer, in lon/lat (WGS84)."""
    by_layer: dict[str, list[Entity]] = {}
    for e in entities:
        by_layer.setdefault(e.layer, []).append(e)
    out: dict[str, dict[str, Any]] = {}
    for layer, ents in sorted(by_layer.items()):
        geoms = [(e, _geometry(e)) for e in ents]
        geoms = [(e, g) for e, g in geoms if g is not None]
        allpts = np.vstack([a for _, g in geoms for a in g[1]]) if geoms else np.zeros((0, 2))
        ll = local_to_lonlat(place.apply(allpts), origin, epsg)
        i = 0
        feats = []
        for e, (gtype, arrays) in geoms:
            coords = []
            for a in arrays:
                c = [[round(float(lon), 9), round(float(lat), 9)] for lon, lat in ll[i : i + len(a)]]
                i += len(a)
                coords.append(c)
            if gtype == "Point":
                geometry = {"type": "Point", "coordinates": coords[0][0]}
            elif gtype == "LineString":
                geometry = {"type": "LineString", "coordinates": coords[0]}
            else:
                geometry = {"type": "Polygon", "coordinates": coords}
            props: dict[str, Any] = {"layer": e.layer, "handle": e.id, "type": e.type}
            if e.text is not None:
                props["text"] = e.text
            feats.append({"type": "Feature", "geometry": geometry, "properties": props})
        out[layer] = {"type": "FeatureCollection", "features": feats}
    return out

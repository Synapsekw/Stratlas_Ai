"""Associate equipment schedules, labelled footprints and mounting pipes in DXF drawings.

Only geometry and numeric/text associations are read. Drawing notes are evidence, not commands.
Views are discovered from their shaft circles and nearby labelled equipment, never sheet windows.
Unsupported or ambiguous rows remain unresolved rather than becoming invented equipment.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import ezdxf
import numpy as np
from scipy.optimize import linear_sum_assignment


@dataclass
class DrawingDevice:
    label: str
    kind: str
    centre_en: tuple[float, float]
    size: tuple[float, float, float]
    azimuth_deg: float
    bottom: float
    parent: str | None
    handle: str


@dataclass
class DrawingPipe:
    label: str
    centre_en: tuple[float, float]
    radius: float
    handle: str


@dataclass
class DrawingInventory:
    devices: list[DrawingDevice] = field(default_factory=list)
    pipes: list[DrawingPipe] = field(default_factory=list)
    platforms: list[list[list[float]]] = field(default_factory=list)
    levels: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _kind(layer: str) -> str | None:
    s = layer.upper()
    if s.startswith(("ANT-", "ANTENNA", "PANEL")):
        return "panel"
    if s in ("RRU", "RADIO", "RRH"):
        return "rru"
    if s in ("BOX", "EQUIPMENT-BOX"):
        return "equipment-box"
    return None


def read_drawing(path: Path) -> DrawingInventory:
    doc = ezdxf.readfile(path)
    m = doc.modelspace()
    result = DrawingInventory()
    texts = []
    for e in m:
        if e.dxftype() not in ("MTEXT", "TEXT"):
            continue
        text = e.plain_text() if e.dxftype() == "MTEXT" else e.dxf.text
        direction = e.get_text_direction() if e.dxftype() == "MTEXT" else None
        angle = math.atan2(direction.y, direction.x) if direction else math.radians(e.dxf.rotation)
        texts.append(
            {
                "text": text.strip(),
                "point": np.array(tuple(e.dxf.insert)[:2]),
                "angle": angle,
                "layer": e.dxf.layer,
                "height": e.dxf.char_height if e.dxftype() == "MTEXT" else e.dxf.height,
            }
        )
    if not texts:
        result.warnings.append("Drawing has no readable equipment labels or schedule.")
        return result
    # Normalize a moved/rotated sheet using its text baseline. This does not rotate the survey.
    candidates = [t for t in texts if t["layer"].upper() == "TABLE"] or texts
    angle = Counter(round(t["angle"], 5) for t in candidates).most_common(1)[0][0]
    right = np.array([math.cos(angle), math.sin(angle)])
    up = np.array([-math.sin(angle), math.cos(angle)])
    basis = np.column_stack([right, up])
    unit = ezdxf.units.conversion_factor(doc.units, ezdxf.units.M) if doc.units else 1.0

    def xy(p):
        return np.asarray(tuple(p))[:2] @ basis * unit

    for t in texts:
        t["point"] = xy(t["point"])
        t["height"] *= unit

    # A schedule row is aligned to its ID/TYPE/BOTTOM/TOP header, wherever it sits on the sheet.
    tables = [t for t in texts if t["layer"].upper() == "TABLE"] or texts
    schedules = []
    for label in tables:
        if label["text"].upper() != "ID":
            continue
        tol = max(label["height"] * 0.4, 1e-5)
        head = sorted(
            [t for t in tables if abs(t["point"][1] - label["point"][1]) < tol], key=lambda t: t["point"][0]
        )
        titles = [t["text"].upper().replace(" ", "") for t in head]
        if not {"ID", "TYPE", "BOTTOM", "TOP"}.issubset(titles):
            continue
        spacing = min(np.diff([t["point"][0] for t in head])) if len(head) > 1 else 1
        for id_text in tables:
            if not re.fullmatch(r"[A-Za-z]+\d+", id_text["text"]):
                continue
            if (
                abs(id_text["point"][0] - label["point"][0]) > tol
                or id_text["point"][1] >= label["point"][1] - tol
            ):
                continue
            row = [t for t in tables if abs(t["point"][1] - id_text["point"][1]) < tol]
            fields = {}
            for h, title in zip(head, titles, strict=True):
                near = min(row, key=lambda t: abs(t["point"][0] - h["point"][0]))
                if abs(near["point"][0] - h["point"][0]) < spacing * 0.45:
                    fields[title] = near["text"]
            try:
                kind = _kind(fields["TYPE"])
                dim = next(v for k, v in fields.items() if k.startswith("WXDXH"))
                w, depth, height = [float(v) for v in re.split(r"[xX×]", dim)]
                bottom, top = float(fields["BOTTOM"]), float(fields["TOP"])
                if kind and min(w, depth, height, top - bottom) > 0:
                    schedules.append(
                        {
                            "label": id_text["text"],
                            "kind": kind,
                            "size": (w, top - bottom, depth),
                            "bottom": bottom,
                            "pipe": fields.get("PIPE"),
                        }
                    )
            except (KeyError, ValueError, StopIteration):
                result.warnings.append(f"Schedule row {id_text['text']} has incomplete dimensions or levels.")
    schedules = list({s["label"]: s for s in schedules}.values())
    if not schedules:
        result.warnings.append("No supported equipment schedule was associated with this drawing.")
        return result

    polys = []
    for e in m.query("LWPOLYLINE"):
        p = np.array([xy(v) for v in e.get_points("xy")])
        if len(p) >= 3:
            polys.append(
                {
                    "points": p,
                    "centre": p.mean(axis=0),
                    "kind": _kind(e.dxf.layer),
                    "layer": e.dxf.layer,
                    "handle": e.dxf.handle,
                }
            )
    rects = [p for p in polys if p["kind"] and len(p["points"]) == 4]
    circles = [
        {
            "centre": xy(e.dxf.center),
            "radius": e.dxf.radius * unit,
            "layer": e.dxf.layer,
            "handle": e.dxf.handle,
        }
        for e in m.query("CIRCLE")
    ]
    shafts = [c for c in circles if c["layer"].upper() in ("TOWER", "MONOPOLE", "SHAFT")]
    if not shafts or not rects:
        result.warnings.append(
            "No labelled plan view with a shaft centre and equipment footprints was found."
        )
        return result
    shaft = max(
        shafts,
        key=lambda c: sum(
            np.linalg.norm(p["centre"] - c["centre"]) < max(4, 12 * c["radius"]) for p in rects
        ),
    )
    centre = shaft["centre"]
    reach = max(4, 12 * shaft["radius"])
    rects = [p for p in rects if np.linalg.norm(p["centre"] - centre) < reach]
    labels = [
        t
        for t in texts
        if t["layer"].upper() != "TABLE" and np.linalg.norm(t["point"] - centre) < reach * 1.5
    ]
    lines = [
        (xy(e.dxf.start), xy(e.dxf.end))
        for e in m.query("LINE")
        if e.dxf.layer.upper() in ("SECTOR", "LEADER", "ANNO")
    ]
    labels_by_id = {}
    for t in labels:
        hit = re.match(r"^([A-Za-z]+\d+)\b", t["text"])
        if hit:
            labels_by_id.setdefault(hit[1], []).append(t)
    # Unique assignment protects close radios from being matched to the same footprint.
    cost = np.full((len(schedules), len(rects)), 1e6)
    for i, s in enumerate(schedules):
        for j, p in enumerate(rects):
            if s["kind"] != p["kind"]:
                continue
            for t in labels_by_id.get(s["label"], []):
                dist = np.linalg.norm(t["point"] - p["centre"])
                for a, b in lines:
                    # A leader touches the footprint at one end and runs towards the text.
                    for start, end in [(a, b), (b, a)]:
                        if np.linalg.norm(start - p["centre"]) < max(
                            s["size"][0], s["size"][2]
                        ) * 0.8 and np.linalg.norm(end - t["point"]) < max(t["height"] * 5, 0.3):
                            dist = min(dist, np.linalg.norm(start - p["centre"]) * 0.2)
                width = np.linalg.norm(p["points"][1] - p["points"][0])
                cost[i, j] = min(cost[i, j], dist + abs(width - s["size"][0]) * 2)
    rows, cols = linear_sum_assignment(cost)
    found = set()
    for i, j in zip(rows, cols, strict=True):
        s, p = schedules[i], rects[j]
        if cost[i, j] > max(s["size"][0] * 1.5, 0.8):
            continue
        front = (p["points"][0] + p["points"][1]) / 2 - p["centre"]
        az = math.degrees(math.atan2(front[0], front[1])) % 360
        if abs(az - 360) < 0.001:
            az = 0.0
        result.devices.append(
            DrawingDevice(
                s["label"],
                s["kind"],
                tuple(p["centre"] - centre),
                s["size"],
                az,
                s["bottom"],
                s["pipe"],
                p["handle"],
            )
        )
        found.add(s["label"])
    result.warnings += [
        f"No unambiguous plan footprint for {s['label']}." for s in schedules if s["label"] not in found
    ]
    pipes = [
        c for c in circles if c["layer"].upper() == "PIPE" and np.linalg.norm(c["centre"] - centre) < reach
    ]
    used = set()
    for c in pipes:
        names = [t for t in labels if re.fullmatch(r"P\d+", t["text"]) and t["text"] not in used]
        if not names:
            continue
        t = min(names, key=lambda t: np.linalg.norm(t["point"] - c["centre"]))
        if np.linalg.norm(t["point"] - c["centre"]) > max(c["radius"] * 6, 0.3):
            continue
        used.add(t["text"])
        result.pipes.append(DrawingPipe(t["text"], tuple(c["centre"] - centre), c["radius"], c["handle"]))
    result.platforms = [
        (p["points"] - centre).tolist()
        for p in polys
        if p["layer"].upper() == "PLATFORM" and np.linalg.norm(p["centre"] - centre) < reach
    ]
    for t in texts:
        match = re.fullmatch(
            r"(LOWER PLATFORM|UPPER PLATFORM|BOTTOM OF MOUNT PIPES|TOP OF MOUNT PIPES)\s*\+?([\d.]+)",
            t["text"],
            re.I,
        )
        if match:
            result.levels[match[1].lower()] = float(match[2])
    return result

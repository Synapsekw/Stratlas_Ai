"""CSV points: PNEZD, PENZD, NEZ (with or without codes), in grid coordinates or WGS84 degrees.

- A UTF-8 byte order mark is dropped; text that is not UTF-8 is read as Windows-1252.
- The separator is the comma, semicolon or tab of the first row, else white space. A row with a
  different column count that holds another separator is refused as **mixed separators** at its
  line. With a semicolon or tab separator a decimal comma (``123,45``) is read as a decimal point.
- A first row whose coordinate columns are not numbers is a **header**: its names place the columns
  (point, name, id; northing, north, n, y; easting, east, e, x; elevation, elev, height, z, rl;
  description, desc, code, feature; latitude, lat; longitude, lon, long). Without a header the
  order is PNEZD (or PNEZ), NEZ for three numbers and NEZD for three numbers and a code; PENZD needs
  a header naming the columns.
- Latitude and longitude columns give WGS84 points (``crs`` EPSG 4326, heights as written); a
  latitude outside -90..90 is refused with a hint that the columns may be swapped.
"""

from __future__ import annotations

import csv
import io
import math
import re
from pathlib import Path

from .model import MAX_POINTS, Design, Point, Points, refuse

SEPARATORS = (",", ";", "\t")
NAMES = {
    "P": {"point", "pt", "pnt", "name", "id", "p", "number", "no", "pointnumber", "pointname"},
    "N": {"northing", "north", "n", "y"},
    "E": {"easting", "east", "e", "x"},
    "Z": {"elevation", "elev", "height", "z", "rl", "h", "level"},
    "D": {"description", "desc", "code", "feature", "d", "featurecode"},
    "LAT": {"latitude", "lat"},
    "LON": {"longitude", "lon", "long", "lng"},
}
_DEC_COMMA = re.compile(r"^-?\d+,\d+$")


def _num(cell: str, decimal_comma: bool) -> float | None:
    s = cell.strip()
    if decimal_comma and _DEC_COMMA.match(s):
        s = s.replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _role(name: str) -> str | None:
    key = re.sub(r"[^a-z]", "", name.lower())
    for role, names in NAMES.items():
        if key in names:
            return role
    return None


def read_csv_points(path: Path) -> Design:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    rows = [(no, line) for no, line in enumerate(io.StringIO(text), start=1)]
    rows = [
        (no, line.rstrip("\r\n")) for no, line in rows if line.strip() and not line.lstrip().startswith("#")
    ]
    if not rows:
        raise refuse(path, None, "the file has no rows.")
    first_no, first = rows[0]
    present = [s for s in SEPARATORS if s in first]
    if len(present) > 1 and not (present == [",", ";"] or present == [",", "\t"]):
        raise refuse(
            path, f"line {first_no}", "the row mixes separators (" + " and ".join(map(repr, present)) + ")."
        )
    if present == [",", ";"]:
        sep = ";"
    elif present == [",", "\t"]:
        sep = "\t"
    else:
        sep = present[0] if present else None
    decimal_comma = sep in (";", "\t")

    def split(line: str) -> list[str]:
        if sep is None:
            return line.split()
        return next(csv.reader([line], delimiter=sep))

    cols = split(first)
    width = len(cols)
    numeric = [_num(c, decimal_comma) is not None for c in cols]
    order: dict[str, int] = {}
    start = 0
    if not any(numeric[1:]) or (width >= 3 and sum(numeric) < 2):
        # a header row
        for i, c in enumerate(cols):
            role = _role(c)
            if role and role not in order:
                order[role] = i
        start = 1
        geo = "LAT" in order and "LON" in order
        if not geo and not ("N" in order and "E" in order):
            raise refuse(
                path,
                f"line {first_no}",
                "the header names no northing and easting (or latitude and longitude) columns: "
                + ", ".join(c.strip() for c in cols)
                + ".",
            )
    else:
        geo = False
        if width == 3:
            order = {"N": 0, "E": 1, "Z": 2}
        elif width == 4 and not numeric[3]:
            order = {"N": 0, "E": 1, "Z": 2, "D": 3}
        elif width >= 4:
            order = {"P": 0, "N": 1, "E": 2, "Z": 3}
            if width >= 5:
                order["D"] = 4
        else:
            raise refuse(
                path, f"line {first_no}", f"the row has {width} columns; points need at least N, E and Z."
            )
    ycol, xcol = (order["LAT"], order["LON"]) if geo else (order["N"], order["E"])
    zcol = order.get("Z")
    pts = Points(path.stem)
    for no, line in rows[start:]:
        cells = split(line)
        if len(cells) != width and sep is not None:
            others = [s for s in SEPARATORS if s != sep and s in line and not (s == "," and decimal_comma)]
            if others:
                raise refuse(
                    path,
                    f"line {no}",
                    f"the row uses {others[0]!r} but the file separates columns with {sep!r} (mixed separators).",
                )
        need = max(ycol, xcol, zcol if zcol is not None else 0)
        if len(cells) <= need:
            raise refuse(
                path, f"line {no}", f"the row has {len(cells)} columns, the file's first row has {width}."
            )
        y, x = _num(cells[ycol], decimal_comma), _num(cells[xcol], decimal_comma)
        z = _num(cells[zcol], decimal_comma) if zcol is not None else 0.0
        for v, what, cell in (
            (y, "latitude" if geo else "northing", cells[ycol]),
            (x, "longitude" if geo else "easting", cells[xcol]),
        ):
            if v is None:
                raise refuse(path, f"line {no}", f'the {what} "{cell.strip()[:40]}" is not a number.')
        if z is None:
            raise refuse(path, f"line {no}", f'the elevation "{cells[zcol].strip()[:40]}" is not a number.')  # type: ignore[index]
        assert y is not None and x is not None
        if geo and (abs(y) > 90 or abs(x) > 180):
            raise refuse(
                path,
                f"line {no}",
                f"the latitude {y} or longitude {x} is out of range; the latitude and longitude columns may "
                "be swapped, or the file holds grid coordinates under latitude and longitude names.",
            )
        if len(pts.points) >= MAX_POINTS:
            raise refuse(path, f"line {no}", f"the file has more than {MAX_POINTS:,} points.")
        pid = (
            cells[order["P"]].strip()
            if "P" in order and order["P"] < len(cells)
            else str(len(pts.points) + 1)
        )
        code = cells[order["D"]].strip() if "D" in order and order["D"] < len(cells) else ""
        pts.points.append(Point(pid or str(len(pts.points) + 1), x, y, z, code or None))
    if not pts.points:
        raise refuse(path, None, "the file has a header but no points.")
    d = Design("csv", points=[pts], source_layers=[pts.name])
    if geo:
        d.crs = {"epsg": 4326}
    return d

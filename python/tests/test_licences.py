"""The pack ships to customers: permissive licences only (M10 decision 1, 7 Oct 2026).

No GPL or AGPL code in it (no Ultralytics/YOLO). MPL-2.0 and LGPL distributions only when named in
``tools/release/licence-exceptions.json`` (certifi today; GEOS ships as a shared library inside the
shapely and rasterio wheels, which stream G1's native gate checks file by file).
"""

import json
import re
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

from packaging.requirements import Requirement

COPYLEFT = re.compile(r"\bA?GPL\b|GNU (Affero )?General Public", re.I)
LESSER = re.compile(r"LGPL|Lesser General Public", re.I)
MPL = re.compile(r"\bMPL\b|Mozilla Public License", re.I)
EXCEPTIONS = Path(__file__).resolve().parents[2] / "tools" / "release" / "licence-exceptions.json"


def runtime_distributions():
    seen: dict[str, object] = {}
    todo = ["aio-pipelines"]
    while todo:
        name = todo.pop()
        key = name.lower().replace("_", "-")
        if key in seen:
            continue
        try:
            dist = distribution(name)
        except PackageNotFoundError:
            continue
        seen[key] = dist
        for req in dist.requires or []:
            r = Requirement(req)
            if r.marker and not r.marker.evaluate({"extra": ""}):
                continue
            todo.append(r.name)
    return seen


def licence_text(dist) -> str:
    meta = dist.metadata
    parts = [meta.get("License-Expression") or "", (meta.get("License") or "")[:400]]
    parts += [c for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    return " | ".join(parts)


def named(kind: str) -> set[str]:
    doc = json.loads(EXCEPTIONS.read_text("utf-8"))
    return {e["name"] for e in doc[kind] if e["ecosystem"] == "python"}


def test_runtime_dependencies_are_not_copyleft():
    dists = runtime_distributions()
    assert "numpy" in dists and "rasterio" in dists
    assert "ultralytics" not in dists
    bad = {}
    for name, dist in dists.items():
        text = licence_text(dist)
        if COPYLEFT.search(LESSER.sub("", text)):
            bad[name] = text
    assert bad == {}


def test_mpl_and_lgpl_only_by_name():
    dists = runtime_distributions()
    mpl, lgpl = named("mpl"), named("lgplShared")
    unlisted = {}
    for name, dist in dists.items():
        text = licence_text(dist)
        if MPL.search(text) and name not in mpl:
            unlisted[name] = text
        if LESSER.search(text) and name not in lgpl:
            unlisted[name] = text
    assert unlisted == {}
    assert "certifi" in mpl

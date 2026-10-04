"""The pack ships to customers: no GPL or AGPL code in it (no Ultralytics/YOLO)."""

import re
from importlib.metadata import PackageNotFoundError, distribution

from packaging.requirements import Requirement

COPYLEFT = re.compile(r"\bA?GPL\b|GNU (Affero )?General Public", re.I)
LESSER = re.compile(r"LGPL|Lesser General Public", re.I)


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

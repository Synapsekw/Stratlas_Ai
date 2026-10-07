"""The pack ships to customers: permissive licences only (M10 decision 1, 7 Oct 2026).

Every runtime distribution of ``aio-pipelines`` must be on the allow-list of
``tools/release/licence-exceptions.json`` (the same file the npm and native gates read): its
``License-Expression`` first, else a short ``License`` field, else its classifiers. MPL-2.0 and LGPL
only for distributions named there; a licence that cannot be classified fails unless an
``elections`` entry states the licence we take it under. Extras are never installed (pyopf's
``tools`` extra pulls GPL plyfile). Native libraries inside the wheels are checked file by file by
``tools/release/native-licences.mjs`` (G1).

When the pack's own native wheels are installed (CI's ``pipelines`` job installs the ``pack-native``
artifact), pycolmap must be our CPU build without CHOLMOD and OpenCV must have no FFmpeg backend:
the PyPI wheels of both bundle GPL code.
"""

import json
import re
import tomllib
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

import pytest
from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[2]
EXCEPTIONS = ROOT / "tools" / "release" / "licence-exceptions.json"
PYPROJECT = ROOT / "python" / "pyproject.toml"

COPYLEFT = re.compile(r"\bA?GPL\b|GNU (Affero )?General Public", re.I)
LESSER = re.compile(r"LGPL|Lesser General Public", re.I)
MPL = re.compile(r"\bMPL\b|Mozilla Public License", re.I)

LICENSE_NAMES = {
    "the mit license (mit)": "MIT",
    "mit license": "MIT",
    "bsd 3-clause": "BSD-3-Clause",
    "bsd-3-clause license": "BSD-3-Clause",
    "new bsd license": "BSD-3-Clause",
    "apache 2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "psf license": "PSF-2.0",
}
CLASSIFIERS = {
    "mit license": "MIT",
    "bsd license": "BSD-3-Clause",
    "apache software license": "Apache-2.0",
    "python software foundation license": "PSF-2.0",
    "isc license (iscl)": "ISC",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "the unlicense (unlicense)": "Unlicense",
    "zlib/libpng license": "Zlib",
    "boost software license 1.0 (bsl-1.0)": "BSL-1.0",
}
SPDX_LIKE = re.compile(r"^[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$")
# Distributions that must never be in the pack, whatever pulls them in.
TRAPS = {"ultralytics", "plyfile", "pymeshlab", "fpdf2", "opencv-python", "open3d", "py3dtiles"}


def policy() -> dict:
    return json.loads(EXCEPTIONS.read_text("utf-8"))


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


def licence_expression(dist) -> str | None:
    """One SPDX expression for a distribution, or None when its metadata does not say."""
    meta = dist.metadata
    if meta.get("License-Expression"):
        return meta["License-Expression"].strip()
    first = (meta.get("License") or "").strip().split("\n")[0].strip()
    if first.lower() in LICENSE_NAMES:
        return LICENSE_NAMES[first.lower()]
    if first and len(first) <= 60 and SPDX_LIKE.match(first) and re.search(r"\d|^MIT$|^ISC$", first):
        return first
    ids = []
    for c in meta.get_all("Classifier") or []:
        if c.startswith("License ::"):
            spdx = CLASSIFIERS.get(c.split("::")[-1].strip().lower())
            if spdx and spdx not in ids:
                ids.append(spdx)
    return " OR ".join(ids) if ids else None


def named(doc: dict, kind: str) -> set[str]:
    return {e["name"] for e in doc.get(kind, []) if e["ecosystem"] == "python"}


def judge(expr: str, name: str, doc: dict) -> bool:
    """True when `expr` is allowed for distribution `name`: OR needs one option, AND needs all."""
    allowed = set(doc["allowed"]["spdx"])
    mpl, lgpl = named(doc, "mpl"), named(doc, "lgplShared")

    def term(t: str) -> bool:
        t = t.strip("() ")
        if " WITH " in t:
            return False
        return (
            t in allowed or (t.startswith("MPL-") and name in mpl) or (t.startswith("LGPL-") and name in lgpl)
        )

    flat = expr.replace("(", " ").replace(")", " ")
    return any(all(term(p) for p in re.split(r"\s+AND\s+", alt)) for alt in re.split(r"\s+OR\s+", flat))


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


def test_every_runtime_licence_is_classified_and_on_the_allow_list():
    doc = policy()
    elected = {e["name"]: e["elected"] for e in doc.get("elections", []) if e["ecosystem"] == "python"}
    problems = {}
    for name, dist in runtime_distributions().items():
        if name == "aio-pipelines":
            continue
        expr = elected.get(name) or licence_expression(dist)
        if expr is None:
            problems[name] = f"cannot classify: {licence_text(dist)[:120]}"
        elif not judge(expr, name, doc):
            problems[name] = expr
    assert problems == {}


def test_mpl_and_lgpl_only_by_name():
    doc = policy()
    mpl, lgpl = named(doc, "mpl"), named(doc, "lgplShared")
    unlisted = {}
    for name, dist in runtime_distributions().items():
        text = licence_text(dist)
        if MPL.search(text) and name not in mpl:
            unlisted[name] = text
        if LESSER.search(text) and name not in lgpl:
            unlisted[name] = text
    assert unlisted == {}
    assert "certifi" in mpl


def test_classifies_metadata_like_the_native_gate():
    class Dist:
        def __init__(self, **meta):
            self.metadata = _Meta(meta)

    class _Meta(dict):
        def get_all(self, key):
            return self.get(key)

    assert licence_expression(Dist(**{"License-Expression": "MIT"})) == "MIT"
    assert licence_expression(Dist(License="The MIT License (MIT)")) == "MIT"
    assert licence_expression(
        Dist(License="BSD 3-Clause", Classifier=["License :: OSI Approved :: BSD License"])
    ) == ("BSD-3-Clause")
    assert licence_expression(
        Dist(License="Files: *", Classifier=["License :: OSI Approved :: BSD License"])
    ) == ("BSD-3-Clause")
    assert licence_expression(Dist(License="see LICENSE.txt")) is None
    doc = policy()
    assert judge("BSD-3-Clause OR GPL-2.0-only", "x", doc)
    assert not judge("MIT AND GPL-3.0-only", "x", doc)
    assert judge("MPL-2.0", "certifi", doc)
    assert not judge("MPL-2.0", "somethingelse", doc)


def test_no_extras_and_no_known_traps():
    deps = tomllib.loads(PYPROJECT.read_text("utf-8"))["project"]["dependencies"]
    with_extras = [d for d in deps if Requirement(d).extras]
    assert with_extras == [], "the pack never installs extras (pyopf[tools] pulls GPL plyfile)"
    installed = set(runtime_distributions())
    assert installed & TRAPS == set()


def test_pycolmap_is_our_cpu_build_without_cholmod():
    pycolmap = pytest.importorskip("pycolmap")
    assert not pycolmap.has_cuda
    assert "without GPU support" in pycolmap.COLMAP_build
    # The PyPI wheels bundle GPL CHOLMOD and SPQR; only our build (tools/pipeline-pack/native) says this.
    assert "without CHOLMOD" in pycolmap.COLMAP_build


def test_opencv_has_no_ffmpeg_or_nonfree_code():
    cv2 = pytest.importorskip("cv2")
    info = cv2.getBuildInformation()
    video = info.split("Video I/O:", 1)[1].split("\n\n", 1)[0] if "Video I/O:" in info else ""
    backends = [line.strip() for line in video.splitlines() if "YES" in line]
    assert not [b for b in backends if b.startswith(("FFMPEG", "GStreamer"))], backends
    nonfree = re.search(r"Non-free algorithms:\s*(\w+)", info)
    assert nonfree is None or nonfree.group(1) == "NO"

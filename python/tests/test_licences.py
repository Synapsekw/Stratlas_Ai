"""Licence report of the pack's Python distributions; it never fails (founder decision of 8 Oct 2026).

Since that decision (ADR 0008, amended) the pipeline pack takes prebuilt wheels with their GPL parts
(pycolmap bundles CHOLMOD and SPQR, pymeshlab is GPL-3.0) and every licence check is a report. This
file still classifies every runtime distribution of ``aio-pipelines`` against
``tools/release/licence-exceptions.json`` (the file the npm and native reports read; ``copyleft``
accepts the GPL family for ``python``) and prints what it finds as warnings: copyleft
distributions, licences it cannot classify and anything outside the policy. The classification
itself is still tested, because ``tools/release/notices.mjs`` lists the same licences in
``THIRD-PARTY-NOTICES.md``.
"""

import json
import re
import warnings
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[2]
EXCEPTIONS = ROOT / "tools" / "release" / "licence-exceptions.json"

COPYLEFT = re.compile(r"\bA?GPL\b|GNU (Affero )?General Public", re.I)
# SPDX ids of the copyleft families the founder accepted for the pack on 8 Oct 2026
COPYLEFT_ID = re.compile(r"^(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CECILL|CPL)-", re.I)
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
    "gpl3": "GPL-3.0-only",
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
    """True when `expr` is allowed for distribution `name`: OR needs one option, AND needs all.
    The copyleft families count when ``copyleft`` accepts them for ``python``."""
    allowed = set(doc["allowed"]["spdx"])
    mpl, lgpl = named(doc, "mpl"), named(doc, "lgplShared")
    copyleft = "python" in (doc.get("copyleft") or {}).get("ecosystems", [])

    def term(t: str) -> bool:
        t = t.strip("() ")
        if copyleft and COPYLEFT_ID.match(t):
            return True
        if " WITH " in t:
            return False
        return (
            t in allowed or (t.startswith("MPL-") and name in mpl) or (t.startswith("LGPL-") and name in lgpl)
        )

    flat = expr.replace("(", " ").replace(")", " ")
    return any(all(term(p) for p in re.split(r"\s+AND\s+", alt)) for alt in re.split(r"\s+OR\s+", flat))


def report() -> dict[str, dict[str, str]]:
    """Notes on the runtime distributions: copyleft ones, unclassified ones, and ones outside the
    policy."""
    doc = policy()
    elected = {e["name"]: e["elected"] for e in doc.get("elections", []) if e["ecosystem"] == "python"}
    notes: dict[str, dict[str, str]] = {"copyleft": {}, "unclassified": {}, "outside policy": {}}
    for name, dist in runtime_distributions().items():
        if name == "aio-pipelines":
            continue
        text = licence_text(dist)
        expr = elected.get(name) or licence_expression(dist)
        if COPYLEFT.search(LESSER.sub("", text)) or (expr and COPYLEFT_ID.search(expr)):
            notes["copyleft"][name] = expr or text[:120]
        if expr is None:
            notes["unclassified"][name] = text[:120]
        elif not judge(expr, name, doc):
            notes["outside policy"][name] = expr
    return notes


def test_the_licence_report_runs_and_never_fails():
    dists = runtime_distributions()
    assert "numpy" in dists and "rasterio" in dists
    notes = report()
    for kind, found in notes.items():
        for name, what in sorted(found.items()):
            warnings.warn(f"licence report ({kind}): {name}: {what}", stacklevel=1)


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
    assert judge("MPL-2.0", "certifi", doc)
    # since 8 Oct 2026 the copyleft families are accepted in the pack
    assert judge("MIT AND GPL-3.0-only", "x", doc)
    assert judge("GPL-3.0", "pymeshlab", doc)
    strict = {**doc, "copyleft": {"ecosystems": []}}
    assert not judge("MIT AND GPL-3.0-only", "x", strict)
    assert not judge("MPL-2.0", "somethingelse", strict)
    assert not judge("LicenseRef-NonCommercial", "x", doc)

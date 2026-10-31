"""Few-shot example crops for the yes/no check of ``detect.vlm`` (roadmap V2, the learning loop).

The app picks a detector's examples when a run starts (its curated ``examples`` first, then crops
from the local review ledger: accepted ones as "is", rejected ones as "is not") and sends them as
absolute files on the detector item: ``examples: [{"file", "verdict"}]``. This module checks that
list, loads the crops once per run, and builds the check message: the "yes" crops, the "no" crops,
then the crop to judge and the question. The examples come first, so the model server's prompt
cache can keep them across the checks of a run.

The set is small and bounded: at most ``MAX_PER_VERDICT`` per verdict, each scaled down to
``EXAMPLE_MAX`` pixels. The order is the app's, "is" before "is not", so the same params always
give the same prompt. A crop that cannot be read is left out with a warning; the run goes on.
"""

from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from PIL import Image

from ..runtime import JobError

Verdict = Literal["is", "is-not"]
VERDICTS: tuple[Verdict, ...] = ("is", "is-not")
#: At most this many crops per verdict (vision 3.3: 2 to 4 crops in all).
MAX_PER_VERDICT = 2
#: The longest side an example crop is sent at, in pixels; smaller crops are never enlarged.
EXAMPLE_MAX = 448
#: A ledger crop is 512 px; anything past this is not a crop.
MAX_EXAMPLE_BYTES = 4 * 1024 * 1024
JPEG_QUALITY = 90
ABSOLUTE = re.compile(r"^([A-Za-z]:[\\/]|/|\\\\)")

YES_INTRO = "Examples of crops where the answer is yes:"
NO_INTRO = "Examples of crops where the answer is no:"
QUERY_INTRO = "Now the crop to judge, from a drone inspection photo:"
QUESTION = "{question} Answer yes or no."


@dataclass(frozen=True)
class Example:
    """One loaded example crop: its verdict and the JPEG bytes sent to the model."""

    verdict: Verdict
    jpeg: bytes


def validate_examples(value: Any) -> list[dict[str, str]]:
    """The ``examples`` of a detector item, checked: a list of ``{file, verdict}`` with an absolute
    file and a verdict of ``is`` or ``is-not``, at most ``MAX_PER_VERDICT`` of each."""
    if not isinstance(value, list):
        raise JobError("A detector's examples must be a list.")
    out: list[dict[str, str]] = []
    for e in value:
        if not isinstance(e, dict) or set(e) != {"file", "verdict"}:
            raise JobError("Each example must be {file, verdict}.")
        if e["verdict"] not in VERDICTS:
            raise JobError("An example's verdict must be is or is-not.")
        f = e["file"]
        if not isinstance(f, str) or not 1 <= len(f) <= 1024 or not ABSOLUTE.match(f):
            raise JobError("An example's file must be an absolute path.")
        out.append({"file": f, "verdict": e["verdict"]})
    for v in VERDICTS:
        if sum(e["verdict"] == v for e in out) > MAX_PER_VERDICT:
            raise JobError(f"A detector takes at most {MAX_PER_VERDICT} {v} examples.")
    return out


def _load(path: Path) -> bytes:
    if path.stat().st_size > MAX_EXAMPLE_BYTES:
        raise ValueError("too large for a crop")
    with Image.open(path) as im:
        im.load()
        img = im.convert("RGB")
    img.thumbnail((EXAMPLE_MAX, EXAMPLE_MAX))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def load_examples(entries: list[dict[str, str]]) -> tuple[list[Example], list[str]]:
    """The examples that could be read, "is" before "is not" (each in the given order), and a
    warning for each one left out."""
    shots: list[Example] = []
    warnings: list[str] = []
    for verdict in VERDICTS:
        for e in entries:
            if e["verdict"] != verdict:
                continue
            path = Path(e["file"])
            try:
                shots.append(Example(verdict, _load(path)))
            except (OSError, ValueError, Image.DecompressionBombError) as err:
                reason = "missing" if isinstance(err, FileNotFoundError) else "unreadable"
                warnings.append(f"example crop {path.name} is {reason}; left out")
    return shots, warnings


def _image(jpeg: bytes) -> dict[str, Any]:
    return {
        "type": "image_url",
        "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()},
    }


def _text(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def check_parts(shots: list[Example], crop_jpeg: bytes, question: str) -> list[dict[str, Any]]:
    """The content of one check message: each verdict's crops under its own line (a verdict with
    none is left out), then the crop to judge and the question."""
    parts: list[dict[str, Any]] = []
    for verdict, intro in (("is", YES_INTRO), ("is-not", NO_INTRO)):
        mine = [s for s in shots if s.verdict == verdict]
        if mine:
            parts.append(_text(intro))
            parts.extend(_image(s.jpeg) for s in mine)
    parts.append(_text(QUERY_INTRO))
    parts.append(_image(crop_jpeg))
    parts.append(_text(QUESTION.format(question=question)))
    return parts


def summary(shots: list[Example]) -> str:
    """``"2 is, 1 is not"``: what a run shows the model."""
    n_is = sum(s.verdict == "is" for s in shots)
    return f"{n_is} is, {len(shots) - n_is} is not"

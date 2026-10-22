"""The vlm detector engine: tile, detect, merge, check.

Talks to a llama.cpp ``llama-server`` (OpenAI-compatible ``/v1/chat/completions``) running a
Qwen2.5-VL model. For one photo and one detector (``aio.vlm-detector/1``, camelCase keys) it:

1. splits the photo into an ``n x n`` grid of overlapping tiles,
2. resizes each tile to the send size so the model's pixel frame equals ours and asks for boxes,
3. maps the boxes back to source pixels and merges duplicates from the overlap,
4. crops each box and asks a yes/no question, scoring it as P(yes) / (P(yes) + P(no)).

Every candidate is kept; thresholding is the caller's business.
"""

from __future__ import annotations

import base64
import io
import json
import math
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from PIL import Image

if TYPE_CHECKING:
    from collections.abc import Sequence

TILES_DEFAULT = {"n": 2, "overlap": 0.2, "sendW": 1344, "sendH": 1008}
MIN_BOX_PX = 8
MERGE_SHARE = 0.6
CROP_PAD = 0.15
CROP_MAX = 896
JPEG_QUALITY = 92
DETECT_TIMEOUT_S = 120
CHECK_TIMEOUT_S = 60

DETECT = (
    "You are a detector for drone inspection photos. Find: {looksLike}\n"
    "Do NOT report: {ignore}\n"
    "Give each area its own tight box. Output JSON only: "
    '[{{"bbox_2d": [x1, y1, x2, y2], "label": "{classId}", "note": "<what and where, max 10 words>"}}]. '
    "Output [] if there is none."
)
CHECK = "This is a crop from a drone inspection photo. {question} Answer yes or no."

FRACTIONS_WARNING = "model answered in fractions"

Box = tuple[float, float, float, float]

# The server is on loopback: never let HTTP_PROXY or a system proxy carry a photo elsewhere.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


@dataclass
class Candidate:
    """One detected area. ``box`` is (x1, y1, x2, y2) in source pixels."""

    box: Box
    note: str
    score: float | None = None  # None = unscored


@dataclass
class PhotoResult:
    """Everything one detector found on one photo."""

    candidates: list[Candidate]
    warnings: list[str] = field(default_factory=list)
    failed: bool = False  # every tile call failed


class VlmError(Exception):
    """The server answered, but not usefully (HTTP error, timeout, malformed reply)."""


class VlmUnavailable(Exception):
    """The server cannot be reached (connection refused or reset)."""


class VlmClient:
    """Minimal client for llama-server's chat completions endpoint."""

    # ``timeout`` is only the fallback: the engine passes DETECT_TIMEOUT_S / CHECK_TIMEOUT_S per call.
    def __init__(self, url: str, api_key: str | None = None, timeout: float = 300.0):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def chat(
        self,
        jpeg: bytes,
        text: str,
        *,
        logprobs: bool = False,
        max_tokens: int = 1024,
        timeout: float | None = None,
    ) -> tuple[str, list[dict] | None]:
        """Send one image then one text part. Returns the reply text and, with ``logprobs``, the
        top logprobs of the first token as a list of ``{token, logprob}``. ``timeout`` (seconds) overrides
        the client's default for this call."""
        image_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        body: dict = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": image_url}},
                        {"type": "text", "text": text},
                    ],
                }
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        if logprobs:
            body["logprobs"] = True
            body["top_logprobs"] = 10
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            self.url + "/v1/chat/completions", data=json.dumps(body).encode(), headers=headers
        )
        try:
            with _OPENER.open(req, timeout=self.timeout if timeout is None else timeout) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            raise VlmError(f"server answered HTTP {e.code}") from e
        except urllib.error.URLError as e:
            if isinstance(e.reason, ConnectionError):
                raise VlmUnavailable(str(e.reason)) from e
            raise VlmError(str(e.reason)) from e
        except ConnectionError as e:
            raise VlmUnavailable(str(e)) from e
        except (TimeoutError, OSError, ValueError) as e:
            raise VlmError(str(e)) from e
        try:
            choice = data["choices"][0]
            reply = choice["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as e:
            raise VlmError("malformed reply") from e
        top = None
        if logprobs:
            try:
                top = choice["logprobs"]["content"][0]["top_logprobs"]
            except (KeyError, IndexError, TypeError):
                top = None
        return reply, top


def tile_grid(w: int, h: int, n: int, overlap: float) -> list[tuple[int, int, int, int]]:
    """An ``n x n`` grid of tiles covering a ``w x h`` image, as (x, y, tw, th), row by row."""
    if n <= 1:
        return [(0, 0, w, h)]
    span = n - (n - 1) * overlap
    tw, th = int(w / span), int(h / span)
    return [
        (round(c * (w - tw) / (n - 1)), round(r * (h - th) / (n - 1)), tw, th)
        for r in range(n)
        for c in range(n)
    ]


def detect_prompt(det: dict) -> str:
    """The fixed detect template filled from the detector; no "Do NOT report" line without ``ignore``."""
    text = DETECT.format(looksLike=det["looksLike"], ignore=det.get("ignore", ""), classId=det["classId"])
    if not det.get("ignore"):
        text = "".join(line for line in text.splitlines(keepends=True) if not line.startswith("Do NOT"))
    return text


def check_prompt(det: dict) -> str:
    """The fixed yes/no template filled with the detector's question."""
    return CHECK.format(question=det["question"])


def parse_boxes(text: str) -> list[tuple[list[float], str]] | None:
    """Boxes and notes from a model reply (bare or fenced JSON). None if there is no JSON list."""
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    body = m.group(1) if m else text
    start, end = body.find("["), body.rfind("]")
    if start < 0 or end < start:
        return None
    try:
        got = json.loads(body[start : end + 1])
    except ValueError:
        return None
    if not isinstance(got, list):
        return None
    out: list[tuple[list[float], str]] = []
    for d in got:
        if not isinstance(d, dict):
            continue
        b = d.get("bbox_2d")
        if not isinstance(b, list) or len(b) != 4:
            continue
        try:
            box = [float(v) for v in b]
        except (TypeError, ValueError):
            continue
        # json reads NaN and Infinity; one in a pass file makes the whole pass unreadable
        if all(math.isfinite(v) for v in box):
            out.append((box, str(d.get("note", ""))))
    return out


def _area(b: Sequence[float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inter(a: Sequence[float], b: Sequence[float]) -> float:
    return _area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def merge(cands: list[Candidate], share: float = MERGE_SHARE) -> list[Candidate]:
    """Largest first; drop a box whose overlap with a kept box is at least ``share`` of the smaller."""
    kept: list[Candidate] = []
    for c in sorted(cands, key=lambda c: -_area(c.box)):
        if all(_inter(c.box, k.box) / max(1e-9, min(_area(c.box), _area(k.box))) < share for k in kept):
            kept.append(c)
    return kept


def score_from_top(top: list[dict]) -> float | None:
    """P(yes) / (P(yes) + P(no)), each summed over case variants (spaces trimmed). None if neither."""
    yes = no = 0.0
    for t in top:
        token = str(t.get("token", "")).strip().lower()
        if token == "yes":
            yes += math.exp(t["logprob"])
        elif token == "no":
            no += math.exp(t["logprob"])
    return yes / (yes + no) if yes + no > 0 else None


def _jpeg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def _detect_tile(client: VlmClient, jpeg: bytes, prompt: str) -> list[tuple[list[float], str]] | None:
    """Ask once, retry once. None if both replies were unusable. VlmUnavailable propagates."""
    for _ in range(2):
        try:
            text, _top = client.chat(jpeg, prompt, timeout=DETECT_TIMEOUT_S)
        except VlmError:
            continue
        got = parse_boxes(text)
        if got is not None:
            return got
    return None


def _check(client: VlmClient, src: Image.Image, box: Box, prompt: str) -> float | None:
    x1, y1, x2, y2 = box
    px, py = (x2 - x1) * CROP_PAD, (y2 - y1) * CROP_PAD
    crop = src.crop(
        (
            int(max(0, x1 - px)),
            int(max(0, y1 - py)),
            math.ceil(min(src.width, x2 + px)),
            math.ceil(min(src.height, y2 + py)),
        )
    )
    crop.thumbnail((CROP_MAX, CROP_MAX))
    try:
        _text, top = client.chat(_jpeg(crop), prompt, logprobs=True, max_tokens=1, timeout=CHECK_TIMEOUT_S)
    except VlmError:
        return None
    return score_from_top(top) if top else None


def run_detector(client: VlmClient, image: Image.Image, det: dict) -> PhotoResult:
    """Run one detector over one photo. Raises VlmUnavailable if the server cannot be reached."""
    tiles_cfg = {**TILES_DEFAULT, **(det.get("tiles") or {})}
    send_w, send_h = int(tiles_cfg["sendW"]), int(tiles_cfg["sendH"])
    prompt = detect_prompt(det)
    warnings: list[str] = []
    found: list[Candidate] = []
    tiles = tile_grid(image.width, image.height, int(tiles_cfg["n"]), float(tiles_cfg["overlap"]))
    failed_tiles = 0
    fractions = False

    for x, y, tw, th in tiles:
        region = image.crop((x, y, x + tw, y + th)).resize((send_w, send_h), Image.LANCZOS)
        got = _detect_tile(client, _jpeg(region), prompt)
        if got is None:
            failed_tiles += 1
            warnings.append(f"tile at ({x}, {y}): reply could not be read")
            continue
        # Fractions of the frame instead of pixels: every value of every box is at most 1.
        tile_fractions = bool(got) and all(v <= 1.0 for b, _ in got for v in b)
        fractions = fractions or tile_fractions
        sx, sy = tw / send_w, th / send_h
        for raw, note in got:
            if tile_fractions:
                raw = [raw[0] * send_w, raw[1] * send_h, raw[2] * send_w, raw[3] * send_h]
            x1, x2 = sorted((raw[0], raw[2]))
            y1, y2 = sorted((raw[1], raw[3]))
            x1, x2 = min(max(x1, 0.0), send_w), min(max(x2, 0.0), send_w)
            y1, y2 = min(max(y1, 0.0), send_h), min(max(y2, 0.0), send_h)
            if x2 <= x1 or y2 <= y1:
                warnings.append(f"tile at ({x}, {y}): a box outside the frame was dropped")
                continue
            box = (x + x1 * sx, y + y1 * sy, x + x2 * sx, y + y2 * sy)
            if box[2] - box[0] < MIN_BOX_PX or box[3] - box[1] < MIN_BOX_PX:
                continue
            found.append(Candidate(box=box, note=note))

    if fractions:
        warnings.append(FRACTIONS_WARNING)
    cands = merge(found)
    check = check_prompt(det)
    for c in cands:
        c.score = _check(client, image, c.box, check)
    return PhotoResult(candidates=cands, warnings=warnings, failed=failed_tiles == len(tiles))

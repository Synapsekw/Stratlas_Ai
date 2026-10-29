"""The vlm detector engine: tile, detect, merge, check.

Talks to a llama.cpp ``llama-server`` (OpenAI-compatible ``/v1/chat/completions``) running a
Qwen2.5-VL model (boxes in sent pixels) or a Qwen3 model (Qwen3.5, Qwen3-VL: boxes in a 0 to 1000
frame of the sent image); ``box_frame`` picks the frame from the model id. For one photo and one detector (``aio.vlm-detector/1``, camelCase keys) it:

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
from typing import TYPE_CHECKING, Literal

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
REPAIRED_WARNING = "reply repaired"

BoxFrame = Literal["pixels", "rel1000"]

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


def box_frame(model_id: str) -> BoxFrame:
    """The frame a model answers ``bbox_2d`` in: 0 to 1000 of the sent image for the Qwen3 family
    (an id that starts ``qwen3``, ``qwen3.5`` and the like: ``qwen3.5-...``, ``qwen3-vl-...``),
    sent pixels for everything else (Qwen2.5-VL). The app's ``localVlmModel`` uses the same rule
    (``QWEN3_FAMILY``) and both test suites check the same ids."""
    return "rel1000" if QWEN3_FAMILY.match(model_id) else "pixels"


#: An id of the Qwen3 family: ``qwen3`` (``qwen-3``, ``qwen_3``), an optional ``.N`` minor, then
#: the end or anything but a digit or a dot. ``qwen30-x`` and ``my-qwen3-...`` are not.
QWEN3_FAMILY = re.compile(r"^qwen[-_ ]?3(?:\.\d+)?(?![\d.])", re.IGNORECASE)


def _try_list(text: str) -> list | None:
    try:
        got = json.loads(text)
    except ValueError:
        return None
    return got if isinstance(got, list) else None


def _read_list(text: str) -> tuple[list | None, bool]:
    """The JSON list in a reply, and whether it needed repair. Repairs: a ``}}`` before ``]`` or ``,``
    becomes ``}``; a trailing ``}}`` becomes ``}]``; a cut-off list is cut back to its last complete object."""
    t = re.sub(r"<think>[\s\S]*?</think>", "", text)
    m = re.search(r"```(?:json)?\s*([\s\S]*?)(?:```|$)", t)
    body = m.group(1) if m else t
    start = body.find("[")
    if start < 0:
        return None, False
    end = body.rfind("]")
    if end > start:
        got = _try_list(body[start : end + 1])
        if got is not None:
            return got, False
    s = body[start:]
    for fixed in (
        re.sub(r"\}\s*\}(\s*[\],])", r"}\1", s),
        re.sub(r"\}\s*\}\s*$", "}]", s.rstrip().rstrip("`").rstrip()),
    ):
        close = fixed.rfind("]")
        got = _try_list(fixed[: close + 1]) if close > 0 else None
        if got is not None:
            return got, True
    cut = s.rfind("}")
    while cut > 0:
        got = _try_list(s[: cut + 1] + "]")
        if got is not None:
            return got, True
        cut = s.rfind("}", 0, cut)
    return None, False


def parse_boxes_ex(text: str) -> tuple[list[tuple[list[float], str]] | None, bool]:
    """Boxes and notes from a model reply (bare or fenced JSON, ``<think>`` blocks ignored) and whether
    the reply needed repair. The list is None if there is no JSON list."""
    got, repaired = _read_list(text)
    if got is None:
        return None, False
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
    return out, repaired


def parse_boxes(text: str) -> list[tuple[list[float], str]] | None:
    """``parse_boxes_ex`` without the repair flag."""
    return parse_boxes_ex(text)[0]


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


def _detect_tile(
    client: VlmClient, jpeg: bytes, prompt: str
) -> tuple[list[tuple[list[float], str]], bool] | None:
    """Ask once, retry once. The boxes and whether the reply was repaired; None if both replies were
    unusable. VlmUnavailable propagates."""
    for _ in range(2):
        try:
            text, _top = client.chat(jpeg, prompt, timeout=DETECT_TIMEOUT_S)
        except VlmError:
            continue
        got, repaired = parse_boxes_ex(text)
        if got is not None:
            return got, repaired
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


def run_detector(client: VlmClient, image: Image.Image, det: dict, frame: BoxFrame = "pixels") -> PhotoResult:
    """Run one detector over one photo. Raises VlmUnavailable if the server cannot be reached.
    ``frame`` is the model's box frame (see ``box_frame``): ``rel1000`` boxes are scaled to the send size."""
    tiles_cfg = {**TILES_DEFAULT, **(det.get("tiles") or {})}
    send_w, send_h = int(tiles_cfg["sendW"]), int(tiles_cfg["sendH"])
    prompt = detect_prompt(det)
    warnings: list[str] = []
    found: list[Candidate] = []
    tiles = tile_grid(image.width, image.height, int(tiles_cfg["n"]), float(tiles_cfg["overlap"]))
    failed_tiles = 0
    fractions = False
    repaired_any = False

    for x, y, tw, th in tiles:
        region = image.crop((x, y, x + tw, y + th)).resize((send_w, send_h), Image.LANCZOS)
        tile_reply = _detect_tile(client, _jpeg(region), prompt)
        if tile_reply is None:
            failed_tiles += 1
            warnings.append(f"tile at ({x}, {y}): reply could not be read")
            continue
        got, repaired = tile_reply
        repaired_any = repaired_any or repaired
        # Fractions of the frame instead of pixels: every value of every box is at most 1.
        tile_fractions = frame == "pixels" and bool(got) and all(v <= 1.0 for b, _ in got for v in b)
        fractions = fractions or tile_fractions
        sx, sy = tw / send_w, th / send_h
        for raw, note in got:
            if frame == "rel1000":
                raw = [
                    raw[0] * send_w / 1000,
                    raw[1] * send_h / 1000,
                    raw[2] * send_w / 1000,
                    raw[3] * send_h / 1000,
                ]
            elif tile_fractions:
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
    if repaired_any:
        warnings.append(REPAIRED_WARNING)
    cands = merge(found)
    check = check_prompt(det)
    for c in cands:
        c.score = _check(client, image, c.box, check)
    return PhotoResult(candidates=cands, warnings=warnings, failed=failed_tiles == len(tiles))

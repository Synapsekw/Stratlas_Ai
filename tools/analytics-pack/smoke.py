"""Smoke check for the Analytics pack runtime: llama-server plus the pinned Qwen model on this machine.

Starts the server with the pack's arguments and the per-launch key in the environment
(`LLAMA_API_KEY`, never on the command line, as the app does), then checks that a request without
the key is refused with HTTP 401, that boxes come back in the pixel frame of the sent image and
that yes/no logprobs score as the detector engine expects. Prints SMOKE OK or the failing check,
and always stops the server.

    python tools/analytics-pack/smoke.py --server <llama-server.exe> --model <gguf> --mmproj <gguf> \
        [--model-id qwen3.5-9b-q4_k_m]
"""

import argparse
import base64
import io
import json
import math
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw

SIZE = (1344, 1008)
SQUARE = (900, 300, 1100, 500)
CORNER_TOLERANCE_PX = 40
REL1000_TOLERANCE = 30  # 3 % of the 0 to 1000 frame
DEFAULT_MODEL_ID = "qwen3.5-9b-q4_k_m"
BOX_PROMPT = 'Locate the red square. Output JSON [{"bbox_2d":[x1,y1,x2,y2]}]'
BOX_RE = re.compile(
    r"\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]"
)


def frame_for(model_id: str) -> str:
    """The frame a model answers boxes in: Qwen3 family in 0 to 1000, Qwen2.5-VL in sent pixels."""
    return "pixels" if model_id.startswith("qwen2.5") else "rel1000"


def is_qwen3(model_id: str) -> bool:
    return model_id.startswith("qwen3")


def tolerance_px(frame: str) -> float:
    return REL1000_TOLERANCE if frame == "rel1000" else CORNER_TOLERANCE_PX


def expected_box(frame: str) -> list[float]:
    """The red square in the model's frame."""
    if frame == "rel1000":
        x1, y1, x2, y2 = SQUARE
        w, h = SIZE
        return [x1 / w * 1000, y1 / h * 1000, x2 / w * 1000, y2 / h * 1000]
    return [float(v) for v in SQUARE]


def box_off(box: list[float], frame: str) -> float:
    """Worst corner distance from the red square, in the units of the frame."""
    return max(abs(a - b) for a, b in zip(box, expected_box(frame)))


HEALTH_TIMEOUT_S = 120


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def image_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


API_KEY = secrets.token_hex(16)


def server_args(
    server: str, model: str, mmproj: str, port: int, model_id: str = ""
) -> list[str]:
    """The pack's llama-server arguments. The key is not among them: see server_env."""
    args = [
        server,
        "--model",
        model,
        "--mmproj",
        mmproj,
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--ctx-size",
        "8192",
        "-ngl",
        "99",
        "--parallel",
        "1",
        "--no-ui",
    ]
    if is_qwen3(model_id):
        # Qwen3.5 thinks by default; the detectors want the answer only.
        args += ["--reasoning", "off"]
    return args


def server_env(key: str) -> dict[str, str]:
    """The server's environment: this one plus the per-launch key, as the app passes it."""
    return {**os.environ, "LLAMA_API_KEY": key}


def check_key_required(base: str) -> str | None:
    """A chat request without the key must be refused with HTTP 401. Returns the failure or None.

    llama-server ignores a Bearer token when it has no key, so if the environment variable were
    ignored (or renamed in a later release) every other check would still pass.
    """
    req = urllib.request.Request(
        base + "/v1/chat/completions",
        data=json.dumps(
            {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    print(f"no key: HTTP {status}")
    if status != 401:
        return f"no key: expected HTTP 401 without the key, got {status}; LLAMA_API_KEY was not applied"
    return None


def chat(base: str, img: Image.Image, text: str, **extra) -> dict:
    body = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url(img)}},
                    {"type": "text", "text": text},
                ],
            }
        ],
        "temperature": 0,
        **extra,
    }
    req = urllib.request.Request(
        base + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def p_yes(resp: dict) -> float:
    top = resp["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    yes = sum(
        math.exp(t["logprob"]) for t in top if t["token"].strip().lower() == "yes"
    )
    no = sum(math.exp(t["logprob"]) for t in top if t["token"].strip().lower() == "no")
    return yes / (yes + no) if yes + no > 0 else 0.0


def wait_healthy(base: str, proc: subprocess.Popen) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited with code {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as r:
                if json.load(r).get("status") == "ok":
                    return
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"server not healthy within {HEALTH_TIMEOUT_S} s")


def check_box(base: str, frame: str, square: Image.Image | None = None) -> str | None:
    """The red square must come back in the model's frame. Returns the failure or None."""
    if square is None:
        square = Image.new("RGB", SIZE, (128, 128, 128))
        ImageDraw.Draw(square).rectangle(SQUARE, fill=(220, 30, 30))
    extra = (
        {"chat_template_kwargs": {"enable_thinking": False}}
        if frame == "rel1000"
        else {}
    )
    t = time.monotonic()
    resp = chat(base, square, BOX_PROMPT, max_tokens=128, **extra)
    text = resp["choices"][0]["message"]["content"]
    m = BOX_RE.search(text)
    box = [float(v) for v in json.loads(m.group(0))] if m else None
    off = box_off(box, frame) if box else None
    print(
        f"{frame} frame: box={box} worst corner off={off} ({time.monotonic() - t:.1f} s)"
    )
    if box is None or off > tolerance_px(frame):
        return f"{frame} frame: expected about {[round(v) for v in expected_box(frame)]}, got {text!r}"
    return None


def run_checks(base: str, frame: str = "rel1000") -> list[str]:
    grey = Image.new("RGB", SIZE, (128, 128, 128))
    square = grey.copy()
    ImageDraw.Draw(square).rectangle(SQUARE, fill=(220, 30, 30))
    failures = []

    keyless = check_key_required(base)
    if keyless:
        failures.append(keyless)

    boxed = check_box(base, frame, square)
    if boxed:
        failures.append(boxed)

    ask = "Is there a red square in this image? Answer yes or no."
    lp = {"logprobs": True, "top_logprobs": 10, "max_tokens": 1}
    t = time.monotonic()
    r_sq = chat(base, square, ask, **lp)
    r_grey = chat(base, grey, ask, **lp)
    try:
        top = r_sq["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
        shape_ok = isinstance(top, list) and all(
            "token" in x and "logprob" in x for x in top
        )
    except (KeyError, IndexError, TypeError):
        shape_ok = False
    print(f"logprobs shape ok: {shape_ok}")
    if not shape_ok:
        failures.append(
            f"logprobs shape: {json.dumps(r_sq['choices'][0].get('logprobs'))[:300]}"
        )
    else:
        y_sq, y_grey = p_yes(r_sq), p_yes(r_grey)
        print(
            f"scores: P(yes) square={y_sq:.3f} grey={y_grey:.3f} ({time.monotonic() - t:.1f} s)"
        )
        if y_sq < 0.9:
            failures.append(f"scores: P(yes) on the square is {y_sq:.3f}, want >= 0.9")
        if y_grey > 0.1:
            failures.append(
                f"scores: P(yes) on plain grey is {y_grey:.3f}, want <= 0.1"
            )
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--mmproj", required=True)
    ap.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    a = ap.parse_args()

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    args = server_args(a.server, a.model, a.mmproj, port, a.model_id)
    with open("smoke-server.log", "w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            args, stdout=log, stderr=subprocess.STDOUT, env=server_env(API_KEY)
        )
        try:
            t = time.monotonic()
            wait_healthy(base, proc)
            print(f"server healthy in {time.monotonic() - t:.1f} s")
            failures = run_checks(base, frame_for(a.model_id))
        except Exception as e:  # noqa: BLE001 - the smoke check reports any failure as one line
            failures = [f"server: {e} (see smoke-server.log)"]
        finally:
            proc.kill()
            proc.wait()

    if failures:
        for f in failures:
            print("FAIL", f)
        return 1
    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

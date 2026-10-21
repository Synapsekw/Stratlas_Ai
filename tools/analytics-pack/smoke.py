"""Smoke check for the Analytics pack runtime: llama-server plus Qwen2.5-VL on this machine.

Starts the server with the pack's arguments and the per-launch key in the environment
(`LLAMA_API_KEY`, never on the command line, as the app does), then checks that a request without
the key is refused with HTTP 401, that boxes come back in the pixel frame of the sent image and
that yes/no logprobs score as the detector engine expects. Prints SMOKE OK or the failing check,
and always stops the server.

    python tools/analytics-pack/smoke.py --server <llama-server.exe> --model <gguf> --mmproj <gguf>
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


def server_args(server: str, model: str, mmproj: str, port: int) -> list[str]:
    """The pack's llama-server arguments. The key is not among them: see server_env."""
    return [
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


def run_checks(base: str) -> list[str]:
    grey = Image.new("RGB", SIZE, (128, 128, 128))
    square = grey.copy()
    ImageDraw.Draw(square).rectangle(SQUARE, fill=(220, 30, 30))
    failures = []

    keyless = check_key_required(base)
    if keyless:
        failures.append(keyless)

    t = time.monotonic()
    resp = chat(
        base,
        square,
        'Locate the red square. Output JSON [{"bbox_2d":[x1,y1,x2,y2]}]',
        max_tokens=128,
    )
    text = resp["choices"][0]["message"]["content"]
    m = re.search(
        r"\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]",
        text,
    )
    box = [float(v) for v in json.loads(m.group(0))] if m else None
    off = max(abs(a - b) for a, b in zip(box, SQUARE)) if box else None
    print(
        f"pixel frame: box={box} worst corner off={off} px ({time.monotonic() - t:.1f} s)"
    )
    if box is None or off > CORNER_TOLERANCE_PX:
        failures.append(f"pixel frame: expected about {list(SQUARE)}, got {text!r}")

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
    a = ap.parse_args()

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    args = server_args(a.server, a.model, a.mmproj, port)
    with open("smoke-server.log", "w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            args, stdout=log, stderr=subprocess.STDOUT, env=server_env(API_KEY)
        )
        try:
            t = time.monotonic()
            wait_healthy(base, proc)
            print(f"server healthy in {time.monotonic() - t:.1f} s")
            failures = run_checks(base)
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

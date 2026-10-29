"""Tests for smoke.py's key handling, against a stub server (the GPU run is done by hand)."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "analytics_smoke", Path(__file__).with_name("smoke.py")
)
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


def _stub(enforce_key: bool):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            ok = not enforce_key or self.headers.get("Authorization") == "Bearer k"
            self.send_response(200 if ok else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}" if ok else b'{"error":"Invalid API Key"}')

        def log_message(self, *_):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.mark.parametrize(
    ("enforce", "fails"), [(True, False), (False, True)], ids=["locked", "open"]
)
def test_check_key_required(enforce, fails):
    srv = _stub(enforce)
    try:
        failure = smoke.check_key_required(f"http://127.0.0.1:{srv.server_port}")
    finally:
        srv.shutdown()
    assert (failure is not None) == fails
    if fails:
        assert "401" in failure


def test_key_goes_in_the_environment_not_argv():
    args = smoke.server_args("srv.exe", "m.gguf", "mm.gguf", 1234)
    assert "--api-key" not in args
    assert smoke.API_KEY not in args
    assert "--no-ui" in args
    assert smoke.server_env("abc")["LLAMA_API_KEY"] == "abc"


def _box_stub(content: str):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"choices": [{"message": {"content": content}}]}).encode()
            )

        def log_message(self, *_):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_rel1000_box_check():
    """A Qwen3 model answers in 0 to 1000 of the image; the check compares in that frame."""
    srv = _box_stub('[{"bbox_2d":[670,298,818,496]}]')
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        ok = smoke.check_box(base, "rel1000")
        wrong_frame = smoke.check_box(base, "pixels")
    finally:
        srv.shutdown()
    assert ok is None
    assert wrong_frame is not None


def test_rel1000_box_off_scales_to_sent_pixels():
    assert smoke.box_off([670, 298, 818, 496], "rel1000") <= smoke.tolerance_px(
        "rel1000"
    )
    assert smoke.box_off([100, 100, 200, 200], "rel1000") > smoke.tolerance_px(
        "rel1000"
    )
    assert smoke.box_off([900, 300, 1100, 500], "pixels") <= smoke.tolerance_px(
        "pixels"
    )


def test_frame_and_server_args_follow_the_model():
    assert smoke.frame_for("qwen3.5-9b-q4_k_m") == "rel1000"
    assert smoke.frame_for("qwen2.5-vl-7b-instruct-q4_k_m") == "pixels"
    args = smoke.server_args("srv.exe", "m.gguf", "mm.gguf", 1, "qwen3.5-9b-q4_k_m")
    assert args[args.index("--reasoning") + 1] == "off"
    assert "--reasoning" not in smoke.server_args("srv.exe", "m.gguf", "mm.gguf", 1)

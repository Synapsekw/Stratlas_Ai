"""Tests for smoke.py's key handling, against a stub server (the GPU run is done by hand)."""

import importlib.util
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

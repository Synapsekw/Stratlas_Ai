"""A threaded fake of llama-server's /v1/chat/completions for the detector engine tests.

Bound to 127.0.0.1 on a free port. A handler receives the parsed request body and returns the
response JSON, or an int to answer with that HTTP status and no body.
"""

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

Handler = Callable[[dict], dict | int]


def text_response(text: str) -> dict:
    """A chat completion that answers with ``text``."""
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


def logprob_response(top: list[tuple[str, float]], text: str = "Yes") -> dict:
    """A one-token chat completion whose first token carries ``top`` as (token, logprob) pairs."""
    top_logprobs = [{"token": t, "logprob": lp} for t, lp in top]
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": text},
                "logprobs": {"content": [{"token": text, "top_logprobs": top_logprobs}]},
            }
        ]
    }


class FakeVlm:
    """Context manager running the fake server; ``requests`` and ``headers`` record what it saw."""

    def __init__(self, handler: Handler):
        self.handler = handler
        self.requests: list[dict] = []
        self.headers: list[dict[str, str]] = []
        self._lock = threading.Lock()
        outer = self

        class _Req(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with outer._lock:
                    outer.requests.append(body)
                    outer.headers.append(dict(self.headers.items()))
                    out = outer.handler(body)
                if isinstance(out, int):
                    self.send_response(out)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                data = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Req)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> "FakeVlm":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

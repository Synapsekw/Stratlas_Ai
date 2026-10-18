"""Run the shipping evidence pipeline against a private benchmark project (no fitted reference inputs).

Usage: python scripts/engineering_bench.py path/to/config.json
Config: {project, job, params}; the project is an ordinary imported project with manifest.json.
Private inputs and generated reports stay in that project; no network calls are made by this driver.
"""

import json
import sys
import threading
from pathlib import Path

from aio_pipelines.engineer.pipeline import ModelEvidence
from aio_pipelines.runtime import Job

config = json.loads(Path(sys.argv[1]).read_text("utf-8"))
project = Path(config["project"]).resolve()


def report(method, data):
    if method in ("progress", "log"):
        print(json.dumps({"event": method, **data}), flush=True)


result = Job(config["job"], ModelEvidence(), project, config["params"], report, threading.Event()).run()
print(
    json.dumps({"job": config["job"], "status": result.get("status"), "pack": result.get("pack")}), flush=True
)

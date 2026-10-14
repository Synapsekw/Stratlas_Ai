"""The alignment engine adapter, and its COLMAP implementation (pycolmap in a child process).

``photo.align`` talks to an ``SfmEngine``: ``features``, ``match`` (on the pairs the pipeline
chose) and ``map`` (global or incremental structure from motion), each returning plain results
and writing models as ``model.npz`` files (``photo/model.py``). The pipeline never imports
pycolmap; tests use an engine over a known scene, and an OpenSfM engine could take COLMAP's place
without changing the stages.

``ColmapEngine`` runs each stage in a child Python (``python -m aio_pipelines.photo.colmap_io
<request.json>``) so that:

- **cancel** kills it within a fraction of a second (the global mapper has no cancellation hook);
- a native crash or a memory spike cannot take the pipeline process down;
- the stage's **peak memory** is measured and recorded in ``run.json``;
- the interpreter can differ: ``AIO_COLMAP_PYTHON`` names another Python with pycolmap (the
  default is this Python: the pack and the development venv install COLMAP's own PyPI wheel,
  ``python/pyproject.toml``).

**Licences.** COLMAP's PyPI wheels bundle CHOLMOD and SPQR (GPL); the founder accepted GPL parts
in the pipeline pack on 8 Oct 2026 (ADR 0008, amended), so any pycolmap build runs. The
third-party notices list what the wheel bundles.

Resume: the COLMAP database lives in the job's staging ``work/``; feature extraction skips photos
that already have keypoints and matching skips pairs that are already matched, so a resumed stage
continues where it stopped.

**Photo names with spaces.** COLMAP's pair list (``ImportedPairingOptions.match_list_path``) is
one ``name1 name2`` per line, split at the first space, so a photo below a folder such as
``Mapping Photos/`` could never be paired. The pair list therefore names photos by
``engine_alias`` (space as ``%20``, percent as ``%25``), and the match stage renames the images in
the database to those aliases for its own duration (``names.alias.json`` remembers the real names,
so a stage stopped half way is put right by the next one). Features and mapping use the real
names, which is what COLMAP reads the photos by. On Windows the worker sets the C runtime's locale
to UTF-8 before COLMAP loads (``utf8_paths``), so photos below folders such as ``Média`` open too.

**Memory.** The guard stops a stage above ``memory_limit``: ``AIO_PHOTO_MEMORY_MB`` when the app
sets it (one cap for every photo job, ``native.memory_cap``), else 75 % of the physical memory and
no more than 90 % of what is free when the stage starts. What it measures is the resident memory of
the engine's own process tree (``tree_memory``; ``native.run_tool`` guards a native tool with the
same figure). On Windows a parent PID alone does not put a process in that tree: the PID of an
ended process is given out again, and its children still name it (``descendants``).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..runtime import Cancelled, JobError, atomic_write_bytes
from ..walk.colmap_child import PYTHON_ENV, utf8_paths
from ..walk.colmap_child import Out as _Out
from ..walk.colmap_child import export_model as _export
from ..walk.colmap_child import import_pycolmap as _import_pycolmap
from ..walk.colmap_child import src_root as _src_root
from .proctree import (
    START_TOLERANCE_S,
    MemoryExceeded,
    descendants,
    end_process,
    end_tree,
    kill,
    kill_list,
    memory_limit,
    memory_status,
    peak_memory_bytes,
    process_links,
    process_memory,
    process_started,
    process_tree,
    tree_memory,
)

# The names that moved to ``proctree`` and ``walk.colmap_child`` stay importable from here until
# this module is deleted.
__all__ = [
    "PYTHON_ENV",
    "START_TOLERANCE_S",
    "MemoryExceeded",
    "descendants",
    "end_process",
    "end_tree",
    "kill",
    "kill_list",
    "memory_limit",
    "memory_status",
    "peak_memory_bytes",
    "process_links",
    "process_memory",
    "process_started",
    "process_tree",
    "tree_memory",
    "utf8_paths",
]

Progress = Callable[[float, str | None], None]


@dataclass
class EngineGroup:
    """One calibration group (camera body and lens at one size) with its starting calibration."""

    id: int
    model: str
    width: int
    height: int
    params: list[float]


@dataclass
class EngineImage:
    key: str  # the run's photo key (folder and path)
    name: str  # path relative to ``image_root`` (what the engine reads)
    group: int


@dataclass
class EngineJob:
    work: Path
    image_root: Path
    images: list[EngineImage]
    groups: list[EngineGroup]
    max_image_size: int = 1600
    max_features: int = 8192
    #: SIFT's first octave: -1 doubles the image first (fine detail on small images, four times
    #: the memory); 0 for images of 1600 px and more.
    first_octave: int = 0
    threads: int = -1
    #: Stop the stage when the engine's memory passes this (0: no limit).
    memory_limit_bytes: int = 0
    seed: int = 0
    check: Callable[[], None] = field(default=lambda: None)
    log: Callable[[str], None] = field(default=lambda m: None)
    memory_peak: dict[str, int] = field(default_factory=dict)

    @property
    def database(self) -> Path:
        return self.work / "database.db"


class SfmEngine(Protocol):
    name: str

    def versions(self) -> dict[str, str]: ...

    def features(self, job: EngineJob, progress: Progress) -> dict[str, Any]: ...

    def match(self, job: EngineJob, pairs: list[tuple[str, str]], progress: Progress) -> dict[str, Any]: ...

    def map(self, job: EngineJob, mapper: str, progress: Progress) -> dict[str, Any]: ...


# ------------------------------------------------------------------------------- memory


# ------------------------------------------------------------------------------- names


def engine_alias(name: str) -> str:
    """A photo name as COLMAP's pair list can hold it (that list splits each line at a space):
    the percent sign and every white space or control character percent-encoded (UTF-8), so a
    space is ``%20`` and a percent sign ``%25``. Unique, and ``urllib.parse.unquote`` reverses it."""
    from urllib.parse import quote

    return "".join(quote(ch, safe="") if ch == "%" or ch.isspace() or ord(ch) < 32 else ch for ch in name)


def alias_names(db, work: Path) -> int:
    """Rename the database's images to their ``engine_alias`` for matching; the real names are
    kept in ``work/names.alias.json`` until ``restore_names``. Returns how many were renamed."""
    restore_names(db, work)
    images = list(db.read_all_images())
    real = {int(im.image_id): im.name for im in images if engine_alias(im.name) != im.name}
    if not real:
        return 0
    rec = work / "names.alias.json"
    atomic_write_bytes(rec, json.dumps({str(k): v for k, v in real.items()}).encode("utf-8"))
    for im in images:
        if int(im.image_id) in real:
            im.name = engine_alias(im.name)
            db.update_image(im)
    return len(real)


def restore_names(db, work: Path) -> int:
    """Put back the real image names an aliased (perhaps stopped) match stage left in the database."""
    rec = work / "names.alias.json"
    if not rec.is_file():
        return 0
    real = {int(k): v for k, v in json.loads(rec.read_text("utf-8")).items()}
    n = 0
    for im in db.read_all_images():
        name = real.get(int(im.image_id))
        if name is not None and im.name != name:
            im.name = name
            db.update_image(im)
            n += 1
    rec.unlink()
    return n


# ------------------------------------------------------------------------------- parent side


class ColmapEngine:
    name = "colmap"

    def __init__(self, python: str | None = None):
        self.python = python or os.environ.get(PYTHON_ENV) or sys.executable
        self._versions: dict[str, str] | None = None

    def _run(
        self, job: EngineJob, op: str, payload: dict[str, Any], progress: Progress, stage: str
    ) -> dict[str, Any]:
        job.work.mkdir(parents=True, exist_ok=True)
        req = job.work / f"{stage}.request.json"
        prog = job.work / f"{stage}.progress.jsonl"
        out = job.work / f"{stage}.out.log"
        req.write_text(json.dumps({"op": op, **payload}), "utf-8")
        prog.write_text("", "utf-8")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(_src_root()) + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
        env["AIO_COLMAP_PROGRESS"] = str(prog)
        env.setdefault("GLOG_minloglevel", "1")
        with open(out, "wb") as log_f:
            proc = subprocess.Popen(
                [self.python, "-m", "aio_pipelines.photo.colmap_io", str(req)],
                stdin=subprocess.DEVNULL,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            pos = 0
            result: dict[str, Any] | None = None
            error: str | None = None
            seen_peak = 0
            last_mem = 0.0
            try:
                while True:
                    done = proc.poll() is not None
                    try:
                        job.check()
                    except Cancelled:
                        kill(proc)
                        raise
                    if job.memory_limit_bytes and not done and time.monotonic() - last_mem >= 0.5:
                        last_mem = time.monotonic()
                        used = tree_memory(proc.pid)
                        seen_peak = max(seen_peak, used)
                        if used > job.memory_limit_bytes:
                            kill(proc)
                            job.memory_peak[stage] = used
                            raise MemoryExceeded(
                                f"Alignment stopped during {stage}: COLMAP needed more than "
                                f"{job.memory_limit_bytes / 1e9:.1f} GB of memory, the limit for this computer "
                                "now. Choose a lower preset, process fewer photos at a time, or close other programs."
                            )
                    with open(prog, encoding="utf-8") as f:
                        f.seek(pos)
                        chunk = f.read()
                    lines = chunk.split("\n")
                    pos += len(chunk.encode("utf-8")) - len(lines[-1].encode("utf-8"))
                    for line in lines[:-1]:
                        try:
                            msg = json.loads(line)
                        except ValueError:
                            continue
                        if "progress" in msg:
                            progress(float(msg["progress"]), msg.get("message"))
                        if "log" in msg:
                            job.log(str(msg["log"]))
                        if "result" in msg:
                            result = msg["result"]
                        if "error" in msg:
                            error = str(msg["error"])
                        if "memoryPeakBytes" in msg:
                            job.memory_peak[stage] = max(int(msg["memoryPeakBytes"]), seen_peak)
                    if done:
                        break
                    time.sleep(0.1)
            finally:
                if proc.poll() is None:
                    kill(proc)
        if error:
            raise JobError(error)
        if proc.returncode != 0 or result is None:
            tail = out.read_text("utf-8", errors="replace").strip().splitlines()[-3:]
            raise JobError(
                f"COLMAP stopped during {stage} (exit {proc.returncode}). " + " ".join(tail)[-400:]
            )
        return result

    def _base(self, job: EngineJob) -> dict[str, Any]:
        return {
            "database": str(job.database),
            "imageRoot": str(job.image_root),
            "maxImageSize": job.max_image_size,
            "maxFeatures": job.max_features,
            "firstOctave": job.first_octave,
            "threads": job.threads,
            "seed": job.seed,
        }

    def versions(self) -> dict[str, str]:
        if self._versions is None:
            env = dict(os.environ)
            env["PYTHONPATH"] = str(_src_root()) + (
                os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
            )
            try:
                p = subprocess.run(
                    [self.python, "-m", "aio_pipelines.photo.colmap_io", "--versions"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=env,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except (OSError, subprocess.TimeoutExpired) as e:
                raise JobError(f"The photo alignment engine could not start: {e}") from e
            try:
                data = json.loads(p.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                data = {"error": (p.stderr or p.stdout or "no output").strip()[-300:]}
            if "error" in data:
                raise JobError(data["error"])
            self._versions = data
        return self._versions

    def features(self, job: EngineJob, progress: Progress) -> dict[str, Any]:
        payload = {
            **self._base(job),
            "groups": [asdict(g) for g in job.groups],
            "images": [{"name": i.name, "group": i.group} for i in job.images],
        }
        return self._run(job, "features", payload, progress, "features")

    #: The array library of the matcher on the card. Tests set ``numpy`` to run that path
    #: without a graphics card; in production it is CuPy from the GPU add-on.
    match_backend: str | None = None

    def _card(self, job: EngineJob) -> dict[str, Any] | None:
        """The graphics card for matching: the GPU add-on the app named, when its card passes
        the test (asked in a process of its own). None means COLMAP's matcher on the CPU."""
        if self.match_backend:
            return {"backend": self.match_backend}
        from .. import accel

        addon = os.environ.get(accel.ADDON_ENV)
        if not addon:
            return None
        state = accel.check(Path(addon))
        if state.get("state") != "ready":
            job.log(f"Matching uses the CPU. {state.get('reason') or 'The graphics card is not ready.'}")
            return None
        return {"addon": addon, "version": state.get("version"), "gpu": state.get("gpu")}

    def match(self, job: EngineJob, pairs: list[tuple[str, str]], progress: Progress) -> dict[str, Any]:
        pairs_file = job.work / "pairs.txt"
        pairs_file.write_text("".join(f"{engine_alias(a)} {engine_alias(b)}\n" for a, b in pairs), "utf-8")
        base = {**self._base(job), "pairs": str(pairs_file)}
        card = self._card(job)
        if card:
            # the card compares the descriptors, COLMAP verifies the matches as it always does
            try:
                made = self._run(
                    job, "match-gpu", {**base, **card}, lambda f, m=None: progress(0.85 * f, m), "match-gpu"
                )
                job.log(f"Matched {made['pairs']} pairs on {made['gpu']} in {made['seconds']:.0f} s.")
                res = self._run(job, "verify", base, lambda f, m=None: progress(0.85 + 0.15 * f, m), "verify")
                job.memory_peak["match"] = max(
                    job.memory_peak.get("match-gpu", 0), job.memory_peak.get("verify", 0)
                )
                return {
                    **res,
                    "engine": "sift-card",
                    "device": "gpu",
                    **({"accelerator": card["version"]} if card.get("version") else {}),
                }
            except Cancelled:
                raise
            except JobError as e:
                from . import gpu_match

                job.log(f"The graphics card could not be used for matching ({e}); matching on the CPU.")
                # what the card wrote is dropped, so COLMAP matches and verifies every pair itself
                gpu_match.clear_matches(job.database)
        return {**self._run(job, "match", base, progress, "match"), "engine": "sift-colmap", "device": "cpu"}

    def map(self, job: EngineJob, mapper: str, progress: Progress) -> dict[str, Any]:
        out = job.work / f"sfm-{mapper}"
        return self._run(
            job, "map", {**self._base(job), "mapper": mapper, "out": str(out)}, progress, f"map-{mapper}"
        )


def load_engine() -> SfmEngine:
    """The engine of this pack: COLMAP, when its build is installed and licence-clean."""
    eng = ColmapEngine()
    eng.versions()
    return eng


# ------------------------------------------------------------------------------- worker side


def _versions() -> dict[str, Any]:
    out = _Out()
    try:
        pc = _import_pycolmap(out)
    except JobError as e:
        return {"error": str(e)}
    info = {
        "pycolmap": str(getattr(pc, "__version__", "?")),
        "colmap": str(getattr(pc, "COLMAP_version", "?")),
    }
    info["cuda"] = str(bool(getattr(pc, "has_cuda", False))).lower()
    return info


def _op_features(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    root = req["imageRoot"]
    groups = {g["id"]: g for g in req["groups"]}
    images = req["images"]
    with pc.Database.open(db_path) as db:
        restore_names(db, Path(db_path).parent)
        existing = {im.name: im for im in db.read_all_images()}
        cams = {c.camera_id: c for c in db.read_all_cameras()}
        cam_of_group: dict[int, int] = {}
        for gid, g in groups.items():
            # one camera per group, created once (a resume finds it by its stored id)
            want = next(
                (
                    cid
                    for cid, c in cams.items()
                    if c.width == g["width"] and c.height == g["height"] and cid == gid
                ),
                None,
            )
            if want is None:
                cam = pc.Camera.create_from_model_name(
                    gid, g["model"], float(g["params"][0]), g["width"], g["height"]
                )
                cam.params = g["params"]
                cam.has_prior_focal_length = True
                want = db.write_camera(cam, use_camera_id=True)
            cam_of_group[gid] = int(want)
        todo = []
        for im in images:
            e = existing.get(im["name"])
            if e is not None and db.exists_keypoints(e.image_id):
                continue
            todo.append(im)
    opts = pc.FeatureExtractionOptions()
    opts.max_image_size = int(req["maxImageSize"])
    opts.num_threads = int(req["threads"])
    opts.use_gpu = False
    opts.sift.max_num_features = int(req["maxFeatures"])
    opts.sift.first_octave = int(req.get("firstOctave", 0))
    total = len(images)
    done = total - len(todo)
    out.send(progress=done / max(total, 1), message=f"{done} of {total} photos")
    by_group: dict[int, list[str]] = {}
    for im in todo:
        by_group.setdefault(im["group"], []).append(im["name"])
    # batches big enough to keep every core busy (COLMAP extracts the photos of a call in
    # parallel), small enough for progress and resume: about 20 calls per run
    batch = max(2 * (os.cpu_count() or 8), total // 20)
    for gid, names in by_group.items():
        ro = pc.ImageReaderOptions()
        ro.existing_camera_id = cam_of_group[gid]
        for k in range(0, len(names), batch):
            part = names[k : k + batch]
            pc.extract_features(
                db_path,
                root,
                image_names=part,
                camera_mode=pc.CameraMode.SINGLE,
                reader_options=ro,
                extraction_options=opts,
                device=pc.Device.cpu,
            )
            done += len(part)
            out.send(progress=done / max(total, 1), message=f"{done} of {total} photos")
    with pc.Database.open(db_path) as db:
        n = db.num_images()
        kp = db.num_keypoints()
    return {"images": n, "keypoints": int(kp)}


def _op_match(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    lines = [ln for ln in Path(req["pairs"]).read_text("utf-8").splitlines() if ln.strip()]
    mo = pc.FeatureMatchingOptions()
    mo.num_threads = int(req["threads"])
    mo.use_gpu = False
    vo = pc.TwoViewGeometryOptions()
    chunk = max(200, len(lines) // 50)
    work = Path(req["pairs"]).parent
    db_work = Path(db_path).parent
    with pc.Database.open(db_path) as db:
        renamed = alias_names(db, db_work)  # the pair list names photos by their aliases
    if renamed:
        out.send(log=f"{renamed} photo names have spaces; matched under escaped names.")
    try:
        for k in range(0, len(lines), chunk):
            part = work / "pairs.part.txt"
            part.write_text("\n".join(lines[k : k + chunk]) + "\n", "utf-8")
            po = pc.ImportedPairingOptions()
            po.match_list_path = str(part)
            pc.match_image_pairs(
                db_path,
                matching_options=mo,
                pairing_options=po,
                verification_options=vo,
                device=pc.Device.cpu,
            )
            out.send(
                progress=min(1.0, (k + chunk) / max(len(lines), 1)),
                message=f"{min(k + chunk, len(lines))} of {len(lines)} pairs",
            )
    finally:
        with pc.Database.open(db_path) as db:
            restore_names(db, db_work)
    with pc.Database.open(db_path) as db:
        matched = db.num_matched_image_pairs()
        verified = db.num_verified_image_pairs()
    return {"pairs": len(lines), "matched": int(matched), "verified": int(verified)}


def _op_verify(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    """COLMAP's geometric verification of matches already in the database (the card's): the
    second half of what ``_op_match`` does in one call."""
    db_path = req["database"]
    lines = [ln for ln in Path(req["pairs"]).read_text("utf-8").splitlines() if ln.strip()]
    vo = pc.TwoViewGeometryOptions()
    chunk = max(200, len(lines) // 20)
    work = Path(req["pairs"]).parent
    db_work = Path(db_path).parent
    with pc.Database.open(db_path) as db:
        alias_names(db, db_work)  # the pair list names photos by their aliases
    try:
        for k in range(0, len(lines), chunk):
            part = work / "pairs.part.txt"
            part.write_text("\n".join(lines[k : k + chunk]) + "\n", "utf-8")
            pc.verify_matches(db_path, str(part), options=vo)
            out.send(
                progress=min(1.0, (k + chunk) / max(len(lines), 1)),
                message=f"{min(k + chunk, len(lines))} of {len(lines)} pairs checked",
            )
    finally:
        with pc.Database.open(db_path) as db:
            restore_names(db, db_work)
    with pc.Database.open(db_path) as db:
        matched = db.num_matched_image_pairs()
        verified = db.num_verified_image_pairs()
    return {"pairs": len(lines), "matched": int(matched), "verified": int(verified)}


def _op_map(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    root = req["imageRoot"]
    dest = Path(req["out"])
    dest.mkdir(parents=True, exist_ok=True)
    mapper = req["mapper"]
    with pc.Database.open(db_path) as db:
        restore_names(db, Path(db_path).parent)  # the real names: COLMAP reads the photos by them
    t0 = time.monotonic()
    out.send(progress=0.02, message=f"{mapper} structure from motion")
    if mapper == "global":
        opts = pc.GlobalPipelineOptions()
        opts.num_threads = int(req["threads"])
        opts.random_seed = int(req["seed"])
        opts.mapper.global_positioning.use_gpu = False
        opts.mapper.bundle_adjustment.ceres.use_gpu = False
        recs = pc.global_mapping(db_path, root, str(dest), opts)
    else:
        opts = pc.IncrementalPipelineOptions()
        opts.num_threads = int(req["threads"])
        opts.random_seed = int(req["seed"])
        count = {"n": 0}

        def next_image():
            count["n"] += 1
            if count["n"] % 10 == 0:
                out.send(progress=0.05, message=f"{count['n']} photos placed")

        recs = pc.incremental_mapping(db_path, root, str(dest), opts, next_image_callback=next_image)
    models = []
    for k, rec in sorted(recs.items(), key=lambda kv: -kv[1].num_reg_images()):
        models.append(_export(pc, rec, dest / f"model-{k}.npz"))
    out.send(progress=1.0, message=f"{len(models)} models in {time.monotonic() - t0:.0f} s")
    return {"models": models, "mapper": mapper, "seconds": round(time.monotonic() - t0, 1)}


def worker_main(argv: list[str]) -> int:
    if argv and argv[0] == "--versions":
        print(json.dumps(_versions()), flush=True)
        return 0
    out = _Out()
    try:
        req = json.loads(Path(argv[0]).read_text("utf-8"))
        if req.get("op") == "probe-alloc":  # memory guard probe: grow in steps, then wait
            hold = []
            for _ in range(int(req.get("steps", 20))):
                hold.append(bytearray(int(req.get("stepBytes", 100 * 2**20))))
                out.send(progress=0.5, message=f"{len(hold)} steps")
                time.sleep(0.3)
            time.sleep(float(req.get("seconds", 30)))
            out.send(result={"held": len(hold)})
            return 0
        if req.get("op") == "probe-sleep":  # liveness probe: progress, then a long wait (cancel tests)
            for k in range(int(req.get("seconds", 60)) * 10):
                if k % 5 == 0:
                    out.send(progress=min(0.99, k / 600), message="waiting")
                time.sleep(0.1)
            out.send(result={"slept": True})
            return 0
        if req.get("op") == "match-gpu":
            # before pycolmap is imported, and without it: NVIDIA's libraries and COLMAP's never
            # share a process. Any failure is a JobError, which sends the engine back to the CPU.
            from . import gpu_match

            try:
                xp = None
                if req.get("backend") == "numpy":
                    import numpy as xp
                result = gpu_match.run(req, out.send, xp)
            except Exception as e:
                raise JobError(f"{type(e).__name__}: {str(e)[:300]}") from e
            out.send(memoryPeakBytes=peak_memory_bytes())
            out.send(result=result)
            return 0
        pc = _import_pycolmap(out)
        if hasattr(pc, "set_random_seed"):
            pc.set_random_seed(int(req.get("seed", 0)))
        op = {"features": _op_features, "match": _op_match, "verify": _op_verify, "map": _op_map}[req["op"]]
        result = op(pc, req, out)
        out.send(memoryPeakBytes=peak_memory_bytes())
        out.send(result=result)
        return 0
    except JobError as e:
        out.send(error=str(e))
        return 1
    except Exception as e:  # a COLMAP failure: shown to the person with its type
        out.send(error=f"COLMAP failed: {type(e).__name__}: {str(e)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(worker_main(sys.argv[1:]))

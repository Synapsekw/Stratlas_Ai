"""Structure from motion on a walk's equirectangular stills (``walk.process``, step ``sfm``).

COLMAP (pycolmap 4.2.1) runs in a child Python as for ``photo.align`` (``photo/colmap_io.py``):
cancel kills it at once, a native crash cannot take the job down, and its memory is guarded
(``colmap_io.memory_limit``, the one cap ``AIO_PHOTO_MEMORY_MB``). The child is
``python -m aio_pipelines.walk.sfm <request.json>``; it talks back through the same progress file.

- **Camera.** One ``EQUIRECTANGULAR`` camera (parameters: width, height) shared by every still,
  never refined (``ba_refine_*`` off; the model has no focal length or distortion to refine).
- **Masks.** ``work/masks/<image name>.png`` (COLMAP's ``mask_path`` convention), the bottom
  ``mask_bottom`` fraction black (ignored): the walker and the pole.
- **Matching.** One database for the whole walk: SIFT on every still, then COLMAP's sequential
  matching with overlap 10 and no loop detection. Sequential matching orders images by name, so
  the still names must sort in walk order (``still_000123.jpg``); ``run_sfm`` refuses otherwise.
- **Mapping in chunks.** Incremental mapping per chunk of ``chunk`` stills, ``overlap`` shared
  with the next (``chunk_ranges``), each its own reconstruction. A failed mapper run (the flaky
  first exit seen in the Walks design) is retried once; both logs stay in ``work/``. A chunk that
  fails twice leaves its stills unregistered (when every chunk fails, ``run_sfm`` raises).
- **Join** (``join_chunks``). Models in walk order; each joins the latest segment by a similarity
  on the camera centres of at least ``MIN_SHARED`` stills registered in both (Umeyama; the scale
  from the centres, then the rotation and translation again with points one spread along each
  camera axis added, so a straight walk, whose centres are collinear, still fixes the roll about
  the line). A model with fewer shared stills starts a new segment; a reconstruction that splits
  into several models therefore gives several segments.
- **Frames.** Every still's ``pos`` and ``q`` (camera to SfM frame, w x y z) are in the frame of
  its own segment. Segments are numbered largest first (most registered stills; ties in walk
  order), and ``points``, ``colors`` and ``up`` belong to segment 0's frame only.
- **Up.** ``up_from_gravity`` when gravity is given for the stills of segment 0 (the gravity
  direction in each camera's frame, from the IMU), else ``up_from_cameras`` (the mean camera down
  axis: a walker holds the camera about level).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..photo import colmap_io as cio
from ..photo.model import qvec_to_rotmat, rotmat_to_qvec
from ..photo.native import memory_cap, tool_threads
from ..runtime import Cancelled, JobError, atomic_write_bytes

#: Stills two chunk models must share (registered in both) to be joined.
MIN_SHARED = 5
#: COLMAP's sequential matching window (no loop detection in this version).
SEQ_OVERLAP = 10
#: SIFT works on at most this many pixels on the long side (COLMAP's default).
MAX_IMAGE_SIZE = 3200
#: Progress split: features and matching, then mapping, then the join.
P_FEATURES = 0.35
P_MAP = 0.95


@dataclass
class StillPose:
    n: int
    registered: bool
    pos: tuple[float, float, float] | None
    q: tuple[float, float, float, float] | None  # camera to SfM frame, wxyz
    segment: int | None


@dataclass
class SfmResult:
    poses: list[StillPose]
    segments: int
    registered_fraction: float
    points: np.ndarray  # (k, 3) float32
    colors: np.ndarray  # (k, 3) uint8
    up: tuple[float, float, float] | None
    timings: dict[str, float]


@dataclass
class ChunkModel:
    """One reconstruction of one chunk: still index -> (R_cw, t_cw) (COLMAP's cam_from_world),
    and its points (model frame) with their colours."""

    poses: dict[int, tuple[np.ndarray, np.ndarray]]
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    colors: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), np.uint8))


# ------------------------------------------------------------------------------- geometry


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """The similarity ``dst ~ s R src + t`` in the least squares sense (Umeyama 1991): s, R, t."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    if src.shape != dst.shape or src.ndim != 2 or src.shape[1] != 3 or len(src) < 3:
        raise ValueError("umeyama needs two (n, 3) point sets of the same size, n >= 3")
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = (xs**2).sum() / len(src)
    if var_s <= 1e-18:
        raise ValueError("umeyama: the source points coincide")
    cov = xd.T @ xs / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1.0
    R = U @ S @ Vt
    s = float(np.trace(np.diag(D) @ S) / var_s)
    t = mu_d - s * R @ mu_s
    return s, R, t


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if not np.isfinite(n) or n < 1e-12:
        raise ValueError("a direction of zero length")
    return v / n


def up_from_gravity(qs: list[np.ndarray], gravity_cam: list[np.ndarray]) -> np.ndarray:
    """Up in the SfM frame from the cameras' rotations (camera to SfM, wxyz) and the gravity
    direction seen in each camera's frame (pointing down, any length): minus the mean of the
    gravity directions taken into the SfM frame."""
    if not qs or len(qs) != len(gravity_cam):
        raise ValueError("up_from_gravity needs one gravity vector per rotation")
    down = np.zeros(3)
    for q, g in zip(qs, gravity_cam, strict=True):
        down += qvec_to_rotmat(q) @ _unit(np.asarray(g, dtype=np.float64))
    return -_unit(down)


def up_from_cameras(qs: list[np.ndarray]) -> np.ndarray:
    """Up in the SfM frame from the cameras alone: minus the mean camera down axis (camera y is
    down), for a camera carried about level."""
    if not qs:
        raise ValueError("up_from_cameras needs at least one rotation")
    down = np.zeros(3)
    for q in qs:
        down += qvec_to_rotmat(q)[:, 1]
    return -_unit(down)


def write_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    """A binary little-endian PLY: x y z (float) red green blue (uchar) per vertex."""
    pts = np.asarray(points, dtype="<f4").reshape(-1, 3)
    cols = np.asarray(colors, dtype=np.uint8).reshape(-1, 3)
    if len(pts) != len(cols):
        raise ValueError("write_ply: one colour per point")
    rec = np.empty(
        len(pts), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")]
    )
    rec["x"], rec["y"], rec["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
    rec["r"], rec["g"], rec["b"] = cols[:, 0], cols[:, 1], cols[:, 2]
    head = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(pts)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "end_header\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(path, head.encode("ascii") + rec.tobytes())


# ------------------------------------------------------------------------------- chunks and join


def chunk_ranges(n: int, chunk: int, overlap: int) -> list[tuple[int, int]]:
    """Still index ranges [a, b) of ``chunk`` stills, each sharing ``overlap`` with the next; the
    last one ends at ``n``."""
    if n <= 0:
        return []
    chunk = max(1, int(chunk))
    overlap = max(0, min(int(overlap), chunk - 1))
    step = chunk - overlap
    out, a = [], 0
    while True:
        b = min(n, a + chunk)
        out.append((a, b))
        if b >= n:
            return out
        a += step


def _centres(model: ChunkModel) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """Still index -> (R_wc, centre) in the model's frame."""
    out = {}
    for k, (R_cw, t) in model.poses.items():
        R_cw = np.asarray(R_cw, dtype=np.float64)
        out[k] = (R_cw.T, -R_cw.T @ np.asarray(t, dtype=np.float64))
    return out


def _join_similarity(
    src: list[tuple[np.ndarray, np.ndarray]], dst: list[tuple[np.ndarray, np.ndarray]]
) -> tuple[float, np.ndarray, np.ndarray] | None:
    """The similarity taking ``src`` cameras (R_wc, centre) onto ``dst``, or None when the shared
    centres cannot fix it (they coincide)."""
    cs = np.array([c for _, c in src])
    cd = np.array([c for _, c in dst])
    try:
        s, _, _ = umeyama(cs, cd)
    except ValueError:
        return None
    if not np.isfinite(s) or s <= 0:
        return None
    spread = float(np.sqrt(((cs - cs.mean(0)) ** 2).sum(1).mean())) or 1.0
    a = [cs] + [cs + spread * np.array([R[:, j] for R, _ in src]) for j in range(3)]
    b = [cd] + [cd + s * spread * np.array([R[:, j] for R, _ in dst]) for j in range(3)]
    return umeyama(np.concatenate(a), np.concatenate(b))


def join_chunks(models: list[ChunkModel], n: int) -> tuple[list[StillPose], int, np.ndarray, np.ndarray]:
    """Join chunk models into segments (module docstring, "Join" and "Frames"): the poses of all
    ``n`` stills, the segment count, and segment 0's points (float32) and colours (uint8)."""
    order = sorted((m for m in models if m.poses), key=lambda m: min(m.poses))
    segs: list[dict[str, Any]] = []
    owner: dict[int, int] = {}  # still -> segment (first come keeps it)
    for m in order:
        cams = _centres(m)
        sim = None
        if segs:
            last = segs[-1]
            shared = sorted(set(cams) & set(last["cams"]))
            if len(shared) >= MIN_SHARED:
                sim = _join_similarity([cams[k] for k in shared], [last["cams"][k] for k in shared])
        if sim is None:
            segs.append({"cams": {}, "parts": []})
            sim = (1.0, np.eye(3), np.zeros(3))
        seg_i = len(segs) - 1
        s, R, t = sim
        seg = segs[seg_i]
        for k, (R_wc, c) in cams.items():
            if k in owner:
                continue
            owner[k] = seg_i
            seg["cams"][k] = (R @ R_wc, s * R @ c + t)
        pts = np.asarray(m.points, dtype=np.float64).reshape(-1, 3)
        seg["parts"].append((s * pts @ R.T + t, np.asarray(m.colors, dtype=np.uint8).reshape(-1, 3)))
    sizes = [sum(1 for o in owner.values() if o == i) for i in range(len(segs))]
    rank = sorted(range(len(segs)), key=lambda i: (-sizes[i], i))
    renum = {old: new for new, old in enumerate(rank)}
    poses = []
    for k in range(n):
        if k not in owner:
            poses.append(StillPose(k, False, None, None, None))
            continue
        R_wc, c = segs[owner[k]]["cams"][k]
        q = rotmat_to_qvec(R_wc)
        poses.append(
            StillPose(
                k,
                True,
                (float(c[0]), float(c[1]), float(c[2])),
                (float(q[0]), float(q[1]), float(q[2]), float(q[3])),
                renum[owner[k]],
            )
        )
    if segs:
        parts = segs[rank[0]]["parts"]
        points = np.concatenate([p for p, _ in parts]).astype(np.float32)
        colors = np.concatenate([c for _, c in parts]).astype(np.uint8)
    else:
        points, colors = np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    return poses, len(segs), points, colors


# ------------------------------------------------------------------------------- parent side


def _write_masks(folder: Path, names: list[str], width: int, height: int, mask_bottom: float) -> None:
    import io

    from PIL import Image

    m = np.full((height, width), 255, np.uint8)
    cut = height - round(height * max(0.0, min(1.0, mask_bottom)))
    m[cut:] = 0
    buf = io.BytesIO()
    Image.fromarray(m).save(buf, format="PNG")
    data = buf.getvalue()
    for name in names:
        p = folder / f"{name}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.is_file() or p.read_bytes() != data:
            p.write_bytes(data)


class _Stages:
    """Runs ``python -m aio_pipelines.walk.sfm`` stages as ``ColmapEngine._run`` runs its own:
    progress and results through a file, the memory guard, cancel by killing the tree."""

    def __init__(self, work: Path, check: Callable[[], None]):
        self.work = work
        self.check = check
        self.python = os.environ.get(cio.PYTHON_ENV) or sys.executable
        self.memory_limit = cio.memory_limit(*cio.memory_status(), memory_cap())

    def run(self, stage: str, req: dict[str, Any], progress: Callable[[float], None]) -> dict[str, Any]:
        req_path = self.work / f"{stage}.request.json"
        prog = self.work / f"{stage}.progress.jsonl"
        log = self.work / f"{stage}.out.log"
        req_path.write_text(json.dumps(req), "utf-8")
        prog.write_text("", "utf-8")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(cio._src_root()) + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
        env["AIO_COLMAP_PROGRESS"] = str(prog)
        env.setdefault("GLOG_minloglevel", "1")
        result: dict[str, Any] | None = None
        error: str | None = None
        with open(log, "wb") as log_f:
            proc = subprocess.Popen(
                [self.python, "-m", "aio_pipelines.walk.sfm", str(req_path)],
                stdin=subprocess.DEVNULL,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            pos, last_mem = 0, 0.0
            try:
                while True:
                    done = proc.poll() is not None
                    self.check()
                    if self.memory_limit and not done and time.monotonic() - last_mem >= 0.5:
                        last_mem = time.monotonic()
                        used = cio.tree_memory(proc.pid)
                        if used > self.memory_limit:
                            cio.kill(proc)
                            raise cio.MemoryExceeded(
                                f"Walk path stopped during {stage}: COLMAP needed more than "
                                f"{self.memory_limit / 1e9:.1f} GB of memory. Close other programs, "
                                "or raise the memory limit in Settings."
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
                            progress(float(msg["progress"]))
                        if "result" in msg:
                            result = msg["result"]
                        if "error" in msg:
                            error = str(msg["error"])
                    if done:
                        break
                    time.sleep(0.1)
            finally:
                if proc.poll() is None:
                    cio.kill(proc)
        if error:
            raise JobError(error)
        if proc.returncode != 0 or result is None:
            tail = log.read_text("utf-8", errors="replace").strip().splitlines()[-3:]
            raise JobError(
                f"COLMAP stopped during {stage} (exit {proc.returncode}). " + " ".join(tail)[-400:]
            )
        return result


def _load_model(path: Path, index: dict[str, int]) -> ChunkModel:
    with np.load(path) as z:
        poses = {
            index[str(name)]: (np.asarray(R, np.float64), np.asarray(t, np.float64))
            for name, R, t in zip(z["img_names"], z["img_R"], z["img_t"], strict=True)
            if str(name) in index
        }
        return ChunkModel(poses, np.asarray(z["xyz"], np.float64), np.asarray(z["rgb"], np.uint8))


def run_sfm(
    stills: list[Path],
    work: Path,
    *,
    mask_bottom: float,
    chunk: int,
    overlap: int = 40,
    gravity: list[np.ndarray | None] | None,
    check: Callable[[], None],
    progress: Callable[[float], None],
) -> SfmResult:
    """SfM on the walk's stills (in walk order); see the module docstring. ``gravity``, when given,
    has one entry per still: the gravity direction in that camera's frame, or None. ``check`` raises
    ``Cancelled`` to stop; ``progress`` gets 0 to 1, never going back."""
    t_all = time.monotonic()
    n = len(stills)
    if gravity is not None and len(gravity) != n:
        raise ValueError("run_sfm: one gravity entry per still")
    last = [0.0]

    def report(f: float) -> None:
        f = max(last[0], min(1.0, float(f)))
        last[0] = f
        progress(f)

    check()
    report(0.0)
    timings: dict[str, float] = {}
    if n == 0:
        report(1.0)
        return SfmResult([], 0, 0.0, np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8), None, timings)
    from PIL import Image

    work.mkdir(parents=True, exist_ok=True)
    root = Path(os.path.commonpath([str(Path(p).resolve().parent) for p in stills]))
    names = [Path(p).resolve().relative_to(root).as_posix() for p in stills]
    if len(set(names)) != n or names != sorted(names):
        raise JobError("The walk's stills must have unique names that sort in walk order.")
    sizes = set()
    for p in stills:
        with Image.open(p) as im:
            sizes.add(im.size)
    if len(sizes) != 1:
        raise JobError("The walk's stills must all have the same size.")
    width, height = sizes.pop()
    masks = work / "masks"
    _write_masks(masks, names, width, height, mask_bottom)
    check()

    stages = _Stages(work, check)
    threads = tool_threads(cap=16)
    from ..photo.align import first_octave

    base = {"database": str(work / "database.db"), "imageRoot": str(root), "threads": threads, "seed": 0}
    t0 = time.monotonic()
    stages.run(
        "features",
        {
            **base,
            "op": "features",
            "names": names,
            "maskRoot": str(masks),
            "width": width,
            "height": height,
            "maxImageSize": MAX_IMAGE_SIZE,
            "firstOctave": first_octave(min(MAX_IMAGE_SIZE, max(width, height))),
            "overlap": SEQ_OVERLAP,
        },
        lambda f: report(P_FEATURES * f),
    )
    timings["features"] = round(time.monotonic() - t0, 2)

    index = {name: k for k, name in enumerate(names)}
    ranges = chunk_ranges(n, chunk, overlap)
    models: list[ChunkModel] = []
    failed: list[str] = []
    t0 = time.monotonic()
    for i, (a, b) in enumerate(ranges):
        lo = P_FEATURES + (P_MAP - P_FEATURES) * i / len(ranges)
        hi = P_FEATURES + (P_MAP - P_FEATURES) * (i + 1) / len(ranges)
        out = work / f"chunk-{i:03d}"
        req = {**base, "op": "map", "names": names[a:b], "out": str(out)}
        res = None
        for attempt, stage in enumerate((f"map-{i:03d}", f"map-{i:03d}-retry")):
            check()
            if out.exists():
                for old in out.glob("model-*.npz"):
                    old.unlink()
            try:
                res = stages.run(stage, req, lambda f, lo=lo, hi=hi: report(lo + (hi - lo) * f))
                break
            except (Cancelled, cio.MemoryExceeded):
                raise
            except JobError as e:
                if attempt == 1:
                    failed.append(f"chunk {i + 1}: {e}")
        if res is not None:
            models.extend(_load_model(Path(m["path"]), index) for m in res["models"])
        report(hi)
    timings["map"] = round(time.monotonic() - t0, 2)
    if failed and len(failed) == len(ranges):
        raise JobError(f"Structure from motion failed twice ({failed[0]}). The logs are in {work}.")

    t0 = time.monotonic()
    poses, segments, points, colors = join_chunks(models, n)
    up = None
    seg0 = [p for p in poses if p.registered and p.segment == 0]
    if seg0:
        with_g = [
            (np.array(p.q), np.asarray(gravity[p.n], np.float64))
            for p in seg0
            if gravity is not None
            and gravity[p.n] is not None
            and np.all(np.isfinite(gravity[p.n]))
            and np.linalg.norm(gravity[p.n]) > 1e-9
        ]
        if with_g:
            u = up_from_gravity([q for q, _ in with_g], [g for _, g in with_g])
        else:
            u = up_from_cameras([np.array(p.q) for p in seg0])
        up = (float(u[0]), float(u[1]), float(u[2]))
    timings["join"] = round(time.monotonic() - t0, 3)
    timings["total"] = round(time.monotonic() - t_all, 2)
    registered = sum(p.registered for p in poses)
    report(1.0)
    return SfmResult(poses, segments, registered / n, points, colors, up, timings)


# ------------------------------------------------------------------------------- worker side


def _op_features(pc, req: dict[str, Any], out) -> dict[str, Any]:
    db_path, root, names = req["database"], req["imageRoot"], req["names"]
    w, h = int(req["width"]), int(req["height"])
    with pc.Database.open(db_path) as db:
        cam_id = next(
            (
                int(c.camera_id)
                for c in db.read_all_cameras()
                if c.model == pc.CameraModelId.EQUIRECTANGULAR and c.width == w and c.height == h
            ),
            None,
        )
        if cam_id is None:
            cam = pc.Camera.create_from_model_name(1, "EQUIRECTANGULAR", 1.0, w, h)
            cam_id = int(db.write_camera(cam))
        existing = {im.name: im for im in db.read_all_images()}
        todo = [nm for nm in names if nm not in existing or not db.exists_keypoints(existing[nm].image_id)]
    opts = pc.FeatureExtractionOptions()
    opts.max_image_size = int(req["maxImageSize"])
    opts.num_threads = int(req["threads"])
    opts.use_gpu = False
    opts.sift.first_octave = int(req["firstOctave"])
    ro = pc.ImageReaderOptions()
    ro.existing_camera_id = cam_id
    ro.mask_path = req["maskRoot"]
    total = len(names)
    done = total - len(todo)
    out.send(progress=0.6 * done / max(total, 1), message=f"{done} of {total} stills")
    batch = max(2 * (os.cpu_count() or 8), total // 20)
    for k in range(0, len(todo), batch):
        part = todo[k : k + batch]
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
        out.send(progress=0.6 * done / max(total, 1), message=f"{done} of {total} stills")
    mo = pc.FeatureMatchingOptions()
    mo.num_threads = int(req["threads"])
    mo.use_gpu = False
    so = pc.SequentialPairingOptions()
    so.overlap = int(req["overlap"])
    so.loop_detection = False
    pc.match_sequential(db_path, matching_options=mo, pairing_options=so, device=pc.Device.cpu)
    out.send(progress=1.0, message="matched")
    with pc.Database.open(db_path) as db:
        return {
            "images": int(db.num_images()),
            "keypoints": int(db.num_keypoints()),
            "verified": int(db.num_verified_image_pairs()),
        }


def _op_map(pc, req: dict[str, Any], out) -> dict[str, Any]:
    dest = Path(req["out"])
    dest.mkdir(parents=True, exist_ok=True)
    names = list(req["names"])
    opts = pc.IncrementalPipelineOptions()
    opts.num_threads = int(req["threads"])
    opts.random_seed = int(req["seed"])
    opts.image_names = names
    opts.multiple_models = True
    opts.ba_refine_focal_length = False
    opts.ba_refine_principal_point = False
    opts.ba_refine_extra_params = False
    count = {"n": 0}

    def next_image():
        count["n"] += 1
        out.send(progress=min(0.95, count["n"] / max(len(names), 1)), message=f"{count['n']} stills placed")

    t0 = time.monotonic()
    recs = pc.incremental_mapping(
        req["database"], req["imageRoot"], str(dest), opts, next_image_callback=next_image
    )
    models = [
        cio._export(pc, rec, dest / f"model-{k}.npz")
        for k, rec in sorted(recs.items(), key=lambda kv: -kv[1].num_reg_images())
    ]
    out.send(progress=1.0, message=f"{len(models)} models")
    return {"models": models, "seconds": round(time.monotonic() - t0, 1)}


def worker_main(argv: list[str]) -> int:
    out = cio._Out()
    try:
        req = json.loads(Path(argv[0]).read_text("utf-8"))
        pc = cio._import_pycolmap(out)
        if hasattr(pc, "set_random_seed"):
            pc.set_random_seed(int(req.get("seed", 0)))
        op = {"features": _op_features, "map": _op_map}[req["op"]]
        result = op(pc, req, out)
        out.send(memoryPeakBytes=cio.peak_memory_bytes())
        out.send(result=result)
        return 0
    except JobError as e:
        out.send(error=str(e))
        return 1
    except Exception as e:  # a COLMAP failure, with its type
        out.send(error=f"COLMAP failed: {type(e).__name__}: {str(e)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(worker_main(sys.argv[1:]))


__all__ = [
    "ChunkModel",
    "SfmResult",
    "StillPose",
    "chunk_ranges",
    "join_chunks",
    "run_sfm",
    "umeyama",
    "up_from_cameras",
    "up_from_gravity",
    "write_ply",
]

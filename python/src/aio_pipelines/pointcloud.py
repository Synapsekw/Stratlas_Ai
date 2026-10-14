"""pointcloud.to_copc: LAS, LAZ or E57 to a COPC file in the project CRS, with PDAL.

PDAL runs as its command-line tool (``pdal``), found in this order: the ``AIO_PDAL`` environment
variable, ``tools/pdal`` inside the pipeline pack, then the PATH. The pack's PDAL is conda-forge's
``libpdal-core`` build (``tools/pipeline-pack/pdal.mjs``): ``Library/bin/pdal.exe`` on Windows,
``bin/pdal`` on macOS, with its PROJ and GDAL data in ``share/`` beside ``bin/``; ``pdal_env``
points PDAL at that data wherever the pack was installed, and keeps PROJ off the network.

The COPC is built by the photo pipeline's shared writer (``photo.cloud_out.write_copc``): untwine,
out of core on all cores with its own progress, else PDAL's ``writers.copc`` in memory. The cloud
is reprojected to the project CRS only when its header declares another CRS (``source_epsg``);
untwine cannot reproject, so PDAL first streams it into a temporary LAS in the job's staging
folder (its progress is the share of points written), which is also how an E57 or PLY becomes
the LAS the writer reads. A source without a CRS is taken as already in the project CRS. The
layer is added to the project manifest last (data-conventions section 4: ``format: "copc"``,
project CRS).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .params import known_keys, number, numbers, text
from .runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path

PDAL_MISSING = (
    "PDAL is not available: the pipeline pack has no tools/pdal and none is on the PATH. "
    "Install the full pipeline pack, or set AIO_PDAL to pdal.exe."
)
CLOUD_EXTENSIONS = {".las", ".laz", ".e57", ".ply"}
#: What the COPC writer reads directly; anything else becomes a LAS first.
LAS_EXTENSIONS = {".las", ".laz"}
LAS_HEADER = 375  # a LAS 1.4 header; its few VLRs are noise next to the points
BUILDING = "Building the viewable cloud"
#: The convert step's progress: reading the header, then the reprojection (when needed), then the
#: COPC build up to the end.
READ_END, PREPARE_END, BUILD_END = 0.02, 0.35, 0.99


def find_pdal() -> str | None:
    env = os.environ.get("AIO_PDAL")
    if env and Path(env).is_file():
        return env
    exe = "pdal.exe" if os.name == "nt" else "pdal"
    pack = Path(sys.prefix).parent / "tools" / "pdal"
    for cand in (pack / "Library" / "bin" / exe, pack / "bin" / exe):
        if cand.is_file():
            return str(cand)
    return shutil.which("pdal")


def pdal_env(exe: str) -> dict[str, str]:
    """The environment PDAL runs in: this process's, plus the PROJ and GDAL data of a conda-style
    PDAL (``<exe>/../../share/proj``, as the pack's is; conda's activation scripts are never run)
    and, on Windows, its folder first on the PATH. A PDAL without such data keeps the environment."""
    env = dict(os.environ)
    share = Path(exe).resolve().parent.parent / "share"
    if (share / "proj" / "proj.db").is_file():
        env["PROJ_DATA"] = str(share / "proj")
        env["PROJ_LIB"] = str(share / "proj")
        env.setdefault("PROJ_NETWORK", "OFF")
    if (share / "gdal").is_dir():
        env["GDAL_DATA"] = str(share / "gdal")
    if os.name == "nt":
        env["PATH"] = str(Path(exe).resolve().parent) + os.pathsep + env.get("PATH", "")
    return env


def elapsed(seconds: float) -> str:
    """``42 s``, ``3 min 20 s`` or ``1 h 05 min``."""
    s = int(seconds)
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60} s"
    return f"{s // 3600} h {s % 3600 // 60:02d} min"


def _run(
    ctx: StepContext,
    args: list[str],
    what: str,
    band: tuple[float, float] = (0.0, 0.0),
    measure: Callable[[], float | None] | None = None,
) -> str:
    """Run PDAL, cancellable (the cancel event kills it); return its stdout or raise with its
    message. Progress moves through ``band`` by ``measure`` (a fraction of the work done) when it
    gives one; otherwise the bar holds at the band's start and the text says how long it has run.

    Output goes to files in the job folder (a full pipe would block PDAL) and stdin is closed.
    """
    out_path = ctx.job.dir / "pdal.out"
    err_path = ctx.job.dir / "pdal.err"
    lo, hi = band
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=out_f,
            stderr=err_f,
            env=pdal_env(args[0]),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        t0 = time.monotonic()
        shown = 0.0
        try:
            while proc.poll() is None:
                if ctx.cancel_event.is_set():
                    proc.kill()
                    proc.wait()
                    ctx.check()
                share = measure() if measure is not None else None
                if share is not None:
                    shown = max(shown, min(1.0, share))
                    ctx.progress(lo + (hi - lo) * shown, what)
                else:
                    ctx.progress(lo + (hi - lo) * shown, f"{what}, {elapsed(time.monotonic() - t0)} so far")
                time.sleep(0.1)
        except BaseException:
            if proc.poll() is None:  # never leave PDAL running
                proc.kill()
                proc.wait()
            raise
    out = out_path.read_text("utf-8", errors="replace")
    err = err_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        msg = (err or out or "").strip().splitlines()
        raise JobError(
            f"PDAL could not finish {what.lower()}: {msg[-1] if msg else f'exit {proc.returncode}'}"
        )
    return out


def read_summary(ctx: StepContext, pdal: str, src: Path) -> dict[str, Any]:
    """PDAL's summary of a cloud: ``num_points``, ``srs`` (``wkt``, ``horizontal``, ``json``)."""
    info = json.loads(_run(ctx, [pdal, "info", "--summary", str(src)], "Reading the cloud"))
    return info.get("summary", {})


_WKT_EPSG = re.compile(r'(?:AUTHORITY\["EPSG",\s*"(\d+)"\]|ID\["EPSG",\s*(\d+)\])\s*\]\s*$')


def source_epsg(srs: dict[str, Any]) -> int | None:
    """The EPSG code of a cloud's horizontal CRS from PDAL's ``srs`` summary: the PROJJSON
    ``id`` (a compound CRS's first component), else the horizontal WKT's own authority. None when
    the file has no CRS or one without an EPSG code."""
    j = srs.get("json")
    if isinstance(j, dict):
        if j.get("type") == "CompoundCRS" and j.get("components"):
            j = j["components"][0]
        ident = j.get("id") if isinstance(j, dict) else None
        if isinstance(ident, dict) and str(ident.get("authority", "")).upper() == "EPSG":
            try:
                return int(ident["code"])
            except (KeyError, TypeError, ValueError):
                pass
    for key in ("horizontal", "wkt"):
        m = _WKT_EPSG.search(str(srs.get(key) or "").strip())
        if m:
            return int(m.group(1) or m.group(2))
    return None


def las_record_length(path: Path) -> int | None:
    """The point record length in a LAS or LAZ header (bytes 105 and 106), else None."""
    try:
        with open(path, "rb") as f:
            head = f.read(107)
    except OSError:
        return None
    if len(head) < 107 or head[:4] != b"LASF":
        return None
    return int.from_bytes(head[105:107], "little") or None


def written_share(dst: Path, points: int, record: int) -> Callable[[], float]:
    """How much of an uncompressed LAS of ``points`` points of ``record`` bytes PDAL has written,
    from the file's size (at most 0.99 until PDAL is done)."""
    total = max(1, points * record)

    def share() -> float:
        try:
            size = dst.stat().st_size
        except OSError:
            return 0.0
        return min(0.99, max(0.0, size - LAS_HEADER) / total)

    return share


def prepare_las(
    ctx: StepContext,
    pdal: str,
    src: Path,
    dst: Path,
    epsg: int | None,
    points: int,
    band: tuple[float, float],
) -> None:
    """``src`` as an uncompressed LAS ``dst`` the COPC writer reads, reprojected to ``epsg`` when
    given. PDAL streams it (every stage here streams for LAS and LAZ), so memory stays flat."""
    writer: dict[str, Any] = {
        "type": "writers.las",
        "filename": str(dst),
        "forward": "major_version,minor_version,dataformat_id",
        "extra_dims": "all",
    }
    stages: list[Any] = [str(src)]
    if epsg:
        stages.append({"type": "filters.reprojection", "out_srs": f"EPSG:{epsg}"})
        # a new CRS needs new offsets (from the first point, as PDAL streams) and a millimetre scale
        writer.update({f"scale_{a}": 0.001 for a in "xyz"})
        writer.update({f"offset_{a}": "auto" for a in "xyz"})
        writer["a_srs"] = f"EPSG:{epsg}"
    stages.append(writer)
    pipe = ctx.stage("prepare-pipeline.json")
    atomic_write_json(pipe, {"pipeline": stages})
    record = las_record_length(src)
    measure = written_share(dst, points, record) if record and points else None
    what = "Reprojecting the cloud" if epsg else "Reading the cloud into LAS"
    try:
        _run(ctx, [pdal, "pipeline", str(pipe)], what, band, measure)
    finally:
        pipe.unlink(missing_ok=True)
    if not dst.is_file():
        raise JobError("PDAL finished without writing the reprojected cloud.")


class _BuildProgress:
    """The step context ``write_copc`` runs with: its progress in plain words. Untwine reports
    its own percentage, which goes straight through; PDAL reports none, so then the bar holds
    where the build began and the text says how long it has run."""

    def __init__(self, ctx: StepContext, measured: bool, start: float):
        self._ctx, self._measured, self._start = ctx, measured, start
        self._t0 = time.monotonic()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._ctx, name)

    def progress(self, fraction: float, message: str | None = None) -> None:
        if self._measured:
            self._ctx.progress(fraction, BUILDING)
        else:
            self._ctx.progress(self._start, f"{BUILDING}, {elapsed(time.monotonic() - self._t0)} so far")


def _layer_id(out_rel: str, taken: set[str]) -> str:
    stem = Path(out_rel).name.split(".")[0]
    base = "cloud-" + (re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") or "points")
    lid, n = base, 2
    while lid in taken:
        lid, n = f"{base}-{n}", n + 1
    return lid


class PointcloudToCopc:
    name = "pointcloud.to_copc"
    title = "Point cloud to COPC"
    description = "Converts LAS, LAZ or E57 to a COPC file in the project CRS and adds it as a layer."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"src", "out", "epsg", "origin"}, self.name)
        src = text(params, "src", required=True)
        assert src is not None
        if Path(src).suffix.lower() not in CLOUD_EXTENSIONS:
            raise JobError("src must be a LAS, LAZ, E57 or PLY file.")
        stem = re.sub(r"[^a-z0-9]+", "-", Path(src).name.split(".")[0].lower()).strip("-") or "cloud"
        out = {
            "src": src,
            "out": text(params, "out", f"clouds/{stem}.copc.laz"),
            "epsg": number(params, "epsg", None, 1024, 999999, integer=True),
            "origin": numbers(params, "origin", 3),
        }
        assert out["out"] is not None
        if not str(out["out"]).lower().endswith(".copc.laz"):
            raise JobError("out must end with .copc.laz.")
        return {k: v for k, v in out.items() if v is not None}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def convert(ctx: StepContext) -> dict[str, Any]:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            # the photo pipeline's shared COPC writer (numpy and friends load only when needed)
            from .photo import cloud_out, native

            src = ctx.input(params["src"])
            summary = read_summary(ctx, pdal, src)
            srs = summary.get("srs") or {}
            has_crs = bool(srs.get("wkt") or srs.get("json"))
            count = int(summary.get("num_points") or 0)
            ctx.log(f"{src.name}: {count:,} points" + ("" if has_crs else ", no CRS in the file"))
            ctx.progress(READ_END, "Reading the cloud")
            epsg = params.get("epsg")
            reproject = None
            if epsg and has_crs:
                found = source_epsg(srs)
                if found == epsg:
                    ctx.log(f"The file is already in EPSG:{epsg}; no reprojection needed.")
                else:
                    reproject = epsg
                    ctx.log(
                        f"Reprojecting from {f'EPSG:{found}' if found else 'the file CRS'} to EPSG:{epsg}."
                    )
            elif epsg:
                ctx.log(f"The file declares no CRS; it is taken as EPSG:{epsg} already.", "warn")
            las, start = src, READ_END
            prepared: Path | None = None
            staged = ctx.stage("cloud.copc.laz")
            try:
                if reproject or src.suffix.lower() not in LAS_EXTENSIONS:
                    prepared = ctx.stage("source.las")
                    prepare_las(ctx, pdal, src, prepared, reproject, count, (READ_END, PREPARE_END))
                    las, start = prepared, PREPARE_END
                ctx.check()
                build = _BuildProgress(ctx, native.find_tool("untwine") is not None, start)
                writer = cloud_out.write_copc(
                    build,  # type: ignore[arg-type]  # a StepContext in all it uses
                    las,
                    staged,
                    count,
                    epsg,
                    ctx.stage("copc-work"),
                    native.memory_budget(),
                    progress=(start, BUILD_END),
                )
            finally:
                if prepared is not None:
                    prepared.unlink(missing_ok=True)  # as big as the cloud: never keep it
            ctx.log(f"Built the viewable cloud with {writer}.")
            return {"points": count, "bytes": staged.stat().st_size}

        def register(ctx: StepContext) -> dict[str, Any]:
            out_rel = str(params["out"]).replace("\\", "/")
            commit_files(ctx, [("cloud.copc.laz", out_rel)])
            mpath = safe_project_path(ctx.project, "manifest.json")
            manifest = json.loads(mpath.read_text("utf-8"))
            layers = manifest.setdefault("layers", [])
            existing = next(
                (
                    layer
                    for layer in layers
                    if layer.get("kind") == "pointcloud" and (layer.get("src") or {}).get("path") == out_rel
                ),
                None,
            )
            points = int(ctx.outputs("convert").get("points") or 0)
            if existing is None:
                lid = _layer_id(out_rel, {str(layer.get("id")) for layer in layers})
                layers.append(
                    {
                        "kind": "pointcloud",
                        "id": lid,
                        "name": Path(params["src"]).name,
                        "visible": True,
                        "src": {"path": out_rel},
                        "format": "copc",
                        **({"pointCount": points} if points else {}),
                    }
                )
                # keep the previous manifest beside it, as the app's own saves do
                shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
                atomic_write_json(mpath, manifest, indent=2)
                ctx.log(f"Added layer {lid} ({out_rel}).")
            else:
                lid = str(existing.get("id"))
            return {"layer": lid, "path": out_rel}

        return [
            Step("convert", "Convert with PDAL", convert, weight=10),
            Step("register", "Add the layer to the project", register, weight=0.5),
        ]

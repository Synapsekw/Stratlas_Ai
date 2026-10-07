"""Smoke test of the native PoissonRecon build (M10 G1, pack-native CI): an oriented sphere cloud
in, a closed mesh on the sphere out, then SurfaceTrimmer over it.

    python smoke_poissonrecon.py <tools/poissonrecon/bin> <work folder>
"""

import subprocess
import sys
from pathlib import Path

import numpy as np

RADIUS = 5.0


def ply_header(text: bytes) -> dict[str, int]:
    head = text.split(b"end_header", 1)[0].decode("ascii", "replace").splitlines()
    return {line.split()[1]: int(line.split()[2]) for line in head if line.startswith("element ")}


def main() -> None:
    bin_dir, work = Path(sys.argv[1]), Path(sys.argv[2])
    work.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if sys.platform == "win32" else ""
    rng = np.random.default_rng(1)
    n = 20000
    normals = rng.normal(size=(n, 3))
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    cloud = np.hstack([normals * RADIUS, normals]).astype("<f4")
    src = work / "sphere.ply"
    props = "".join(f"property float {p}\n" for p in ("x", "y", "z", "nx", "ny", "nz"))
    src.write_bytes(
        f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n{props}end_header\n".encode()
        + cloud.tobytes()
    )
    mesh = work / "mesh.ply"
    args = ["--in", str(src), "--out", str(mesh), "--depth", "7", "--density", "--ascii"]
    subprocess.run([str(bin_dir / f"PoissonRecon{suffix}"), *args], check=True)
    counts = ply_header(mesh.read_bytes())
    assert counts.get("face", 0) > 1000, counts
    # ASCII vertices: x y z density; every vertex near the sphere.
    lines = mesh.read_text().split("end_header", 1)[1].split()
    xyz = np.array(lines[: counts["vertex"] * 4], dtype=float).reshape(-1, 4)[:, :3]
    err = np.abs(np.linalg.norm(xyz, axis=1) - RADIUS)
    assert np.percentile(err, 95) < 0.1, float(np.percentile(err, 95))
    trimmed = work / "trimmed.ply"
    subprocess.run(
        [str(bin_dir / f"SurfaceTrimmer{suffix}"), "--in", str(mesh), "--out", str(trimmed), "--trim", "5"],
        check=True,
    )
    assert ply_header(trimmed.read_bytes()).get("face", 0) > 0
    print(f"PoissonRecon: {counts['face']} faces, 95% within {np.percentile(err, 95):.3f} m of the sphere")


if __name__ == "__main__":
    main()

import numpy as np

from aio_pipelines.engineer.compound import fit_compound


def test_compound_fits_rotated_shifted_roofs_and_fence_without_site_coordinates():
    rng = np.random.default_rng(25)
    parts = []
    for axis, c in [(0, -4), (0, 4), (2, -4), (2, 4)]:
        p = rng.uniform([-4, 0, -4], [4, 2, 4], (5000, 3))
        p[:, axis] = c + rng.normal(0, 0.008, len(p))
        parts.append(p)
    for cx, cz, w, d, y in [(-1, -2, 3, 2, 2.7), (2, 2, 1, 1.5, 1.5)]:
        p = rng.uniform([cx - w / 2, y - 0.005, cz - d / 2], [cx + w / 2, y + 0.005, cz + d / 2], (6000, 3))
        parts.append(p)
    a = np.concatenate(parts)
    theta = 0.31
    rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    a[:, [0, 2]] = a[:, [0, 2]] @ rot.T + [20, -13]
    a[:, 1] += 5
    out = fit_compound(a, [20, 5, -13], [{"kind": "cloud", "ref": "scan"}])
    fence = next(o for o in out if o["kind"] == "fence")
    assert len(fence["path"]) == 5
    assert abs(fence["size"][1] - 2) < 0.08
    roofs = [o for o in out if o["kind"] in ("canopy", "cabinet")]
    assert len(roofs) == 2
    canopy = next(o for o in roofs if o["kind"] == "canopy")
    expected = np.array([-1, -2]) @ rot.T + [20, -13]
    assert np.linalg.norm(np.array(canopy["centre"])[[0, 2]] - expected) < 0.07
    assert abs(canopy["centre"][1] - 7.7) < 0.03
    assert canopy["quality"]["centre"]["basis"] == "measured"
    assert canopy["sources"][0]["ref"] == "scan"


def test_compound_rejects_ground_and_scattered_clutter():
    rng = np.random.default_rng(4)
    p = rng.uniform([-5, -0.03, -5], [5, 0.03, 5], (10000, 3))
    assert fit_compound(p, [0, 0, 0], []) == []

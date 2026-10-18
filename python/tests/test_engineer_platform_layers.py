"""Nearby horizontal layers must not be averaged into a nonexistent platform."""

import numpy as np

from aio_pipelines.engineer.supports import _platforms


def test_nearby_deck_faces_are_not_averaged_or_counted_as_two_platforms():
    rng = np.random.default_rng(34)
    xz = rng.uniform(-1.3, 1.3, (10000, 2))
    xz = xz[np.linalg.norm(xz, axis=1) > 0.4]
    deck = np.column_stack([xz[:, 0], 18 + 0.025 * xz[:, 0], xz[:, 1]])
    # Two close horizontal surfaces overlap height bins, but remain separate planes.
    caps = deck.copy()
    caps[:, 1] += 0.08
    points = np.concatenate([deck, caps])
    found = _platforms(points, points, np.zeros(3), np.array([0, 1, 0]), lambda h: 0.3, [], lambda: None)
    assert len(found) == 1
    assert abs(found[0]["centre"][1] - 18.08) < 0.01
    assert any("underside" in note for note in found[0]["notes"])
    assert found[0]["quality"]["centre"]["residualM"] < 0.01


def test_nearby_faces_cannot_emit_the_same_selectable_identity_twice():
    rng = np.random.default_rng(34)
    xz = rng.uniform(-1.3, 1.3, (10000, 2))
    xz = xz[np.linalg.norm(xz, axis=1) > 0.4]
    points = np.concatenate(
        [np.column_stack([xz[:, 0], y + 0.025 * xz[:, 0], xz[:, 1]]) for y in (18.03, 18.07)]
    )
    found = _platforms(points, points, np.zeros(3), np.array([0, 1, 0]), lambda h: 0.3, [], lambda: None)
    assert found
    assert len({o["id"] for o in found}) == len(found)

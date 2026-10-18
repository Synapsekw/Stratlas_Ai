import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from aio_pipelines.engineer.members import _components


def test_dense_components_do_not_materialize_point_pairs(monkeypatch):
    import aio_pipelines.engineer.members as members

    class BoundedTree(cKDTree):
        def query_pairs(self, *args, **kwargs):
            raise AssertionError("Dense point pairs must not be materialized")

    monkeypatch.setattr(members, "cKDTree", BoundedTree)
    rng = np.random.default_rng(4)
    p = np.r_[rng.uniform(0, 0.01, (80000, 3)), rng.uniform(2, 2.01, (40000, 3))]
    groups = _components(p, 0.35, 15)
    assert sorted(map(len, groups)) == [40000, 80000]


def test_cell_clustering_preserves_exact_euclidean_connectivity():
    rng = np.random.default_rng(13)
    for dim in (2, 3):
        for eps in (0.15, 0.3, 0.5):
            p = rng.uniform(0, 3, (650, dim))
            pairs = cKDTree(p).query_pairs(eps, output_type="ndarray")
            graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(p), len(p)))
            _, labels = connected_components(graph, directed=False)
            expected = {frozenset(np.flatnonzero(labels == i)) for i in np.unique(labels)}
            assert {frozenset(g) for g in _components(p, eps, 1)} == expected

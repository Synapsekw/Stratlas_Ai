"""photo.products: dense cloud (COPC), DSM and DTM, orthomosaic and textured mesh, as new layers.

G0 stub (M10 stream G3 builds it): parameters as ``PhotoProductsParams`` in ``@aio/schema``.
Existing layer kinds only (``mesh``, ``pointcloud`` ``copc``, ``raster`` ``kit-pyramid``).
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class PhotoProducts(NotBuiltYet):
    name = "photo.products"
    title = "Create products from photos"
    description = "Dense cloud, DSM and DTM, orthomosaic and textured mesh from an aligned run."
    keys = frozenset({"run", "products", "preset", "dense", "gsdCm", "region", "capture", "meshTriangles"})
    required = frozenset({"run", "products"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "products": frozenset({"cloud", "dsm", "dtm", "ortho", "mesh", "tiles"}),
        "preset": frozenset({"fast", "standard", "high"}),
        "dense": frozenset({"auto", "cpu", "cuda"}),
    }

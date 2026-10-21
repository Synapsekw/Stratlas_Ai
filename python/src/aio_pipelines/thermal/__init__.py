"""Thermal photos: radiometric decoders and the temperature physics.

Kept import-free on purpose: each decoder family is imported from its own module
(``aio_pipelines.thermal.flir``, ``aio_pipelines.thermal.physics``) so a missing native
library for one family never breaks the others.
"""

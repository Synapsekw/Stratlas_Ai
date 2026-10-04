"""Volumetric Survey Kit pipelines, ported from the kit's ``build/`` scripts (the founder's own code).

grid.py     resample a DSM GeoTIFF onto the job's common grid (block mean), resumable by row block
process.py  yard floor, pile detection on the envelope of both dates, four bases, volumes, change
"""

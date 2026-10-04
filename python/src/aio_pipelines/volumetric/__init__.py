"""Volumetric Survey Kit pipelines, ported from the kit's ``build/`` scripts (the founder's own code).

grid.py     resample a DSM GeoTIFF onto the job's common grid (block mean), resumable by row block
ortho.py    orthomosaic onto the grid as WebP tiles, and the tile pyramid (resample.py, pyramid.py)
process.py  yard floor, pile detection on the envelope of both dates, four bases, volumes, change
package.py  the kit's data scripts (pile grids, site DSM, vol.js, site.js) and authoritative volumes
cloud.py    a point cloud as a survey date (DSM and colour GeoTIFFs); not in the kit
terrain.py  terrain GLB per date for the app's volumetric workspace (port of the Masafi import)
pipeline.py volumetric.process: DSM GeoTIFFs -> piles.json
build.py    volumetric.build: raw surveys -> a complete volumetric project
"""

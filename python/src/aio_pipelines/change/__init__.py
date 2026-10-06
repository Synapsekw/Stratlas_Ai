"""Change between two capture dates (M8, FUS-12).

changeset.py the aio.change/1 writer every change pipeline shares (C0)
raster.py    change.raster: two orthos to a change heat map and polygons (C2)
surface.py   change.surface: two DSMs or clouds to cut and fill regions (C2)
register.py  co-registration check of two rasters (C2)
cloud.py     change.cloud: cloud-to-cloud distance as a COPC Distance field (C3)
mesh.py      change.mesh: model deviation and tagged part diff (C3)
frames.py    change.frames: changes in pose-matched frame pairs as draft detections (C4)
"""

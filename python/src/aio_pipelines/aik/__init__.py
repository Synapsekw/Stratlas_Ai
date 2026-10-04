"""Asset Inspection Kit pipelines, ported from the kit's ``kit/`` package (v1.0.0, the founder's own code).

cameras.py  cameras.json from EXIF GPS + DJI XMP gimbal angles; 2560 px review copies
config.py   kit job config (job.yaml shape) merged with a bundled vertical profile
masks.py    class-index masks: statistics and coloured overlays
records.py  canonical photo and finding records, heights, zones, sides, grouping, stats, CSV
project.py  back-project boxes and masks onto a GLB as pins or textured patches (trimesh)

The maths is kept as in the kit so results match the original deliverables; what changed is
I/O (files are staged and committed by the job runtime) and progress and cancel hooks.
"""

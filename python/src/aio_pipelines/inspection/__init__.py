"""Inspection pipeline: the Asset Inspection Kit run end to end on a native project.

A native inspection project (built in the app: photos with poses, a mesh, a class catalogue and a
severity model) is turned into a kit job in the job's staging folder, in the kit's model frame,
and the kit's own code does the work:

  contact sheets   ``aik.contact`` (photo tiling with ids burned in, for a visual detection pass)
  detections       ``aio.detections/1`` files (review, AI, ONNX), kit lists or COCO, through
                   ``aik.detections`` into the kit's assessment
  back-projection  ``aik.project`` (median hit of a 5 x 5 ray grid inside each box)
  clustering       ``aik.records`` (same class within ``cluster_m`` is one defect, D01 from the top)
  statistics       ``aik.records`` stats, register and CSV

The groups become issues in ``issues.json`` (``aio.issues/1``), merged by stable ids with what
is already there: issues a person made or edited are never changed or dropped.
"""

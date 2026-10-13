---
type: session
date: 2026-10-13-1923
branch: fix/photo-scale
status: complete
related: [../plans/2026-10-13-photo-scale-design.md, ../plans/2026-10-13-photo-scale.md]
---

# Photo processing at scale: a bounded dense cloud

## What changed

- **Landed as #114 (e459d339).** Fusion now needs two agreeing photos, or one at the block edge where only one other photo can check a pixel. The merge runs per tile, in parallel: voxel mean, column collapse, "seen twice" counted per collapsed bin, then an outlier filter (k 16, 2.5 sigma). A point budget caps the cloud (Standard 150 M, High 400 M), and the fusion chunks (format 2, about 18 B per point) are deleted after a complete merge.
- **The steps run dsm, dtm, then cloud.** The DTM is always smrf-grid. Ground class 2 comes from height above the DTM, tile by tile. The COPC is built out of core with untwine 1.5.1 (pipeline pack 0.6.1), with PDAL `writers.copc` as a fallback under a memory limit. Every external tool runs through `run_tool` with a memory limit and real progress.
- **Work layout 2:** the depth key is unchanged, so depth maps are reused; fusion and merge have their own keys. An old-layout cleanup frees the old cloud data, and an old job is refused at every step after prepare, pointing to Create maps again.
- **Cloud change regions** now need the 8 nearest neighbours to agree, which fixes a latent noise bridge. The mesh input is capped at what MeshLab keeps.
- **GPU add-on 0.1.0** was rebuilt for pack 0.6.x and hand-installed in the founder's runtime; its self-test answers ready on the card. Built subagent-driven: 9 tasks, per-task reviews, two root-cause debugs (edge coverage, change regions) and a final review.

## Why

A run of about 1,000 drone photos at 2 cm on a 64 GB, 24-thread PC never finished. Fusion kept 913 M points (32.9 GB). PDAL's whole-cloud SMRF and COPC writer then reached 123 GB of memory, swapped, and failed with `bad allocation`. The bar sat at 40 %, because PDAL progress was a 60 s ramp. No GPU was used: the add-on was not installed. Pix4D (1 point per 8 px at half scale, 3 matches) and ODM (2 views, a statistical filter, untwine) were compared; the budgets match Pix4D for 20 MP photos.

## How to test

1. Install pipeline pack 0.6.1 into `<data folder>/runtime` (it carries untwine).
2. In a project with a failed or cancelled photo run, open the Processing drawer and choose Create maps again, with point cloud, DSM and orthomosaic.
3. Prepare logs "Removing files of an older processing version" with the space freed. The depth maps are reused, and fusion runs again (faster with the GPU add-on). The merge logs the points and spacing (at most about 150 M at Standard). Then DSM, DTM and cloud run in that order, and the cloud step's bar moves with untwine's percentages.
4. The point cloud layer opens, and its ground points are class 2. Memory stays well under 64 GB in Task Manager.
5. Resume the old failed job instead: it shows the "Create maps again" message and changes nothing.

## Open threads

- **Real-data proof (plan task 10)** is owed: the founder's run with pack 0.6.1, in a window the founder agrees to. Use it to tune `RAW_PER_POINT` in `budget.py` (and the disk check, which also counts depth maps that already exist).
- **Follow-ups:**
  - the report's memory peak leaves out child processes;
  - old `c-*` and `m-*` folders are never cleaned;
  - `survey/cleanup.py` and `tiles/cloud.py` still load the whole cloud;
  - texrecon over budget has no fallback;
  - watch the noise at the block edge and near occlusions;
  - ML point classes and a metric spacing option (from the comparison).

## Next session entry point

Rebuild the installer and pack 0.6.1 once all sessions have landed (founder). Then run the real-data proof and tune the disk estimate from its numbers.

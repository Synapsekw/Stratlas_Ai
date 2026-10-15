---
type: session
date: 2026-10-16-0058
branch: feat/pointcloud-cleanup
status: complete
related: [plans/2026-10-15-pointcloud-cleanup-design.md, plans/2026-10-15-pointcloud-cleanup.md]
---

# Point cloud cleanup tools

## What changed

- A per-layer cleanup recipe (`aio.pccleanup/1`, `edits/pointcloud/<layerId>.json`, journaled): clip box (drag faces, turn about vertical), height range, box or lasso regions (hide, delete, set class), per-layer hidden classes and a noise run. It shows live in the viewer; the original file is never changed. Data conventions section 37.
- New pipeline job `pointcloud.clean`: noise mode (PDAL `filters.outlier`, optional `filters.elm`) marks noise as class 7 in a working COPC with a count and Undo; save mode writes a derived COPC layer (`derived.kind` cleanup) and hides the original.
- `survey.export` applies the recipe ("Apply cleanup" in the export dialog). A Clean up panel sits in the point cloud toolbar group, with four right-click actions, undo/redo per layer, and the legend editing the panel's cloud.
- Pipeline pack 0.12.0 (bentley-import took 0.10.0, engineering-model 0.11.0); the PDAL driver check adds the two filters.
- Founder decisions 15 Oct: one branch; live recipe per layer; per-layer hidden classes; hide is view only, delete is applied on save and export; projects holding a cleaned copy need app 0.16+.
- e2e: pointcloud-clipbox, pointcloud-noise, pointcloud-clean-export (the last two run in CI, which now installs PDAL).

## Why

Surveyors need to trim stray points, sky noise and unwanted classes from a cloud without touching the source file, and carry the result into exports.

## How to test

1. Open a project with a COPC point cloud (import a LAS/LAZ first if needed; it converts to COPC). Go to Scene, 3D view.
2. In the toolbar's point cloud group click Clean up (hexagon icon). The panel opens top left.
3. Clip box: click Fit to layer, then Edit box. Drag a face handle inward: points outside vanish live. Drag the ring to turn the box. Switch Keep to Outside: the inside vanishes instead. Ctrl Z undoes the last change.
4. Height range: type a Highest value below the cloud top: points above it disappear.
5. Select points: click Lasso, draw a loop around some points, release. A bar shows how many loaded points are selected; click Delete. They disappear; Ctrl Z brings them back.
6. Remove noise: click Remove noise. After the job a notice says how many points were marked as noise; class 7 (Low noise) is hidden in the legend. Click Undo in the notice: the original cloud returns.
7. Save cleaned copy: keep or change the name, click Save. A layer "name (cleaned)" appears and the original is hidden; the original file is unchanged.
8. Right-click the point cloud layer in the sidebar: Clean up..., Remove noise..., Save cleaned copy..., Reset cleanup are there.
9. Export the cloud (Site data, Export survey data, point cloud) with "Apply cleanup" on: the exported LAZ leaves out clipped, deleted and hidden-class points.

Noise and save need pack 0.12.0; with an older pack the panel says to update it in Settings, Processing tools, while the live tools still work.

## Open threads

- Measure PDAL peak memory and time of noise and save on the real 21.7M-point cloud.
- Main-thread masking cost on large clouds; deleted points flicker in briefly while new chunks stream.
- Every project open rewrites each recipe (sweep), also for look-only reviewers.
- Split layout with no 3D pane: right-click Clean up does nothing.
- Flaky under load, not this branch's code: Stage.test.ts "shader programs made ahead of the frame" and the manifestFile.test.ts busy-flag tests (fixed real-time waits).
- The sidebar context-menu session moves the four cleanup actions into its shared registry when it rebases.

## Next session entry point

Land this branch (pack 0.12.0), then run the owed real-cloud measurement; the sidebar menu session folds in the four cleanup actions.

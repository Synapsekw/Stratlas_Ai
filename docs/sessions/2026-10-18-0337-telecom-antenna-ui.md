---
type: session
date: 2026-10-18-0337
branch: feat/telecom-ui
status: complete
related:
  [
    superpowers/specs/2026-10-17-telecom-antenna-detection-design.md,
    superpowers/plans/2026-10-17-telecom-antenna-detection.md,
    guide/45-antenna-inventory.md,
  ]
---

# Telecom antenna detection and its workbench UI

## What changed

- One-click antenna detection landed earlier (`9ec70e57`, #167, pipeline pack 0.14.0): the `telecom.antennas` job finds the tower crown, fits planar faces and boxes, and measures azimuth, downtilt, plumb, size and position into `telecom/antennas.json`; optional AI labelling sends photo crops only after a send preview. On the reference site it lists 34 units and matches all 6 manual azimuths (mean 0.86, worst 2.14 degrees).
- Recall fix (`dc02b62f`, #170): a face grown past its unit (up a pipe, into the frame beside it) is cut to its solid part before pairing, so the same panel is no longer kept in one sample of a crown and lost in another.
- This PR moves the temporary panel into the workbench: the Measure bench gets an **Antenna inventory** section (a 3D pick holds it open and scrolls to the row; a search shows it when its title matches), the CSV export is a tool next to **Export survey data** in Site data, and **Detect antennas** stays in the Telecom family.
- The AI send preview is a modal under `<body>` on the modal layer; a run that ends offers AI labelling from the store, and the stage mounts `AntennaRunner` (the inventory read, the boxes in 3D, the preview) in one marked block, so neither depends on the bench in front.

## Why

Merge 1 shipped with a temporary entry until the stage-island workbench existed; stage-island reviewed the wiring twice (one high, four important findings, then three minors), all fixed here.

## How to test

1. Open a tower project with a point cloud, open the **Measure** workbench, open **Telecom** and click **Detect antennas**; the jobs chip shows **Detecting antennas**.
2. When it ends, the **Antenna inventory** section lists the units by kind with their status; boxes show on the tower in 3D.
3. Fold the section, then click a box in 3D: the section opens and its row is in view. Click the section header: it folds.
4. Switch to **Selection**: the boxes stay in 3D.
5. In **Site data**, the document icon next to **Export survey data** opens **Include drafts** and **Export CSV**.
6. With **Label with AI** on in the detection options and a provider set, a finished run shows **Send photo crops for labelling** over the whole window.

## Open threads

- No e2e clicks a box on the canvas (the scroll timing is unit-tested with fake timers).
- Thresholds are tuned on one reference site; rooftop sites, electrical tilt and magnetic north are not supported (`KNOWN-LIMITS.md`).
- A lone front whose lower part is hidden by a plate in front, with no sides seen, stays out by design.

## Next session entry point

After this PR lands, the RF coverage UI (`feat/rf-ui`) reads the inventory; antenna work resumes only on founder feedback from the next build.

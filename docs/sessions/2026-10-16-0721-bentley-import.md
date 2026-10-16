---
type: session
date: 2026-10-16-0721
branch: feat/bentley-import
status: complete
related: [plans/2026-10-15-bentley-import-design.md, plans/2026-10-15-bentley-import.md]
---

# Bentley import

## What changed

- Landed as PR #146, main `d0740d93`, pipeline pack 0.10.0, data conventions section 36, and a contract-changes row adding optional `PhotoRef.lens` (`cx, cy, k1..k3, p1, p2`).
- **`.zpc` import:** a `.zpc` (Bentley iTwin Capture Modeler: a ZIP of LAZ tiles) imports through Add data as one COPC layer, built from the folder of tiles with untwine. A card asks for the survey date, prefilled from the LAS header, because the header holds the export day.
- **AT XML import:** a BlocksExchange AT `.xml` plus a photo folder becomes the `bentley.import` job. It is written as an imported run like `opf.import`, with a photos layer placed by Bentley's poses (world to camera, rows right, down, forward) and photos matched by file name in subfolders. The parser reads only the direct pose and ignores `Pose/Metadata`, which holds a decoy GPS pose. Photos get 2560 px review copies.
- Rulings: the survey date card; the P1/P2 swap against OpenCV is assumed and unverified (no tie points in the export; under 0.4 px; nothing reads it); untwine replaces the planned merge-copc port (each tile has its own offset).
- Reference job check, on a real job not in the repo: the `.zpc` imported in 220.8 s, giving 125,562,135 points (836 MB COPC). The XML has 560 of 560 photos aligned, with 98% of cameras facing the cloud at 4.9 to 15.6 m. Photo matching on the real photos is not done yet: the photos are not on this PC.

## Why

Telecom tower inspection jobs arrive already aligned in Bentley. This feeds findings-on-model placement (posed photos and a cloud in the same frame, the same capture date) with no ODM run.

## How to test

1. Open a project in UTM 40N (EPSG:32640) and click Add data.
2. Pick the `.zpc`. Set the flight date on the card and click Import. One cloud layer appears under that date, after about 4 min for 125M points.
3. Add data the AT `.xml` and pick the photo folder. A photos layer appears with cameras ringed around the cloud; click one and its photo opens. The job log shows the matched, missing and unaligned counts.

## Open threads

- Run photo matching on the real job once its photos are on this PC.
- The P1/P2 distortion convention needs a tie-point export to confirm.
- The north-first axis order is untested.
- Peak memory of the import was not measured.

## Next session entry point

Get the real job's photos onto this PC and run the AT import against them; then try the steps above in the next build.

# N1: model add-ons outside the Analytics pack (plan, 11 Nov 2026)

Wave 3 item N1 of `plans/2026-10-30-intelligence-review.md` (study `vision.md` 3.11-3.13, `research.md` 2; founder decision 4). Built autonomously on the founder's go of 11 Nov; every call below is made on the founder's behalf.

## Goal

A small add-on pack mechanism, downloaded on demand from Settings > Models and detection (one click, size shown first, progress, SHA-256 check, removable) with a "Choose file" fallback, and three add-ons on it, each wired where it belongs and only active when installed:

1. **Road defects** (`road-defects`, kind `detector`): a YOLO ONNX detector (`model.onnx` + `aio.detector/1` card). It is listed with the detection models (`where: 'addon'`) and runs in the existing local ONNX detection (Inspect, Ask AI on this computer).
2. **Segmentation** (`segmentation`, kind `segmenter`): a SAM-class ONNX encoder and decoder that replace the pipeline pack's model for Suggest boundaries and the Review mask assist, and unlock **2D-to-3D lifting**: a photo mask goes through its photo's camera onto a point cloud (`segment.lift`), as a cleanup region with a depth band, so the cloud can be classified from photo masks.
3. **Ground classifier** (`ground-classifier`, kind `point-classifier`): `classifier.json` with PDAL SMRF settings; a point cloud noise run also marks ground (class 2).

The full Analytics pack (6,886/7,000 MB) is not touched.

## Decisions

- **Archive and catalogue.** `<id>-<version>.aioaddon` is a gzipped tar with `addon.json` (`aio.addon/1`) and its files. `catalogue.json` (`aio.addon-catalogue/1`) at a configurable base URL lists each add-on with its archive's URL, size and SHA-256, so the size shows before the download and the archive is checked before it is opened; each file is then checked against the manifest. Base URL: Settings `addons.baseUrl`, overridden by `QUADRION_ADDONS_URL`; the build has no built-in address yet (nothing is published, per the brief), so until one is set the page offers Choose file only and says why.
- **Where they live.** `<dataRoot>/runtime/addons/<id>/`, beside the packs. A new version replaces the old one atomically (staging folder, rename).
- **Choose file** checks every file's SHA-256 against the archive's manifest; when the catalogue is reachable and lists that version, the archive's own SHA-256 too.
- **Offline only** blocks downloads and the catalogue read, never Choose file.
- **Licences.** The person sees the licence before download. A detector add-on takes the import gate of `licence.ts` (warning shown). The segmenter add-on takes the relaxed gate as well, with the warning shown, since SAM 3 ships under Meta's own SAM License, which the founder approved for internal use (bench 22-23 Oct); the pipeline pack's own model keeps the strict gate.
- **SAM 3 in ONNX, not PyTorch.** The add-on carries a SAM-class ONNX export so it runs in the app's existing onnxruntime worker; no PyTorch runtime ships. The interface is the one MobileSAM already uses (`segment.ts`).
- **Lifting** is a Python job (`segment.lift`) that reads the cloud, projects it through each mask's posed photo, keeps the points the photo saw (a depth buffer), and answers a lasso region in that camera's clip space with a depth band (`CleanupRegion.depth`, new optional field). The recipe stays the only source of truth, and the viewer and the pipeline evaluate the region the same way (shared vectors).
- **Ground** is PDAL SMRF (`filters.smrf`, ignoring class 7) inside the noise run, so the existing working copy, recipe and save flow carry it unchanged. Main fills `ground` from the installed add-on in the job gate and drops any the window sent.
- **Pack.** `POINTCLOUD_GROUND_MIN_PACK` and `SEGMENT_LIFT_MIN_PACK` are 0.35.0, the batch's shared bump.
- **Bench.** `tools/detectors/bench.py` gains `--drafts <aio.detections file>` so a detector that is not a VLM (the road YOLO run in the app) is judged with the same truth, IoU matching and references.

## Contract changes

New `aio.addon/1`, `aio.addon-catalogue/1`, `aio.point-classifier/1` (`packages/schema/src/addons.ts`); IPC `addons:list|install|choose|installFile|cancel|remove`, event `addons:progress`; Settings `addons.baseUrl`; `DetectorModelInfo.where` gains `addon`; `CleanupRegion.depth?` and `label?`; `NoiseParams.ground?`, `NoiseRun.groundMarked?`, `pointcloud.clean` noise `ground?`; new job `segment.lift` (`SegmentLiftParams`, `SegmentLiftResult`). One row "Add-on pack manifest" in `docs/architecture/contract-changes.md`.

## Tasks

| Task | What                                                                                                                                                                                                                                         | Packages                                                                | Tests                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | Schema contracts above                                                                                                                                                                                                                       | `packages/schema`                                                       | schema tests for the manifest and catalogue                                                                                                             |
| T1   | Main: add-on catalogue, download (`downloadVerified`), unpack, checks, install, remove, IPC, preload; integration in the model registry, the segmenter lookup, the `pointcloud.clean` gate and pack refusals; `tools/addons/build-addon.mjs` | `apps/desktop` main, preload, `tools/addons`                            | vitest: catalogue parse, install from a fake server, tampered archive, size mismatch, offline refusal, choose file, remove, registry listing, gate fill |
| T2   | Python: SMRF ground in the noise run; `segment.lift`; depth band in both evaluators and the shared vectors; `bench.py --drafts`                                                                                                              | `python`, `packages/pointcloud`, `tools/detectors`                      | pytest: ground on a synthetic cloud (PDAL), lift on a synthetic posed camera, vectors; vitest vectors; bench test                                       |
| T3   | Renderer: Add-ons section in Models and detection, Mark ground in the cleanup panel, "Classify on point cloud" on a detection mask                                                                                                           | `apps/desktop` renderer, `packages/ui` i18n, `packages/ai` action specs | vitest for the store; e2e `addons.spec.ts`                                                                                                              |
| T4   | Pack bump 0.35.0 (or a line in it), notes, guide, contract row, session note                                                                                                                                                                 | `python`, `docs`                                                        | `pnpm check`                                                                                                                                            |

## Execution DAG

```
T0 (schema) --> T1 (main)     --+
            --> T2 (python)   --+--> T4 (pack, docs, checks)
            --> T3 (renderer) --+    (T3's e2e runs after T1)
```

- Batch 1, in parallel after T0: T1, T2, T3 (no shared files: main and preload / python, pointcloud, tools/detectors / renderer, ui, ai).
- Critical path: T0 → T1 → T3 e2e → T4.

## E2e

- New `apps/desktop/e2e/addons.spec.ts`: a loopback fake server (allowed by the zero-network guard) serves a catalogue and three small archives built from the synthetic marker detector, the synthetic colour segmenter and a classifier file. Download with size and progress, the detector listed from the add-on, remove, a tampered archive refused with its reason, Choose file offline.
- Existing specs that exercise touched pipelines: `pointcloud-clean-export.spec.ts`, `detect-local.spec.ts`, `settings-pages.spec.ts`, `analytics-settings.spec.ts`.

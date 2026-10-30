# Vision and 3D intelligence audit (30 Oct 2026)

Read-only audit of worktree `E:\Dev\AIO Software\.claude\worktrees\intelligence-review`. Paths are relative to the repo root. Line numbers come from grep or reads at this commit; numbers marked "(agent)" came from survey subagents and were not each re-read by hand.

## Headline

The app does far less learned interpretation than its features suggest. Only three things in it use a learned model:

1. The local VLM detector (`detect.vlm`, Qwen3.5-9B in Analytics pack 0.2.0).
2. Custom analytics asks, which use the same local model or cloud Claude/OpenAI.
3. A user-imported ONNX YOLO model for 360 video.

Everything else is classical geometry or image rules: telecom antennas, the engineering model, cloud cleanup, area change, road PCI and thermal. Some of that is well engineered, but none of it is measured against ground truth.

Only one detector ships: corrosion on metal. It is still marked experimental and its Qwen3.5 bench was a no-go. Reviews are logged, but the only use of them is a suggested threshold. Nothing links a 2D detection to 3D automatically, and nothing tracks an object across survey dates except issues a person confirms.

## 1. Inventory

### Local VLM detectors (`detect.vlm`)

- **Code:** `python/src/aio_pipelines/detect/engine.py` and `detect/pipeline.py`. The llama-server is launched by `apps/desktop/src/main/analytics/server.ts` (~293-312) with `--ctx-size 8192 -ngl 99 --parallel 1` and `--reasoning off` for Qwen3.5.
- **Method** (`engine.py:1-12`):
  - Cut the photo into a 2x2 grid with 20 % overlap.
  - Resize each tile to 1344x1008.
  - Ask for `bbox_2d` JSON.
  - Map the boxes back and merge them with containment-share 0.6.
  - Re-ask each crop as a yes/no question and score it P(yes)/(P(yes)+P(no)) from first-token logprobs.
- **Constants** (`engine.py:33-39`): MIN_BOX_PX 8, MERGE_SHARE 0.6, CROP_PAD 0.15.
- **Parser repair:** handles the Qwen `}}` bug the bench found (`engine.py:197-230`), so phase 1 of the 23 Oct plan is partly done.
- **Output:** an `aio.detections/1` draft pass (`detect/pipeline.py:1-18`). Every candidate is kept. A candidate under the threshold carries `belowThreshold`, and one with no score carries `unscored`.
- **The one shipped detector:** `tools/analytics-pack/detectors/plant/corrosion-metal/detector.json`.
  - Threshold 0.8.
  - Its `tunedOn` still names `qwen2.5-vl-7b`, but the pack now ships Qwen3.5-9B.
  - `tools/analytics-pack/README.md` (~33) records the Qwen3.5 bench as "no go": truth too thin, 0.5 false drafts per photo on the chimney project.
- **Evidence:**
  - 22-23 Oct bench: Gemma 4 E4B F1 0.52 on chimney, Qwen3.5-9B road F1 0.37, SAM 3 road recall 45 %.
  - 27 Oct bench (`docs/superpowers/specs/2026-10-27-custom-analytics-design.md:14-27`): gauge finding F1 0.93-1.0 for every model. Corrosion: cloud best F1 0.34, local at most 0.10. Qwen3.5 found 2 of 14 ortho changes, against 10-11 for the cloud models.
  - None of this data is in git.

### Custom analytics (`packages/ai/src/ask.ts`)

- **Request kinds:** plain-words Find, Compare dates and Ask, with up to 12 typed fields per item.
- **Routing:**
  - Find and count run locally.
  - Changes and text go to Sonnet 5.5, bulk to Haiku 5.5.
  - Default routes are in `packages/ai/src/routes.ts:77-81`.
- **Guards:** whole-frame boxes out (`WHOLE_FRAME = 0.9`, `ask.ts:264`), tiny boxes out, merge, and a cap of `MAX_ASK_ITEMS = 30` (`ask.ts:26`).
- **Default:** cloud AI is on for new installs. `aiPolicy: forbid` keeps a project's images on this PC.
- **Limits:** no sample images, so no few-shot. Answers land as dashed drafts and Accept turns them into issues.

### 360 video detection

- **Code:** a user-imported ONNX YOLO model running in the main-process inference worker (`apps/desktop/src/main/inference/{detect,layouts,nms,seam,tile}.ts`).
- **Method:** letterbox, wrap-around tiles, then NMS and a seam merge.
- **Evidence:** parity only, not accuracy. 17 of 18 boxes match the Ultralytics reference, mean IoU 0.85-0.97 (`docs/sessions/2026-10-18-2345-local-detection-360-video.md:18`).
- **Gaps:**
  - Frame detections are skipped by inspection placement (`python/src/aio_pipelines/inspection/detections.py:19, 228-229`), so they are never on the map or model.
  - There is no frame-to-frame tracking, so one worker gives a box per frame.

### Telecom antennas (`python/src/aio_pipelines/telecom/*`)

- **Method:** classical.
  - Crown/axis detection.
  - Planar faces from PCA normals plus RANSAC (`faces.py:21-64`: voxel 1.5 cm, RANSAC 8 mm, min face 8 cm).
  - Faces paired into boxes, with size rules for kind (`boxes.py:40-76`), and circle fits for dishes.
- **Cloud labelling:** `packages/ai/src/antennaLabel.ts` picks one label per crop.
- **Photo links:** each unit links to its top 3 photos with no occlusion test (`photos.py:1-12`).
- **Re-runs:** deletions block re-detection within 0.3 m (`merge.py:39`).
- **Evidence:** one reference site with 34 units and 6 of 6 azimuths within 2.14° (agent). No precision/recall bench.

### Engineering model (`engineer/*`, job `model.evidence`)

- **Method:** classical fits (axis, slice circles, members, supports, hardware).
- **Photos:** evidence images only, never used in the geometry.
- **Bench:** `python/scripts/engineering_bench.py` drives a run but computes no metric.
- **Live AI correction:** not yet evaluated (agent: session 2026-10-16-1700).

### Point cloud cleanup and classification

- **Automatic:** only noise, written as class 7, from PDAL statistical outlier (meanK 8, multiplier 2.0) plus optional `filters.elm` (`pointcloud_cleanup/pipeline.py:44-45`).
- **Manual:** everything else is a recipe of box and lasso selections.
- **Missing:** no ground, vegetation or structure classifier. "Point cloud segmentation with hand correction" is planned only (NORTH-STAR §3).

### Area change detection (`python/src/aio_pipelines/change/*`)

- **Imagery:** gradient, SSIM or RGB difference with a measured noise floor (`raster.py:93` NOISE_FLOOR 5.0) and light-change suppression.
- **Registration:** phase-correlation tiles that refuse misaligned pairs (`register.py:132` and around it).
- **Clouds:** cloud-to-cloud distance (`cloud.py:61` SIGNIFICANT_M 0.05).
- **Thresholds:** the founder's "conservative" preset, never tuned on data.
- **Missing:** no semantic label of what changed.

### Thermal (`thermal/*`)

- **Built (M1):** decode only.
  - FLIR parser and DJI TSDK binding to float32 °C rasters.
  - Evidence: within 0.01 °C of an independent reference, byte-identical to `dji_irp`, 54 of 54 photos parse.
- **Not built:**
  - Hot-spot detection, isotherms and georeferenced readings (M2+).
  - Absolute-accuracy ground truth (plan:473).

### Road (`road/*`)

- **Method:** ASTM D6433 PCI from defect polygons (`pci.py`).
- **Missing:** no detector. Defects arrive from an import.
- **Evidence:** parity with a delivered build. No imagery model.

### Inspection placement (`inspection/*`, `aik/*`)

- **Method:**
  - Back-project accepted boxes onto the mesh with a 5x5 ray grid and the median hit.
  - Cluster same-class hits within `clusterM`.
  - Keep stable issue ids.
- **In the renderer:**
  - `annotate/src/crossview/place.ts` places a single finding on demand.
  - Cross-date issue matching (`packages/change/src/issues.ts:20-38`) suggests matches by class within max(0.5 m, 2 % height), and a person confirms.

## 2. Gaps

1. **No evaluation sets or metrics in the loop.**
   - `tools/detectors/bench.py` is good:
     - a hash split, 30 % tune and 70 % bench (`bench.py:49-51`);
     - a hit means the draft box contains the truth centre;
     - recall, plus false drafts per photo.
   - It is a dev command, its reference data lives in scratchpads, and nothing runs it on a model or prompt change. There is no gold set for telecom, change, cleanup, engineering or video.
   - The "hit = contains centre" rule rewards huge boxes. There is no IoU or precision at fixed recall.
2. **Corrections are logged, not learned.**
   - Every accept, reject and box edit goes to a per-detector ledger with a 512 px crop (`apps/desktop/src/main/analytics/ledger.ts`).
   - The only use is `suggestThreshold` (`ledger.ts:105`, after 20 scored reviews), which is shown, never applied.
   - Detector `samples` and `examples` (is / is-not) are stored and exported but never sent to the model. `detect/engine.py` has no reference to them, and `detect_prompt` (`engine.py:152-157`) only fills `looksLike` and `ignore`.
   - Telecom deletions and edits never retune a rule.
3. **Prompts and model drift.**
   - The detector's `tunedOn` is stale after the model swap.
   - The 27 Oct bench says Qwen3.5 returns 3-10x more boxes on the old prompt.
   - `detect.vlm` has no box cap, although the ask path caps at 30 and the 23 Oct plan's phase 1 asked for one. `run_detector` keeps every merged candidate and pays one verifier call per candidate (`engine.py:388-390`), so a runaway list costs minutes per photo.
   - Gemma's `[y,x,y,x]` frame is not supported by `box_frame` (`engine.py:166-172`), which knows only pixels and Qwen3 rel1000.
4. **Merge rule.** Largest-first containment (`engine.py:262-268`) keeps the big box and drops the precise small one inside it. That is the wrong preference for defects.
5. **Tiling.**
   - Fixed at 2x2 by default. The 27 Oct bench found tiling halves precision for gauge-sized objects.
   - Tile size takes no account of ground sample distance, although camera height and focal length are known for posed photos.
6. **No automatic 2D-to-3D fusion.**
   - VLM drafts reach 3D only through accept, then inspection placement or a manual "Place on model".
   - The same defect seen in 8 photos is 8 drafts to review. There is no multi-view vote before review, although `aik.project` already gives each box a 3D point.
7. **Temporal tracking.**
   - Only issues have tracks, and a person confirms them.
   - Telecom units, change regions, thermal readings and 360 detections are per-date islands.
   - Corrosion growth ("this spot got worse") cannot be asked.
8. **GPU.**
   - The VLM uses the GPU fully (`-ngl 99`), but with `--parallel 1` and one request at a time.
   - All 3D work (telecom, engineer, cleanup, change cloud) and change imagery run on CPU numpy/scipy/PDAL.
   - Single-threaded per-photo decode loops are covered by the other session's job-performance study; see that report.
9. **3D semantics are missing entirely:** no ground, vegetation or structure segmentation, and no texture-based defects on meshes.

## 3. Improvements, ranked by impact over effort

Pack budget: the Analytics pack archive is 6,886 MB against 7,000 MB (`tools/release/budgets.mjs:54`). That leaves about 114 MB. Any new model below says how it fits.

| # | Change | Impact | Effort | Evidence | Model fit |
|---|---|---|---|---|---|
| 1 | Cap candidates per tile and per photo in `run_detector` (for example 30, the ask-path value), and send the cap in the prompt | High: stops runaway Qwen3.5 lists and verifier cost | XS | `engine.py:388-390`, `ask.ts:26` | none |
| 2 | Re-tune and re-bench corrosion on Qwen3.5 with a larger `--limit`; update `tunedOn`; run `bench.py` in a pre-release script for every shipped detector, with stored reference results | High: the only shipped detector is unproven on the shipped model | S | detector.json, analytics-pack README ~33, `bench.py` | none |
| 3 | Few-shot from `examples`: put 2-4 is / is-not crops in the detect and verify prompts (multi-image chat already works with llama-server) | High: uses data users already curate | S | `engine.py:152-157`, schema `analytics.ts` ~90-105 | none |
| 4 | Feed the ledger back: auto-add rejected crops tagged `looks-like-but-is-not` as is-not examples; offer "apply suggested threshold" once there are 20+ reviews | High: closes the loop | S-M | `ledger.ts:13,105`, `RejectReasonMenu.tsx` | none |
| 5 | Better metrics in `bench.py`: IoU ≥ 0.3 matching, precision, and a PR curve per threshold, in place of the centre-contains rule alone | Medium-high: honest go/no-go | S | `bench.py:81, 233-251` | none |
| 6 | Multi-view vote before review: project each draft with `aik.project`, cluster across photos, show one draft per 3D cluster with an n-views count, and boost confidence with agreement | High: fewer reviews, fewer false alarms | M | `inspection/frame.py`, `aik/records` | none |
| 7 | Merge rule: prefer the higher-scored or smaller box when one contains another, or use IoU NMS after scoring | Medium | XS | `engine.py:262-268` | none |
| 8 | GSD-aware tiling: choose `n` from object size in metres and the photo's GSD; send small-object classes at full resolution | Medium | S | `TILES_DEFAULT` `engine.py:33` | none |
| 9 | Place 360 detections: project frame boxes through the walk pose onto the mesh or map, and track across frames (IoU tracker) so one object is one draft | Medium-high for PPE and walk audits | M | `inspection/detections.py:228-229` | none |
| 10 | Temporal links: carry issue `track` matching to telecom units (box centre within 0.3 m after the date shift) and to change regions; show per-track trends (corrosion area, PCI, max °C) | High for repeat customers | M | `packages/change/src/issues.ts:20-38`, `telecom/merge.py:39` | none |
| 11 | Road YOLO trained from the 2,115 reviewed defects, run in the existing ONNX worker | High for road | M | memory bench; `inference/*` | 20-60 MB ONNX: download on demand or an optional add-on, never inside the Analytics pack |
| 12 | SAM 3 masks for road recall (45 %) and for cloud-segmentation hand correction | Medium-high | M-L (PyTorch runtime, gated licence) | memory bench | Too big for the 114 MB left: an optional "Segmentation" add-on pack, downloaded on demand |
| 13 | Point cloud ground/vegetation/structure classifier: PDAL SMRF/CSF for ground (no model), then a small ONNX point model | High for the planned segmentation milestone | M-L | NORTH-STAR §3; `pointcloud_cleanup/pipeline.py:44-45` | PDAL is already in the pipeline pack; the point model is an add-on downloaded on demand |
| 14 | Thermal M2: rule-based hot-spot finder (ΔT over a local median, min area), then georeference via the existing ray placement | Medium-high | M | `thermal/raster.py`, plan:5 | none |
| 15 | Gemma 4 E4B: do not add it next to Qwen3.5 | Low | none | 27 Oct bench favours Qwen3.5 for reading; Gemma wins chimney | Only as a swap after a `bench.py` win on the shipped detectors; never both in one pack |
| 16 | Change semantics: send each change region crop pair to the custom-analytics Compare route (cloud, or local where `aiPolicy` forbids) for a kind label | Medium | S-M | `change/raster.py`, `ask.ts` routes | none (cloud) |
| 17 | Telecom photo occlusion test: depth-test the box against the cloud before ranking the top 3 photos | Medium for label quality | S | `telecom/photos.py:1-12` | none |

## Suggested order

1. **Quick fixes:** items 1, 7, 5 and 2. Make the shipped detector honest on the shipped model.
2. **Learning loop:** items 3 and 4. This turns reviews into accuracy without any new weights.
3. **Fewer reviews, links across dates:** items 6, 9 and 10.
4. **New models:** items 11-13, all outside the full Analytics pack, as on-demand or optional add-ons.

# ADR 0011: Magic polygon model (MobileSAM in the pipeline pack)

- Status: **Accepted, 10 Oct 2026.** M11 decision 4 (magic polygon model and weights); founder approved G12, the model downloads for the spike and shipping the model inside the pipeline pack (10 Oct 2026, in the M11 Build session).
- Deciders: founder; integration lead (M11 G12)
- Plan: `docs/plans/2026-10-07-m11-surveying.md`, decision 4 and "G12 Local AI helpers"
- Contracts: `@aio/schema` `ipc.ts` (`surveyAi:suggest`, `surveyAi:status`); data-conventions sections 16 (the boundary model) and 27 ("Suggest boundaries"); code: `apps/desktop/src/main/inference/segment.ts`, `apps/desktop/src/main/surveyAi.ts`, `apps/desktop/src/renderer/survey/MagicPolygon.tsx`, `apps/desktop/src/renderer/survey/orthoCrop.ts`, `apps/desktop/src/renderer/survey/snapRegions.ts`, `tools/pipeline-pack/sam.mjs`

## Context

**Suggest boundaries** turns one click on an ortho into a draft polygon (a stockpile toe, a pad, a pit), and the AI cut and fill breakdown snaps the whole-site comparison's regions to the edges seen in the ortho. Both need a promptable segmentation model that runs on the CPU of an ordinary laptop, offline, in under 1.5 s per click, with an outline that matches the truth (IoU at least 0.85 on the synthetic piles). The app already runs onnxruntime-node in the inference utility process (M8, BLD-10) and the Review mask assist already reads a SAM-class model from the pipeline pack (`models/sam/`), so the question is which model, and how it reaches a person's computer.

## Options considered

Three Apache-2.0 models, each as a ready-made ONNX export (encoder plus prompt decoder), downloaded for the spike to a cache outside the repository (`%LOCALAPPDATA%\QuadrionDev\model-cache\g12`, never committed):

| Model                                    | Export used                                                                                               | Source (pinned)                                                                                                                   | Licence                                                                         | Size                                  | SHA-256 (encoder / decoder)               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| MobileSAM (TinyViT encoder, SAM decoder) | `PulpCut/mobilesam-onnx` `mobilesam.encoder.onnx`, `mobilesam.decoder.onnx`                               | https://huggingface.co/PulpCut/mobilesam-onnx at `1e774d85`; weights from https://github.com/ChaoningZhang/MobileSAM              | Apache-2.0 (upstream repository and weights; the export repository states none) | 28.2 + 16.5 MB                        | `4125037c5e24d6ea…` / `b0735abf07c7affd…` |
| EfficientSAM ViT-T                       | `weights/efficient_sam_vitt_encoder.onnx`, `..._decoder.onnx`                                             | https://github.com/yformer/EfficientSAM at `d525f622`                                                                             | Apache-2.0                                                                      | 24.8 + 16.6 MB                        | `84ed466ffcc5c1f8…` / `a62f8fa5ea080447…` |
| SAM 2.1 Hiera tiny                       | `onnx/vision_encoder.onnx`, `onnx/prompt_encoder_mask_decoder.onnx` (fp32 and the int8 `_quantized` pair) | https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX at `814a0666`; weights from https://github.com/facebookresearch/sam2 | Apache-2.0                                                                      | 134.4 + 21.2 MB (int8: 53.0 + 9.0 MB) | `4f30aacd3aaefbca…` / `874414704c5d686d…` |

Not SAM 3 (custom licence, decision 4). Full checksums are in the cache's `SHA256SUMS` and, for the shipped model, in `tools/pipeline-pack/sam.mjs`.

**Spike** (`onnxruntime-node` 1.30 CPU, the app's runtime): 44 synthetic crops of 1024 x 1024 pixels with exact truth outlines from the G13 generator (`python/tests/survey_synth.py`): the quarry demo's seven pile dates as the demo renders them, the same seven with sand-coloured piles (only shading and texture tell them apart), and 30 random piles (cone, frustum, paraboloid, mound, prism, wedge; 6 to 22 m; low-contrast colours; zero to two neighbours that may touch; a sloping ground). One positive click per pile, jittered within 30% of its radius; the model's own best-scored mask is the answer.

| Model               | IoU mean  | IoU worst | Crops at IoU 0.85 or more | Per click, all cores | Per click, 4 threads | Decoder only (a second click on the same crop) |
| ------------------- | --------- | --------- | ------------------------- | -------------------- | -------------------- | ---------------------------------------------- |
| **MobileSAM**       | **0.989** | **0.955** | **44 / 44**               | 0.58 s               | **0.65 s**           | 37 ms                                          |
| EfficientSAM ViT-T  | 0.854     | 0.148     | 37 / 44                   | 0.76 s               | 0.71 s               | 26 ms                                          |
| SAM 2.1 tiny (fp32) | 0.796     | 0.145     | 34 / 44                   | 0.88 s               | 1.63 s               | 60 ms                                          |
| SAM 2.1 tiny (int8) | 0.799     | 0.133     | 34 / 44                   | 0.78 s               | 1.62 s               | 58 ms                                          |

EfficientSAM and SAM 2.1 hold the right outline among their three masks (best-of-three IoU 0.989 to 0.990) but score a part of the pile (a frustum's flat top, one face of a wedge) higher, so their own choice misses; MobileSAM's choice was right on every crop. SAM 2.1 tiny misses the latency target with four threads (a laptop's share).

**Delivery options:** (a) in the installer: always there, but even the smallest model is 44 MB against an installer growth budget of 15 MB over 0.9.0 (`tools/release/budgets.mjs`); (b) a separate model pack a person imports, as map and geoid packs: one more file to find and install; (c) inside the pipeline pack, which every surveying feature already needs (the survey pipelines run there): nothing extra for the person.

## Decision

1. **MobileSAM** is the magic polygon model, from the pinned export above. It meets both quality targets on every synthetic crop with margin, is the smallest, and its decoder takes the standard SAM prompt inputs the Review mask assist already uses.
2. **It ships inside the pipeline pack** in `models/sam/` (`encoder.onnx`, `decoder.onnx`, `model.json` with `name`, `version`, `licence` `Apache-2.0`, `source`, `sha256` and `input`). The pack build fetches the two files from the pinned URLs and refuses them unless their SHA-256 matches (`tools/pipeline-pack/sam.mjs`, as PDAL's lock does); weights never enter git. The pack grows by about 44 MB unpacked (budget: 1.1 GB unpacked, 450 MB compressed).
3. **No download, no pop-up.** The app makes no network call (zero network). Without the pack, or with a pack that carries no model, **Suggest boundaries** stays visible and says what it needs ("Suggest boundaries needs the pipeline pack ..."); the first-start welcome's pipeline pack line names it too. The Review mask assist uses the same model.
4. **The model card says how the encoder takes its image** (`input`: `hwc-255`, an H x W x 3 image of 0 to 255 values, as this export takes; or `nchw-imagenet`, the 1 x 3 x 1024 x 1024 ImageNet-normalised tensor of the usual SAM export, the default when absent), so a later re-export from the official checkpoint drops in without code changes.
5. **Licence check:** the card's licence passes the M8 model licence gate (`inference/licence.ts`); a pack whose card names a licence the gate refuses is not used.
6. The click runs on a 1024 x 1024 crop of the ortho the renderer composes from the layer's own image or tiles (never the map or 3D canvas, so measurements and labels drawn on it never reach the model): 60 m around the click, grown to 120, 240 and 480 m while the outline reaches the crop's edge. The embeddings of the last crop are kept, so a second click, the buffer (keys U and I) and the vertex count (keys J and K) answer in a fraction of a second. The same call snaps the whole-site comparison's draft regions (`snapRegions.ts`): the outline is taken only when its overlap over union with the rule-based region is at least 0.5.

## Consequences

- The synthetic crops are simple (uniform materials on sand); real orthos have shadows, vehicles and touching piles. The founder's real-data checks (TESTING stage M11) decide whether the DSM edge channel the plan mentions is needed; until then the outline comes from the ortho alone, and KNOWN-LIMITS says so.
- The AI cut and fill breakdown stays rule-based on the `change.surface` and whole-site regions (decision 4); the model only proposes snapped boundaries as drafts.
- A future model (a re-export, a larger SAM) is a pack change with a new card, not an app change.
- Checked end to end on 10 Oct 2026: `segment.ts` with the shipped export on the 44 crops gives IoU 0.985 mean and 0.948 worst (the polygon, after simplifying), 0.55 s a click and 0.17 s for a buffer or vertex change; in the app on the quick quarry demo the first click on Stockpile SP1 (model load included) answers in 1.4 s with an outline of 58 points, 969 m2 against the cone's 1,018 m2; the Review mask assist outlines six crops from a box within 2% of the true area.

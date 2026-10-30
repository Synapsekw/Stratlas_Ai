# Intelligence study: competitor AI, offline models, agent patterns (30 Oct 2026)

Web research for Quadrion AI. A note on how much to trust it: vendor pages are marketing. Secondary blogs disagree on dates and sizes, and I mark where they do. Every model claim below is the authors' own and has not been replicated. Treat it as a shortlist to benchmark, not a ranking.

## 1. What competitors ship (2025-2026)

**DroneDeploy** is the most aggressive.
- Progress AI (early access, July 2026 quarterly release) fills P6 schedule actuals automatically from captures, writes schedule-deviation reports with an XER export, shows progress trends by trade and level, and sends "morning reports" that flag stalls. It also has an AI chat for trade-coordination questions.
- The Progress AI MCP server lets Procore, Copilot and Claude query progress data from outside DroneDeploy.
- A ground-robot "Capture Agent" walks sites after hours by following the drawings.
- Inspection AI, from Horizons 2025, ranks issue severity in imagery and pushes findings into maintenance systems.
- Sources: https://dronedeploy.com/blog/whats-new-in-dronedeploy-july-2026-quarterly-release, https://dronedeploy.com/blog/dronedeploy-unveils-agentic-ai-and-robotics-products-at-horizons-2025, https://dronelife.com/2025/10/28/dronedeploy-ai-agents-automation-industries/
- Lesson: their AI is valuable because it writes into schedules (P6) and CMMS systems, not because it has a chat window. MCP is now table stakes for being queried by other agents.

**Propeller** shipped little that is labelled AI.
- Its June 2026 "Release Blitz" was about capture: daily automated site capture, handheld scanning (beta), next-gen 3D measurement and DirtMate RTK.
- It also showed an AI CAD concept generator that drafts designs on survey data from a text description and exports DXF/TTM.
- It acquired Spacesium in February 2026 to automate mining and aggregate workflows.
- Sources: https://www.propelleraero.com/june-2026-release-blitz/, https://www.propelleraero.com/blog/propeller-acquires-spacesium/
- Lesson: civil and mining customers pay for survey-grade measurement they trust. AI is welcome where it removes clicks, such as auto-capture, design drafts and stockpile toe detection.

**Pix4D** (PIX4Dinspect / PIX4Dcloud).
- Automatic telecom inventory: it detects panel and microwave antennas and computes azimuth, downtilt and height.
- An AI image filter drops redundant photos. Pix4D claims 250 images give results comparable to 2,500.
- Inspectors review detected faults next to the original images.
- Sources: https://pix4d-com-preview.netlify.app/blog/streamlining-telecom-inspections, https://geospatialworld.net/news/pix4dscan-and-pix4dinspect-launched-to-assist-inspections-and-asset-management
- Lesson: this is the closest match to Quadrion's antenna work. The bar is "a measurement plus the source photo next to it".

**Skydio** puts its AI into capture, not analysis. 3D Scan does surface-hugging autonomous flight to give complete coverage, and outputs feed other photogrammetry tools (https://www.skydio.com/blog/introducing-skydio-3d-scan).

**Bentley** has two threads.
- Engineering agents shown at its Year in Infrastructure event: an LLM orchestrates discipline-specific agents for grading, hydraulics and drawings (https://aecmag.com/ai/bentley-systems-shapes-its-ai-future/).
- iTwin Capture reality modelling moved into Cesium ion (https://dailycadcam.com/bentley-advances-cesium-with-reality-modeling-capabilities-brings-geospatial-context-to-infrastructure-engineering/?amp=1). Third-party comparisons note it is not self-service on lower tiers.

**Esri** ships pretrained point-cloud classifiers (trees, power lines) and train-your-own point CNNs in ArcGIS Pro behind the Image Analyst licence. Its 2026 direction is natural-language GeoAI assistants (https://doc.esri.com/en/arcgis-pro/latest/help/analysis/deep-learning/deep-learning-in-arcgis-pro.html, https://2026wagisconference.sched.com/event/2LTjk).

**Matterport**: Property Intelligence (2024) auto-derives measurements, floor plans and reports. Genesis (generative "defurnishing", layout) has no confirmed general release (https://www.geoweeknews.com/news/matterport-property-intelligence-ai-automation-reality-capture).

**Cyberhawk** upgraded iHawk with the AI tool Visualive and is being acquired by Ondas, with close expected in Q3 2026. **Nearthlab** focuses on AI wind-blade inspection. **Hammer Missions** raised EUR 1.6M in 2025 for AI development (https://www.eu-startups.com/2025/04/british-drone-startup-hammer-missions-secures-e1-6-million-to-expand-to-usa). I found nothing current on Unleash live.

**Valued vs fluff.**
- Valued:
  - measurable outputs: volumes, schedule actuals, antenna tilt and azimuth, defect counts with severity;
  - export into the customer's system of record (P6, CMMS, CAD);
  - fewer flights and photos;
  - every finding traceable to its source image.
- Fluff:
  - "digital twin + generative AI" visions with no shipping date (Genesis);
  - chat over data that cannot act or cite;
  - large-dataset claims ("20 trillion sq ft") that customers cannot verify;
  - mAP numbers from vendor test sets.
- Notably, nobody advertises offline or on-prem AI. That is Quadrion's open lane for sensitive sites and air-gapped clients.

## 2. Open models that run offline on one NVIDIA GPU

**Open-vocabulary detection and segmentation**
- **SAM 3** (Meta, Nov 2025, open weights): segments every instance of a text concept ("rusted bolt") or an image exemplar in images and video. Its SA-Co benchmark is released too. This is the core for "find all X". Sources: https://about.fb.com/news/2025/11/new-sam-models-detect-objects-create-3d-reconstructions/, https://en.papernotes.org/ICLR2026/segmentation/sam_3_segment_anything_with_concepts/
- **YOLOE** (Mar 2025): real-time text, visual or prompt-free detection and segmentation at 10-50M parameters. It suits a fast first pass over thousands of photos. Source: https://arxiv.org/abs/2503.07465
- **Grounding DINO 1.5 Pro** (47.6 LVIS zero-shot AP) and **OWLv2** (44.6) are stronger but heavier. GDINO 1.5 Pro is API-only, so the open Grounding DINO / OWLv2 are the offline options. Source: https://codesota.com/tasks/zero-shot-object-detection
- **Recommended pattern**: YOLOE or SAM 3 proposes boxes and masks, then a VLM verifies and describes each crop. This is cheaper and more accurate than asking a VLM to localise.

**Small VLMs**
- **Gemma 4** (2 Apr 2026, Apache 2.0): E2B, E4B, 26B-A4B MoE and 31B, all with vision and function calling. Source: https://simonwillison.net/b/9404 (sizes vary between secondary sources; check the HF card).
- **Qwen3.5 Small** (Mar 2026): 0.8B, 2B, 4B and 9B, natively multimodal. The 35B-A3B MoE is reported stronger at grounding and GUI tasks than Qwen3-VL. Source: https://docs.roboflow.com/changelog/explore-by-month/march-2026/qwen3.5-vl-in-workflows
- An A3B/A4B MoE model fits a 16-24 GB card quantised and is the sweet spot.

**3D point-cloud segmentation**
- **Point Transformer V3** is the backbone.
- **Sonata** (CVPR 2025) adds DINOv2-style self-supervised point features.
- **Utonia** (Mar 2026) trains one PTv3 encoder across remote-sensing, LiDAR, indoor, CAD and video-lifted clouds. It is the best candidate for drone photogrammetry clouds because of that domain mix. Train a light linear or head layer on a few hundred labelled clouds.
- Sources: https://github.com/pointcept/utonia, https://arxiv.org/abs/2603.03283, https://www.alphaxiv.org/abs/2503.16429
- For open-vocabulary 3D, lift 2D SAM 3 masks into the cloud through the known camera poses (OpenScene-style projection). Quadrion already has the poses from ODM, so this is easier than any native 3D open-vocab model.

**Change detection**
- Research has moved to training-free open-vocabulary change detection: SAM/DINOv2/DINOv3 propose class-agnostic changes, then CLIP or a VLM names them. Examples are AdaptOVCD, OpenDPR, CoRegOVCD and MemOVCD (2026).
- Naming the category, not finding the change, is the bottleneck. All of these target satellite imagery; I found no drone-specific model.
- Sources: https://arxiv.org/abs/2603.27645, https://arxiv.org/pdf/2604.26774
- Quadrion has co-registered ortho, DSM and clouds across dates. Geometric differencing (DSM/C2C) plus a VLM to label the changed regions is the practical path.

**Defects, cracks, corrosion**
- dacl10k: bridge-damage segmentation, 9.9k images, baseline mIoU only 0.42. Source: https://arxiv.org/abs/2309.00460
- CODEBRIM: cracks, corrosion stain, exposed rebar; a CC BY 4.0 copy is on Roboflow. Source: https://universe.roboflow.com/j3di/codebrim_revised20250213
- No strong off-the-shelf model exists. Expect to fine-tune YOLO or SAM 3 on customer labels, which makes the correction loop in section 3 the real asset.

**Thermal**
- HOTSPOT-YOLO (YOLOv11, 90.8% mAP on a public 6k-image PV set): https://arxiv.org/abs/2508.18912
- A Kaggle thermal PV anomaly set of about 20k images, used in an ISPRS 2025 RF-DETR vs YOLO12 comparison: https://isprs-archives.copernicus.org/articles/XLVIII-2-W11-2025/127/2025/isprs-archives-XLVIII-2-W11-2025-127-2025.pdf
- A Zenodo UAV PV set: https://zenodo.org/records/16420123
- Solar hotspot detection is a solved, cheap win. Check dataset licences before use.

**Depth and feed-forward 3D**
- **Depth Anything 3** (Nov 2025): consistent depth and poses from any number of views, beating VGGT with fewer parameters, trained on public data only. Source: https://cdn.jsdelivr.net/gh/bytedance-seed/depth-anything-3@main/README.md
- **VGGT** and the CVPR 2026 follow-up VGGT-Ω: https://openaccess.thecvf.com/content/CVPR2026/html/Wang_VGGT-ohm_CVPR_2026_paper.html
- Uses: an instant preview before ODM finishes, depth for single 360 frames (measure in walkthroughs), and densifying sparse captures. They are not survey-grade replacements for ODM.

**Semantic Gaussian splatting**
- LangSplat and its 2025 successors: Gen-LangSplat (no per-scene autoencoder), SLGaussian (feed-forward, about 30 s per scene) and Hi-LSplat (hierarchical).
- Sources: https://arxiv.org/abs/2312.16084, https://arxiv.org/abs/2510.22930, https://arxiv.org/abs/2412.08331
- Still research-grade. Park it unless splats become a first-class product layer.

## 3. Agent patterns that make a domain agent reliable

**Current Claude family** (official, https://platform.claude.com/docs/en/about-claude/models/overview)

| Model | Price per MTok (in / out) | Use |
|---|---|---|
| Fable 5.1 | $10 / $50 | Long-horizon reasoning |
| Opus 5.5 | $4 / $20 | Default recommendation |
| Sonnet 5.5 | $2 / $10 | Speed and intelligence balance |
| Haiku 5.5 | from $0.10 / $0.50 | Classification, extraction, routing |

- All four have a 1M context window, 128K output, vision, tool use and adaptive thinking with an `effort` parameter.
- Batch API requests are 50% off.
- Cache reads cost 10% of base input in general, 5% on Opus 5.5 and Sonnet 5.5, and 2.5% on Fable 5.1.

**Tool design** (Anthropic, https://www.anthropic.com/engineering/writing-tools-for-agents)
- Make a few high-level, namespaced tools that match user tasks, for example `volumes.compute_pile(boundary_id, base='lowest_point')` rather than raw database calls.
- Return compact, meaningful context (names, units, IDs the next call needs) and paged or truncated output with hints.
- Write tool descriptions like onboarding docs, then refine them by running evals and letting Claude critique its own transcripts.

**MCP both ways**
- DroneDeploy now exposes progress data over MCP.
- Quadrion can expose a local MCP server so external Claude, Copilot or Procore agents can query project facts.
- Internally, keep one tool registry for the in-app agent, the MCP server and the right-click action registry. That makes the agent, the UI and outside agents share one verified code path.

**Grounding over screen-driving**
- Prefer structured tools and app state over computer-use clicking. Use screenshots only for verification: the agent renders the view it changed and checks it with vision.
- Every answer cites the layer, date or photo IDs it came from, so the UI can click through to the source. This is the traceability customers value in Pix4D and Inspection AI.

**Plan-verify loops**
- For multi-step jobs (process, measure, report), plan, run, then verify against invariants: volume sign, units, CRS, date order, coverage. Re-plan on failure.
- Route verification to a cheaper model or to code checks.
- Destructive or slow actions (re-processing, deleting) need explicit user confirmation.

**Evals** (Anthropic, https://anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Start with 20-50 tasks taken from real failures and founder checks, each with a reference answer.
- Prefer code graders, for example "volume within 2% of the reference" or "antenna azimuth within 3°". Use rubric graders for prose and human review to calibrate them.
- Grade the final state, not the steps taken.
- Measure pass^k (consistency) for customer-facing flows.
- Read transcripts.
- Move saturated tasks into regression suites and run them in CI against recorded fixtures.

**Retrieval over project data**
- With 1M context and cheap cache reads, a cached, structured project manifest often beats a vector database. The manifest lists layers, dates, measurements, detections and notes.
- Add keyword or metadata search tools for photos and reports. Add embeddings (SigLIP or a VLM's own) only for "find photos like this".

**Human-in-the-loop correction learning**
- Every accepted, edited or deleted detection is a label. Store it with the crop, the prompt and the model version.
- Use it in three ways:
  - few-shot exemplars for SAM 3 visual prompts, available immediately;
  - periodic fine-tuning of a YOLOE or YOLO head per customer or class, overnight on the local GPU;
  - active learning that sorts the low-confidence detections to the top of the review queue.
- This is the moat DroneDeploy cites (its annotation volume) at a small team's scale.

**Cost control**
- Prompt-cache the system prompt, tool definitions and project manifest.
- Route by task:
  - Haiku 5.5 for intent, classification and photo triage;
  - Sonnet 5.5 for normal turns;
  - Opus 5.5 at medium effort for multi-step analysis;
  - Fable 5.1 only on demand for hard planning.
- Send bulk VLM work (thousands of photos) to the local models and keep Claude for reasoning over their structured results.
- Use the Batch API for overnight report generation.
- Downscale and crop images before sending them to the cloud.

## Recommended small-team adoption order

1. Build one tool registry shared by the agent, the right-click menus and a local MCP server, and make every answer cite its sources.
2. Write an eval harness of 30 real tasks with code graders and run it in CI.
3. Set up a detection pipeline where SAM 3 or YOLOE proposes, a local VLM verifies and the user corrects, and log every correction.
4. Use 2D-to-3D mask lifting with the ODM poses for point-cloud labels. Try a Utonia/Sonata head later.
5. Change detection: geometric diff plus VLM labelling.
6. Add model routing and caching.
7. Park semantic splats and native open-vocabulary 3D.

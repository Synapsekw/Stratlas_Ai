# Engineering generation benchmark

Run this from the isolated checkout. Keep source scans, photographs, drawings, reference models and generated reports outside Git. The reference is an evaluation input only: the production evidence and assembly stages must not read its mesh or fitted component records.

## Source-only baseline

Prepare an ordinary imported project with `manifest.json` and readable cloud layers. A private JSON configuration supplies `project`, a unique `job` and `params` conforming to `ModelEvidenceParams`. Include `run`, cloud layer IDs, selected photo paths, drawing paths, optional camera poses and a region of interest. Use processing tools 0.16.0 and PDAL for compressed LAS/COPC input. Set `PYTHONPATH` to this checkout's `python/src` when using an existing environment.

```powershell
python python/scripts/engineering_bench.py C:/private/benchmark/config.json
node tools/agent/engineering-benchmark.mjs C:/private/benchmark/project run-id C:/private/benchmark/build
node tools/agent/engineering-compare.mjs C:/private/benchmark/build/model.glb C:/private/reference/model.glb --candidate-georef C:/private/benchmark/build/model.georeference.json --reference-georef C:/private/reference/model.georeference.json --evidence C:/private/benchmark/project/engineering/run-id/evidence.json --out C:/private/benchmark/comparison --render
```

The first command runs the shipping evidence pipeline. The second uses the shipping assembler, GLB builders, validation and georeferencing with a **null AI proposal**. It records failed assemblies, unresolved evidence, mesh checks, size and world-coordinate invariance under a changed project origin. That invariance establishes frame arithmetic, not independent survey accuracy.

The comparison uses one camera and coordinate frame for both models. Supply both georeferences. `--cloud C:/private/points.json` adds source and overlay images; this optional JSON contains local XYZ triples in the candidate's effective frame. Its points must already include the source offset exactly once. The tool does not align, centre or scale each model independently. Numeric drawing tags are compared by common-frame mesh bounding-box centres; differently detailed backs can move those centres without moving the measured face.

## Actual app review and picking

Build the desktop app first, then run:

```powershell
pnpm -F @aio/desktop build
node tools/agent/engineering-visual-proof.mjs C:/private/benchmark/project C:/private/benchmark/build C:/private/benchmark/app-proof
```

This creates a disposable desktop profile and benchmark project, loads the generated GLB using production placement, opens a saved engineering review and verifies representative antenna/radio picks against their component IDs. Screenshots show the actual Electron viewport, selected-component inspector and cloud overlays. The component inventory is checked against every generated assembly. A successful count does not mean every occluded component has been individually raycast-tested.

When the input has a saved run record, the screenshot driver preserves its stages, proposal, approval and usage. It rejects a run whose model ID does not match the supplied GLB model. Source-only builds without a run record receive a fixture that explicitly records the AI stage as skipped. These screenshots prove saved-run review and interaction; they do not alone prove the complete generation workflow. Use `QUADRION_E2E_SWGL=warp` for the Windows software-rendering fallback when needed.

## Live run and acceptance

Use the app's Sources / Modelling options / input review flow for a live benchmark. Approve the concrete evidence pool, provider/model and estimated budget once. Preserve the run folder's proposals, usage, approval and validation records. Do not inject a reference-derived proposal or auto-grant consent to make the benchmark pass. Source, frame, route or budget changes require renewed approval; an unknown model price blocks a budgeted run.

Report these separately:

- Regeneration: source-only, replayed proposal or live provider; any manual corrections.
- Placement: CRS, origin, effective cloud offset, independent base/tip/shaft-top checks and changed-origin import/reopen.
- Inventory: measured and inferred parts, missing/extra associations, stable IDs and selection.
- Fit: per-device face/axis residuals, support and occluded fields; dimensions, bearings and reference-centre discrepancies.
- Appearance: identical-camera full, crown, base, top, reverse and cloud-overlay views.
- File validity: validator errors/warnings, duplicate/degenerate triangles, failed assemblies and budgets.

Do not treat file validity, a low shaft residual or an attractive screenshot as proof of reference fidelity. Current compound/cable builders simplify obscured detail. Reference fidelity is a separate acceptance gate.

### Private benchmark live checkpoint — 17 October 2026

The user approved one OpenAI benchmark with a US$5 estimated cap and a prepared pool of 40 images plus 56 measured component records. The run used the production main-process AI runtime, consent/spend persistence, bounded measurement tools, assembler, GLB builders and georeferencing. It reused the locally prepared source evidence; it was **not** a complete interactive Sources-to-generation desktop run. The reference GLB was an evaluation input only.

- Estimated cost: US$0.8947681 across 11 provider requests; 423,462 input and 42,214 output tokens. Recorded AI time: 596,323 ms. The original approval, spend and time record survived continuation; no allowance was reset.
- Passes 1 and 3 produced valid 60-entry proposals. Pass 2 failed at the old reply ceiling. Inventory-sized output reservation and bounded tool-step accounting fixed that truncation path. Additional regressions enforce accumulated-history cost and remaining tokens before continuations and repairs.
- Output: 205 addressable assemblies, 138,488 triangles, approximately 4.63 MB. Khronos validation: zero errors/warnings; no degenerate or duplicate triangles; no failed builders.
- All 56 measured observations were retained. All 30 antenna/radio centres, dimensions and bearings equal their source records. Ground-to-tip height is about 31.08 m; terminal tip differs from the reference by 4.4 cm. This establishes preservation of the measured frame, not independent survey accuracy.
- The saved result loaded all 205 IDs in the real desktop viewport; representative antenna and radio scene picks opened their corresponding inspectors. Expandable review notes keep the component inventory visible. The private proof includes full/crown/top/base/reverse views, cloud overlays and actual desktop screenshots.

**Fidelity acceptance failed.** The AI changed 57 descriptions but no existing assembly parameter sets; it added one generic ladder whose rails conflict with the observed step bolts. Mount/bracket construction, cable bundles, materials, canopy profiles, auxiliary mounting tubes and the beacon remain incomplete. Reference-centre differences for X01, R16 and R11 exceed 0.10 m. These findings require richer source-derived geometry and additional validation; a successful provider response is not a fidelity pass. The private evidence/proof files stay outside Git. Nothing has been merged to main.

### Detail refinement - 17 October 2026

Local source processing and replay of the saved approved pass-3 proposal; **no new provider call**.
Reference meshes/records were evaluation inputs only. Original cloud, drawing and photograph inputs
were processed through the shipping evidence pipeline. Bounded voxel connectivity replaces the dense
all-pairs clustering allocation that failed on the original scan.

- Output: 275 selectable assemblies, 311,560 triangles, 10,308,356 bytes. Zero validator errors or
  warnings, duplicate/degenerate triangles or failed builders. All 30 new source-device poses remain
  exact; the prior georeference is unchanged and the source height offset is applied once.
- Height: 31.075 m fitted ground to terminal tip; tip differs from the reference by 4.81 cm.
  Fresh source fitting differs slightly from the prior cached pass; no fit-to-reference transform
  or scale correction is applied.
- Details: two fitted two-face roofs (about 8 mm residual each), 80 measured climbing-step centres,
  two supported auxiliary crown rods and a red cap cluster. Clamps, U-bolts, cable runs/looms,
  sheet corrugations, fence pickets, pads and safety wire retain explicit inferred provenance.
- Actual desktop proof: all 275 IDs load. Real raycasts and mouse clicks select an antenna, radio,
  clamp, service cable, roof and climbing route. Review keeps the model visible. The driver now
  covers these detail classes when present. Inspector controls no longer imply that changing
  rung spacing or a fitted roof's scalar height will change its measured geometry.
  Coverage describes the sampled region; full face coverage no longer claims all-sided visibility.
- Private `visual-proof.html` includes before/refined/reference views, source overlays, selection
  screenshots, hashes and validation. This is not a new live-provider critique or a complete
  interactive Sources-to-generation recording. Saved AI critique notes predate the refinement.

**Strict reference acceptance remains open.** Common-frame bounding-box centre differences for
X01 (21.8 cm), R16 (18.1 cm) and X02 (10.5 cm) exceed 10 cm. Reference backs/details can affect this
metric. Platform outlines retain their registered drawing support; obscured equipment, cable
connectivity, hidden rod extensions and construction details remain unresolved. Do not move
measured devices or stretch the tower merely to make this comparison pass.

A diagnostic check of 81 samples per disputed front face against the same source point sample
does not establish that the reference positions are better: the current small radio has a
13 mm median nearest-point distance versus 23 mm for the reference; both boxes have incomplete
support. This check is diagnostic only, not proof of correct object association or hidden depth.

The shared evidence/coordinates/GLB/review framework supports several families. Detailed automatic
reconstruction is family-specific; this telecom benchmark does not establish universal reconstruction
of arbitrary engineering assets. UI Fix/d-ba has been notified; all changes remain isolated with
no main edits, rebase, merge or push.

Verification: full `pnpm check` passed (10,019 tests passed, 14 skipped), 99 focused Python
engineering/evidence tests passed, desktop build passed, and all six representative desktop picks
passed. Rebuilding the saved procedural model with the final code reproduces the delivered GLB
byte-for-byte. Independent code review reported no outstanding findings. These checks do not
close the separate reference-fidelity gate above.

## Regression checks

```powershell
pnpm exec tsc -b
pnpm exec vitest run packages/ai/src/engineer.test.ts packages/ai/src/main.engineer.test.ts packages/ai/src/engineerApproval.test.ts packages/ai/src/engineerTools.test.ts apps/desktop/src/renderer/engineer packages/modelling/src/engineer --maxWorkers=2
python -m pytest python/tests/test_model_evidence.py python/tests/test_engineer_ground.py python/tests/test_engineer_compound.py python/tests/test_engineer_tip.py python/tests/test_evidence_checkpoints.py
pnpm exec playwright test --config apps/desktop/playwright.config.ts engineering-flow.spec.ts engineering-inspect.spec.ts engineering-georef.spec.ts
```

Electron tests use synthetic sources and a fake provider. They cover approval, review, selection, acceptance, recovery and placement without spending money. The screenshot driver supplies the complementary real-source visual check. Keep expensive source runs and live-provider runs explicit; neither belongs in ordinary CI.

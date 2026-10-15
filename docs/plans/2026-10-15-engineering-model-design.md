# Create engineering model: design

Date: 2026-10-15. Branch: `feat/engineering-model`. Status: approved by the founder on 2026-10-15 (sections 1 to 5 and 4b).

## 1. Intent

When a user imports or selects mapping data for a vertical asset, Quadrion offers **Create engineering model**. It turns the available evidence (a point cloud, ordinary photos, or both, optionally an existing reconstruction mesh) into a clean, editable, component-based engineering interpretation, shows it in the 3D workspace for review, and exports it as a valid, georeferenced GLB with an editable specification, a component register and a georeference sidecar.

The target quality is the private chimney reference (local only): smooth authored geometry, coherent clean PBR materials, meaningful separate components (shaft, coating bands, open flues, crown deck and access, ventilation, earthing, crown and intermediate warning lights, ducts, supports, service pipework), and complete inferred surfaces where evidence supports them. It is a quality and interaction reference, not a template: no height, flue count, light elevation, layout, coordinate or path from it appears in code, fixtures or docs.

Supported asset families: chimneys and industrial stacks (multiple flues, surrounding equipment), flare stacks (tip, supports, platforms, access, service lines), telecom towers (lattice and monopole, legs and bracing, platforms, antenna mounts and antennas, equipment).

Supported input modes: point cloud only, photos only (including unposed, sparse or a single photo), and combined.

AI does visual and semantic interpretation and returns a typed, bounded proposal. Deterministic local code does measurement, constraints, meshing, validation and export. No model output is ever executed.

### Success criteria (acceptance A to I)

- **A.** A partial noisy synthetic chimney cloud plus photos produces an inspectable draft with measured taper, the fixture-supported flue count and intermediate lights; the output is authored geometry, not the input repackaged.
- **B.** A flare and a telecom lattice and monopole example build from their own assemblies, not chimney geometry relabelled.
- **C.** Photos only exercises real ingestion, provider inference (mocked in CI), schema validation and meshing. Sparse or single-photo input stays usable and marks scale, hidden components and placement correctly. An unavailable reconstruction runtime is reported as unavailable, never as success.
- **D.** Correcting a count or a light elevation regenerates only the affected components, keeps unrelated ids and accepted edits, and survives save and reopen.
- **E.** Hover, click, focus, clear, hide, drag (no select) and multi-material picking work in Quadrion at the CI viewport (1100 x 720, scale 1, WARP). Component ids and descriptions survive GLB and `.aio` round trips.
- **F.** A georeferenced asset exported from project A and imported into project B with a different origin lands at the same world position, orientation and scale within stated tolerance (1 mm position, 0.01 degree heading, 1e-6 scale); cross-CRS (UTM zone to UTM zone), rotated assets, unknown vertical datum, missing metadata and double-transform prevention are covered. Assertions use computed geometry, never a self-reported flag.
- **G.** The produced file passes the Khronos glTF validator with no errors, has finite positions, valid indices and unit normals, keeps intended openings open, closes solids elsewhere, and respects budgets. Checked on the written file.
- **H.** OpenAI and Anthropic run the same workflow with mocked replies; offline, no key, invalid reply, rate limit, cancel and resume paths are tested; an offline test proves no request leaves.
- **I.** A large cloud is processed through bounded crops and samples; nothing raw is sent to a model, the renderer never holds the full cloud, and no client data is written into fixtures.

## 2. Founder decisions (2026-10-15)

1. **Staged merges.** One spec and one plan; built in five stages (S1 to S5) on this branch, each merged to `main` when green. The user-facing entry points stay hidden until S5. The finished feature includes everything in the brief.
2. **`aio.procmodel/2` with a migrator** from `/1` in `packages/schema/src/versions.ts`, following `docs/release/UPGRADE-POLICY.md`.
3. **Two new project sharing flags**, `aiCloudPhotos` and `aiCloudScans`, both off by default, set from the send preview ("Allow for this project"), enforced in the main process. `aiCloudDrawings` keeps its meaning.
4. **Live evaluation on the private reference is run by the founder in the app**, approving the send preview themself. Agents deliver a local comparison script; nothing private is sent by an agent and no comparison output enters git.
5. **Place model (4b)** added on request: interactive placement for every mesh layer, not only engineering models.

## 3. Audit findings that shape the design

- **Schema.** `packages/schema/src/procmodel.ts`: literal `aio.procmodel/1`, five strict part kinds (extrusion, cylinder, box, pipe, sphere), `partBase` with status, confidence and `PartOrigin` (fit, drawing, agent, manual). No assemblies, hierarchy, rotation, material or evidence. Migration machinery exists but unused (`versions.ts` `MIGRATIONS`, `readVersioned`). `checkProcModel` uses plain `safeParse`.
- **Modelling.** `packages/modelling/src/mesher.ts` meshes closed solids only (no taper, hollow or open ends), no budget, no instancing. `glb.ts` writes flat nodes, one vertex-coloured material, string extras `{tag, type, part}`. No glTF validator in tests. Per-kind switches in `procmodel.ts` and `ModelBuilder.tsx`.
- **Fitting.** `python/src/aio_pipelines/modelfit/` fits a vertical-axis single-radius cylinder, box, extrusion or straight pipe per cluster; reads COPC by dumping the whole cloud to LAS via PDAL; no axis estimate, no sections, no repeated members, no renders. `ground_surface`, `voxel_thin`, `fit_circle`, `ransac_circle` are reusable.
- **Jobs.** `apps/desktop/src/main/jobs/runner.ts` runs one Python process per job over JSON-RPC; steps are resumable with atomic commits (`runtime.py`); a new pipeline needs registration in Python, `packages/schema/src/jobs.ts`, `apps/desktop/src/renderer/jobs.ts`, `processing/pipelines.ts`, tests and the compat tool, plus a pack version bump.
- **Photos.** `photo/exif.py` reads EXIF, blur, dhash (warn only), sha1 duplicates; EXIF orientation is never applied. Reconstruction is pycolmap (`photo.align`, `photo.products`), Windows x64 and Apple silicon only.
- **AI.** `packages/ai/src/main.ts` holds the agent loop and `runDetect` (batched vision calls parsed by `detect.ts`), the gate order (route, provider, offline, cloud-off, project policy, key, local capability), cancellation via `AbortController`, usage events to the per-project tally. No structured-output path, no capability flags per cloud model, no budget. `aiCloudDrawings` (manifest) is enforced only in renderer tool executors (`modeller/agentTools.ts`). The send preview (`session.ts`, `AgentPanel.tsx`) shows text, context and one image. Mock providers: `QUADRION_AI_TEST_PROVIDER=1` with `scripted.ts`.
- **Import and packages.** `packages/project/src/builder/raw.ts` copies a GLB with an identity transform and reads nothing inside it. `LayerDerived.kind` is `change | model`. `.aio` (`packages/project/src/package/`) carries files under the project folder via `plan.ts` patterns and per-layer `ownership()`; the manifest round-trips through `parseManifest`.
- **Geo.** `packages/geo/src/index.ts` supports EPSG:4326, 3857 and WGS84 UTM (326xx, 327xx) plus static defs; height passes through; `gridConvergenceDeg` exists in `crs.ts`; no EPSG-to-EPSG helper; no vertical datum beyond `absAltOffsetM`.
- **Engine.** `packages/engine/src/adapters/mesh.ts` loads GLB with three.js, merges per material and keeps originals on `PICK_LAYER`; `adapters/model.ts` `selectableNode` picks by manifest tag, then extras `tag` or `id`; `stage/Stage.ts` has hover, click with slop, background deselect, `Highlighter` (single node per mode), fly-to-selection. No per-node visibility, no group highlight.
- **UI.** The layer right-click menu is `LayerDateMenu` in `apps/desktop/src/renderer/shell/DateMenus.tsx` (date oriented). Model Builder opens from the palette (`shell/Palette.tsx`). Post-import messages are plain text (`builder/ImportPanel.tsx`). `builder/AlignModel.tsx` does point-pair georeferencing and the Y up / Z up switch with an undo `previous`; `builder/objPlacement.ts` auto-places OBJ; `builder/recentre.ts` shifts every layer transform.

## 4. Approach

A Python job (`model.evidence`) does local measurement and writes a bounded evidence pack. The existing AI layer in the main process makes structured calls that return a typed proposal. Deterministic TypeScript in `@aio/modelling` assembles measurements and proposal into an `aio.procmodel/2` model, meshes it and writes the GLB. Keys, routing, policy, offline mode, cancellation and the cost meter stay where they are.

Rejected: AI calls from Python (duplicates keys and providers); Blender as a runtime (large, new packaging, no gain over extending the mesher).

## 5. Design

### 5.1 Contracts (S1)

All in `@aio/schema`, each with a row in `docs/architecture/contract-changes.md`.

#### `aio.procmodel/2`

Every `/1` field keeps its meaning. Additions:

```ts
type ProcModelV2 = {
  schema: 'aio.procmodel/2';
  // all /1 fields: id, name, createdAt, updatedAt, capture?, sources?, parts[]
  family?: 'chimney' | 'flare' | 'telecom-lattice' | 'telecom-monopole' | 'generic';
  scope?: 'asset' | 'asset-and-surroundings';
  materials: Material[]; // default []
  assemblies: Assembly[]; // default []
  scale?: ScaleRecord;
  georef?: Georef; // aio.georef/1 body, see below
  evidence?: EvidenceInventory; // supported, missing, unresolved
  run?: { id: string; detail: 'fast' | 'standard' | 'detailed' };
};

type Material = {
  id: string; // e.g. 'concrete-cream'
  name: string;
  baseColor: [number, number, number, number]; // linear RGBA 0..1
  metallic: number; // 0..1
  roughness: number; // 0..1
  emissive?: [number, number, number]; // lenses
  doubleSided?: boolean; // open flue liners, thin plates
};

type ValueBasis = 'measured' | 'observed' | 'inferred' | 'user';

type ParamQuality = {
  basis: ValueBasis;
  residualM?: number; // RMS distance of supporting points, metres
  support?: number; // inlier point count
  coverage?: number; // 0..1 share of angular or length bins with support
  note?: string; // max 200 chars
};

type EvidenceRef = {
  kind: 'cloud' | 'photo' | 'mesh' | 'user';
  ref: string; // layer id, photo id (sha1), or 'user'
  view?: string; // evidence image id inside the run
};

type Assembly = {
  id: string; // stable, see 5.4
  parent?: string; // assembly id
  kind: AssemblyKind;
  params: AssemblyParams[kind]; // discriminated on kind, strict, bounded
  name: string;
  description: string; // short functional description, max 300 chars
  category: string; // 'Shaft', 'Flues', 'Access', 'Warning lights', ...
  tag?: string; // plant tag when known
  type?: string; // Quadrion class (kept compatible with `class`)
  material?: string; // default material id, per-mesh overrides in params
  status: 'draft' | 'accepted' | 'rejected';
  origin: PartOrigin; // /1 union, plus { by: 'engineer', runId, model? }
  quality: Record<string, ParamQuality>; // keyed by param name
  sources: EvidenceRef[];
  unobserved?: ('back' | 'top' | 'interior' | 'base')[]; // inferred surfaces
  hidden?: boolean; // review visibility, not exported as a flag
};

type ScaleRecord = {
  status: 'measured' | 'reference' | 'provisional';
  reference?: { what: 'height' | 'diameter' | 'other'; valueM: number; label?: string };
};
```

Assembly kinds and their parameters (all lengths in metres, local frame, bounded by zod min and max; counts capped):

| Kind           | Params                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shaft`        | `base: Vec3`, `axis?: Vec3` (default up), `profile: {y, r}[]` (2 to 64, y increasing), `wall?: number`, `openTop: boolean`, `joints?: {spacing}`        |
| `band`         | `shaft: id`, `y0`, `y1`, `material`                                                                                                                     |
| `flue`         | `centre: Vec3` (top centre), `rOuter`, `rInner`, `height`, `rim?: boolean`, `flange?: boolean` (always open mouth)                                      |
| `flareTip`     | `base: Vec3`, `r`, `height`, `windshield?: boolean`, `pilots?: count 0..8`                                                                              |
| `deck`         | `y`, `outline: {r} or Vec2[]`, `thickness`, `openings: {centre: Vec2, r}[]`                                                                             |
| `ringPlatform` | `y`, `rInner`, `rOuter`, `thickness`, `arcDeg?` (partial ring)                                                                                          |
| `guardrail`    | `path: Vec3[] or {y, r}`, `height`, `posts: spacing`, `rails: 1..3`                                                                                     |
| `ladder`       | `bottom: Vec3`, `top: Vec3`, `width`, `rungSpacing`, `cage?: boolean`                                                                                   |
| `hatch`        | `centre: Vec3`, `size: [w, d]`, `open?: boolean`                                                                                                        |
| `louvre`       | `centre: Vec3`, `normal: Vec3`, `size: [w, h]`, `blades: 3..40`                                                                                         |
| `duct`         | `path: Vec3[]`, `section: {rect: [w, h]} or {round: r}`, `transition?: {at: index, to: section}`, `flanges?: boolean`                                   |
| `pipeRun`      | `path: Vec3[]`, `diameter`, `bendRadius?`, `flanges?: Vec3 indices` (open ends allowed)                                                                 |
| `frame`        | `kind: 'portal' or 'rack'`, `base: Vec3`, `span`, `height`, `yawDeg`, `bays: 1..20`, `braced: boolean`, `member: size`                                  |
| `base`         | `outline: Vec2[] or {r}`, `y`, `height`                                                                                                                 |
| `cabinet`      | `base: Vec3`, `size: [w, h, d]`, `yawDeg`                                                                                                               |
| `lattice`      | `base: Vec3`, `legs: 3 or 4`, `widthBase`, `widthTop`, `height`, `bays: {height, bracing: 'X' or 'K' or 'Z'}[]` (1 to 80), `legSection`, `braceSection` |
| `monopole`     | `base: Vec3`, `profile: {y, r}[]`, `sides: 0 (round) or 8..18`                                                                                          |
| `antenna`      | `kind: 'panel' or 'dish' or 'rru' or 'omni'`, `centre: Vec3`, `azimuthDeg`, `tiltDeg`, `size`                                                           |
| `antennaMount` | `kind: 'pipe' or 'sector-frame' or 'standoff'`, `centre: Vec3`, `azimuthDeg`, `size`                                                                    |
| `warningLight` | `fixture: 'single' or 'twin' or 'canister' or 'beacon'`, `centre: Vec3` (lens centre), `outward: Vec3`, `size`, meshes: housing, lens (emissive), mount |
| `earthing`     | `path: Vec3[]`, `diameter`                                                                                                                              |

`parts[]` (the `/1` primitives) stay valid alongside assemblies and still mesh as before.

Migration `/1 -> /2`: set `schema`, add `materials: []`, `assemblies: []`. No other field changes. Registered in `MIGRATIONS`; `checkProcModel` and the main-process reader switch to `readVersioned`. A `/1` file opened by this build is upgraded on next save with the `.bak` the writer already keeps. Older builds refuse `/2` with the existing "made by a newer version" message.

#### `aio.georef/1`

```ts
type Georef = {
  schema: 'aio.georef/1';
  crs: { epsg: number } | { wkt: string };
  anchor: [E: number, N: number, H: number]; // full precision, CRS units (metres)
  axes: 'x-east,y-up,z-south'; // only value in /1
  units: 'm';
  modelToCrs: Mat4; // column-major; maps model xyz to E, N, H
  heading: { deg: number; status: 'measured' | 'user' | 'assumed-grid' };
  scale: { factor: number; status: 'measured' | 'reference' | 'user' | 'provisional' };
  horizontal: { status: 'surveyed' | 'from-source' | 'user' | 'unplaced'; accuracyM?: number };
  vertical: { datum: string | 'unknown'; status: 'from-source' | 'user' | 'unknown' };
  provenance: {
    by: 'engineer' | 'place-model' | 'import' | 'compat';
    runId?: string;
    source?: string;
  };
  deviation?: { rmsM: number; p95M: number; samples: number }; // model vs evidence where measured
};
```

Stored in GLB `asset.extras.aioGeoref` and in `georeference.json` beside the export. Mesh vertex positions stay near the anchor in float32; geographic values live only in this record.

**Compatibility adapter** (`packages/schema/src/georefCompat.ts`, pure): recognises `asset.extras.georeference` with `schema: 'chimney.georeference/1'` and keys `crs.epsg`, `origin_easting_northing_height_m`, `model_anchor`, `model_axes {x,y,z}`, `units`, `model_to_source_enh_column_major`, `heading_about_up_deg`, and free-text basis fields. It validates the axes are grid east, up, grid south, the units are metres and the matrix is finite, then maps to `aio.georef/1` with `provenance.by: 'compat'`, heading status `assumed-grid`, vertical `unknown` unless a datum is stated. Anything else returns a typed refusal that leads to placement needed. A synthetic fixture with this structure (no real values) is in the tests.

#### Layers and manifest

- Mesh layer (`packages/schema/src/layers.ts`): optional `georef?: Georef` and `placement?: 'placed' | 'needed' | 'provisional'` (absent means current behaviour). `AssetTag` unchanged.
- `LayerDerived.kind` unchanged: an engineering model is a procedural model (`derived.kind: 'model'`), told apart by its `.procmodel.json` family.
- Manifest (`packages/schema/src/manifest.ts`): `aiCloudPhotos?: boolean`, `aiCloudScans?: boolean`. Absent means off.

#### `model.evidence` pipeline (`packages/schema/src/jobs.ts`)

```ts
type ModelEvidenceParams = {
  run: string; // run id, folder engineering/<run>/
  clouds: { layer: string }[]; // 0..4 pointcloud layers
  meshes: { layer: string }[]; // 0..2 mesh layers (reference evidence)
  photos: { path: string }[]; // 0..400 originals, project-relative or absolute
  region?: { centre: Vec2; radiusM: number } | { min: Vec3; max: Vec3 };
  detail: 'fast' | 'standard' | 'detailed';
  limits: { maxPoints: number; maxImages: number; maxPx: number }; // defaults per detail
};
```

Steps (each resumable, atomic): `crop`, `ground`, `axis`, `sections`, `members`, `renders`, `photos`, `pack`. Outputs under `engineering/<run>/`:

- `evidence.json`: CRS, units, bounds, crop, sample counts, axis (point, direction, tilt), base point, per-slice fits `{y, centre, r, residualM, support, coverage}`, taper fit, repeated members `{kind: 'flue' or 'light-candidate' or 'leg' or 'antenna-candidate', items[], metrics}`, family hint scores (fill ratio, slenderness, top features), colour summaries per height band, photo inventory `{id, original, w, h, orientationApplied, blur, dupOf?, gps?: camera position only}`.
- `img/*.png`: four side orthographic renders, top render, height-slice outline images, detail crops (crown, base, light candidates), photo review copies (max `maxPx` on the long side). Bounded by `maxImages`.

Cloud reading uses PDAL `readers.copc` with `bounds` (and `filters.crop` for LAS or LAZ) so only the region is decoded; a voxel sample caps points at `maxPoints` (fast 300k, standard 1M, detailed 2M). Renders are numpy z-buffer splats with Pillow (no new heavy dependency). Photos get `ImageOps.exif_transpose`, sha1 and dhash dedupe (near duplicates dropped, kept in inventory with `dupOf`), blur score.

Reconstruction reuse: when there are 20 or more photos and the photogrammetry runtime is available (existing hardware probe), the setup offers "Reconstruct first" which queues the existing `photo.align` and `photo.products` jobs; their cloud then feeds `model.evidence`. If unavailable, the photos-only path runs and the run records `reconstruction: 'unavailable'`. It never reports a reconstruction that did not happen.

#### AI routing (`packages/schema/src/agent.ts`, `packages/ai/src/routes.ts`)

- New `AiTask` value `engineer`, defaulting to the `vision` route's provider and model.
- New capability table (`packages/ai/src/capabilities.ts`): per provider and model pattern, `{vision, structured, maxImages, maxImagePx}`. A route whose model lacks `vision` and `structured` is refused for `engineer` with a message naming the setting to change. Unknown cloud models are treated as capable only if the user enables "Treat as vision model" in settings (stored per route).

### 5.2 Pipeline stages

The setup flow and the Processing drawer show exactly these stages:

1. **Inspect sources**: the `model.evidence` job.
2. **Estimate geometry**: deterministic, from `evidence.json` only (taper profile, base, axis, flue count and positions from repeated members, light candidate heights, lattice leg spacing and bay heights). Every value carries `measured` with residual, support and coverage.
3. **Identify components**: the AI step.
   - One structured call per pass through AI SDK `generateObject` with a zod schema, so OpenAI and Anthropic share one code path. Input: the approved evidence images and a compact text summary of measurements. Source text, EXIF and OCR are passed as quoted data, never as instructions.
   - Proposal schema (`EngineerProposal`, bounded): `family` with reasons; `identity: {sameAsset: boolean, conflicts: {imageIds, reason}[]}`; `components: {role, kind, count (0..64), approx params (ratios of asset height when scale is unknown), imageIds (evidence), observed: boolean}[]` (max 120); `unresolved: string[]` (max 40); `notes` (max 1000 chars). No geometry arrays, no code.
   - Validation failure gets one repair call with the zod issues; a second failure raises `InvalidProposalError` and keeps the measured-only draft.
   - Passes: fast 1, standard 2, detailed 3. Pass 2 and 3 are verification and refinement: generated-model renders from the same views are sent beside the evidence and the model returns corrections in the same schema. Local silhouette overlap (5.2 step 5) decides whether a correction is kept; the model's own judgement never accepts a draft.
   - Budget: default cost cap per run fast US$0.50, standard US$2, detailed US$5 (settings), checked before each call with a pre-flight estimate from image count and `pricing.ts`; tokens capped per call; wall time 10 minutes per run; one call in flight per run; SDK retries 2. Hitting a cap stops and returns the best draft with unresolved items.
   - Cache: `engineering/<run>/ai/<key>.json` where key is SHA-256 of evidence image hashes, measurement summary, setup settings, prompt version, schema version, provider and model. A cached reply is reused without a call, so reopen and retry never pay twice.
4. **Generate model**: the family assembler (`packages/modelling/src/engineer/`), deterministic.
   - Precedence for every parameter: user > measured > AI (observed) > template default (inferred). The winning basis is written to `quality`.
   - Constraints: flues evenly spaced on a circle inside the crown radius minus clearance unless measured positions exist; lights sit on the shaft surface at their elevation using the taper profile radius; platforms and guardrails follow the shaft radius at their height; antennas on mounts at the leg or pole radius; pipes and ducts end on a support or equipment face (no floating fittings); no two assemblies may intersect beyond a tolerance (checked, reported).
   - No scale source: everything is built in units of the asset height with height 1 scaled to a provisional value, `scale.status: 'provisional'`, and the UI asks for a reference dimension. Values are never labelled measured metres.
   - Templates per family supply defaults only for parts the evidence or the proposal establishes; nothing is added "because chimneys have it". Symmetric completion of unseen backs is allowed and recorded in `unobserved`.
5. **Validate**: on the written GLB: Khronos `gltf-validator` (npm), finite positions, index ranges, unit normals, no degenerate or duplicate triangles, closed solids except declared openings (flue mouths, open pipe ends, hatches), triangle budget (fast 150k, standard 400k, detailed 900k), silhouette overlap per side view against the cloud render (IoU reported per view when a cloud exists).
6. **Ready to review.**

Run state: `engineering/<run>/run.json` records setup, stage status, outputs and hashes; each stage is skipped on resume when its inputs hash is unchanged. Files are written to staging then renamed. Cancel stops the job or the AI call (`ai:cancel`, existing `runs` map) and leaves completed stages. Retry resumes the same run id. Accept is idempotent: it creates or replaces exactly one layer `model-<id>`.

Offline: stages 1, 2, 4 and 5 run; stage 3 shows "Needs a vision model. Offline mode is on, so nothing is sent." and the draft is measured-only. No silent cloud fallback anywhere. With no cloud source and offline, the run stops after inspect with that message.

Data sharing: before any call the send preview lists every image (thumbnail, size, kind: photo or scan render or generated view), the text summary, the route and the cost estimate. Photos need `aiCloudPhotos`, scan renders need `aiCloudScans` (or a one-time allow from the preview). The main process re-checks the flags and the existing `AiPolicy` before sending.

### 5.3 Interface (S5 for the flow, S2 for scene inspection)

- **Entry points**: "Create engineering model..." in the layer right-click menu for pointcloud, mesh and photos layers (`DateMenus.tsx`, one small added group; a coming, unowned "sidebar right-click menus" ask also targets that menu, so this change stays minimal and is flagged when merging); a button in Model Builder; an action link in the import result for a compatible import (structured action, never auto-start).
- **Setup dialog**: sources (multi-select layers and an "Add photos..." file picker), region of interest (centre and radius picked in the scene or on the map, or a box), suggested family with override, scope, detail (standard default), reference dimension (height, diameter or other), placement (from source, pick anchor, or unplaced), the provider and model from settings (link to Settings), and "Preview what is sent".
- **Progress**: the six stages in the panel and the Processing drawer with cancel and retry.
- **Review** in an extended Model Builder: component tree grouped by category with search and per-component visibility; card with description, tag, type, basis per value, residual, support, coverage, sources (thumbnails link to originals), unobserved surfaces; parameter editor; add component by kind; remove; accept, reject, accept all; rebuild; source and model visibility toggles; evidence inventory (supported, missing, unresolved).
- **Agent corrections** (`packages/ai/src/modelling-tools.ts`, `modeller/agentTools.ts`): new tools `list_components`, `edit_component` (params), `set_count` (role, count), `add_component`, `remove_component`. They update the parametric model through the assembler and keep unrelated ids and accepted components.

### 5.4 Stable ids

Assembly id = `<role>-<index>` where role comes from the family assembler (`shaft`, `band`, `flue`, `light-crown`, `light-l<level>`, `ladder`, `antenna-s<sector>`, ...) and index is 1-based in a deterministic order (azimuth from north clockwise, then height). The model id is fixed at creation. Regeneration merges by id: an accepted component keeps its id and user-basis values; a component whose role and index disappear (count lowered) is removed only if it is still a draft, otherwise it is kept and flagged. Count changes add new ids at the end of the order. GLB node name is the id; extras carry the full record.

### 5.5 Scene inspection (S2)

- GLB: one node per assembly (name = id), child mesh primitives per material, node `extras`: `{component, name, description, category, tag?, type?, parent?, basis, unobserved?, quality summary}` plus the existing `{tag, type, part}` keys so `selectableNode`, issues and asset references keep working.
- Engine: `selectableNode` resolves a hit to the nearest ancestor carrying `extras.component`; the Highlighter highlights every mesh under that node (group highlight with the shared outline), and materials are cloned per highlighted node so shared materials never tint unrelated parts; hidden nodes are excluded from raycasts (visibility chain already filtered) and per-node visibility is added to `LayerHandle` (`setNodeVisible`). Drag beyond the existing slop never selects. Background click and Escape clear. Hover shows a brief card (name, category, one-line description); click opens the component panel with Focus component (existing fly-to-selection). Touch: tap selects, list selection works.

### 5.6 Placement, exchange and import (S2)

- **Accept** creates the mesh layer with `transform` computed from `georef` relative to the project. Same CRS: translation `[E - E0, H - H0, -(N - N0)]` composed with `modelToCrs` rotation and scale. Different supported CRS: transform the anchor through `@aio/geo` (`toWgs84` then `fromWgs84`, new helper `transformPoint(p, fromEpsg, toEpsg)`), rotate heading by the difference in grid convergence at the anchor (`gridConvergenceDeg`), keep scale (note: projection scale factor difference recorded, not applied, below 1e-4). Unsupported CRS or `wkt` the registry cannot read: `placement: 'needed'`.
- **Export** ("Export engineering model..."): writes `<name>.glb` (with `asset.extras.aioGeoref` and node extras), `<name>.procmodel.json`, `<name>.components.json` (the register: one row per component with every 5.1 field) and `<name>.georeference.json`, to a staging folder renamed when complete.
- **GLB import** (`packages/project/src/builder/raw.ts`): parse the GLB JSON chunk only (no full load). `aioGeoref` valid: place as above, `placement: 'placed'`, layer carries `georef`. Compat structure: adapter then the same. Present but invalid or unsupported: `placement: 'needed'` with the reason. Absent: unchanged behaviour (identity, no `placement`). The transform is applied once: the layer transform is computed from the record and the GLB vertices are never rewritten; re-import of an already placed file is idempotent.
- **Vertical datum**: H passes through. Unknown stays `unknown`, never assumed MSL, never snapped to terrain. If both projects declare different known datums, import sets `placement: 'needed'` for height only (horizontal placed) with a message.
- **Photos only**: no defensible anchor means `placement: 'provisional'` at the project origin with a banner; EXIF GPS (camera position) is shown as a hint only. The user sets the anchor with Place model.
- **`.aio`**: the layer `georef` and `placement` ride in the manifest; `engineering/<run>/` files are excluded from packages (evidence may hold photos) unless the project already shares them; `models/*.procmodel.json` and the GLB travel. Export, open and extract are tested to keep placement and node extras.

### 5.7 Place model (4b, S2)

- For every mesh layer (GLB, OBJ, engineering): "Place model..." in the layer right-click menu and the layer panel, and offered (not started) after an import that lands with `placement: 'needed'` or `'provisional'`.
- Step 1: click a point on the 2D map or in the 3D scene (terrain, cloud or mesh hit) and the model's local origin lands there; or type E, N, H in the project CRS, or latitude and longitude.
- Step 2: a gizmo (three.js `TransformControls` in `@aio/engine`): move along east, north, up; rotate about the vertical; modes for tilt and uniform scale; number fields for offsets (m), heading, tilt (deg) and scale. "Drop to ground" sets the base on the terrain or cloud under the anchor only when pressed. Undo (reusing the `previous` pattern of `AlignModel.tsx`), Reset, Done, Cancel.
- Saves to `layer.transform`; works with `recentre.ts` (re-centre shifts it like any layer). For layers with `georef`, updates position, heading and scale with status `user` and `placement: 'placed'`.
- Read-only packages refuse with the existing extract message. The point-pair "Georeference model" stays.

### 5.8 Error handling

Typed errors with user messages: missing key, offline, policy forbids, unsupported model (capability), rate limit (wait message, no lost work), network, invalid proposal (after repair), budget reached, cancelled, reconstruction unavailable, PDAL missing, unsupported CRS, conflicting asset identity (flagged images listed; the user removes them or continues with the majority set, never blended silently). Every error keeps accepted components and completed stages.

## 6. Stages to merge

| Stage | Lands                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Contracts (procmodel/2 + migrator, georef/1 + compat adapter, layer and manifest additions, job params, `engineer` task); assembly builders for all three families; GLB writer with hierarchy, PBR materials, emissive, extras and asset extras; budgets; validator tests |
| S2    | Georeferenced export and import, cross-CRS, `.aio` round trip, scene component inspection, Place model                                                                                                                                                                    |
| S3    | Python `model.evidence` job (crop, ground, axis, sections, members, renders, photo ingest); pipeline pack 0.8.0 (reaches testers only with an installer the founder asks for)                                                                                             |
| S4    | AI identify step, capability table, structured output, policy flags, extended send preview, caching, budgets, mocks for both providers                                                                                                                                    |
| S5    | Setup flow, stages UI, review and corrections, agent tools, entry points enabled, help and docs, end-to-end specs                                                                                                                                                         |

Hidden entry points until S5: the menu items and Model Builder button are behind a build constant `ENGINEERING_MODEL_UI` set true in S5. Place model ships enabled in S2.

## 7. Testing

- **Fixtures**: seeded synthetic generators in Python (`python/tests/synth_assets.py`) and TypeScript (`packages/modelling/src/engineer/fixtures.ts`) for a tapered multi-flue stack with bands and two light levels, a flare with tip and platforms, a four-leg lattice with antennas and a monopole; clouds with noise, gaps (one side missing) and ground; synthetic photos (rendered PNGs) for the photos-only path. Known truth stored beside each.
- **A**: Python `test_model_evidence.py` recovers taper (radius error under 2 percent), flue count and light levels from the partial noisy stack; TS assembler test checks the draft has the measured profile, the flue count and both light levels, and that its triangle set is not the input.
- **B**: assembler tests per family assert assembly kinds (lattice legs and braces, monopole, antennas; flare tip) and absence of chimney-only kinds.
- **C**: photos-only pipeline test with synthetic images and mocked provider: ingestion (orientation applied, duplicates dropped), proposal validated, meshed; single image gives `scale.status: 'provisional'`, `placement: 'provisional'`, hidden parts marked `unobserved`; reconstruction-unavailable path records `unavailable`.
- **D**: store and assembler tests for count and elevation edits (ids and accepted edits kept); e2e saves, reopens and checks.
- **E**: e2e `engineering-picking.spec.ts` (hover card, click, Focus, Escape, background clear, hide, drag without select, multi-material highlight) at 1100 x 720; GLB and `.aio` round-trip unit tests on extras.
- **F**: `packages/project` tests export from project A and import into B (different origin; different UTM zone; rotated asset; unknown vertical; missing metadata; re-import idempotent), comparing transformed vertex positions in world E, N, H against truth; e2e `engineering-georef.spec.ts`.
- **G**: every produced GLB in tests goes through `gltf-validator` and the geometry checks (open flue mouths verified by boundary loops at the declared openings).
- **H**: `packages/ai` tests with fetch mocks for OpenAI and Anthropic replies through `generateObject`; offline (no request, asserted by the fetch mock and the e2e network guard), no key, invalid reply then repair, rate limit, cancel, resume from cache.
- **I**: Python test on a generated large cloud asserts bounded points read and only images in the pack; renderer test asserts no raw arrays cross IPC.
- **E2E** (`apps/desktop/e2e/engineering-model.spec.ts`): setup, run with `QUADRION_AI_TEST_PROVIDER=1` scripted replies, review, correction, accept, export. All specs run the CI way (`QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=warp`, `--workers=1`).
- **Local comparison** (outside git): `tools/agent/engineering-compare.mjs` takes any engineering run and a reference GLB path as arguments, renders full, rear, crown, base and light views of both, lists the component inventories side by side and reports residuals and coverage. The founder runs the live evaluation on the private reference in the app.

## 8. Known limitations (to state in help)

- The result is an engineering interpretation, not an as-built survey or fabrication drawing. Inferred parts are marked.
- Photos-only models have provisional scale and placement until a reference dimension and an anchor are set.
- Warning light type, count and height are read from evidence; nothing is claimed about regulatory compliance or flash pattern.
- Cross-CRS import covers the bundled registry (WGS84, Web Mercator, WGS84 UTM and static definitions); others need Place model.
- Unknown vertical datums stay unknown; heights from two such projects are assumed comparable only with the user's say-so.
- Reconstruction from photos needs the photogrammetry runtime (Windows x64 and Apple silicon packs).
- Equipment make, model and process duty stay unknown unless a user enters them.

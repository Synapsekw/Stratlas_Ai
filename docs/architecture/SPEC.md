# Architecture specification

|         |                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| Status  | Approved v1.0 (2026-10-03)                                                                                         |
| Date    | 2026-10-03                                                                                                         |
| Inputs  | [PRD v1.1](../PRD.md), [tech evaluation](tech-evaluation.md), Kestrel review (below), six reference artifacts      |
| Decided | Electron shell; Kestrel stays a separate app, code may be copied; annotation suite in Release A; no model training |

## 1. Shape of the system

```
┌──────────────────────────── Electron app ────────────────────────────┐
│ Main process (Node)                                                  │
│   app lifecycle · windows · menus · native dialogs                   │
│   aio:// protocol (Range/206 streaming from project roots + packs)   │
│   settings · key vault (@napi-rs/keyring) · AI runtime (AI SDK)      │
│   IPC router (zod-validated contracts)                               │
│ Utility process "data" (Node)                                        │
│   library.sqlite · project.sqlite · importers · indexers · exports   │
│ Renderer (React 19, sandboxed, contextIsolation, no Node)            │
│   app shell + docking (dockview) · panels · stores (Zustand)         │
│   Viewports: 3D · Map · Video · Photo · Point cloud · Report         │
│   Engine (three.js r186) · MapLibre · workers (COPC, decode, tiles)  │
│   Legacy viewer host (sandboxed <webview>-free iframe on aio://)     │
│ Release B: Python sidecar (python-build-standalone) JSON-RPC/stdio   │
└──────────────────────────────────────────────────────────────────────┘
```

Rules that keep it fast, safe and offline:

- The renderer never touches the file system, the network or keys. It asks the main process through typed IPC and reads bulk data through `aio://`.
- Heavy CPU work runs off the UI thread: point-cloud decode and tile reprojection in Web Workers; SQLite, indexing and import in the data utility process; pipelines in Python (Release B).
- AI calls run only in the main process. With cloud AI off, the main process refuses outbound requests, and a network-blocking end-to-end test proves zero requests.

## 2. Monorepo layout and ownership

pnpm workspaces. Every package has one owner stream (section 9), its own tests, and a public API in `src/index.ts`. Packages depend only on `schema` and on packages listed under "depends on".

| Package               | Responsibility                                                                                                                                                          | Depends on                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/schema`     | zod schemas and TS types: project manifest, layers, time, annotations, severity models, IPC contracts, agent tools                                                      | none                          |
| `packages/geo`        | CRS registry (proj4, EPSG defs bundled), float64 project origin, transforms, quadtree tiling, geodesy                                                                   | schema                        |
| `packages/engine`     | three.js scene graph, cameras and controls, picking, layer render adapters, projector shaders, clipping, measure                                                        | schema, geo                   |
| `packages/pointcloud` | COPC reader (copc.js + laz-perf) in workers, octree LOD, EDL, legacy packed clouds, Potree 2 adapter                                                                    | schema, geo, engine           |
| `packages/maps`       | MapLibre 2D map, PMTiles protocol over aio://, styles, glyphs, sprites; 3D ground quadtree from raster tiles                                                            | schema, geo, engine           |
| `packages/video`      | playback controller (`<video>` + rVFC), WebCodecs exact-frame, telemetry parsers (kit flight JSON, DJI SRT), clip-to-flight sync, lens models (pinhole, f-theta)        | schema, geo                   |
| `packages/annotate`   | annotation tools for mesh, image, video, point cloud, map; issues and sightings; severity models; back-projection; undo stack                                           | schema, geo, engine, video    |
| `packages/ai`         | provider registry (Anthropic, OpenAI, Gemini via AI SDK), model routing, agent loop, tool registry, approval policy, cost meter; split into `ai/main` and `ai/renderer` | schema                        |
| `packages/brand`      | product name, app ID, wordmark, icon set, report brand themes (e&, Zain, whitelabel); the only place the product name lives                                             | none                          |
| `packages/ui`         | design tokens, components, icons, dockview panels, command palette                                                                                                      | schema                        |
| `packages/volumetric` | native volumetric workspace: stockpile register, four bases, volumes recomputed from the kit grids in a worker, cut and fill, sections, boundary editor (N1)            | schema, engine, ui, workspace |
| `packages/project`    | package read/write, importers for the six kit formats, exports (CSV, GeoJSON, COCO, kit JSON, ZIP64)                                                                    | schema, geo                   |
| `packages/change`     | change between capture dates (M8 C1): change sets and register, issue, detection and vector change, producer registry (C2 to C4 plug in), Changes panel                 | schema, ui, workspace         |
| `packages/modelling`  | procedural models from drawings and point clouds (M8 C5): validation, mesher (one tagged node per part), GLB writer, Model builder screen                               | schema, ui                    |
| `apps/desktop`        | Electron main, preload, data utility process, renderer app composition                                                                                                  | all                           |
| `legacy/`             | the four existing viewer builds, hosted unchanged (Release A fallback and parity reference)                                                                             | none                          |
| `python/`             | Release B pipelines (copied from the Asset Inspection Kit, the Volumetric Survey Kit and Kestrel backend modules)                                                       | none                          |

## 3. Core contracts (written first, frozen early)

These live in `packages/schema` and are the only coupling between streams. They are reviewed and frozen before parallel work starts; later changes go through a short contract-change note.

### 3.1 Project manifest and layers

```ts
type ProjectManifest = {
  schema: 'aio.project/1';
  id: string;
  name: string;
  customer?: string;
  site?: string;
  crs: { epsg: number } | { wkt: string }; // project CRS
  origin: [number, number, number]; // float64, in project CRS
  captures: Capture[]; // survey dates
  layers: Layer[];
  severityModels: SeverityModel[];
  classCatalogues: ClassCatalogue[];
  brand?: string;
};

type Layer =
  | { kind: 'mesh'; id; name; src: AssetRef; transform: Mat4; tags?: AssetTag[] }
  | { kind: 'pointcloud'; id; name; src: AssetRef; format: 'copc' | 'potree2' | 'kit-packed' }
  | { kind: 'basemap'; id; pack: string; style: 'dark' | 'light' }
  | {
      kind: 'raster';
      id;
      name;
      src: AssetRef;
      role: 'ortho' | 'dsm' | 'plan';
      format: 'cog' | 'pmtiles' | 'kit-pyramid';
    }
  | { kind: 'video'; id; name; src: AssetRef; flight: FlightRef; lens: LensModel; offsetMs: number }
  | { kind: 'photos'; id; name; items: PhotoRef[] } // pose per photo
  | { kind: 'panoramas'; id; items: PanoRef[] }
  | { kind: 'legacy'; id; viewer: 'aik' | 'volumetric' | 'road' | 'twin'; entry: AssetRef };
```

`AssetRef` is a content hash inside the package or a path in `external.json` (data left on the NAS).

### 3.2 Time

One project clock in UTC milliseconds. Every time-bearing layer maps its local time to the clock: video by `flight start + offsetMs`, photos by EXIF time, captures by date. The timeline store owns the playhead; viewports subscribe. The flight log is the clock master during playback; the video element is slaved to it, with drift correction from `requestVideoFrameCallback`.

### 3.3 Annotations, issues and severity

```ts
type SeverityModel = {
  id: string;
  name: string; // e.g. "Flare stack corrosion (kit stack profile)"
  levels: { value: number; label: string; color: string; criteria: string; action?: string }[];
  uncertain?: { label: string; color: string }; // not graded
};

type Issue = {
  id: string;
  code: string; // D01, F03 ...
  classId: string;
  severity: number | 'uncertain';
  status: 'draft' | 'reviewed' | 'approved' | 'closed';
  title: string;
  note: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  sightings: Sighting[]; // one issue, many datasets
  measurements?: Measurement[];
  source: 'human' | 'agent' | 'import';
};

type Sighting =
  | {
      on: 'mesh';
      layer: string;
      geom: SurfacePoint | SurfacePolyline | SurfacePolygon | SurfacePatch;
    }
  | { on: 'image'; layer: string; photo: string; geom: Box | RotBox | Polygon | Point | MaskRef }
  | {
      on: 'video';
      layer: string;
      track: { t: number; geom: Box | Polygon }[];
      range?: [number, number];
    }
  | { on: 'pointcloud'; layer: string; geom: Point3 | Box3 | Polygon3 | PointSelectionRef }
  | { on: 'map'; layer: string; geom: GeoJSON.Geometry }
  | { on: 'pano'; layer: string; pano: string; geom: SphericalPolygon };
```

Back-projection (ANN-9) is one function in `annotate`: image or frame geometry plus the camera pose and lens, raycast against the mesh or ground, gives a mesh sighting. It reuses the logic of the Asset Inspection Kit `project.py` (pins and patches) and the HCl projector maths.

### 3.4 Agent tools

```ts
type ToolDef<I, O> = {
  name: string;
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  scope: 'app' | 'project' | 'window'; // which windows offer it
  risk: 'read' | 'navigate' | 'write' | 'send'; // write and send need approval
  run: (input: I, ctx: ToolContext) => Promise<O>;
};
```

The agent loop runs in the main process. Tools that act on the scene (fly to, set time, select, capture frame) are executed in the renderer through an IPC round trip; data tools (query issues, compare captures, export) run in the data process. Each call becomes a visible step with approve and undo. Patterns are copied from Kestrel's project agent: risk tiers, approvals that survive a restart, fixed-text error messages.

### 3.5 IPC

Every channel is declared once in `schema/ipc.ts` as `{ request: ZodType, response: ZodType }`. The preload exposes a typed `window.aio` with no generic `invoke`. Main validates every request.

## 4. Fusion: how the mandatory experiences work

**Shared scene.** All layers render in one three.js scene in a local east-north-up frame around the float64 project origin, so float32 geometry stays precise at UTM magnitudes.

**Al-Zour (video + map + model).** Ground = quadtree of raster tiles: ortho where present, basemap raster cache elsewhere. Plant GLB on top. Each video layer draws its flight path; playing a clip moves the drone marker along the interpolated pose and the projector shader drapes the current frame onto the ground and the plant (ground footprint and mesh projection are the same shader with different receivers). The 2D map viewport shows the same path and footprint in MapLibre, sharing selection and playhead.

**HCl tank (video on mesh + cloud).** Tank GLB receives the f-theta projection from the Elios pose; the point cloud renders with EDL; section planes clip mesh and cloud together; findings are issues with mesh sightings, linked to the frames that see them.

**Ported, not rewritten.** The projector shaders, f-theta code, rVFC sync, flight interpolation and the packed-cloud decoder come from the HCl and Al-Zour artifacts and the Asset Inspection Kit engine source, refactored into `engine`, `video` and `pointcloud`. The point-cloud LOD, EDL, clip box and measure come from Kestrel `frontend/src/clouds/`, with COPC added. The image annotation canvas comes from Kestrel `images/`.

## 5. Offline maps

- Build step (CI or a script, online once): `pmtiles extract` from the Protomaps daily planet build with a GCC bounding box to z15 and the world to z6, producing `gcc.pmtiles` and `world.pmtiles`, plus the Protomaps style, glyphs (Latin and Arabic) and sprites.
- Packs live in a shared app data folder, registered in `library.sqlite`, served over `aio://packs/…` with range requests to the `pmtiles` protocol in MapLibre.
- The 3D ground uses a rasterised cache of the same style (generated per tile on demand in a worker, cached on disk).
- Legacy jobs keep their baked basemap images. No online tile source exists anywhere in the app.

## 6. Legacy viewers in Release A

The six existing jobs open two ways:

1. **Native**: importers in `packages/project` convert kit offline folders into a project package (manifest, layers, issues, severity model from the kit profile). The two mandatory workspaces (Al-Zour and HCl) are native from the first milestone.
2. **Legacy host**: until each native workspace reaches parity, the original offline viewer runs inside a sandboxed iframe served from `aio://legacy/…`, with the platform shims (downloads, db, pdf.js bundled) injected. This guarantees all six open on day one and gives a pixel reference for parity tests.

## 7. Release B: Builder

- `python/aio_pipelines`: a versioned, separately signed pipeline pack. It is copied from the Asset Inspection Kit (cameras, project, records, report), the Volumetric Survey Kit (resample, process, package) and Kestrel backend modules (PotreeConverter import with RAM admission, volumes and surfaces, reportlab reports). Kestrel's OpenAPI-first discipline is kept by defining pipeline jobs as JSON-RPC methods with schemas in `packages/schema`.
- Main spawns jobs, streams progress and logs to a Jobs panel, supports cancel and resume from per-step manifests.
- Detection review uses the annotation suite. AI-assisted detection calls the routed vision model and writes draft issues. Local inference later runs ONNX through onnxruntime (no training, no AGPL code in customer builds).
- Customer package export: ZIP64 store mode, optional AES, read-only player flag, AI policy forced to forbid unless the package allows it.

## 8. Quality, security and testing

- TypeScript strict everywhere; ESLint flat config with typescript-eslint; Prettier; lefthook with lint-staged; commitlint.
- Vitest unit tests per package (geo maths, parsers, schemas, severity logic, back-projection); golden tests for CRS against control points from the six projects.
- Playwright Electron E2E: open each of the six projects, play an Al-Zour clip, annotate in each viewport, export; the zero-network test runs the whole suite with all non-`aio:` requests failing.
- Visual parity tests: native workspace screenshots against the legacy viewer at the same camera.
- Performance test: recorded camera path on Al-Zour and HCl with frame-time budget.
- Security: contextIsolation, sandbox, no remote content, strict CSP, Electron fuses, IPC validation, keys only in the OS vault, signed builds.
- Docs: this spec, ADRs in `docs/architecture/adr/`, a README per package, CONTRIBUTING with the stream workflow.

## 9. Parallel delivery model

The build is organised so many agents can work at once without blocking each other.

**Phase 0, serial, short (one agent, about 1 hour).** Scaffold the monorepo with tooling and CI; write `packages/schema` (all contracts above) and stub every package with its public API and a failing test; add fixtures extracted from the six projects (small slices: a GLB, 10 s of video with its flight log, 1 M points, 50 photos with poses, a PMTiles extract of Kuwait City). Contracts are reviewed and frozen at the end of this phase.

**Phase 1, parallel (about 10 streams, each in its own git worktree and branch).**

| Stream                      | Owns                                                                                 | First deliverable                                                            |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| S1 Shell                    | `apps/desktop` main, preload, aio:// protocol, settings, keys, data process, library | App opens, library lists fixture projects, aio:// streams video with seeking |
| S2 UI                       | `packages/ui`, renderer composition, chosen UI direction, docking, command palette   | Four screens of the chosen direction with live stores                        |
| S3 Engine                   | `packages/engine`, `packages/geo`                                                    | Georeferenced scene with GLB, picking, cameras, clipping, measure            |
| S4 Point cloud              | `packages/pointcloud`                                                                | COPC + legacy packed clouds with LOD and EDL at budget                       |
| S5 Maps                     | `packages/maps`, map pack build script                                               | GCC + world packs; 2D map; 3D ground quadtree                                |
| S6 Video                    | `packages/video`                                                                     | Synced playback, flight path, projection onto ground and mesh, f-theta       |
| S7 Annotate                 | `packages/annotate`                                                                  | Issue model, severity models, image and mesh tools, back-projection          |
| S8 Annotate video and cloud | `packages/annotate` (video, cloud, map tools)                                        | Video tracks and time ranges, cloud and map tools                            |
| S9 AI                       | `packages/ai`                                                                        | Providers, routing, agent loop, tool registry, approvals, agent panel        |
| S10 Import and legacy       | `packages/project`, `legacy/`                                                        | Importers for the six jobs, legacy host with shims, exports                  |
| S11 QA and release          | CI, E2E, zero-network, perf tests, electron-builder, signing                         | Nightly installers for Windows and macOS                                     |

**Integration.** An integration agent merges streams into `main` every cycle (about every 60 to 90 minutes of agent time), runs the full test suite, and posts a status. A stream merges only green. Contract changes need a note and the integration agent's sign-off.

**Phase 2, vertical slices.** Once streams land, slice teams assemble the Al-Zour workspace and the HCl workspace end to end, then the remaining four projects, then customer mode.

**What can start before the UI direction is chosen.** S3 to S11 do not depend on the visual direction. Only S2 waits for it.

## 10. Milestones

| Milestone           | Content                                                                            | Exit test                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M0 Foundation       | Phase 0 complete                                                                   | CI green on Windows and macOS; contracts frozen                                                            |
| M1 Fusion core      | S1 to S6 first deliverables integrated                                             | Al-Zour fixture plays a clip with ground and mesh projection at 60 fps; HCl fixture projects onto the tank |
| M2 Annotate and AI  | S7 to S9 integrated                                                                | Issue created on a photo appears on the mesh and in the video; agent answers and acts in each viewport     |
| M3 All six projects | S10 importers + legacy host                                                        | All six open offline; visual parity checks pass                                                            |
| M4 Release A        | Customer mode, installers, docs                                                    | Signed installers; zero-network suite passes; PRD Release A musts met                                      |
| M5 to M7 Release B  | Pipeline pack, builder wizard, detection review, report generation, package export | 300-photo job built end to end in under one day                                                            |

## 11. Open decisions

1. UI direction: **decided, Mission** (ADR 0002, `docs/design/DIRECTION.md`). The product name is **Stratlas, temporary**: the display name, app ID, executable name, URL scheme label, icons and wordmark come from one file, `packages/brand/brand.json` plus its icon set, so a rename touches only that package and the installer config generated from it. Internal identifiers (package scope `@aio/*`, the `aio://` protocol, `.aio` project folders) stay neutral and do not change on rename.
2. Code-signing certificates and Apple Developer account in the Synapse entity.
3. Mapbox-baked basemaps inside legacy jobs: keep for internal use, replace with OSM before customer distribution.
4. Licensing model for customer installs.

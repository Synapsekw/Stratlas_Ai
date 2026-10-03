# Phase 0 (M0 Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A green, typed, linted pnpm monorepo with frozen shared contracts, stubbed packages, a launchable Electron shell and local fixtures, so eleven streams can work in parallel.

**Architecture:** pnpm workspaces; `packages/schema` holds every cross-package contract as zod schemas plus inferred types; every other package depends only on `schema` and the packages SPEC section 2 lists; `apps/desktop` is electron-vite (main, preload, renderer). Client data never enters git.

**Tech Stack:** Node 24, pnpm 10.24, TypeScript 6.0.x (pinned below 6.1 for typescript-eslint), ESLint 10 flat + typescript-eslint 8.71, Prettier 3.9, Vitest 5, Playwright 1.63, zod 4, Electron 44, electron-vite 5, Vite 8, React 19.3.

**Spec:** `docs/architecture/SPEC.md` (approved v1.0), `docs/PRD.md` v1.1, `docs/design/DIRECTION.md`, ADR 0001 and 0002.

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`; ESM everywhere (`"type": "module"`).
- Package scope `@aio/*`; protocol `aio://`; product name only in `packages/brand`.
- Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP `default-src 'self' aio:`; no remote origins.
- Zero network requests when cloud AI is off (enforced by the E2E zero-network test).
- No client data in git: `docs/design/assets/`, `fixtures/data/` are git-ignored.
- No em or en dashes in user-facing copy.
- Local commits only; never push.

## Review Focus

1. A manifest written by a newer app version (`schema: 'aio.project/2'`) must be rejected with a message naming the version, not crash. Test in Task 2.
2. A severity value outside the project's severity model must fail validation with the issue code in the message. Test in Task 2.
3. An IPC request with extra or wrong-typed fields must be rejected by main before any handler runs. Test in Task 5.
4. The packaged app must start with no network at all and make zero non-`aio:`/`file:` requests. Test in Task 5 (E2E).
5. A video sighting whose track is not time-sorted must be rejected (interpolation depends on order). Test in Task 2.

---

### Task 1: Repository and tooling

**Files:** create `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, `.npmrc`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `prettier.config.js`, `.prettierignore`, `lefthook.yml`, `commitlint.config.js`, `README.md`, `CONTRIBUTING.md`, `docs/architecture/adr/template.md`.

- [ ] Step 1: `git init -b main`; write `.gitignore` (node_modules, dist, out, .vite, coverage, playwright-report, test-results, _.log, .env_, `docs/design/assets/`, `fixtures/data/`, `.claude/settings.local.json`).
- [ ] Step 2: root `package.json` (private, type module, packageManager `pnpm@10.24.0`, engines node >=24) with scripts `lint`, `lint:fix`, `format`, `format:check`, `typecheck` (`tsc -b`), `test` (`vitest run`), `test:e2e`, `dev`, `build`, `fixtures`; `pnpm-workspace.yaml` with `apps/*`, `packages/*`; `.npmrc` `node-linker=hoisted`, `auto-install-peers=true`.
- [ ] Step 3: `tsconfig.base.json` with the Global Constraints flags, `target ES2023`, `module/moduleResolution NodeNext` for packages, `composite`, `declaration`, `sourceMap`; root `tsconfig.json` with project references.
- [ ] Step 4: ESLint flat config: `@eslint/js` recommended, `typescript-eslint` strictTypeChecked + stylisticTypeChecked with `projectService`, `eslint-plugin-react-hooks`, `eslint-config-prettier`; rules: `no-console` warn (allow warn/error), `@typescript-eslint/consistent-type-imports`, import boundaries rule forbidding `apps/*` imports from packages and renderer imports of `electron`/`node:*`.
- [ ] Step 5: Prettier (printWidth 100, singleQuote, trailingComma all); lefthook pre-commit `lint-staged` (eslint --fix, prettier --write), commit-msg commitlint conventional.
- [ ] Step 6: `pnpm install`; run `pnpm lint && pnpm format:check` → expected PASS on the empty tree. Commit `chore: scaffold monorepo tooling`.

### Task 2: `packages/schema` contracts (frozen at end of Phase 0)

**Files:** `packages/schema/{package.json,tsconfig.json,README.md}`, `src/index.ts`, `src/common.ts`, `src/manifest.ts`, `src/layers.ts`, `src/time.ts`, `src/annotation.ts`, `src/severity.ts`, `src/agent.ts`, `src/ipc.ts`, tests `src/*.test.ts`.

**Produces:** zod schemas `ProjectManifest`, `Layer`, `AssetRef`, `Capture`, `LensModel`, `FlightRef`, `PoseSample`, `SeverityModel`, `ClassCatalogue`, `Issue`, `Sighting`, `ToolMeta`, `IpcContract` map `ipc`, and helper `parseManifest(json: unknown): Result<ProjectManifest>`; `validateIssueAgainstModel(issue, model): Result<Issue>`; all types via `z.infer`.

Key definitions (exact):

```ts
// common.ts
export const Id = z.string().min(1).max(128);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Mat4 = z.array(z.number()).length(16);
export const IsoTime = z.string().datetime({ offset: true });
export const AssetRef = z.union([
  z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ path: z.string().min(1) }), // relative to package root or external.json entry
]);
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
```

```ts
// layers.ts (discriminated on kind)
LensModel = discriminatedUnion('model', [
  { model: 'pinhole', hfovDeg: number(0,180), aspect: number>0 },
  { model: 'ftheta', hfovDeg: number(0,360), aspect: number>0, k?: number[] },
]);
PoseSample = { t: number /* ms since flight start */, pos: Vec3, q: Quat, gimbal?: { pitch, yaw, roll } };
FlightRef = { src: AssetRef, startUtcMs: number int };
Layer = discriminatedUnion('kind', [mesh, pointcloud, basemap, raster, video, photos, panoramas, legacy])
// fields exactly as SPEC 3.1; every layer has id: Id, name: string, visible: boolean default true
```

```ts
// manifest.ts
export const SCHEMA_VERSION = 'aio.project/1' as const;
export const ProjectManifest = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    id: Id,
    name: z.string().min(1),
    customer: z.string().optional(),
    site: z.string().optional(),
    crs: z.union([z.object({ epsg: z.number().int() }), z.object({ wkt: z.string() })]),
    origin: Vec3,
    captures: z.array(Capture),
    layers: z.array(Layer),
    severityModels: z.array(SeverityModel),
    classCatalogues: z.array(ClassCatalogue),
    brand: z.string().optional(),
  })
  .superRefine(uniqueIds('layers'))
  .superRefine(uniqueIds('severityModels'));
export function parseManifest(json: unknown): Result<ProjectManifest>; // rejects other schema versions with
// error `Project was saved by a newer Stratlas (schema ${v}). Update the app to open it.`
```

```ts
// severity.ts
SeverityLevel = { value: int 0..9, label, color: /^#[0-9a-f]{6}$/i, criteria: string, action?: string }
SeverityModel = { id, name, levels: SeverityLevel[] (min 1, unique values, sorted asc), uncertain?: { label, color } }
ClassCatalogue = { id, name, assetType: string, classes: { id, label, color, hotkey?: string(len 1), severityModel: Id }[] }
```

```ts
// annotation.ts
Geometry types: Box {x,y,w,h} in image px; RotBox +angleDeg; Polygon {points:[x,y][] min 3}; Point2 {x,y};
MaskRef {src: AssetRef}; SurfacePoint {p: Vec3, n: Vec3, face?: int}; SurfacePolyline {points: Vec3[] min 2};
SurfacePolygon {points: Vec3[] min 3}; SurfacePatch {src: AssetRef /* mesh patch glb */}; Box3 {min: Vec3, max: Vec3};
Sighting = discriminatedUnion('on', [mesh, image, video, pointcloud, map, pano]) exactly per SPEC 3.3;
video.track: { t: number, geom: Box|Polygon }[] min 1, refine: strictly increasing t
  -> message "Video track keyframes must be in time order".
Issue = { id, code: /^[A-Z]{1,3}\d{2,4}$/, classId, severityModelId, severity: int | 'uncertain',
  status: 'draft'|'reviewed'|'approved'|'closed', title, note, author, createdAt: IsoTime, updatedAt: IsoTime,
  sightings: Sighting[] min 1, source: 'human'|'agent'|'import' }
validateIssueAgainstModel(issue, model): error `Issue ${code}: severity ${s} is not in model "${model.name}"`
  when severity is a number not among levels, or 'uncertain' when model.uncertain is absent.
```

```ts
// agent.ts (metadata only; run() lives in ai package)
ToolRisk = enum ['read','navigate','write','send']; ToolScope = enum ['app','project','window'];
ToolMeta = { name: /^[a-z][a-z0-9_]{2,63}$/, description: string min 10, scope, risk, windows?: WindowKind[] }
WindowKind = enum ['scene3d','map','video','photo','pointcloud','report','issues']
needsApproval(risk) => risk === 'write' || risk === 'send'
```

```ts
// ipc.ts: single source of channels
export const ipc = {
  'app:getInfo': { request: z.object({}).strict(), response: z.object({ name: z.string(), version: z.string(), platform: z.string() }) },
  'library:list': { request: z.object({}).strict(), response: z.array(LibraryEntry) },
  'project:open': { request: z.object({ path: z.string().min(1) }).strict(), response: ProjectManifestResult },
  'settings:get': ..., 'settings:set': ..., 'ai:setKey': { request: { provider: enum['anthropic','openai','google'], key: string min 8 }.strict(), response: { ok: boolean } },
  'ai:hasKey': ..., 'dialog:openFolder': ...
} as const satisfies Record<string, { request: ZodType; response: ZodType }>;
export type IpcChannel = keyof typeof ipc;
```

- [ ] Step 1: Write tests first: valid Al-Zour-like manifest parses; `aio.project/2` rejected with the newer-version message; duplicate layer ids rejected; out-of-model severity rejected with code in message; unsorted video track rejected; `ipc['project:open'].request` rejects extra keys; tool name regex.
- [ ] Step 2: `pnpm -F @aio/schema test` → FAIL (modules missing).
- [ ] Step 3: Implement the files above.
- [ ] Step 4: Tests PASS; `pnpm typecheck` PASS. Commit `feat(schema): shared contracts v1`.

### Task 3: `packages/brand`

**Files:** `packages/brand/{package.json,tsconfig.json,README.md,brand.json,src/index.ts,src/index.test.ts,icons/mark.svg,icons/icon.svg}`.
`brand.json`: `{ "productName": "Stratlas", "appId": "ai.synapse-solutions.stratlas", "executableName": "Stratlas", "temporary": true, "company": "Synapse Solutions" }`. Icons copied from `docs/brand/logos/round2/stratlas-r5-*.svg`. `src/index.ts` exports typed `brand` (zod-validated). Test: productName non-empty, appId reverse-DNS. Commit `feat(brand): single-source product identity`.

### Task 4: Package stubs with public APIs

For each of `geo, engine, pointcloud, maps, video, annotate, ai, ui, project`: `package.json` (`@aio/<name>`, deps per SPEC section 2), `tsconfig.json` (references), `README.md` (responsibility, public API, owner stream), `src/index.ts` exporting the interfaces below, `src/index.test.ts` with one real test.

- geo: `createOrigin(origin: Vec3, epsg: number): ProjectFrame`; `ProjectFrame.toLocal(xyz: Vec3): Vec3`, `toProject(local: Vec3): Vec3` (implemented: subtraction/addition in float64; test round-trip at UTM magnitudes 245884.9, 3179597.1 keeps 1 mm).
- engine: `interface Viewport { mount(el: HTMLElement): void; dispose(): void; setLayers(l: Layer[]): void }` and `interface LayerAdapter<K extends Layer['kind']>`; test: type-level + adapter registry `registerAdapter/getAdapter`.
- pointcloud: `decodeKitPacked(buf: ArrayBuffer, scale: number, offset: Vec3): { positions: Float32Array; intensity: Uint8Array }` implemented (int16 xyz mm + uint8 intensity, 7 bytes per point) with a test on a synthetic 2-point buffer.
- maps: `interface MapPack { id: string; path: string; bbox: [number,number,number,number]; maxZoom: number }`; `packUrl(pack: MapPack): string` returns `pmtiles://aio://packs/<id>.pmtiles`; test.
- video: `interpolatePose(samples: PoseSample[], tMs: number): PoseSample` implemented (lerp position, slerp quaternion, clamp at ends) with tests.
- annotate: `nextIssueCode(existing: string[], prefix: string): string` (F01 to F99 then F100) implemented with test; re-export schema types.
- ai: `PROVIDERS = ['anthropic','openai','google'] as const`; `interface ModelRoute { task: 'chat'|'vision'|'report'|'extract'|'build'; provider; model: string }`; `defaultRoutes()`; test.
- ui: `tokens` object mirroring DIRECTION.md (bg-0..3, chrome, line*, fg-0..4, acc*, s1..s5, fonts, scale, radii); `tokens.css` generated by `scripts/build-tokens.ts`; test that every severity token exists.
- project: `kitImporters` registry type and `detectPackageKind(files: string[]): 'aik'|'volumetric'|'road'|'twin'|'native'|null` implemented with tests using the known file names of each package.

- [ ] Steps: write tests, run (fail), implement, run (pass), `pnpm lint && pnpm typecheck && pnpm test` green, commit `feat: package stubs with public APIs`.

### Task 5: `apps/desktop` launchable shell

**Files:** `apps/desktop/{package.json,electron.vite.config.ts,electron-builder.yml,tsconfig.*.json}`, `src/main/{index.ts,ipc.ts,protocol.ts,window.ts}`, `src/preload/index.ts`, `src/renderer/{index.html,main.tsx,App.tsx,styles.css}`, tests `src/main/ipc.test.ts`, `e2e/smoke.spec.ts`, `playwright.config.ts`.

- main: single BrowserWindow (1440x900, min 1100x700, dark `backgroundColor` = tokens bg-0, `titleBarStyle: 'hidden'` with overlay on Windows), security flags from Global Constraints, `registerSchemesAsPrivileged` for `aio` (standard, secure, supportFetchAPI, stream, corsEnabled) with a stub handler returning 404; `handle(channel, fn)` wrapper that parses with `ipc[channel].request` and rejects invalid input before calling `fn`, then validates output.
- preload: `contextBridge.exposeInMainWorld('aio', { invoke: <C extends IpcChannel>(c, req) => ipcRenderer.invoke(c, req) })` typed via schema.
- renderer: React app showing the Mission title bar (wordmark from brand, Offline chip) and an empty stage, styled by `@aio/ui/tokens.css`; fonts IBM Plex bundled from `@fontsource` packages.
- Tests: Vitest `ipc.test.ts` (invalid request rejected without handler call; valid passes); Playwright `_electron.launch` smoke: window title contains productName, `window.aio.invoke('app:getInfo', {})` returns name, and a request listener fails the test on any URL whose protocol is not `file:`, `aio:`, `devtools:` or `data:`/`blob:`.
- [ ] Steps: tests first, implement, `pnpm -F desktop build && pnpm test:e2e` green, commit `feat(desktop): secure Electron shell`.

### Task 6: CI and contributor workflow

**Files:** `.github/workflows/ci.yml` (matrix windows-latest, macos-latest; pnpm cache; lint, typecheck, test, build, e2e with xvfb not needed on win/mac), `CONTRIBUTING.md` (streams, worktrees under `../stratlas-wt/<stream>`, branch names `stream/<sN>-<name>`, merge only green, contract-change notes in `docs/architecture/contract-changes.md`), `docs/architecture/contract-changes.md`.

- [ ] Commit `ci: lint, typecheck, test, e2e on Windows and macOS`.

### Task 7: Fixtures

**Files:** `tools/fixtures/build.mjs`, `fixtures/README.md`, git-ignored `fixtures/data/{alzour,hcl}/`.

- `pnpm fixtures` copies from `docs/design/assets/` (already extracted real data) into `fixtures/data/alzour` and `fixtures/data/hcl`, and writes a `manifest.json` per project that validates with `parseManifest` (Al-Zour: mesh plant.glb, raster ortho, basemap placeholder, 2 video layers with flights from the clip path JSONs, panoramas; HCl: mesh tank.glb, pointcloud kit-packed cloud.bin, 2 video layers with f-theta lens 114 deg, issues from findings.json mapped to `Issue` with severity model "HCl lining 1 to 5").
- Test: `tools/fixtures/build.test.mjs` runs the build into a temp dir and validates both manifests.
- [ ] Commit `chore(fixtures): local fixture builder for Al-Zour and HCl`.

### Task 8 (runs in parallel from the start): full project data staging

Founder requirement: M1 must open **KIPIC Al-Zour and HCl Tank with all their data**, not fixtures only. A background job stages complete source data, read-only from the sources, into `E:\Stratlas Data\sources\{alzour,hcl}\` (outside the repo) with an inventory `INVENTORY.md` per project. Sources: Al-Zour published artifact files and asset store (25 clips, flights.json, panoramas, photos, ortho tile pyramid, point-cloud chunks, plan tiles, asset register CSV, plant GLB) and the HCl offline package on `\\DanNas\Work Data\Asset Inspections\Oil and Gas\Hydrochloric Acid Tank\HCl Tank 710-D-130335 Digital Report` (10 flights of video, 10 clouds, flight JSONs, photos, thumbs, findings, PDF). Stream S10 later converts these into `.aio` packages in `E:\Stratlas Data\projects\`.

**Exit (M0):** `pnpm lint && pnpm typecheck && pnpm test && pnpm -F desktop build && pnpm test:e2e` all green locally on Windows; contracts tagged `contracts-v1`.

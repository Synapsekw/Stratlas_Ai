# Create engineering model: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn point clouds, ordinary photos or both into a clean, component-based, editable and georeferenced engineering model of a chimney, flare stack or telecom tower, reviewable in Quadrion and exportable as a validated GLB with its specification, component register and georeference.

**Architecture:** A Python job (`model.evidence`) measures the asset locally and writes a bounded evidence pack. The existing AI layer in the main process makes structured, cached, budgeted calls that return a typed proposal. Deterministic TypeScript in `@aio/modelling` assembles measurements, proposal and user values into an `aio.procmodel/2` model, meshes it into PBR component nodes and writes the GLB. Placement uses a new `aio.georef/1` record carried in the GLB, the sidecar and the mesh layer.

**Tech Stack:** TypeScript (strict), zod, React 19, three.js (GLTFLoader, TransformControls), Vercel AI SDK (`generateObject`), Vitest, Playwright (Electron), Python 3.13 with numpy, scipy, Pillow and PDAL, pytest, Khronos `gltf-validator` (npm).

**Spec:** `docs/plans/2026-10-15-engineering-model-design.md` (read it with this plan; section numbers below refer to it).

## Global Constraints

- Work only in `E:\Dev\AIO Software\.claude\worktrees\engineering-model` on `feat/engineering-model`; never edit the main checkout or another worktree.
- Stage by path (`git add <paths>`), never `git add -A`; never `git stash`; conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm check` green before every stage merge; strict TS, no `any`, no non-null assertions; every package exports its API from `src/index.ts` and depends only on packages SPEC.md section 2 allows.
- No em or en dashes in user-facing text; product name only through `@aio/brand`.
- No client names, site names, real coordinates, private paths, reference screenshots or reference values in code, fixtures, docs or commit messages. Check with `node tools/agent/check-public-text.mjs <files>`.
- Electron runs stay off-screen (`QUADRION_USER_DATA` set by the e2e fixtures). e2e runs with `--workers=1`, one Playwright run at a time.
- Schema files: `aio.procmodel/2` with a migrator; every `@aio/schema` change gets a row in `docs/architecture/contract-changes.md`.
- Sharing flags `aiCloudPhotos` and `aiCloudScans` are off when absent and enforced in the main process. No silent cloud fallback anywhere.
- Detail defaults: points fast 300k, standard 1M, detailed 2M; triangles fast 150k, standard 400k, detailed 900k; AI cost cap fast US$0.50, standard US$2, detailed US$5; AI passes 1, 2, 3; AI wall time 10 minutes per run; one call in flight per run.
- Test F tolerances: 1 mm position, 0.01 degree heading, 1e-6 scale.
- Engineering entry points are behind `ENGINEERING_MODEL_UI` (false until Task 39). Place model ships enabled in S2.
- `apps/desktop/src/renderer/shell/DateMenus.tsx` is also the target of an upcoming, unowned "sidebar right-click menus" ask: add one small group only and mention it in every merge announcement that touches it.
- CI-style e2e: `pnpm demo:build --quick` (and `pnpm demo:change --quick`) first, then from `apps/desktop`: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp pnpm exec playwright test <spec> --workers=1`. In a worktree point `QUADRION_E2E_PYTHON` at the main checkout's venv (memory: e2e in a worktree).

## Review Focus

1. **A `/1` model saved by an older build opened in this build, edited and saved**: must migrate to `/2`, keep every part id and status, keep the `.bak`, and the old build must refuse the `/2` file with the "newer version" message, not a zod dump. Test in Task 12 (`apps/desktop/src/main/modelBuilder.test.ts`, "upgrades a /1 file on save and keeps parts").
2. **A plain GLB from another tool with arbitrary `asset.extras` (not ours, not the compat structure)**: must import exactly as today (identity, no `placement`, same message). Test in Task 16 (`glbGeoref.test.ts`, "foreign extras are ignored").
3. **Lowering a count below the number of accepted components** ("there are two flues, not three" when flue-3 was accepted): accepted flue-3 is kept and flagged, never silently deleted. Test in Task 10 (`merge.test.ts`, "accepted component survives a lowered count").
4. **Photos of two different towers in one run**: the identity conflict is surfaced, the run does not blend them, and the user can drop the flagged images. Test in Task 31 (`engineer.test.ts`, "conflicting identity stops before generate").
5. **Re-centring the project after placing or importing a georeferenced model**: the model must stay at the same world E, N, H (recentre shifts the layer transform once; georef anchor untouched). Test in Task 15 (`placement.test.ts`, "recentre keeps world position").

---

## Package ownership

| Package / area              | Tasks                                      |
| --------------------------- | ------------------------------------------ |
| `packages/schema`           | 1, 2, 3, 4, 17 (ipc rows), 30 (agent)      |
| `packages/modelling`        | 5, 6, 7, 8, 9, 10, 11, 12 (helpers), 37    |
| `packages/geo`              | 15                                         |
| `packages/project`          | 16, 18                                     |
| `packages/engine`           | 19, 21 (gizmo)                             |
| `packages/ai`               | 30, 31, 33                                 |
| `python/`                   | 12 (fit.py), 24, 25, 26, 27, 28            |
| `apps/desktop/src/main`     | 12, 17, 32, 33, 35                         |
| `apps/desktop/src/renderer` | 20, 21 (UI), 28 (jobs), 32, 35, 36, 38, 39 |
| `apps/desktop/e2e`          | 22, 41                                     |
| `docs/`, `tools/agent`      | 4, 40                                      |

## Contract changes (rows for `docs/architecture/contract-changes.md`)

Task 4 adds rows 1 to 6, Task 17 adds row 7, Task 30 adds row 8, Task 32 adds row 9. Approver column: "Founder (2026-10-15 design approval)".

1. `| 2026-10-15 | aio.procmodel/2: adds family, scope, materials[], assemblies[] (20 assembly kinds with bounded params, per-param quality basis measured/observed/inferred/user, sources, unobserved), scale, georef, evidence, run; PartOrigin gains { by: 'engineer', runId, model? }; migrator /1 to /2 adds materials: [] and assemblies: [] only | Engineering models need components, materials and evidence; /1 parts keep their meaning | modelling, desktop (model builder), python (modelfit) | Founder (2026-10-15 design approval) |`
2. `| 2026-10-15 | New family aio.georef/1 (crs, anchor ENH, axes x-east,y-up,z-south, units m, modelToCrs, heading, scale, horizontal, vertical datum or unknown, provenance, deviation) and georefCompat adapter for the asset.extras.georeference structure 'chimney.georeference/1' | Portable placement of exported GLBs between projects | modelling, project, geo, desktop | Founder (2026-10-15 design approval) |`
3. `| 2026-10-15 | Mesh layer gains optional georef (aio.georef/1) and placement ('placed' or 'needed' or 'provisional'); LayerPatch gains the same two keys (mesh layers only) | Georeferenced import and Place model; absent keeps current behaviour | project, engine, desktop | Founder (2026-10-15 design approval) |`
4. `| 2026-10-15 | Manifest gains optional aiCloudPhotos and aiCloudScans (absent means off); aiCloudDrawings unchanged | Separate consent for photos and scan renders sent to cloud AI | ai, desktop | Founder (2026-10-15 design approval) |`
5. `| 2026-10-15 | PipelineName gains model.evidence with ModelEvidenceParams; new schemas EvidencePack (engineering/<run>/evidence.json), EngineerProposal, EngineerRun (engineering/<run>/run.json) | Local measurement job and the AI proposal contract | python, ai, modelling, desktop | Founder (2026-10-15 design approval) |`
6. `| 2026-10-15 | Node extras for procedural GLBs may carry JSON values (component, name, description, category, parent, basis, unobserved, quality) beside the existing string tag, type, part | Component inspection inside Quadrion; tag, type, part unchanged | engine, desktop | Founder (2026-10-15 design approval) |`
7. `| 2026-10-15 | IPC: model:exportEngineering, engineer:runRead, engineer:runWrite, engineer:evidenceImage; ai:setCloudEvidence | Export bundle, persisted runs and policy flags | desktop, schema | Founder (2026-10-15 design approval) |`
8. `| 2026-10-15 | AiTask gains engineer; settings routes gain optional treatAsVision per route | Capability-gated engineering step | ai, desktop | Founder (2026-10-15 design approval) |`
9. `| 2026-10-15 | IPC ai:engineer (request EngineerCall, events engineer-progress, engineer-usage, engineer-result) | Structured AI step reusing cancellation and the cost meter | ai, desktop | Founder (2026-10-15 design approval) |`

## Execution DAG

```
S1: T1, T2, T3  ->  T4  ->  T5  ->  T6, T7, T8  ->  T9  ->  T10  ->  T11, T12  ->  T13 (gate)
S2: T15 -> T16 -> T17 -> T18 ;  T19 -> T20 ;  T21 (needs T19) ;  T22 (needs T16, T18, T20, T21) -> T23 (gate)
S3: T24 -> T25 -> T26, T27 -> T28 -> T29 (gate)
S4: T30 -> T31 -> T32, T33 -> T34 (gate)
S5: T35 -> T36, T37, T38 -> T39 -> T40, T41 -> T42 (gate)
```

Dependencies across stages: S2 needs S1 merged (T2 schemas, T9 writer). T27 imports the `Axis` and `Taper` types from T25. S3 needs T3 (EvidencePack) and T24 fixtures. S4 needs T3 (EngineerProposal), T10 (assembler entry), S3 (`evidence.json`). S5 needs all earlier stages. S3 can be built in parallel with S2 (no shared files) once S1 is merged.

Parallel batches (no shared files inside a batch; each batch dispatched in one message):

| Batch | Tasks              | Packages touched                                                                             |
| ----- | ------------------ | -------------------------------------------------------------------------------------------- |
| 1a    | T1, T2, T3         | schema (procmodel.ts+versions.ts / georef files+layers+manifest / jobs files+agent)          |
| 1b    | T4                 | schema index, docs                                                                           |
| 1c    | T5                 | modelling `engineer/geom.ts`                                                                 |
| 1d    | T6, T7, T8         | modelling `engineer/builders/{shaft,access,lines,steel,telecom,lights}.ts`                   |
| 1e    | T9                 | modelling `glb.ts`, `mesher.ts`, `engineer/validate.ts`                                      |
| 1f    | T10                | modelling `engineer/assemble/*` core + chimney                                               |
| 1g    | T11, T12           | modelling `assemble/{flare,telecom}.ts` / desktop main + python fit + modelling procmodel.ts |
| 2a    | T15, T19, T24      | geo / engine / python tests (S3 starts here)                                                 |
| 2b    | T16, T20, T21, T25 | project / renderer workspace / engine gizmo + renderer builder / python engineer cloud       |
| 2c    | T17, T26, T27      | desktop main + schema ipc / python members / python render+photos                            |
| 2d    | T18, T28           | project package / python pipeline + renderer jobs                                            |
| 2e    | T22                | e2e                                                                                          |
| 4a    | T30                | ai capabilities + schema agent                                                               |
| 4b    | T31                | ai engineer                                                                                  |
| 4c    | T32, T33           | renderer preview + main policy / ai scripted + main ai IPC                                   |
| 5a    | T35                | renderer engineer run store + main runs                                                      |
| 5b    | T36, T37, T38      | renderer setup / modelling review UI / ai tools + renderer agentTools                        |
| 5c    | T39                | entry points                                                                                 |
| 5d    | T40, T41           | docs + tools / e2e                                                                           |

**Critical path:** T1 -> T4 -> T5 -> T6 -> T9 -> T10 -> T12 -> T13 (S1 merge) -> T15 -> T16 -> T17 -> T18 -> T22 -> T23 (S2 merge) -> T30 -> T31 -> T33 -> T34 (S4 merge, needs S3 merged) -> T35 -> T37 -> T39 -> T41 -> T42. S3 runs beside S2 and is off the critical path unless it slips past T23.

## Acceptance coverage

| Letter | Proved by                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | T25/T26 `python/tests/test_model_evidence.py::test_partial_noisy_stack_*`; T10 `assemble/chimney.test.ts` "draft from measurements"; T41 `engineering-model.spec.ts` "cloud plus photos" |
| B      | T11 `assemble/flare.test.ts`, `assemble/telecom.test.ts`; T8 builder tests                                                                                                               |
| C      | T27 `test_engineer_photos.py`; T31 `engineer.test.ts` "photos only"; T35 `runStore.test.ts` "single photo is provisional"; T41 "photos only" e2e                                         |
| D      | T10 `merge.test.ts`; T38 `agentTools.test.ts`; T41 "correct count and light height, reopen"                                                                                              |
| E      | T19 `model.test.ts`, `highlight.test.ts`; T22 `engineering-picking.spec.ts`; T18 `package.test.ts` "extras survive .aio"                                                                 |
| F      | T15 `placement.test.ts`; T16 `glbGeoref.test.ts`; T22 `engineering-georef.spec.ts`                                                                                                       |
| G      | T9 `validate.test.ts`; every assembler test calls `validateGlb` on the written bytes                                                                                                     |
| H      | T31 `engineer.test.ts` (OpenAI and Anthropic fetch mocks, offline, no key, invalid, 429, cancel, cache); T41 offline e2e with the network guard                                          |
| I      | T25 `test_large_cloud_bounded`; T31 "sends only pack images"; T35 `runStore.test.ts` "no arrays over IPC"                                                                                |

---

# Stage S1: contracts and geometry

### Task 1: `aio.procmodel/2` and its migrator

**Files:**

- Create: `packages/schema/src/assemblies.ts`
- Modify: `packages/schema/src/procmodel.ts` (literal, new top-level fields, `PartOrigin` engineer member)
- Modify: `packages/schema/src/versions.ts` (registry entry version 2, `MIGRATIONS`)
- Test: `packages/schema/src/assemblies.test.ts`, `packages/schema/src/procmodel.test.ts`, `packages/schema/src/versions.test.ts`

**Interfaces:**

- Produces: `PROCMODEL_SCHEMA = 'aio.procmodel/2'`, `PROCMODEL_V1 = 'aio.procmodel/1'`, `ProcModel` (zod, v2), `Material`, `ValueBasis`, `ParamQuality`, `EvidenceRef`, `AssemblyKind`, `Assembly`, `AssemblyParams<K>`, `ScaleRecord`, `EvidenceInventory`, `ModelFamily`, `migrateProcModel1to2(raw): Record<string, unknown>`; `MIGRATIONS` gains `{ family: 'aio.procmodel', from: 1, ... }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/schema/src/assemblies.test.ts
import { describe, expect, it } from 'vitest';
import { Assembly, AssemblyKind, Material } from './assemblies';

const origin = { by: 'engineer', runId: 'r1' } as const;
const base = {
  name: 'Shaft',
  description: 'Tapered shaft',
  category: 'Shaft',
  status: 'draft',
  origin,
  quality: {},
  sources: [],
} as const;

describe('Assembly', () => {
  it('accepts a tapered shaft with an open top', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'shaft-1',
      kind: 'shaft',
      params: {
        base: [0, 0, 0],
        profile: [
          { y: 0, r: 10 },
          { y: 100, r: 7 },
        ],
        openTop: true,
      },
    });
    expect(r.success).toBe(true);
  });
  it('refuses a profile whose heights do not increase', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'shaft-1',
      kind: 'shaft',
      params: {
        base: [0, 0, 0],
        profile: [
          { y: 10, r: 5 },
          { y: 5, r: 4 },
        ],
        openTop: true,
      },
    });
    expect(r.success).toBe(false);
  });
  it('refuses a flue whose inner radius is not below the outer', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'flue-1',
      kind: 'flue',
      params: { centre: [0, 100, 0], rOuter: 1, rInner: 1.2, height: 5 },
    });
    expect(r.success).toBe(false);
  });
  it('caps lattice bays at 80', () => {
    const bays = Array.from({ length: 81 }, () => ({ height: 1, bracing: 'X' }));
    const r = Assembly.safeParse({
      ...base,
      id: 'lattice-1',
      kind: 'lattice',
      params: {
        base: [0, 0, 0],
        legs: 4,
        widthBase: 6,
        widthTop: 1.5,
        height: 81,
        bays,
        legSection: 0.15,
        braceSection: 0.08,
      },
    });
    expect(r.success).toBe(false);
  });
  it('rejects unknown params (strict)', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'cabinet-1',
      kind: 'cabinet',
      params: { base: [0, 0, 0], size: [1, 2, 1], yawDeg: 0, script: 'rm -rf' },
    });
    expect(r.success).toBe(false);
  });
  it('lists all 20 kinds', () => {
    expect(AssemblyKind.options).toHaveLength(20);
  });
  it('keeps material colours in 0..1', () => {
    expect(
      Material.safeParse({
        id: 'm',
        name: 'M',
        baseColor: [1.2, 0, 0, 1],
        metallic: 0,
        roughness: 0.5,
      }).success,
    ).toBe(false);
  });
});
```

```ts
// add to packages/schema/src/versions.test.ts
import { MIGRATIONS, readVersioned } from './versions';
import { ProcModel } from './procmodel';

it('migrates aio.procmodel/1 to /2 without touching parts', () => {
  const v1 = {
    schema: 'aio.procmodel/1',
    id: 'm1',
    name: 'M',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    parts: [
      {
        kind: 'box',
        id: 'b1',
        status: 'accepted',
        origin: { by: 'manual' },
        base: [0, 0, 0],
        size: [1, 1, 1],
      },
    ],
  };
  const r = readVersioned(v1, { family: 'aio.procmodel', schema: ProcModel });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.schema).toBe('aio.procmodel/2');
  expect(r.value.assemblies).toEqual([]);
  expect(r.value.materials).toEqual([]);
  expect(r.value.parts[0]).toEqual(v1.parts[0]);
  expect(r.migratedFrom).toBe(1);
  expect(v1.schema).toBe('aio.procmodel/1'); // input not mutated
});
it('has exactly one procmodel migration', () => {
  expect(MIGRATIONS.filter((m) => m.family === 'aio.procmodel').map((m) => m.from)).toEqual([1]);
});
```

Also in `procmodel.test.ts`: change every fixture literal from `/1` to `/2` with `materials: [], assemblies: []`; add "refuses duplicate assembly ids" and "refuses an assembly parent that does not exist".

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/schema exec vitest run src/assemblies.test.ts src/versions.test.ts src/procmodel.test.ts`
Expected: FAIL (`./assemblies` not found; migration missing).

- [ ] **Step 3: Implement `assemblies.ts`**

```ts
import { z } from 'zod';
import { Vec2, Vec3 } from './common';

const L = z.number().positive().max(1000); // a length in metres
const Y = z.number().min(-500).max(1500);
const Count = (max: number) => z.number().int().min(0).max(max);
const Dir = Vec3.refine((v) => Math.hypot(v[0], v[1], v[2]) > 1e-6, 'A direction cannot be zero.');

export const ModelFamily = z.enum([
  'chimney',
  'flare',
  'telecom-lattice',
  'telecom-monopole',
  'generic',
]);
export const ValueBasis = z.enum(['measured', 'observed', 'inferred', 'user']);
export const ParamQuality = z
  .object({
    basis: ValueBasis,
    residualM: z.number().nonnegative().optional(),
    support: z.number().int().nonnegative().optional(),
    coverage: z.number().min(0).max(1).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();
export const EvidenceRef = z
  .object({
    kind: z.enum(['cloud', 'photo', 'mesh', 'user']),
    ref: z.string().min(1).max(200),
    view: z.string().max(120).optional(),
  })
  .strict();
export const Material = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    baseColor: z.tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ]),
    metallic: z.number().min(0).max(1),
    roughness: z.number().min(0).max(1),
    emissive: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    doubleSided: z.boolean().optional(),
  })
  .strict();

const Profile = z
  .array(z.object({ y: Y, r: L }).strict())
  .min(2)
  .max(64)
  .refine(
    (p) => p.every((s, i) => i === 0 || s.y > (p[i - 1]?.y ?? -Infinity)),
    'Profile heights must increase.',
  );
const Section = z.union([
  z.object({ rect: z.tuple([L, L]) }).strict(),
  z.object({ round: L }).strict(),
]);
const Path3 = z.array(Vec3).min(2).max(64);
const Outline = z.union([z.object({ r: L }).strict(), z.array(Vec2).min(3).max(128)]);

export const AssemblyParamsByKind = {
  shaft: z
    .object({
      base: Vec3,
      axis: Dir.optional(),
      profile: Profile,
      wall: L.optional(),
      openTop: z.boolean(),
      joints: z.object({ spacing: L }).strict().optional(),
    })
    .strict(),
  band: z
    .object({ shaft: z.string().min(1).max(80), y0: Y, y1: Y, material: z.string().max(40) })
    .strict()
    .refine((b) => b.y1 > b.y0, 'A band ends above where it starts.'),
  flue: z
    .object({
      centre: Vec3,
      rOuter: L,
      rInner: L,
      height: L,
      rim: z.boolean().optional(),
      flange: z.boolean().optional(),
    })
    .strict()
    .refine((f) => f.rInner < f.rOuter, 'Inner radius must be below outer radius.'),
  flareTip: z
    .object({
      base: Vec3,
      r: L,
      height: L,
      windshield: z.boolean().optional(),
      pilots: Count(8).optional(),
    })
    .strict(),
  deck: z
    .object({
      y: Y,
      outline: Outline,
      thickness: L,
      openings: z.array(z.object({ centre: Vec2, r: L }).strict()).max(16),
    })
    .strict(),
  ringPlatform: z
    .object({
      y: Y,
      rInner: L,
      rOuter: L,
      thickness: L,
      arcDeg: z.number().min(10).max(360).optional(),
    })
    .strict()
    .refine((p) => p.rInner < p.rOuter, 'Inner radius must be below outer radius.'),
  guardrail: z
    .object({
      path: z.union([Path3, z.object({ y: Y, r: L }).strict()]),
      height: L,
      posts: L,
      rails: z.number().int().min(1).max(3),
    })
    .strict(),
  ladder: z
    .object({ bottom: Vec3, top: Vec3, width: L, rungSpacing: L, cage: z.boolean().optional() })
    .strict(),
  hatch: z.object({ centre: Vec3, size: z.tuple([L, L]), open: z.boolean().optional() }).strict(),
  louvre: z
    .object({
      centre: Vec3,
      normal: Dir,
      size: z.tuple([L, L]),
      blades: z.number().int().min(3).max(40),
    })
    .strict(),
  duct: z
    .object({
      path: Path3,
      section: Section,
      transition: z
        .object({ at: z.number().int().min(0), to: Section })
        .strict()
        .optional(),
      flanges: z.boolean().optional(),
    })
    .strict(),
  pipeRun: z
    .object({
      path: Path3,
      diameter: L,
      bendRadius: L.optional(),
      flanges: z.array(z.number().int().min(0)).max(64).optional(),
    })
    .strict(),
  frame: z
    .object({
      kind: z.enum(['portal', 'rack']),
      base: Vec3,
      span: L,
      height: L,
      yawDeg: z.number().min(-360).max(360),
      bays: z.number().int().min(1).max(20),
      braced: z.boolean(),
      member: L,
    })
    .strict(),
  base: z.object({ outline: Outline, y: Y, height: L }).strict(),
  cabinet: z
    .object({ base: Vec3, size: z.tuple([L, L, L]), yawDeg: z.number().min(-360).max(360) })
    .strict(),
  lattice: z
    .object({
      base: Vec3,
      legs: z.union([z.literal(3), z.literal(4)]),
      widthBase: L,
      widthTop: L,
      height: L,
      bays: z
        .array(z.object({ height: L, bracing: z.enum(['X', 'K', 'Z']) }).strict())
        .min(1)
        .max(80),
      legSection: L,
      braceSection: L,
    })
    .strict(),
  monopole: z
    .object({
      base: Vec3,
      profile: Profile,
      sides: z.union([z.literal(0), z.number().int().min(8).max(18)]),
    })
    .strict(),
  antenna: z
    .object({
      kind: z.enum(['panel', 'dish', 'rru', 'omni']),
      centre: Vec3,
      azimuthDeg: z.number().min(0).max(360),
      tiltDeg: z.number().min(-30).max(30),
      size: z.tuple([L, L, L]),
    })
    .strict(),
  antennaMount: z
    .object({
      kind: z.enum(['pipe', 'sector-frame', 'standoff']),
      centre: Vec3,
      azimuthDeg: z.number().min(0).max(360),
      size: z.tuple([L, L, L]),
    })
    .strict(),
  warningLight: z
    .object({
      fixture: z.enum(['single', 'twin', 'canister', 'beacon']),
      centre: Vec3,
      outward: Dir,
      size: L,
    })
    .strict(),
  earthing: z.object({ path: Path3, diameter: L }).strict(),
} as const;

export const AssemblyKind = z.enum(
  Object.keys(AssemblyParamsByKind) as [
    keyof typeof AssemblyParamsByKind,
    ...(keyof typeof AssemblyParamsByKind)[],
  ],
);
export type AssemblyKind = z.infer<typeof AssemblyKind>;
export type AssemblyParams<K extends AssemblyKind> = z.infer<(typeof AssemblyParamsByKind)[K]>;

// PartOrigin is imported lazily to avoid a cycle: procmodel.ts imports this file.
import { PartOrigin } from './procmodel';

const assemblyBase = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  parent: z.string().max(80).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(300),
  category: z.string().min(1).max(60),
  tag: z.string().max(80).optional(),
  type: z.string().max(40).optional(),
  material: z.string().max(40).optional(),
  status: z.enum(['draft', 'accepted', 'rejected']),
  origin: PartOrigin,
  quality: z.record(z.string().max(60), ParamQuality),
  sources: z.array(EvidenceRef).max(64),
  unobserved: z
    .array(z.enum(['back', 'top', 'interior', 'base']))
    .max(4)
    .optional(),
  hidden: z.boolean().optional(),
};

export const Assembly = z.discriminatedUnion(
  'kind',
  (Object.keys(AssemblyParamsByKind) as AssemblyKind[]).map((k) =>
    z.object({ ...assemblyBase, kind: z.literal(k), params: AssemblyParamsByKind[k] }).strict(),
  ) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
);
export type Assembly = {
  [K in AssemblyKind]: z.infer<z.ZodObject<typeof assemblyBase>> & {
    kind: K;
    params: AssemblyParams<K>;
  };
}[AssemblyKind];

export const ScaleRecord = z
  .object({
    status: z.enum(['measured', 'reference', 'provisional']),
    reference: z
      .object({
        what: z.enum(['height', 'diameter', 'other']),
        valueM: L,
        label: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const EvidenceInventory = z
  .object({
    supported: z.array(z.string().max(80)).max(400),
    missing: z.array(z.string().max(200)).max(100),
    unresolved: z.array(z.string().max(200)).max(100),
  })
  .strict();

export type Material = z.infer<typeof Material>;
export type ValueBasis = z.infer<typeof ValueBasis>;
export type ParamQuality = z.infer<typeof ParamQuality>;
export type EvidenceRef = z.infer<typeof EvidenceRef>;
export type ScaleRecord = z.infer<typeof ScaleRecord>;
export type EvidenceInventory = z.infer<typeof EvidenceInventory>;
export type ModelFamily = z.infer<typeof ModelFamily>;
```

If the import cycle with `procmodel.ts` breaks module init, move `PartOrigin` into a new `packages/schema/src/partOrigin.ts` re-exported from `procmodel.ts` (same export name, no meaning change).

- [ ] **Step 4: Implement the v2 model in `procmodel.ts`**

- `PROCMODEL_SCHEMA = 'aio.procmodel/2'`; add `export const PROCMODEL_V1 = 'aio.procmodel/1' as const;`.
- `PartOrigin` gains `z.object({ by: z.literal('engineer'), runId: z.string().max(80), model: z.string().max(120).optional() }).strict()`.
- `ProcModel` object gains: `family: ModelFamily.optional()`, `scope: z.enum(['asset', 'asset-and-surroundings']).optional()`, `materials: z.array(Material).max(64)`, `assemblies: z.array(Assembly).max(2000)`, `scale: ScaleRecord.optional()`, `georef: Georef.optional()` (import from `./georef`, Task 2; until Task 2 lands in the same batch use `z.unknown().optional()` and switch in Task 4), `evidence: EvidenceInventory.optional()`, `run: z.object({ id: z.string().max(80), detail: z.enum(['fast', 'standard', 'detailed']) }).strict().optional()`.
- `superRefine` additionally: duplicate assembly ids; `parent` must name an existing assembly; `material` and `band.params.material` must name an existing material; part ids and assembly ids must not collide.

- [ ] **Step 5: Register the migration in `versions.ts`**

```ts
export function migrateProcModel1to2(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(raw), schema: 'aio.procmodel/2', materials: [], assemblies: [] };
}
export const MIGRATIONS: readonly Migration[] = [
  {
    family: 'aio.procmodel',
    from: 1,
    note: 'Procedural models gain engineering components and materials; existing parts are unchanged.',
    migrate: migrateProcModel1to2,
  },
];
```

Set the `aio.procmodel` registry entry's current version to 2 (keep `where: 'models/*.procmodel.json'`). Update the `MIGRATIONS` doc comment ("Empty in 1.0" is no longer true).

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @aio/schema exec vitest run`
Expected: PASS (all schema tests, including the existing registry tests).

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/assemblies.ts packages/schema/src/assemblies.test.ts packages/schema/src/procmodel.ts packages/schema/src/procmodel.test.ts packages/schema/src/versions.ts packages/schema/src/versions.test.ts
git commit -m "feat(schema): aio.procmodel/2 with engineering assemblies and a /1 migrator"
```

### Task 2: `aio.georef/1`, compat adapter, mesh layer and manifest additions

**Files:**

- Create: `packages/schema/src/georef.ts`, `packages/schema/src/georefCompat.ts`, `packages/schema/src/__fixtures__/georef/compat.synthetic.json`
- Modify: `packages/schema/src/layers.ts` (mesh layer + `LayerPatch`), `packages/schema/src/manifest.ts`, `packages/schema/src/versions.ts` is NOT touched here (registry entry for `aio.georef` is added in Task 4 to keep batch 1a file-disjoint)
- Test: `packages/schema/src/georef.test.ts`, `packages/schema/src/georefCompat.test.ts`, `packages/schema/src/layers.test.ts`

**Interfaces:**

- Produces: `GEOREF_SCHEMA = 'aio.georef/1'`, `Georef` (zod), `type Georef`, `Placement = z.enum(['placed','needed','provisional'])`, `fromCompatGeoreference(raw: unknown): { ok: true; georef: Georef } | { ok: false; reason: string }`, `readGlbGeoref(assetExtras: unknown): { kind: 'aio' | 'compat'; georef: Georef } | { kind: 'invalid'; reason: string } | { kind: 'absent' }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/schema/src/georefCompat.test.ts
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/georef/compat.synthetic.json';
import { fromCompatGeoreference, readGlbGeoref } from './georefCompat';

describe('compat georeference', () => {
  it('maps the synthetic compat structure to aio.georef/1', () => {
    const r = fromCompatGeoreference(fixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.georef.crs).toEqual({ epsg: 32633 });
    expect(r.georef.anchor).toEqual([400000.125, 5600000.25, 12.5]);
    expect(r.georef.heading.status).toBe('assumed-grid');
    expect(r.georef.vertical).toEqual({ datum: 'unknown', status: 'unknown' });
    expect(r.georef.provenance.by).toBe('compat');
  });
  it('refuses axes other than east, up, south', () => {
    const bad = { ...fixture, model_axes: { x: 'grid east', y: 'grid north', z: 'up' } };
    expect(fromCompatGeoreference(bad)).toEqual({
      ok: false,
      reason: expect.stringContaining('axes'),
    });
  });
  it('refuses a non-finite matrix', () => {
    const bad = {
      ...fixture,
      model_to_source_enh_column_major: [
        ...fixture.model_to_source_enh_column_major.slice(0, 15),
        null,
      ],
    };
    expect(fromCompatGeoreference(bad).ok).toBe(false);
  });
  it('reads aio first, then compat, else absent; foreign extras are absent', () => {
    expect(readGlbGeoref({ generator: 'x', somethingElse: 1 }).kind).toBe('absent');
    expect(readGlbGeoref(undefined).kind).toBe('absent');
    expect(readGlbGeoref({ georeference: fixture }).kind).toBe('compat');
    expect(readGlbGeoref({ aioGeoref: { schema: 'aio.georef/1' } }).kind).toBe('invalid');
  });
});
```

The fixture (synthetic values only):

```json
{
  "schema": "chimney.georeference/1",
  "crs": { "epsg": 32633, "name": "WGS 84 / UTM zone 33N" },
  "origin_easting_northing_height_m": [400000.125, 5600000.25, 12.5],
  "model_anchor": [0, 0, 0],
  "model_axes": { "x": "grid east", "y": "up", "z": "grid south" },
  "units": "metres",
  "model_to_source_enh_column_major": [
    1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 400000.125, 5600000.25, 12.5, 1
  ],
  "heading_about_up_deg": 0,
  "vertical_basis": "Source heights kept as supplied; datum not stated."
}
```

`georef.test.ts`: accepts a full record; refuses `axes` other than the one literal; refuses `anchor` with NaN; `vertical.datum: 'unknown'` requires `status: 'unknown'`.
`layers.test.ts`: a mesh layer with `georef` and `placement: 'needed'` parses; a pointcloud layer with `placement` is refused; `LayerPatch` with `placement` parses.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/schema exec vitest run src/georef.test.ts src/georefCompat.test.ts src/layers.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// packages/schema/src/georef.ts
import { z } from 'zod';
import { Mat4 } from './common';

export const GEOREF_SCHEMA = 'aio.georef/1' as const;
const Finite = z.number().finite();
export const Georef = z
  .object({
    schema: z.literal(GEOREF_SCHEMA),
    crs: z.union([
      z.object({ epsg: z.number().int().positive() }).strict(),
      z.object({ wkt: z.string().min(10).max(20000) }).strict(),
    ]),
    anchor: z.tuple([Finite, Finite, Finite]),
    axes: z.literal('x-east,y-up,z-south'),
    units: z.literal('m'),
    modelToCrs: Mat4,
    heading: z
      .object({ deg: Finite, status: z.enum(['measured', 'user', 'assumed-grid']) })
      .strict(),
    scale: z
      .object({
        factor: z.number().positive().finite(),
        status: z.enum(['measured', 'reference', 'user', 'provisional']),
      })
      .strict(),
    horizontal: z
      .object({
        status: z.enum(['surveyed', 'from-source', 'user', 'unplaced']),
        accuracyM: z.number().nonnegative().optional(),
      })
      .strict(),
    vertical: z
      .object({
        datum: z.string().min(1).max(120),
        status: z.enum(['from-source', 'user', 'unknown']),
      })
      .strict()
      .refine(
        (v) => (v.datum === 'unknown') === (v.status === 'unknown'),
        'An unknown datum has status unknown.',
      ),
    provenance: z
      .object({
        by: z.enum(['engineer', 'place-model', 'import', 'compat']),
        runId: z.string().max(80).optional(),
        source: z.string().max(300).optional(),
      })
      .strict(),
    deviation: z
      .object({
        rmsM: z.number().nonnegative(),
        p95M: z.number().nonnegative(),
        samples: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Georef = z.infer<typeof Georef>;
export const Placement = z.enum(['placed', 'needed', 'provisional']);
export type Placement = z.infer<typeof Placement>;
```

`georefCompat.ts`: a zod `CompatGeoreference` (passthrough for free-text keys, strict types for the known keys); `fromCompatGeoreference` checks `schema === 'chimney.georeference/1'`, axes text normalised to lower case equals `grid east`/`up`/`grid south`, `units` in `metres|meters|m`, matrix 16 finite numbers; builds `Georef` with `modelToCrs` = the compat matrix, `anchor` = `origin_easting_northing_height_m`, `heading: { deg: heading_about_up_deg ?? 0, status: 'assumed-grid' }`, `scale: { factor: 1, status: 'provisional' }`, `horizontal: { status: 'from-source' }`, `vertical: { datum: 'unknown', status: 'unknown' }`, `provenance: { by: 'compat', source: 'asset.extras.georeference' }`. `readGlbGeoref(extras)`: if `extras.aioGeoref` exists, `Georef.safeParse` it (`invalid` with the first issue message on failure); else if `extras.georeference` exists, run the adapter (`invalid` on refusal); else `absent`.

`layers.ts`: the mesh layer object gains `georef: Georef.optional()` and `placement: Placement.optional()`; `LayerPatch` gains the same two optional keys (document "mesh layers only" in the doc comment; the project writer refuses them for other kinds in Task 16). `manifest.ts`: `aiCloudPhotos: z.boolean().optional()`, `aiCloudScans: z.boolean().optional()` beside `aiCloudDrawings`, with doc comments "absent means off".

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aio/schema exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/georef.ts packages/schema/src/georef.test.ts packages/schema/src/georefCompat.ts packages/schema/src/georefCompat.test.ts packages/schema/src/__fixtures__/georef/compat.synthetic.json packages/schema/src/layers.ts packages/schema/src/layers.test.ts packages/schema/src/manifest.ts
git commit -m "feat(schema): aio.georef/1, compat adapter, mesh layer placement and sharing flags"
```

### Task 3: evidence, proposal and run contracts; `model.evidence` pipeline; `engineer` task

**Files:**

- Create: `packages/schema/src/engineer.ts`, `packages/schema/src/modelEvidence.ts`
- Modify: `packages/schema/src/jobs.ts` (`PipelineName`, catalogue entry, `PIPELINE_PARAMS`), `packages/schema/src/jobs.test.ts` (expected names), `packages/schema/src/agent.ts` (`AiTask` gains `engineer`)
- Test: `packages/schema/src/engineer.test.ts`, `packages/schema/src/modelEvidence.test.ts`

**Interfaces:**

- Produces: `ModelEvidenceParams`, `EVIDENCE_LIMITS: Record<Detail, { maxPoints: number; maxImages: number; maxPx: number }>` (`fast {300_000, 12, 1024}`, `standard {1_000_000, 24, 1568}`, `detailed {2_000_000, 40, 1568}`), `EvidencePack` (zod for `evidence.json`), `SliceFit`, `MemberGroup`, `PhotoItem`, `EngineerProposal`, `ProposalComponent`, `EngineerSetup`, `EngineerRun`, `EngineerStage = z.enum(['inspect','estimate','identify','generate','validate','review'])`, `Detail = z.enum(['fast','standard','detailed'])`, `DETAIL_BUDGETS: Record<Detail, { triangles: number; costUsd: number; passes: number }>` (`fast {150_000, 0.5, 1}`, `standard {400_000, 2, 2}`, `detailed {900_000, 5, 3}`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/schema/src/engineer.test.ts
import { describe, expect, it } from 'vitest';
import { EngineerProposal, EngineerRun, DETAIL_BUDGETS } from './engineer';

const comp = {
  role: 'flue',
  kind: 'flue',
  count: 4,
  params: { heightRatio: 0.03 },
  imageIds: ['img-3'],
  observed: true,
};
describe('EngineerProposal', () => {
  it('accepts a bounded proposal', () => {
    expect(
      EngineerProposal.safeParse({
        family: { value: 'chimney', reasons: ['tall tapered shaft'] },
        identity: { sameAsset: true, conflicts: [] },
        components: [comp],
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(true);
  });
  it('refuses more than 120 components and counts above 64', () => {
    expect(
      EngineerProposal.safeParse({
        family: { value: 'chimney', reasons: [] },
        identity: { sameAsset: true, conflicts: [] },
        components: Array(121).fill(comp),
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(false);
    expect(
      EngineerProposal.safeParse({
        family: { value: 'chimney', reasons: [] },
        identity: { sameAsset: true, conflicts: [] },
        components: [{ ...comp, count: 65 }],
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(false);
  });
  it('refuses geometry arrays in params', () => {
    expect(
      EngineerProposal.safeParse({
        family: { value: 'chimney', reasons: [] },
        identity: { sameAsset: true, conflicts: [] },
        components: [{ ...comp, params: { vertices: [1, 2, 3] } }],
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(false);
  });
});
it('budgets per detail match the spec', () => {
  expect(DETAIL_BUDGETS.standard).toEqual({ triangles: 400_000, costUsd: 2, passes: 2 });
});
it('a run records stages in order', () => {
  const r = EngineerRun.safeParse({
    schema: 'aio.engineer-run/1',
    id: 'run-1',
    modelId: 'eng-1',
    createdAt: '2026-10-15T00:00:00Z',
    setup: {
      sources: { clouds: [], meshes: [], photos: [{ path: 'a.jpg' }] },
      family: 'auto',
      scope: 'asset',
      detail: 'standard',
      placement: 'unplaced',
    },
    stages: { inspect: { status: 'done', hash: 'h' } },
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  });
  expect(r.success).toBe(true);
});
```

`modelEvidence.test.ts`: params default limits per detail; refuses 5 clouds, 401 photos; an `EvidencePack` fixture with two slices and a flue group parses; slices must have `coverage` 0..1.
`jobs.test.ts`: append `'model.evidence'` to the expected list.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/schema exec vitest run src/engineer.test.ts src/modelEvidence.test.ts src/jobs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`engineer.ts`:

```ts
import { z } from 'zod';
import { ModelFamily } from './assemblies';
export const Detail = z.enum(['fast', 'standard', 'detailed']);
export type Detail = z.infer<typeof Detail>;
export const DETAIL_BUDGETS = {
  fast: { triangles: 150_000, costUsd: 0.5, passes: 1 },
  standard: { triangles: 400_000, costUsd: 2, passes: 2 },
  detailed: { triangles: 900_000, costUsd: 5, passes: 3 },
} as const satisfies Record<Detail, { triangles: number; costUsd: number; passes: number }>;
export const EngineerStage = z.enum([
  'inspect',
  'estimate',
  'identify',
  'generate',
  'validate',
  'review',
]);
const Scalar = z.union([z.number().finite(), z.string().max(80), z.boolean()]); // no arrays, no objects
export const ProposalComponent = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    kind: z.string().max(40), // validated against AssemblyKind by the assembler; unknown kinds become unresolved
    count: z.number().int().min(0).max(64),
    params: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), Scalar)
      .refine((p) => Object.keys(p).length <= 24),
    levels: z.array(z.number().min(0).max(1.2)).max(16).optional(), // heights as ratio of asset height (lights, platforms)
    imageIds: z.array(z.string().max(40)).max(24),
    observed: z.boolean(),
    description: z.string().max(300).optional(),
  })
  .strict();
export const EngineerProposal = z
  .object({
    family: z.object({ value: ModelFamily, reasons: z.array(z.string().max(200)).max(8) }).strict(),
    identity: z
      .object({
        sameAsset: z.boolean(),
        conflicts: z
          .array(
            z
              .object({
                imageIds: z.array(z.string().max(40)).max(40),
                reason: z.string().max(300),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    components: z.array(ProposalComponent).max(120),
    unresolved: z.array(z.string().max(200)).max(40),
    notes: z.string().max(1000),
  })
  .strict();
export const EngineerSetup = z
  .object({
    sources: z
      .object({
        clouds: z.array(z.object({ layer: z.string() }).strict()).max(4),
        meshes: z.array(z.object({ layer: z.string() }).strict()).max(2),
        photos: z.array(z.object({ path: z.string().max(1000) }).strict()).max(400),
      })
      .strict(),
    region: z
      .union([
        z
          .object({
            centre: z.tuple([z.number(), z.number()]),
            radiusM: z.number().positive().max(2000),
          })
          .strict(),
        z
          .object({
            min: z.tuple([z.number(), z.number(), z.number()]),
            max: z.tuple([z.number(), z.number(), z.number()]),
          })
          .strict(),
      ])
      .optional(),
    family: z.union([z.literal('auto'), ModelFamily]),
    scope: z.enum(['asset', 'asset-and-surroundings']),
    detail: Detail,
    reference: z
      .object({
        what: z.enum(['height', 'diameter', 'other']),
        valueM: z.number().positive().max(1000),
        label: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
    placement: z.enum(['from-source', 'anchor', 'unplaced']),
    anchor: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .strict();
const StageState = z
  .object({
    status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']),
    hash: z.string().max(80).optional(),
    message: z.string().max(500).optional(),
    output: z.string().max(300).optional(),
  })
  .strict();
export const EngineerRun = z
  .object({
    schema: z.literal('aio.engineer-run/1'),
    id: z.string().regex(/^run-[a-z0-9-]{1,60}$/),
    modelId: z.string().max(80),
    createdAt: z.string(),
    setup: EngineerSetup,
    stages: z.record(EngineerStage, StageState),
    usage: z
      .object({
        costUsd: z.number().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    reconstruction: z.enum(['not-needed', 'queued', 'done', 'unavailable']).optional(),
  })
  .strict();
export type ProposalComponent = z.infer<typeof ProposalComponent>;
export type EngineerProposal = z.infer<typeof EngineerProposal>;
export type EngineerSetup = z.infer<typeof EngineerSetup>;
export type EngineerRun = z.infer<typeof EngineerRun>;
export type EngineerStage = z.infer<typeof EngineerStage>;
```

`modelEvidence.ts`: `ModelEvidenceParams` exactly as spec 5.1 (`run`, `clouds` max 4, `meshes` max 2, `photos` max 400, `region?`, `detail`, `limits` defaulting from `EVIDENCE_LIMITS[detail]`), and `EvidencePack`:

```ts
export const SliceFit = z
  .object({
    y: z.number(),
    centre: z.tuple([z.number(), z.number()]),
    r: z.number().positive(),
    residualM: z.number().nonnegative(),
    support: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1),
    shape: z.enum(['circle', 'polygon', 'square']).default('circle'),
  })
  .strict();
export const MemberGroup = z
  .object({
    kind: z.enum(['flue', 'light-candidate', 'leg', 'antenna-candidate', 'platform']),
    items: z
      .array(
        z
          .object({
            centre: z.tuple([z.number(), z.number(), z.number()]),
            size: z.number().nonnegative(),
            support: z.number().int().nonnegative(),
            azimuthDeg: z.number().min(0).max(360).optional(),
          })
          .strict(),
      )
      .max(128),
    metrics: z
      .object({
        residualM: z.number().nonnegative().optional(),
        regularity: z.number().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict();
export const PhotoItem = z
  .object({
    id: z.string().regex(/^[0-9a-f]{40}$/),
    original: z.string().max(1000),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    orientationApplied: z.boolean(),
    blur: z.number().nonnegative(),
    dupOf: z.string().optional(),
    gpsCamera: z.tuple([z.number(), z.number(), z.number()]).optional(),
    review: z.string().max(200).optional(),
  })
  .strict();
export const EvidenceImage = z
  .object({
    id: z.string().regex(/^img-[a-z0-9-]{1,40}$/),
    file: z.string().max(200),
    kind: z.enum(['side', 'top', 'slice', 'crop', 'photo']),
    view: z.string().max(40),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
    sha1: z.string().length(40),
  })
  .strict();
export const EvidencePack = z
  .object({
    schema: z.literal('aio.evidence/1'),
    run: z.string(),
    crs: z
      .union([
        z.object({ epsg: z.number().int() }).strict(),
        z.object({ wkt: z.string() }).strict(),
      ])
      .nullable(),
    units: z.literal('m'),
    bounds: z
      .object({
        min: z.tuple([z.number(), z.number(), z.number()]),
        max: z.tuple([z.number(), z.number(), z.number()]),
      })
      .strict()
      .nullable(),
    samples: z
      .object({
        read: z.number().int().nonnegative(),
        kept: z.number().int().nonnegative(),
        ground: z.number().int().nonnegative(),
      })
      .strict(),
    axis: z
      .object({
        point: z.tuple([z.number(), z.number(), z.number()]),
        dir: z.tuple([z.number(), z.number(), z.number()]),
        tiltDeg: z.number().min(0).max(90),
      })
      .strict()
      .nullable(),
    base: z.tuple([z.number(), z.number(), z.number()]).nullable(),
    height: z.number().positive().nullable(),
    slices: z.array(SliceFit).max(256),
    taper: z
      .object({
        profile: z.array(z.object({ y: z.number(), r: z.number().positive() }).strict()).max(64),
        residualM: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
    members: z.array(MemberGroup).max(16),
    familyHints: z
      .object({
        fillRatio: z.number().min(0).max(1),
        slenderness: z.number().nonnegative(),
        topFeatures: z.number().int().nonnegative(),
        suggested: ModelFamily,
      })
      .strict()
      .nullable(),
    colours: z
      .array(
        z
          .object({
            y0: z.number(),
            y1: z.number(),
            rgb: z.tuple([z.number(), z.number(), z.number()]),
          })
          .strict(),
      )
      .max(64),
    photos: z.array(PhotoItem).max(400),
    images: z.array(EvidenceImage).max(64),
    reconstruction: z.enum(['not-needed', 'unavailable', 'used']),
    warnings: z.array(z.string().max(300)).max(50),
  })
  .strict();
```

`jobs.ts`: add `'model.evidence'` to `PipelineName`, a catalogue entry (label "Measure an asset for an engineering model", resumable true, steps `crop, ground, axis, sections, members, renders, photos, pack`), and `'model.evidence': ModelEvidenceParams` in `PIPELINE_PARAMS`. `agent.ts`: `AiTask` gains `'engineer'` (append, keep order).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aio/schema exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/engineer.ts packages/schema/src/engineer.test.ts packages/schema/src/modelEvidence.ts packages/schema/src/modelEvidence.test.ts packages/schema/src/jobs.ts packages/schema/src/jobs.test.ts packages/schema/src/agent.ts
git commit -m "feat(schema): evidence pack, engineer proposal and run contracts, model.evidence pipeline"
```

### Task 4: schema exports, registry entries, contract rows and conventions

**Files:**

- Modify: `packages/schema/src/index.ts`, `packages/schema/src/versions.ts` (registry: `aio.georef` v1 `models/*.georeference.json`, `aio.evidence` v1 `engineering/*/evidence.json`, `aio.engineer-run` v1 `engineering/*/run.json`), `packages/schema/src/procmodel.ts` (switch `georef` to `Georef`), `docs/architecture/contract-changes.md` (rows 1 to 6), `docs/architecture/data-conventions.md` (section 15 update, new section "Engineering models and georeference"), `tools/compat/*` corpus as the compat tests require
- Test: `packages/schema/src/versions.test.ts` ("registry knows aio.georef, aio.evidence, aio.engineer-run"), `node --test tools/compat/*.test.mjs`

**Interfaces:** Consumes Tasks 1 to 3. Produces the public `@aio/schema` exports every later task imports.

- [ ] **Step 1: Failing test**: in `versions.test.ts`, `expect(readerFor('aio.georef/1').kind).toBe('current')`, same for `aio.evidence/1`, `aio.engineer-run/1`, and `readerFor('aio.procmodel/2').kind === 'current'`, `readerFor('aio.procmodel/1').kind === 'older'`.
- [ ] **Step 2: Run**: `pnpm --filter @aio/schema exec vitest run src/versions.test.ts` (FAIL).
- [ ] **Step 3: Implement**: add `export * from './assemblies'; export * from './georef'; export * from './georefCompat'; export * from './engineer'; export * from './modelEvidence';` to `index.ts`; add the three registry entries; replace the temporary `z.unknown()` for `georef`; paste rows 1 to 6 (section "Contract changes" above) at the bottom of `contract-changes.md`; in `data-conventions.md` section 15 change "parts (extrusion, cylinder, box, pipe, sphere)" to list parts and assemblies, document `models/<id>.georeference.json`, `models/<id>.components.json`, `engineering/<run>/` (evidence, images, ai cache, run.json; not packaged), node extras keys, stable id rule (spec 5.4) and the georef placement formula (spec 5.6).
- [ ] **Step 4: Run**: `pnpm --filter @aio/schema exec vitest run` and `node --test tools/compat/` (PASS; regenerate the compat corpus with `node tools/compat/build-corpus.mjs` if its additive test asks for it, and commit the regenerated files).
- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/index.ts packages/schema/src/versions.ts packages/schema/src/versions.test.ts packages/schema/src/procmodel.ts docs/architecture/contract-changes.md docs/architecture/data-conventions.md tools/compat/corpus
git commit -m "feat(schema): export engineering contracts and register their file families"
```

### Task 5: geometry kernel for engineering builders

**Files:**

- Create: `packages/modelling/src/engineer/geom.ts`
- Test: `packages/modelling/src/engineer/geom.test.ts`

**Interfaces:**

- Produces:

```ts
export type V3 = [number, number, number];
export interface Prim {
  material: string;
  positions: number[];
  normals: number[];
  indices: number[];
  openings?: Opening[];
}
export interface Opening {
  centre: V3;
  normal: V3;
  r: number;
} // declared intended boundary loop
export class MeshSink {
  constructor(segmentsFor: (r: number) => number);
  prim(material: string): Prim; // one primitive per material per component
  frustumShell(
    m: string,
    o: {
      base: V3;
      axis: V3;
      profile: { y: number; r: number }[];
      capBottom: boolean;
      capTop: boolean;
      sides?: number;
    },
  ): void;
  annulusTube(
    m: string,
    o: { centre: V3; axis: V3; rOuter: number; rInner: number; y0: number; y1: number },
  ): void; // open both ends, rim faces closed, declares the top opening
  disc(
    m: string,
    o: { centre: V3; normal: V3; r: number; holes?: { c: [number, number]; r: number }[] },
  ): void;
  slab(
    m: string,
    o: {
      y: number;
      outline: [number, number][] | { r: number };
      thickness: number;
      holes: { c: [number, number]; r: number }[];
    },
  ): void;
  box(m: string, o: { centre: V3; size: V3; yawDeg?: number; up?: V3 }): void;
  beam(m: string, a: V3, b: V3, section: number): void; // square member between two points
  rod(m: string, a: V3, b: V3, r: number, caps: boolean): void;
  sweep(
    m: string,
    path: V3[],
    r: number,
    o: { bendRadius?: number; capStart: boolean; capEnd: boolean },
  ): void;
  torus(m: string, o: { centre: V3; axis: V3; R: number; r: number }): void;
  rectSweep(m: string, path: V3[], w: number, h: number, caps: boolean): void;
  triangles(): number;
  out(): Prim[];
}
export const SEGMENTS = {
  fast: (r: number) => clampSeg(r, 0.8, 12, 48),
  standard: (r: number) => clampSeg(r, 0.4, 16, 96),
  detailed: (r: number) => clampSeg(r, 0.2, 24, 160),
};
```

- [ ] **Step 1: Write the failing tests** (reuse the existing `closedAndWound` and `normalsAgree` logic from `mesher.test.ts`; copy those two helpers into `packages/modelling/src/engineer/testGeom.ts`, exported for builder tests)

```ts
import { describe, expect, it } from 'vitest';
import { MeshSink, SEGMENTS } from './geom';
import { boundaryLoops, closedAndWound, normalsUnit, volume } from './testGeom';

describe('geom kernel', () => {
  it('frustum shell closed with caps has the analytic volume', () => {
    const s = new MeshSink(SEGMENTS.detailed);
    s.frustumShell('c', {
      base: [0, 0, 0],
      axis: [0, 1, 0],
      profile: [
        { y: 0, r: 10 },
        { y: 50, r: 6 },
      ],
      capBottom: true,
      capTop: true,
    });
    const [p] = s.out();
    expect(closedAndWound(p!)).toBe(true);
    const exact = (Math.PI * 50 * (100 + 60 + 36)) / 3;
    expect(Math.abs(volume(p!) - exact) / exact).toBeLessThan(0.01);
  });
  it('annulus tube keeps its mouth open: two boundary loops at the declared radii', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.annulusTube('steel', {
      centre: [0, 0, 0],
      axis: [0, 1, 0],
      rOuter: 1.5,
      rInner: 1.3,
      y0: 0,
      y1: 10,
    });
    const [p] = s.out();
    const loops = boundaryLoops(p!);
    expect(loops).toHaveLength(0); // the tube itself is a closed annular solid (rim faces), the bore is open space
    expect(p!.openings).toEqual([{ centre: [0, 10, 0], normal: [0, 1, 0], r: 1.3 }]);
  });
  it('slab with holes leaves through-openings and stays closed', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.slab('deck', {
      y: 10,
      outline: { r: 6 },
      thickness: 0.3,
      holes: [
        { c: [2, 0], r: 1 },
        { c: [-2, 0], r: 1 },
      ],
    });
    expect(closedAndWound(s.out()[0]!)).toBe(true);
  });
  it('sweep with bends has unit normals and no degenerate triangles', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.sweep(
      'pipe',
      [
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
        [5, 5, 5],
      ],
      0.2,
      { bendRadius: 0.6, capStart: true, capEnd: true },
    );
    expect(normalsUnit(s.out()[0]!)).toBe(true);
    expect(closedAndWound(s.out()[0]!)).toBe(true);
  });
  it('fast detail uses fewer triangles than detailed', () => {
    const a = new MeshSink(SEGMENTS.fast),
      b = new MeshSink(SEGMENTS.detailed);
    for (const s of [a, b])
      s.frustumShell('c', {
        base: [0, 0, 0],
        axis: [0, 1, 0],
        profile: [
          { y: 0, r: 10 },
          { y: 50, r: 6 },
        ],
        capBottom: true,
        capTop: true,
      });
    expect(a.triangles()).toBeLessThan(b.triangles());
  });
});
```

`boundaryLoops(p)`: build an edge-use count map over `indices`; edges used once form boundary loops; return loops as vertex index arrays. `closedAndWound(p)`: no boundary edges and signed volume positive. `normalsUnit(p)`: every normal length within 1e-4 of 1.

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/geom.test.ts` (FAIL).
- [ ] **Step 3: Implement**: port the `Builder` from `mesher.ts` (vertex, tri with winding auto-flip, quad, fan) into `MeshSink`, keyed per material. `frustumShell`: rings at each profile height with `segmentsFor(max r)` segments (or `sides` for polygonal monopoles), smooth side normals from the cone slope `n = normalize([cos t, (r0 - r1)/(y1 - y0), sin t])`, optional flat caps with fan. `annulusTube`: outer wall outward normals, inner wall inward normals, top and bottom rim annuli; push `openings` for the top (and bottom when `y0` is the base of a flue that is open below; the flue builder decides). `slab`: polygon or circle outline with circular holes, triangulated by `earcut`-style ear clipping with hole bridging (write `triangulateWithHoles(outer, holes)` in this file; the existing `triangulate` handles no holes), top and bottom faces plus outer and hole side walls. `sweep`: parallel-transport frames along the polyline, each interior corner replaced by an arc of `bendRadius` (default 1.5 x r) with 8 steps at standard detail; caps optional. `rectSweep`: same with a rectangle profile. `beam`: box between two points. All positions are absolute float64 here; `glb.ts` subtracts the node anchor later.
- [ ] **Step 4: Run**: same command, PASS.
- [ ] **Step 5: Commit**: `git add packages/modelling/src/engineer/geom.ts packages/modelling/src/engineer/geom.test.ts packages/modelling/src/engineer/testGeom.ts && git commit -m "feat(modelling): geometry kernel for engineering assemblies"`

### Task 6: shaft family builders (shaft, band, flue, flareTip, deck, base)

**Files:** Create `packages/modelling/src/engineer/builders/shaft.ts`, test `shaft.test.ts`.

**Interfaces:**

- Consumes: `MeshSink`, `Assembly`, `AssemblyParams<'shaft'|'band'|'flue'|'flareTip'|'deck'|'base'>`.
- Produces: `buildShaft(sink, a, ctx)`, `buildBand`, `buildFlue`, `buildFlareTip`, `buildDeck`, `buildBase`, each `(sink: MeshSink, a: Extract<Assembly, {kind: K}>, ctx: BuildCtx) => void`; `interface BuildCtx { model: ProcModel; radiusAt(shaftId: string, y: number): number; material(id?: string, fallback: string): string }` (defined in `packages/modelling/src/engineer/builders/ctx.ts`, created in this task and read-only for Tasks 7 and 8).

- [ ] **Step 1: Failing tests**

```ts
it('shaft follows its taper profile', () => {
  const m = model([
    shaft('shaft-1', [
      { y: 0, r: 10 },
      { y: 60, r: 6 },
      { y: 100, r: 6 },
    ]),
  ]);
  const s = sinkFor(m, 'shaft-1');
  const radii = ringRadiiAt(s.out()[0]!, [0, 30, 60, 100]);
  expect(radii.map((r) => +r.toFixed(2))).toEqual([10, 8, 6, 6]);
});
it('open-top hollow shaft leaves the top open and declares it', () => {
  const s = sinkFor(
    model([
      shaft(
        'shaft-1',
        [
          { y: 0, r: 5 },
          { y: 50, r: 4 },
        ],
        { wall: 0.4, openTop: true },
      ),
    ]),
    'shaft-1',
  );
  expect(s.out().flatMap((p) => p.openings ?? [])).toHaveLength(1);
});
it('four flues are four separate assemblies, each open at the mouth', () => {
  const m = model([
    shaft('shaft-1', [
      { y: 0, r: 8 },
      { y: 100, r: 6 },
    ]),
    ...[1, 2, 3, 4].map((i) => flue(`flue-${i}`, i)),
  ]);
  for (const id of ['flue-1', 'flue-2', 'flue-3', 'flue-4']) {
    const prims = sinkFor(m, id).out();
    expect(prims.flatMap((p) => p.openings ?? []).length).toBeGreaterThanOrEqual(1);
    for (const p of prims) expect(closedAndWound(p)).toBe(true);
  }
});
it('band wraps the shaft between y0 and y1 slightly proud of it', () => {
  const m = model([
    shaft('shaft-1', [
      { y: 0, r: 8 },
      { y: 100, r: 6 },
    ]),
    band('band-1', 'shaft-1', 40, 45),
  ]);
  const r = ringRadiiAt(sinkFor(m, 'band-1').out()[0]!, [42]);
  expect(r[0]!).toBeGreaterThan(m.radiusAt('shaft-1', 42));
  expect(r[0]! - m.radiusAt('shaft-1', 42)).toBeLessThan(0.05);
});
it('deck openings line up with flue centres', () => {
  /* deck with openings at flue centres; boundaryLoops none; hole count 4 via Euler characteristic */
});
it('flare tip with windshield and pilots builds separate material primitives', () => {
  /* expect materials ['steel','refractory'] */
});
```

Helpers `model`, `shaft`, `flue`, `band`, `sinkFor`, `ringRadiiAt` live in `packages/modelling/src/engineer/builders/testFixtures.ts` (created here; Tasks 7 and 8 import but do not edit it; if they need more helpers they create their own file).

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/builders/shaft.test.ts` (FAIL).
- [ ] **Step 3: Implement**: shaft = `frustumShell` (outer), if `wall` then an inner shell with reversed normals and a top rim annulus; `openTop` false closes the top with a cap; `joints.spacing` adds 1 cm proud shallow torus rings every spacing (separate material `joint`). Band = `frustumShell` at `radiusAt(y) + 0.01` between `y0` and `y1`, open ends closed with thin rims so the solid stays closed. Flue = `annulusTube` from `centre.y - height` to `centre.y` plus optional rim `torus` and flange rings; always open mouth. FlareTip = frustum plus windshield half-shell (`doubleSided` material) plus pilot rods. Deck = `slab` with openings; Base = `slab` with height.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/modelling/src/engineer/builders/shaft.ts packages/modelling/src/engineer/builders/shaft.test.ts packages/modelling/src/engineer/builders/ctx.ts packages/modelling/src/engineer/builders/testFixtures.ts && git commit -m "feat(modelling): shaft, band, flue, flare tip, deck and base builders"`

Note for the batch: Task 6 creates `ctx.ts` and `testFixtures.ts`. Dispatch Task 6 first in batch 1d and Tasks 7 and 8 one minute later, or have Tasks 7 and 8 wait for those two files to exist before running tests; they must not edit them.

### Task 7: access and line builders (ringPlatform, guardrail, ladder, hatch, louvre, duct, pipeRun, earthing)

**Files:** Create `packages/modelling/src/engineer/builders/access.ts`, `lines.ts`, tests `access.test.ts`, `lines.test.ts`.

**Interfaces:** Produces `buildRingPlatform`, `buildGuardrail`, `buildLadder`, `buildHatch`, `buildLouvre` (access.ts), `buildDuct`, `buildPipeRun`, `buildEarthing` (lines.ts), same signature as Task 6.

- [ ] **Step 1: Failing tests** (key assertions)

```ts
it('guardrail on a circle has posts at the requested spacing', () => {
  const s = build('guardrail', { path: { y: 100, r: 6 }, height: 1.1, posts: 1.5, rails: 2 });
  expect(countComponents(s.out()[0]!)).toBe(Math.ceil((2 * Math.PI * 6) / 1.5) + 2); // posts + two rail rings
});
it('ladder rungs match spacing and the cage is a separate primitive group', () => {
  const s = build('ladder', {
    bottom: [0, 0, 6],
    top: [0, 30, 6],
    width: 0.5,
    rungSpacing: 0.3,
    cage: true,
  });
  expect(
    s
      .out()
      .map((p) => p.material)
      .sort(),
  ).toEqual(['steel-galv', 'steel-galv-cage']);
});
it('duct with a rect-to-round transition is closed and continuous', () => {
  const s = build('duct', {
    path: [
      [0, 2, 0],
      [10, 2, 0],
      [10, 2, 10],
    ],
    section: { rect: [2, 1.5] },
    transition: { at: 1, to: { round: 0.9 } },
    flanges: true,
  });
  for (const p of s.out()) expect(closedAndWound(p)).toBe(true);
});
it('pipe run with an open end declares the opening', () => {
  const s = build('pipeRun', {
    path: [
      [0, 1, 0],
      [4, 1, 0],
      [4, 3, 0],
    ],
    diameter: 0.2,
    bendRadius: 0.4,
  });
  expect(s.out()[0]!.openings).toBeUndefined(); // capped by default
});
it('louvre has the requested blades', () => {
  /* countComponents == blades + 1 frame */
});
```

`countComponents(p)` (connected components by shared vertices) goes in `packages/modelling/src/engineer/builders/testCount.ts`, created by this task.

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/builders/access.test.ts src/engineer/builders/lines.test.ts` (FAIL).
- [ ] **Step 3: Implement**: ringPlatform = annular slab (partial arc when `arcDeg`) plus grating material; guardrail = rods for posts and torus or sweep rails; ladder = two rails (`rod`), rungs (`rod`), cage hoops (`torus` arcs) and verticals in material `steel-galv-cage`; hatch = box frame plus lid (rotated when open); louvre = frame `box` plus blades as thin boxes tilted 40 degrees; duct = `rectSweep` up to the transition index, a lofted transition piece (rectangle ring to circle ring, 16 steps, quads), `sweep` after, flanges as thin `box` or `torus`; pipeRun = `sweep` with bends and flange discs at listed indices; earthing = thin `sweep`.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/modelling/src/engineer/builders/access.ts packages/modelling/src/engineer/builders/access.test.ts packages/modelling/src/engineer/builders/lines.ts packages/modelling/src/engineer/builders/lines.test.ts packages/modelling/src/engineer/builders/testCount.ts && git commit -m "feat(modelling): access, duct, pipe and earthing builders"`

### Task 8: steel, telecom and warning light builders (frame, cabinet, lattice, monopole, antenna, antennaMount, warningLight)

**Files:** Create `packages/modelling/src/engineer/builders/steel.ts`, `telecom.ts`, `lights.ts`, tests `steel.test.ts`, `telecom.test.ts`, `lights.test.ts`.

**Interfaces:** Produces `buildFrame`, `buildCabinet`, `buildLattice` (steel.ts), `buildMonopole`, `buildAntenna`, `buildAntennaMount` (telecom.ts), `buildWarningLight` (lights.ts). Also `latticeLegAt(params, y): V3[]` exported from steel.ts (antenna placement uses it in Task 11).

- [ ] **Step 1: Failing tests**

```ts
it('four-leg lattice tapers from widthBase to widthTop', () => {
  const p = {
    base: [0, 0, 0],
    legs: 4,
    widthBase: 8,
    widthTop: 2,
    height: 40,
    bays: Array.from({ length: 8 }, () => ({ height: 5, bracing: 'X' })),
    legSection: 0.2,
    braceSection: 0.1,
  };
  expect(latticeLegAt(p, 0).map((v) => Math.hypot(v[0], v[2]))).toEqual(
    Array(4).fill(Math.SQRT2 * 4),
  );
  expect(latticeLegAt(p, 40).map((v) => +Math.hypot(v[0], v[2]).toFixed(6))).toEqual(
    Array(4).fill(+(Math.SQRT2 * 1).toFixed(6)),
  );
});
it('X bracing gives two braces per face per bay, K gives two, Z gives one', () => {
  expect(braceCount({ legs: 4, bays: [{ bracing: 'X' }] })).toBe(8);
  expect(braceCount({ legs: 3, bays: [{ bracing: 'Z' }] })).toBe(3);
});
it('lattice of 80 bays at standard detail stays under 150k triangles', () => {
  /* sink.triangles() < 150_000 */
});
it('monopole with 12 sides is polygonal, 0 sides is round', () => {
  /* count distinct normals in a ring */
});
it('panel antenna faces its azimuth (0 = north = -Z)', () => {
  const s = build('antenna', {
    kind: 'panel',
    centre: [0, 30, 0],
    azimuthDeg: 90,
    tiltDeg: 0,
    size: [0.3, 1.4, 0.15],
  });
  const front = faceNormalOfLargestArea(s.out()[0]!);
  expect(front.map((v) => +v.toFixed(3))).toEqual([1, 0, 0]); // east
});
it('warning light has housing, lens and mount as three primitives; lens is emissive material', () => {
  const s = build('warningLight', {
    fixture: 'twin',
    centre: [6, 50, 0],
    outward: [1, 0, 0],
    size: 0.4,
  });
  expect(
    s
      .out()
      .map((p) => p.material)
      .sort(),
  ).toEqual(['lamp-housing', 'lamp-lens-red', 'steel-galv']);
});
it('twin fixture has two lenses, single has one', () => {
  /* countComponents on the lens prim */
});
```

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/builders/steel.test.ts src/engineer/builders/telecom.test.ts src/engineer/builders/lights.test.ts` (FAIL).
- [ ] **Step 3: Implement**: lattice legs interpolate the half-width linearly by height, legs placed at 45, 135, 225, 315 degrees (4 legs) or 90, 210, 330 (3 legs); bays stack from the base; X = two diagonals per face, K = two half diagonals to the mid-height of the face, Z = one diagonal alternating direction per bay; horizontals at each bay top; members are `beam`s. Monopole = `frustumShell` with `sides`. Antenna: panel = box rotated by azimuth (`yaw = azimuthDeg`, north is -Z) and tilt; dish = shallow cone plus rim; rru = small box; omni = rod. Mount: pipe = vertical rod; sector-frame = three-pipe frame with beams; standoff = beam from leg to pipe. Warning light: mount bracket (`steel-galv`) from the shaft surface along `outward`, housing (`lamp-housing`, short cylinder), lens (`lamp-lens-red`, dome or cylinder; twin = two side by side; canister = tall cylinder; beacon = dome on top). Frame: portal = two columns, beam, optional braces; rack = bays of columns and beams. Cabinet = box with door seam inset.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/modelling/src/engineer/builders/steel.ts packages/modelling/src/engineer/builders/steel.test.ts packages/modelling/src/engineer/builders/telecom.ts packages/modelling/src/engineer/builders/telecom.test.ts packages/modelling/src/engineer/builders/lights.ts packages/modelling/src/engineer/builders/lights.test.ts && git commit -m "feat(modelling): lattice, monopole, antenna, frame, cabinet and warning light builders"`

### Task 9: PBR GLB writer with hierarchy, engineering meshing and the validator

**Files:**

- Modify: `packages/modelling/src/glb.ts` (new `writeGlbV2`; `writeGlb` kept and unchanged for `/1` parts output), `packages/modelling/src/mesher.ts` (`meshProcModel` meshes assemblies too), `packages/modelling/src/index.ts`, `packages/modelling/package.json` (dependency `gltf-validator`)
- Create: `packages/modelling/src/engineer/meshAssemblies.ts`, `packages/modelling/src/engineer/validate.ts`, `packages/modelling/src/engineer/materials.ts`
- Test: `packages/modelling/src/engineer/meshAssemblies.test.ts`, `packages/modelling/src/engineer/validate.test.ts`, `packages/modelling/src/mesher.test.ts` (existing tests still pass; add one for a mixed model)

**Interfaces:**

- Consumes: builders from Tasks 6 to 8, `ProcModel` v2.
- Produces:

```ts
// glb.ts
export interface GlbMaterial {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive?: [number, number, number];
  doubleSided?: boolean;
}
export interface GlbNodeV2 {
  name: string;
  extras: Record<string, unknown>;
  translation: [number, number, number];
  primitives: {
    material: number;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
  }[];
  children?: GlbNodeV2[];
}
export function writeGlbV2(
  nodes: readonly GlbNodeV2[],
  o: {
    root: string;
    generator: string;
    materials: readonly GlbMaterial[];
    assetExtras?: Record<string, unknown>;
  },
): Uint8Array;
// meshAssemblies.ts
export interface ComponentMesh {
  id: string;
  prims: Prim[];
  anchor: V3;
  triangles: number;
}
export function meshAssemblies(
  model: ProcModel,
  o: { detail: Detail; include: (a: Assembly) => boolean },
): { components: ComponentMesh[]; triangles: number; overBudget: boolean };
export function componentExtras(a: Assembly): Record<string, unknown>; // {component, name, description, category, tag?, type?, parent?, basis, unobserved?, quality, part: a.id}
export function buildEngineeringGlb(
  model: ProcModel,
  o: { detail: Detail; drafts: boolean; generator: string },
): {
  glb: Uint8Array;
  nodes: { node: string; tag?: string; area?: string }[];
  triangles: number;
  overBudget: boolean;
};
// materials.ts
export const DEFAULT_MATERIALS: readonly Material[]; // concrete-cream, concrete-grey, paint-red, paint-white, steel-galv, steel-galv-cage, steel-blue, stainless, lamp-housing, lamp-lens-red (emissive), refractory, insulation-tan, grating, joint, cable, cabinet-grey
export function resolveMaterials(model: ProcModel): Material[]; // model materials override defaults by id
// validate.ts
export interface GlbReport {
  validatorErrors: number;
  validatorWarnings: number;
  messages: string[];
  finite: boolean;
  indicesValid: boolean;
  normalsUnit: boolean;
  degenerate: number;
  duplicateTris: number;
  unintendedHoles: { node: string; loops: number }[];
  intendedOpenOk: boolean;
  triangles: number;
  withinBudget: boolean;
}
export async function validateGlb(
  glb: Uint8Array,
  o: { budget: number; openings: Record<string, Opening[]> },
): Promise<GlbReport>;
```

- [ ] **Step 1: Failing tests**

```ts
// validate.test.ts
import { validateGlb } from './validate';
import { buildEngineeringGlb } from './meshAssemblies';
import { stackFixture } from './fixtures'; // created in Task 10; until then use builders/testFixtures model()

it('a synthetic stack passes the Khronos validator with zero errors', async () => {
  const { glb } = buildEngineeringGlb(stackModel(), {
    detail: 'standard',
    drafts: true,
    generator: 'test',
  });
  const r = await validateGlb(glb, { budget: 400_000, openings: openingsOf(stackModel()) });
  expect(r.validatorErrors).toBe(0);
  expect(r.finite && r.indicesValid && r.normalsUnit).toBe(true);
  expect(r.degenerate).toBe(0);
  expect(r.duplicateTris).toBe(0);
  expect(r.unintendedHoles).toEqual([]);
  expect(r.intendedOpenOk).toBe(true);
});
it('reports an over-budget model', async () => {
  const { glb } = buildEngineeringGlb(stackModel(), {
    detail: 'detailed',
    drafts: true,
    generator: 'test',
  });
  expect((await validateGlb(glb, { budget: 1000, openings: {} })).withinBudget).toBe(false);
});
it('detects a punched hole as unintended', async () => {
  /* write a GLB with a deleted triangle via writeGlbV2; unintendedHoles has that node */
});

// meshAssemblies.test.ts
it('one node per assembly named by id, child primitives per material, extras carry the record', async () => {
  const { glb } = buildEngineeringGlb(stackModel(), {
    detail: 'fast',
    drafts: true,
    generator: 't',
  });
  const { json } = readGlb(glb);
  const nodes = json.nodes as { name: string; extras: Record<string, unknown>; mesh?: number }[];
  const flue = nodes.find((n) => n.name === 'flue-2')!;
  expect(flue.extras).toMatchObject({
    component: 'flue-2',
    category: 'Flues',
    part: 'flue-2',
    basis: expect.any(String),
  });
  expect(
    (json.meshes as { primitives: unknown[] }[])[flue.mesh!]!.primitives.length,
  ).toBeGreaterThanOrEqual(1);
});
it('lens material is emissive and doubleSided materials are flagged', () => {
  /* json.materials find name 'lamp-lens-red' has emissiveFactor */
});
it('rejected assemblies are not written; drafts only when drafts: true', () => {});
it('vertex positions are relative to the node translation (precision far from origin)', () => {
  // model with base at [100000, 0, -200000]; max |position| in accessors < 200
});
it('three.js GLTFLoader loads it and exposes userData.component', async () => {
  /* follow the existing mesher.test.ts GLTFLoader pattern */
});
```

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling add gltf-validator@2.0.0-dev.3.10` (pin the exact version npm shows as latest on 2026-10-15 and at least two weeks old), then `pnpm --filter @aio/modelling exec vitest run src/engineer/validate.test.ts src/engineer/meshAssemblies.test.ts` (FAIL).
- [ ] **Step 3: Implement**:
  - `writeGlbV2`: same buffer layout as `writeGlb`, but per node one mesh with one primitive per material index; materials written as `pbrMetallicRoughness { baseColorFactor, metallicFactor, roughnessFactor }`, `emissiveFactor`, `doubleSided`; root node `o.root` with children; `asset.extras = o.assetExtras` when given; extras written as JSON values; indices uint16 when the primitive has under 65536 vertices.
  - `meshAssemblies`: for each included assembly, a `MeshSink(SEGMENTS[detail])` and the builder by kind (a `const BUILDERS: { [K in AssemblyKind]: Builder<K> }` table so a missing kind is a type error); anchor = the assembly's base or centre param (first of `base`, `centre`, `bottom`, `path[0]`, `[0, y, 0]`); positions made relative to the anchor; `overBudget` when the sum exceeds `DETAIL_BUDGETS[detail].triangles`. If over budget at `detailed`, retry at `standard`, then `fast`, and report the detail used.
  - `componentExtras`: `basis` = the most common basis in `quality` (ties: `inferred` wins over `observed` over `measured`, so the label never overstates); `quality` summarised to `{param: basis}` plus `residualM` max and `coverage` min.
  - `meshProcModel` in `mesher.ts`: unchanged for `parts`; when `model.assemblies.length > 0`, the build path in Task 12 calls `buildEngineeringGlb` and merges `/1` parts as extra nodes (convert each `PartMesh` to a `GlbNodeV2` with a material from `CLASS_COLOURS`).
  - `validateGlb`: run `validateBytes` from `gltf-validator` (`maxIssues: 50`), parse with `readGlb`, then per node: finiteness, index range, normal length, zero-area and duplicate triangles (sorted index triple hash), boundary loops vs declared openings (a loop matches an opening when its centroid is within 2 cm of `centre` and mean radius within 2 percent of `r`; unmatched loops are unintended holes). Openings are written to node extras as `openings` so the validator can run on files alone; `o.openings` overrides for tests.
- [ ] **Step 4: Run**: `pnpm --filter @aio/modelling exec vitest run` (PASS, including the old `mesher.test.ts`).
- [ ] **Step 5: Commit**: `git add packages/modelling/package.json pnpm-lock.yaml packages/modelling/src/glb.ts packages/modelling/src/mesher.ts packages/modelling/src/mesher.test.ts packages/modelling/src/index.ts packages/modelling/src/engineer/meshAssemblies.ts packages/modelling/src/engineer/meshAssemblies.test.ts packages/modelling/src/engineer/validate.ts packages/modelling/src/engineer/validate.test.ts packages/modelling/src/engineer/materials.ts && git commit -m "feat(modelling): PBR component GLB writer and file validator"`

### Task 10: assembler core, stable ids, merge, and the chimney family

**Files:**

- Create: `packages/modelling/src/engineer/assemble/assemble.ts`, `assemble/ids.ts`, `assemble/merge.ts`, `assemble/chimney.ts`, `packages/modelling/src/engineer/fixtures.ts`
- Test: `assemble/ids.test.ts`, `assemble/merge.test.ts`, `assemble/chimney.test.ts`

**Interfaces:**

- Consumes: `EvidencePack`, `EngineerProposal`, `EngineerSetup`, `ProcModel`, `Assembly`.
- Produces:

```ts
export interface AssembleInput {
  modelId: string;
  runId: string;
  family: ModelFamily;
  scope: 'asset' | 'asset-and-surroundings';
  evidence: EvidencePack | null;
  proposal: EngineerProposal | null;
  setup: EngineerSetup;
  user: UserOverrides;
  previous: ProcModel | null;
  now: string;
}
export interface UserOverrides {
  params: Record<string, Record<string, number | string | boolean>>;
  counts: Record<string, number>;
  levels: Record<string, number[]>;
  removed: string[];
  added: Assembly[];
} // keyed by assembly id or role
export interface AssembleResult {
  model: ProcModel;
  changed: string[];
  kept: string[];
  flagged: { id: string; reason: string }[];
  unresolved: string[];
}
export function assemble(input: AssembleInput): AssembleResult;
export type FamilyAssembler = (ctx: FamilyCtx) => Assembly[];
export interface FamilyCtx {
  input: AssembleInput;
  height: number;
  scale: ScaleRecord;
  value<T extends number | string | boolean>(
    role: string,
    param: string,
    candidates: {
      user?: T;
      measured?: { v: T; q: Omit<ParamQuality, 'basis'> };
      observed?: T;
      inferred: T;
    },
  ): { v: T; q: ParamQuality };
  radiusAt(y: number): number;
  sources(role: string): EvidenceRef[];
}
export function assignIds(role: string, items: { azimuthDeg?: number; y?: number }[]): string[]; // `${role}-${i}` ordered by azimuth clockwise from north, then height
export function mergeModels(
  previous: ProcModel | null,
  next: Assembly[],
  o: { removedRoles?: string[] },
): {
  assemblies: Assembly[];
  changed: string[];
  kept: string[];
  flagged: { id: string; reason: string }[];
};
// fixtures.ts (synthetic truth, shared by Tasks 10, 11, 31, 35, 41)
export const STACK_TRUTH: {
  height: number;
  profile: { y: number; r: number }[];
  flues: number;
  fluePitchR: number;
  lightLevels: number[];
  lightsPerLevel: number;
  bands: [number, number][];
};
export function stackEvidence(o?: { partial?: boolean }): EvidencePack;
export function stackProposal(o?: { flues?: number; levels?: number[] }): EngineerProposal;
export const FLARE_TRUTH, LATTICE_TRUTH, MONOPOLE_TRUTH;
export function flareEvidence(): EvidencePack;
export function latticeEvidence(): EvidencePack;
export function monopoleEvidence(): EvidencePack;
export function flareProposal(): EngineerProposal;
export function latticeProposal(): EngineerProposal;
export function monopoleProposal(): EngineerProposal;
export function setupFor(family: ModelFamily | 'auto', detail?: Detail): EngineerSetup;
```

`STACK_TRUTH` (synthetic, not the reference): height 120, profile `[{y:0,r:9},{y:55,r:6.5},{y:120,r:6.5}]`, flues 3, fluePitchR 2.6, lightLevels `[40, 80]` plus crown 120, lightsPerLevel 3, bands `[[100,104],[108,112]]`.

- [ ] **Step 1: Failing tests**

```ts
// ids.test.ts
it('orders by azimuth clockwise from north, then height', () => {
  // north = -Z => azimuth 0; east = +X => 90
  expect(assignIds('flue', [{ azimuthDeg: 200 }, { azimuthDeg: 10 }, { azimuthDeg: 95 }])).toEqual([
    'flue-3',
    'flue-1',
    'flue-2',
  ]);
});

// merge.test.ts
it('accepted component survives a lowered count and is flagged', () => {
  const prev = withStatus(assembleStack({ flues: 3 }), 'flue-3', 'accepted');
  const next = assembleStack({ flues: 2, previous: prev });
  expect(next.model.assemblies.find((a) => a.id === 'flue-3')?.status).toBe('accepted');
  expect(next.flagged).toContainEqual({ id: 'flue-3', reason: expect.stringContaining('count') });
});
it('raising a count adds new ids at the end and keeps the others byte-identical', () => {
  const prev = assembleStack({ flues: 3 });
  const next = assembleStack({ flues: 4, previous: prev.model });
  expect(next.model.assemblies.filter((a) => a.kind === 'flue').map((a) => a.id)).toEqual([
    'flue-1',
    'flue-2',
    'flue-3',
    'flue-4',
  ]);
  for (const id of ['shaft-1', 'light-l1-1', 'band-1'])
    expect(byId(next.model, id)).toEqual(byId(prev.model, id));
});
it('a user value wins over measured and is kept across regeneration', () => {
  const prev = assembleStack({ user: { params: { 'shaft-1': { wall: 0.5 } } } });
  const next = assembleStack({
    previous: prev.model,
    user: { params: { 'shaft-1': { wall: 0.5 } } },
  });
  expect(byId(next.model, 'shaft-1').quality.wall).toEqual({ basis: 'user' });
});
it('moving one light level regenerates only that level', () => {
  const prev = assembleStack({});
  const next = assembleStack({ previous: prev.model, user: { levels: { 'light-l1': [45] } } });
  expect(next.changed.every((id) => id.startsWith('light-l1-'))).toBe(true);
});

// chimney.test.ts
it('draft from measurements has the measured taper, flue count and both light levels', () => {
  const r = assemble({
    ...base,
    evidence: stackEvidence({ partial: true }),
    proposal: stackProposal(),
  });
  const shaft = byKind(r.model, 'shaft')[0]!;
  expect(shaft.params.profile[0]!.r).toBeCloseTo(STACK_TRUTH.profile[0]!.r, 0);
  expect(shaft.quality.profile?.basis).toBe('measured');
  expect(byKind(r.model, 'flue')).toHaveLength(3);
  const levels = [
    ...new Set(byKind(r.model, 'warningLight').map((a) => Math.round(a.params.centre[1]))),
  ].sort((a, b) => a - b);
  expect(levels).toEqual([40, 80, 120]);
});
it('is authored geometry, not the input: no assembly carries raw points, all positions come from builders', async () => {
  const { glb } = buildEngineeringGlb(
    assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() }).model,
    { detail: 'standard', drafts: true, generator: 't' },
  );
  const r = await validateGlb(glb, { budget: 400_000, openings: {} });
  expect(r.validatorErrors).toBe(0);
  expect(r.triangles).toBeLessThan(stackEvidence().samples.kept); // smaller than the cloud
});
it('lights sit on the shaft surface using the taper radius', () => {
  const r = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() });
  for (const l of byKind(r.model, 'warningLight')) {
    const [x, y, z] = l.params.centre;
    expect(Math.hypot(x, z) - radiusAt(r.model, y)).toBeLessThan(0.6);
  }
});
it('no measured scale and no reference: scale provisional and nothing labelled measured', () => {
  const r = assemble({ ...base, evidence: null, proposal: stackProposal() });
  expect(r.model.scale?.status).toBe('provisional');
  expect(
    r.model.assemblies.flatMap((a) => Object.values(a.quality)).some((q) => q.basis === 'measured'),
  ).toBe(false);
});
it('nothing is added because chimneys usually have it: no ladder without evidence or proposal', () => {
  expect(
    byKind(
      assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() }).model,
      'ladder',
    ),
  ).toHaveLength(0);
});
it('flues stay inside the crown radius minus clearance and do not intersect', () => {});
it('a reference height scales a provisional model and marks it reference', () => {});
```

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/assemble` (FAIL).
- [ ] **Step 3: Implement**:
  - `assemble`: pick the family assembler (`chimney`, and in Task 11 `flare`, `telecom-lattice`, `telecom-monopole`; `generic` uses chimney's shaft-only path), compute `height` from evidence (`evidence.height`) else `setup.reference` (height) else 1 with provisional scale; run the assembler; `mergeModels(previous, next)`; apply `user.removed` (drop drafts, flag accepted) and `user.added`; set `materials` to `resolveMaterials` defaults used; fill `evidence` inventory (supported = ids with any `measured` or `observed`; missing = proposal roles with count 0 or unknown kind; unresolved = proposal.unresolved plus flagged reasons); write `family`, `scope`, `scale`, `run`, `updatedAt`.
  - `FamilyCtx.value`: precedence user > measured > observed > inferred, returns `ParamQuality` with the winning basis (and residual, support, coverage for measured).
  - `chimney.ts`: shaft from `evidence.taper.profile` (measured) else proposal ratios times height (observed) else a straight 1:12 taper (inferred); open top when the proposal lists flues; bands from `evidence.colours` runs of contrasting colour (measured) or proposal `band` levels (observed); flues from `members` kind `flue` (measured centres and radii) else proposal count on a circle of radius `0.55 x crown r` (observed count, inferred positions), `rOuter` from measured size or `0.18 x crown r`; deck at the crown with openings at flue centres; guardrail on the deck only when proposed; lights per level from proposal `levels` or `members` `light-candidate` clusters by height (measured), azimuths from members else evenly spaced from north; crown lights at the deck rim; ladder, platforms, ducts, frames, pipe runs, cabinets, louvres, earthing only when proposed (observed), placed by simple rules (ladder on the north face from base to crown; ducts from the proposal's `entryRatio` height radially outward to `scope` radius; cabinets at the base on the duct side); every inferred surface sets `unobserved` from evidence coverage (slice coverage under 0.5 on the back half means `back`).
  - `ids.ts`: azimuth = `(atan2(x, -z) in degrees + 360) % 360`; stable sort by azimuth then y.
  - `mergeModels`: map by id; unchanged role and params keep the previous object (structural equality); accepted previous objects are kept even if the new set lacks them (flagged); user-basis params copy forward.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/modelling/src/engineer/assemble packages/modelling/src/engineer/fixtures.ts && git commit -m "feat(modelling): evidence-driven assembler with stable ids and the chimney family"`

### Task 11: flare and telecom families

**Files:** Create `packages/modelling/src/engineer/assemble/flare.ts`, `assemble/telecom.ts`, tests `flare.test.ts`, `telecom.test.ts`. Register them in `assemble.ts` via a `FAMILIES` map that Task 10 creates with `chimney` and `generic` and the comment "Task 11 adds flare and telecom"; this task edits only that map line (sequential after Task 10, so no conflict).

**Interfaces:** Produces `assembleFlare: FamilyAssembler`, `assembleLattice: FamilyAssembler`, `assembleMonopole: FamilyAssembler`.

- [ ] **Step 1: Failing tests**

```ts
it('flare builds a riser shaft, a flare tip, platforms and service lines, no flues or bands', () => {
  const m = assemble({
    ...base('flare'),
    evidence: flareEvidence(),
    proposal: flareProposal(),
  }).model;
  const kinds = new Set(m.assemblies.map((a) => a.kind));
  expect(kinds.has('flareTip')).toBe(true);
  expect(kinds.has('ringPlatform')).toBe(true);
  expect(kinds.has('pipeRun')).toBe(true);
  expect(kinds.has('flue')).toBe(false);
  expect(kinds.has('band')).toBe(false);
});
it('lattice builds legs and bracing as one lattice assembly plus separate antennas and mounts', () => {
  const m = assemble({
    ...base('telecom-lattice'),
    evidence: latticeEvidence(),
    proposal: latticeProposal(),
  }).model;
  expect(byKind(m, 'lattice')).toHaveLength(1);
  expect(byKind(m, 'shaft')).toHaveLength(0);
  expect(byKind(m, 'antenna').map((a) => a.id)).toEqual([
    'antenna-s1-1',
    'antenna-s1-2',
    'antenna-s2-1',
    'antenna-s2-2',
    'antenna-s3-1',
    'antenna-s3-2',
  ]);
  expect(byKind(m, 'lattice')[0]!.params.legs).toBe(LATTICE_TRUTH.legs);
});
it('monopole uses a monopole, never a shaft', () => {});
it('antennas sit on mounts at the pole or leg radius at their height', () => {});
it('every family output passes validateGlb', async () => {});
```

- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/engineer/assemble/flare.test.ts src/engineer/assemble/telecom.test.ts` (FAIL).
- [ ] **Step 3: Implement**: flare: riser = `shaft` (measured slices, usually cylindrical) or a guyed lattice when members show legs; `flareTip` at the top; platforms from members `platform` (rings at measured heights) or proposal levels; ladder when proposed; service lines (`pipeRun`) up the riser from base to tip when proposed, offset by riser radius + 0.4 m; lights per proposal. Lattice: legs from members `leg` (count 3 or 4, base and top widths from leg spacing at the lowest and highest slices), bays from proposal `bays` or evenly spaced 4 to 6 m with bracing from proposal or `X`; antenna sectors from members `antenna-candidate` clustered by azimuth (sector `s1` is the first clockwise from north) else proposal counts; mounts per antenna; platforms at antenna heights when proposed; cabinets at the base. Monopole: `monopole` with measured profile and `sides` from proposal (default 0), antennas as for lattice using the pole radius.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/modelling/src/engineer/assemble/flare.ts packages/modelling/src/engineer/assemble/flare.test.ts packages/modelling/src/engineer/assemble/telecom.ts packages/modelling/src/engineer/assemble/telecom.test.ts packages/modelling/src/engineer/assemble/assemble.ts && git commit -m "feat(modelling): flare and telecom tower families"`

### Task 12: readers, writers and builds use `/2`

**Files:**

- Modify: `packages/modelling/src/procmodel.ts` (`newProcModel` writes `/2` with `materials: []`, `assemblies: []`; `checkProcModel` uses `readVersioned`; new helpers `setAssemblyStatus`, `findAssembly`, `assemblySummary`), `packages/modelling/src/index.ts` (export the engineer API), `apps/desktop/src/main/modelBuilder.ts` (read through `readVersioned`, refuse newer with `newerRefusal`, build with `buildEngineeringGlb` when the model has assemblies), `python/src/aio_pipelines/modelfit/fit.py` (commit step accepts `/1` or `/2`, writes back the version it read; a new file is written as `/2` with empty `materials` and `assemblies`)
- Test: `packages/modelling/src/procmodel.test.ts`, `apps/desktop/src/main/modelBuilder.test.ts`, `python/tests/test_modelfit.py`

**Interfaces:** Produces `setAssemblyStatus(m, ids, status): ProcModel`, `findAssembly(m, id): Assembly | undefined`, `assemblySummary(a): string`; `model:build` output gains `triangles` and `report?: GlbReport` (no IPC shape change: the existing result object gains optional fields; record it in row 7 in Task 17).

- [ ] **Step 1: Failing tests**:
  - `modelBuilder.test.ts`: "upgrades a /1 file on save and keeps parts" (write a `/1` file, `model:read` returns `schema: 'aio.procmodel/2'`, `model:write` then the file on disk is `/2`, the `.bak` exists and is the `/1` text); "refuses a /3 file with the newer-version message"; "builds an engineering model to a GLB with one node per accepted assembly".
  - `test_modelfit.py`: `test_commit_appends_to_v2_model` (existing `/2` file with one assembly; after fit the assembly is untouched and parts were appended; schema stays `/2`); `test_new_model_is_v2`.
  - `procmodel.test.ts`: `checkProcModel` on a `/1` object succeeds and returns the migrated model.
- [ ] **Step 2: Run**: `pnpm --filter @aio/modelling exec vitest run src/procmodel.test.ts`; `pnpm --filter @aio/desktop exec vitest run src/main/modelBuilder.test.ts`; `cd python && uv run pytest tests/test_modelfit.py -q` (all FAIL on the new cases).
- [ ] **Step 3: Implement** as listed. In `fit.py`, read `schema`, accept `aio.procmodel/1` and `/2`, preserve unknown keys (`materials`, `assemblies`, and the rest) when appending, and keep the atomic write and `.bak`.
- [ ] **Step 4: Run** the three commands: PASS.
- [ ] **Step 5: Commit**: `git add packages/modelling/src/procmodel.ts packages/modelling/src/procmodel.test.ts packages/modelling/src/index.ts apps/desktop/src/main/modelBuilder.ts apps/desktop/src/main/modelBuilder.test.ts python/src/aio_pipelines/modelfit/fit.py python/tests/test_modelfit.py && git commit -m "feat(modelling): read and write aio.procmodel/2 everywhere and build assemblies"`

### Task 13: S1 stage gate

- [ ] `pnpm check` in the worktree: green (quote the summary line).
- [ ] `cd python && uv run pytest tests/test_modelfit.py -q`: green.
- [ ] e2e: `model-builder.spec.ts` the CI way (it reads `/1` demo models; must still pass through the migrator): `pnpm demo:build --quick`, then from `apps/desktop`: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp pnpm exec playwright test e2e/model-builder.spec.ts --workers=1`.
- [ ] Independent review of the S1 diff by a fresh reviewer (strongest model, high effort) against spec 5.1 and this plan; fix findings.
- [ ] `node tools/agent/finish-task.mjs`; then the CLAUDE.md merge sequence (ListAgents + SendMessage, lock, PR, `watch-ci.mjs`, `--ff-only`, push with the guard lifted for that one command, release, announce `main` moved). Do not run `--cleanup`: the branch continues with S2.

---

# Stage S2: placement, exchange and inspection

### Task 15: georef placement math and `transformPoint`

**Files:** Create `packages/geo/src/placement.ts`; modify `packages/geo/src/index.ts` (export); test `packages/geo/src/placement.test.ts`.

**Interfaces:**

```ts
export function transformPoint(p: Vec3, fromEpsg: number, toEpsg: number): Vec3; // height passes through
export interface ProjectGeo {
  crs: { epsg: number } | { wkt: string };
  origin: Vec3;
  verticalDatum?: string | 'unknown';
}
export type PlacementResult =
  | {
      kind: 'placed';
      transform: Mat4;
      headingDeltaDeg: number;
      scaleNote?: string;
      heightNote?: string;
    }
  | { kind: 'needed'; reason: string; horizontalOnly?: Mat4 };
export function georefToLayerTransform(g: Georef, project: ProjectGeo): PlacementResult;
export function layerTransformToGeoref(
  transform: Mat4,
  project: ProjectGeo,
  prev: Georef | null,
  by: 'place-model' | 'engineer',
): Georef; // inverse for Place model and Accept
export function worldOfModelPoint(transform: Mat4, project: ProjectGeo, p: Vec3): Vec3; // E, N, H for tests
```

- [ ] **Step 1: Failing tests** (all assert computed coordinates, never flags)

```ts
const g = (o: Partial<Georef> = {}): Georef => ({
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: [400010, 5600020, 15],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: enhMatrix([400010, 5600020, 15], 0, 1),
  heading: { deg: 0, status: 'measured' },
  scale: { factor: 1, status: 'measured' },
  horizontal: { status: 'from-source' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer' },
  ...o,
});
const A = { crs: { epsg: 32633 }, origin: [400000, 5600000, 10] as Vec3 };
const B = { crs: { epsg: 32633 }, origin: [399500, 5600700, 0] as Vec3 };
const probe: Vec3[] = [
  [0, 0, 0],
  [3, 50, -2],
  [-4, 120, 6],
];

it('same world position from two projects with different origins (1 mm)', () => {
  const ra = georefToLayerTransform(g(), A),
    rb = georefToLayerTransform(g(), B);
  if (ra.kind !== 'placed' || rb.kind !== 'placed') throw new Error('not placed');
  for (const p of probe)
    expectClose(
      worldOfModelPoint(ra.transform, A, p),
      worldOfModelPoint(rb.transform, B, p),
      0.001,
    );
});
it('rotated asset keeps its heading within 0.01 degree', () => {
  /* heading 37.5: compare world bearing of model +X in A and B */
});
it('cross-CRS UTM 33N to UTM 34N lands at the same lon/lat (1 mm after round trip) and rotates by the convergence difference', () => {
  const C = { crs: { epsg: 32634 }, origin: transformPoint([400000, 5600000, 0], 32633, 32634) };
  const r = georefToLayerTransform(g(), C);
  if (r.kind !== 'placed') throw new Error();
  const w = worldOfModelPoint(r.transform, C, [0, 0, 0]);
  expectClose(transformPoint(w, 32634, 32633), [400010, 5600020, 15], 0.001);
  expect(
    Math.abs(
      r.headingDeltaDeg -
        (gridConvergenceDeg(...lonLatOf(g()), 32634) - gridConvergenceDeg(...lonLatOf(g()), 32633)),
    ),
  ).toBeLessThan(0.01);
});
it('unsupported CRS gives placement needed', () => {
  expect(georefToLayerTransform(g({ crs: { wkt: 'LOCAL_CS["x"]' } }), A).kind).toBe('needed');
});
it('different known vertical datums: horizontal only, height needed', () => {
  const r = georefToLayerTransform(g({ vertical: { datum: 'EGM2008', status: 'from-source' } }), {
    ...A,
    verticalDatum: 'NAVD88',
  });
  expect(r.kind).toBe('needed');
  if (r.kind === 'needed') expect(r.horizontalOnly).toBeDefined();
});
it('unknown datum passes height through unchanged (no MSL assumption)', () => {
  /* world H == anchor H + model y */
});
it('scale factor is applied once', () => {
  /* factor 2: world distance between probe points doubles, not quadruples */
});
it('recentre keeps world position', () => {
  /* apply recentre's shift to transform (import shiftTransform from @aio/project? no: replicate the documented formula T' = translate(-d) * T in this test) and compare world positions */
});
it('layerTransformToGeoref inverts georefToLayerTransform', () => {});
```

- [ ] **Step 2: Run**: `pnpm --filter @aio/geo exec vitest run src/placement.test.ts` (FAIL).
- [ ] **Step 3: Implement**: model point m maps to CRS point `c = modelToCrs * m` (E, N, H). In the same CRS, local = `[E - E0, H - H0, -(N - N0)]`, so `transform = L * modelToCrs` where `L` maps ENH to local (`x = E - E0`, `y = H - H0`, `z = -(N - N0)`). For a different CRS: anchor `a' = transformPoint(anchor, from, to)`; `delta = conv_to(lonlat) - conv_from(lonlat)`; build `modelToCrs' = T(a') * R_up(-delta) * T(-anchor) * modelToCrs` (rotation about the vertical through the anchor; heading in grid terms changes by the convergence difference; sign convention fixed by the test), scale untouched, note when the projection scale factors differ by more than 1e-4. `wkt` or unknown EPSG (`isKnownCrs` false) gives `needed`. Vertical: if both known and different, `needed` with `horizontalOnly` (height uses the anchor H as is). `layerTransformToGeoref`: `modelToCrs = L^-1 * transform`; heading from the rotation part (`atan2`), scale from the column norm, statuses `user` for `place-model`.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/geo/src/placement.ts packages/geo/src/placement.test.ts packages/geo/src/index.ts && git commit -m "feat(geo): georeference placement between projects and CRSs"`

### Task 16: GLB georef import and export bundle writer

**Files:**

- Create: `packages/project/src/builder/glbGeoref.ts`, `packages/modelling/src/engineer/exportBundle.ts`
- Modify: `packages/project/src/builder/raw.ts` (GLB branch), `packages/project/src/builder/layers.ts` or the file where `LayerPatch` is applied (refuse `georef`/`placement` on non-mesh layers; find it with `grep -n "LayerPatch" packages/project/src`)
- Test: `packages/project/src/builder/glbGeoref.test.ts`, `packages/project/src/builder/raw.test.ts` (new cases), `packages/modelling/src/engineer/exportBundle.test.ts`

**Interfaces:**

```ts
// packages/project/src/builder/glbGeoref.ts
export function readGlbJsonChunk(head: Uint8Array): Record<string, unknown> | null; // reads only the 12-byte header plus the JSON chunk
export async function readGlbJsonFromFile(path: string): Promise<Record<string, unknown> | null>; // reads header, then exactly the JSON chunk length
export function placeImportedGlb(
  json: Record<string, unknown> | null,
  project: ProjectGeo,
): { transform: Mat4; georef?: Georef; placement?: Placement; message: string };
// packages/modelling/src/engineer/exportBundle.ts
export interface EngineeringBundle {
  glb: Uint8Array;
  procmodel: string;
  components: string;
  georeference: string | null;
}
export function exportBundle(
  model: ProcModel,
  o: { detail: Detail; generator: string; georef: Georef | null },
): EngineeringBundle; // GLB carries asset.extras.aioGeoref; components.json is the register
export function componentRegister(model: ProcModel): ComponentRow[];
export interface ComponentRow {
  id: string;
  name: string;
  category: string;
  type?: string;
  description: string;
  tag?: string;
  parent?: string;
  kind: AssemblyKind;
  dimensions: Record<string, number | string>;
  units: 'm';
  material?: string;
  status: string;
  basis: Record<string, ValueBasis>;
  residualM?: number;
  coverage?: number;
  sources: EvidenceRef[];
  unobserved?: string[];
}
```

- [ ] **Step 1: Failing tests**:
  - `glbGeoref.test.ts`: "aio georef places the model" (write a bundle GLB with `exportBundle`, call `placeImportedGlb` with project B, compare world positions of three node vertices against the georef truth within 1 mm via `worldOfModelPoint`); "compat structure places it" (GLB written with `writeGlbV2({ assetExtras: { georeference: compatFixture } })`); "invalid aioGeoref gives placement needed with the reason"; "foreign extras are ignored" (identity, `placement` undefined, the old message text); "no extras keeps identity"; "re-import of an already placed file is idempotent" (two imports, equal transforms, vertices untouched byte-for-byte in the copied file).
  - `raw.test.ts`: importing a georeferenced GLB writes a mesh layer with `georef`, `placement: 'placed'` and a non-identity transform; importing a plain GLB writes exactly the current record.
  - `exportBundle.test.ts`: components.json rows equal the accepted assemblies; ids, descriptions and categories survive `readGlb` of the bundle GLB; georeference.json parses as `Georef`; the GLB passes `validateGlb`.
- [ ] **Step 2: Run**: `pnpm --filter @aio/project exec vitest run src/builder/glbGeoref.test.ts src/builder/raw.test.ts` and `pnpm --filter @aio/modelling exec vitest run src/engineer/exportBundle.test.ts` (FAIL).
- [ ] **Step 3: Implement**: `readGlbJsonFromFile` opens the file, reads 20 bytes (header + JSON chunk header), checks magic `glTF`, version 2 and chunk type `JSON`, then reads that many bytes; returns parsed JSON or null. `placeImportedGlb`: `readGlbGeoref(json.asset?.extras)`; `absent` returns the current identity and message; `aio`/`compat` call `georefToLayerTransform`; `placed` returns transform, georef, `placement: 'placed'`, message "Placed from the georeference in the file."; `needed` returns identity (or `horizontalOnly`), the georef and `placement: 'needed'` with the reason plus "Place it with Place model."; `invalid` returns identity, `placement: 'needed'`, the reason. In `raw.ts` the GLB branch calls these after `copyFile` and adds `georef` and `placement` to the layer only when defined.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/project/src/builder/glbGeoref.ts packages/project/src/builder/glbGeoref.test.ts packages/project/src/builder/raw.ts packages/project/src/builder/raw.test.ts packages/modelling/src/engineer/exportBundle.ts packages/modelling/src/engineer/exportBundle.test.ts <LayerPatch file> && git commit -m "feat(project): place imported GLBs from their georeference"`

### Task 17: export IPC and engineering file IPC

**Files:** Create `apps/desktop/src/main/engineering.ts`, test `apps/desktop/src/main/engineering.test.ts`; modify `packages/schema/src/ipc.ts` (channels below), `apps/desktop/src/main/index.ts` (register handlers), `apps/desktop/src/preload/*` if channels are allow-listed there (check `grep -rn "ai:setCloudDrawings" apps/desktop/src/preload`), `docs/architecture/contract-changes.md` (row 7).

**Interfaces (IPC, zod in `ipc.ts`):**

```ts
'model:exportEngineering': { req: { modelId: string; folder: string; detail: Detail }; res: { ok: true; files: string[] } | { ok: false; error: string } };
'engineer:runRead': { req: { runId: string }; res: { run: EngineerRun | null; evidence: EvidencePack | null; proposal: EngineerProposal | null } };
'engineer:runWrite': { req: { run: EngineerRun }; res: { ok: boolean; error?: string } };
'engineer:evidenceImage': { req: { runId: string; imageId: string }; res: { dataUrl: string } | { error: string } }; // thumbnails for the preview; max 1568 px; never raw clouds
'ai:setCloudEvidence': { req: { photos?: boolean; scans?: boolean }; res: { ok: boolean; error?: string } };
```

- [ ] **Step 1: Failing tests** (`engineering.test.ts` with a temp project): export writes exactly four files into `<folder>/<name>/` via a staging folder renamed at the end (assert no partial folder remains after a thrown write in the middle, using an injected failing writer); `engineer:runWrite` validates and writes atomically with `.bak`; `engineer:runRead` of a missing run returns nulls; `engineer:evidenceImage` refuses ids not in `evidence.json` and paths outside `engineering/<run>/img`; `ai:setCloudEvidence` refuses for packages (read-only) and writes the manifest flags with the existing backup helper.
- [ ] **Step 2: Run**: `pnpm --filter @aio/desktop exec vitest run src/main/engineering.test.ts` (FAIL).
- [ ] **Step 3: Implement** with the same helpers `modelBuilder.ts` uses for atomic writes and manifest updates (`updateManifest`). Paste row 7.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add apps/desktop/src/main/engineering.ts apps/desktop/src/main/engineering.test.ts apps/desktop/src/main/index.ts packages/schema/src/ipc.ts docs/architecture/contract-changes.md <preload file if changed> && git commit -m "feat(desktop): engineering export, run files and evidence sharing flags over IPC"`

### Task 18: `.aio` round trip keeps placement and component extras

**Files:** Modify `packages/project/src/package/plan.ts` (exclude `engineering/**`; `models/*.georeference.json` and `models/*.components.json` travel); test `packages/project/src/package/package.test.ts` (new cases).

- [ ] **Step 1: Failing tests**: export a temp project with an engineering mesh layer (`georef`, `placement`, a bundle GLB) and an `engineering/run-1/` folder; `openPackage` then `extractProject`; assert the manifest layer `georef` and `placement` deep-equal, the GLB bytes are equal, `readGlb` node extras for every component are equal, `engineering/` is absent, and world positions of three vertices via `worldOfModelPoint` match before and after within 1 mm.
- [ ] **Step 2: Run**: `pnpm --filter @aio/project exec vitest run src/package/package.test.ts` (FAIL on the exclusion).
- [ ] **Step 3: Implement** the pattern changes in `plan.ts`.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/project/src/package/plan.ts packages/project/src/package/package.test.ts && git commit -m "feat(project): engineering models round-trip through .aio packages"`

### Task 19: engine component picking, group highlight, per-node visibility

**Files:** Modify `packages/engine/src/adapters/model.ts` (`selectableNode`), `packages/engine/src/adapters/mesh.ts` (`setNodeVisible`, `componentInfo`), `packages/engine/src/types.ts` (`LayerHandle` optional methods), `packages/engine/src/stage/highlight.ts` (group highlight, material cloning), `packages/engine/src/stage/Stage.ts` (hover payload carries component info; Escape clears); tests `packages/engine/src/adapters/model.test.ts`, `packages/engine/src/stage/highlight.test.ts`.

**Interfaces:**

```ts
// types.ts
export interface ComponentInfo {
  id: string;
  name: string;
  category?: string;
  description?: string;
  tag?: string;
  basis?: string;
}
export interface LayerHandle {
  setVisible(v: boolean): void;
  dispose(): void;
  setNodeVisible?(node: string, visible: boolean): void;
  components?(): ComponentInfo[];
}
// model.ts
export function selectableNode(
  hit: Object3D,
  stopAt: Object3D,
  tagged: ReadonlySet<string>,
): Object3D | null; // now prefers the nearest ancestor with userData.component
export function componentOf(node: Object3D): ComponentInfo | null;
// Stage hover/select events: { node: string; layerId: string; component?: ComponentInfo }
```

- [ ] **Step 1: Failing tests** (`model.test.ts` with a three.js scene built from `buildEngineeringGlb` loaded by `GLTFLoader` in Node as the existing mesher test does):
  - hit on a lens mesh of `light-l1-2` resolves to the node `light-l1-2`, not its mesh child and not the root;
  - two components sharing a material: highlighting one leaves the other's material colour unchanged (`highlight.test.ts`: compare `material.color` before and after; assert the highlighted meshes use cloned materials and are restored on clear);
  - group highlight covers every mesh under the component node (three meshes for a warning light);
  - `setNodeVisible('flue-2', false)` hides it and `intersect` no longer returns it, while a component behind it is hit instead;
  - legacy `/1` GLB (extras `{tag,type,part}` only) still resolves as before.
- [ ] **Step 2: Run**: `pnpm --filter @aio/engine exec vitest run src/adapters/model.test.ts src/stage/highlight.test.ts` (FAIL).
- [ ] **Step 3: Implement**: `selectableNode` walks up from the hit to `stopAt`, returning the first node with `userData.component`, else the existing order. The merged-per-material render copy must keep per-node visibility: when a layer's GLB has `userData.component` nodes, skip the merge for those nodes (render originals; component GLBs are already one mesh per material per node, so draw calls stay bounded by the budget) and keep the merge for other meshes. `Highlighter.set(mode, node)` applies the tint to every `Mesh` descendant with a per-mesh cloned material (kept in a `WeakMap` and restored on clear) and draws the outline shell for each. Stage: on `keydown` Escape, clear selection; hover event includes `componentOf(node)`.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/engine/src/adapters/model.ts packages/engine/src/adapters/model.test.ts packages/engine/src/adapters/mesh.ts packages/engine/src/types.ts packages/engine/src/stage/highlight.ts packages/engine/src/stage/highlight.test.ts packages/engine/src/stage/Stage.ts && git commit -m "feat(engine): pick, highlight and hide engineering components"`

### Task 20: component hover brief and component panel

**Files:** Create `apps/desktop/src/renderer/workspace/ComponentBrief.tsx`, `apps/desktop/src/renderer/workspace/ComponentList.tsx`; modify `apps/desktop/src/renderer/workspace/SelectionCard.tsx` (component section with Focus component and Clear), the workspace store if selection payload needs `component` (`grep -n "selection" apps/desktop/src/renderer/workspace/*.ts`); tests `ComponentBrief.test.tsx`, `ComponentList.test.tsx`, `SelectionCard.test.tsx` (new case).

**Interfaces:** `ComponentBrief({ info: ComponentInfo; x: number; y: number })`; `ComponentList({ layerId: string; components: ComponentInfo[]; hidden: ReadonlySet<string>; selected?: string; onSelect(id): void; onToggle(id, visible): void })` with a search box filtering by name, id, category, tag.

- [ ] **Step 1: Failing tests**: brief shows name, category and the first sentence of the description, clamped to the viewport; list search "lens" finds warning lights by description; clicking a row calls `onSelect` (touch: tap works because it is a button); visibility toggle calls `onToggle`; SelectionCard for a component shows id, tag, basis line and "Focus component" calling `workspace.flyTo({ kind: 'selection' })`; Escape key in the card clears selection.
- [ ] **Step 2: Run**: `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/ComponentBrief.test.tsx src/renderer/workspace/ComponentList.test.tsx src/renderer/workspace/SelectionCard.test.tsx` (FAIL).
- [ ] **Step 3: Implement** using `@aio/ui` primitives and existing tokens; strings without em or en dashes; the list mounts in the layer panel for mesh layers whose handle has `components()`.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add apps/desktop/src/renderer/workspace/ComponentBrief.tsx apps/desktop/src/renderer/workspace/ComponentBrief.test.tsx apps/desktop/src/renderer/workspace/ComponentList.tsx apps/desktop/src/renderer/workspace/ComponentList.test.tsx apps/desktop/src/renderer/workspace/SelectionCard.tsx apps/desktop/src/renderer/workspace/SelectionCard.test.tsx && git commit -m "feat(desktop): component hover brief, list and selection panel"`

### Task 21: Place model (gizmo, pick a point, numeric fields)

**Files:** Create `packages/engine/src/stage/placeGizmo.ts` (+ test), `apps/desktop/src/renderer/builder/PlaceModel.tsx` (+ test); modify `packages/engine/src/index.ts` (export), `apps/desktop/src/renderer/shell/Palette.tsx` (action `builder:place-model`), `apps/desktop/src/renderer/shell/DateMenus.tsx` (one "Place model..." item for mesh layers; small, see Global Constraints), `apps/desktop/src/renderer/builder/BuilderLayer.tsx` (mount next to `AlignModel`), `apps/desktop/src/renderer/builder/ImportPanel.tsx` (an action button "Place model" for items whose layer has `placement` `needed` or `provisional`).

**Interfaces:**

```ts
// placeGizmo.ts
export type GizmoMode = 'move' | 'rotate' | 'tilt' | 'scale';
export interface PlaceGizmo {
  attach(layerId: string, transform: Mat4): void;
  setMode(m: GizmoMode): void;
  onChange(cb: (t: Mat4) => void): () => void;
  detach(): void;
}
export function createPlaceGizmo(stage: Stage): PlaceGizmo; // three TransformControls; rotate limited to the Y axis, tilt to X and Z, scale uniform
export function composePlacement(o: {
  anchor: Vec3;
  headingDeg: number;
  tiltXDeg: number;
  tiltZDeg: number;
  scale: number;
  up: 'y' | 'z';
}): Mat4;
export function decomposePlacement(t: Mat4): {
  anchor: Vec3;
  headingDeg: number;
  tiltXDeg: number;
  tiltZDeg: number;
  scale: number;
};
```

- [ ] **Step 1: Failing tests**: `placeGizmo.test.ts`: `decomposePlacement(composePlacement(x))` round-trips within 1e-9 for random inputs; heading 90 maps model +X to world south (-north) as per the frame (+Z south); dragging changes emit transforms only through `onChange`. `PlaceModel.test.tsx`: step 1 "Click a point" then a simulated scene pick sets the anchor; typing E, N, H in the project CRS sets the anchor through `projectToLocal`; latitude and longitude convert through `fromWgs84`; "Drop to ground" calls the provided `groundAt(x, z)` once and only on click; Undo restores the previous transform; Done calls `saveLayers([id], { transform, georef?, placement: 'placed' })` with `georef` from `layerTransformToGeoref(..., 'place-model')` only when the layer has a `georef`; a read-only project shows the existing extract message and no gizmo.
- [ ] **Step 2: Run**: `pnpm --filter @aio/engine exec vitest run src/stage/placeGizmo.test.ts` and `pnpm --filter @aio/desktop exec vitest run src/renderer/builder/PlaceModel.test.tsx` (FAIL).
- [ ] **Step 3: Implement**: the gizmo uses `TransformControls` from `three/examples/jsm/controls/TransformControls.js`, disables camera orbit while dragging (Stage's controls `enabled = false` on `dragging-changed`), and maps the object's matrix back to a `Mat4`. `PlaceModel.tsx` follows `AlignModel.tsx` for layout, save and the `previous` undo pattern; fields: East offset, North offset, Up offset (m), Heading, Tilt, Scale; buttons Undo, Reset, Done, Cancel.
- [ ] **Step 4: Run**: PASS. **Step 5: Commit**: `git add packages/engine/src/stage/placeGizmo.ts packages/engine/src/stage/placeGizmo.test.ts packages/engine/src/index.ts apps/desktop/src/renderer/builder/PlaceModel.tsx apps/desktop/src/renderer/builder/PlaceModel.test.tsx apps/desktop/src/renderer/shell/Palette.tsx apps/desktop/src/renderer/shell/DateMenus.tsx apps/desktop/src/renderer/builder/BuilderLayer.tsx apps/desktop/src/renderer/builder/ImportPanel.tsx && git commit -m "feat(desktop): place, move, rotate and scale any model in the scene"`

### Task 22: S2 end-to-end specs

**Files:** Create `apps/desktop/e2e/engineeringFixtures.ts` (builds a synthetic engineering project: `/2` model from `fixtures.ts` stack, bundle GLB, mesh layer with georef; and a second empty project with a different origin), `apps/desktop/e2e/scenePick.ts` (shared helper `clickWorldPoint(win, p)` and `hoverWorldPoint`, extracted from the inline pattern in `model-builder.spec.ts`; that spec is not edited), `apps/desktop/e2e/engineering-picking.spec.ts`, `apps/desktop/e2e/engineering-georef.spec.ts`, `apps/desktop/e2e/place-model.spec.ts`.

- [ ] **Step 1: Write the specs**:
  - `engineering-picking.spec.ts`: hover a flue shows the brief with its name; click selects `flue-2` (assert `workspace.getState().selection.id === 'flue-2'`); Focus component moves the camera (distance to the flue centre decreases); Escape clears; background click clears; drag across the flue (mouse down, move 60 px, up) leaves selection empty; hide `flue-2` in the list then clicking its screen point selects the shaft behind or nothing; clicking a warning light lens selects the light component and every one of its meshes is tinted (read via `__stratlas.stage()` scene traversal), while another light sharing the material is not.
  - `engineering-georef.spec.ts`: in project A, Export engineering model (IPC called directly via the test hook for the folder choice); open project B (different origin); import the exported GLB through Add data; assert the B layer `placement === 'placed'` and that `worldOfModelPoint` of three node vertices (read from the GLB in Node) matches A within 1 mm; import a plain GLB and assert identity transform and no `placement`.
  - `place-model.spec.ts`: import a plain GLB, open Place model from the right-click menu, click a scene point, set Heading 30 in the field, Done, reopen the project, assert the transform decomposes to that anchor and 30 degrees.
- [ ] **Step 2: Run each the CI way** (see Global Constraints) with `--workers=1`; all pass.
- [ ] **Step 3: Commit**: `git add apps/desktop/e2e/engineeringFixtures.ts apps/desktop/e2e/scenePick.ts apps/desktop/e2e/engineering-picking.spec.ts apps/desktop/e2e/engineering-georef.spec.ts apps/desktop/e2e/place-model.spec.ts && git commit -m "test(e2e): component picking, georeferenced round trip and Place model"`

### Task 23: S2 stage gate

- [ ] `pnpm check` green; the three S2 specs plus `model-builder.spec.ts` and `package.spec.ts` the CI way; independent review; `finish-task.mjs`; merge per CLAUDE.md; announce that `DateMenus.tsx` gained one Place model item.

---

# Stage S3: local evidence job (Python)

### Task 24: synthetic asset generators

**Files:** Create `python/tests/synth_assets.py`, `python/tests/test_synth_assets.py`.

**Interfaces:** `stack_cloud(seed=1, partial=False, noise=0.02, ground=True) -> (np.ndarray[N,3] float64 local xyz, dict truth)`; `flare_cloud(seed)`, `lattice_cloud(seed)`, `monopole_cloud(seed)`; `write_las(points, path, crs_epsg=32633, offset=(400000, 5600000, 0))` (laspy is not a dependency: write a LAS 1.2 point format 0 file with numpy `tofile` and a handwritten header, then convert to COPC in tests with PDAL when available; tests that need PDAL are marked `requires_pdal`); `synth_photos(dir, n, seed, size=(1600,1200), rotate_exif=False)` renders simple silhouettes with Pillow and optionally writes an EXIF Orientation 6 tag. Truth matches `STACK_TRUTH` etc. in `packages/modelling/src/engineer/fixtures.ts` (same numbers; a test in Task 24 reads that TS file as text and checks the numbers to keep them in sync).

- [ ] **Step 1**: test that `stack_cloud(partial=True)` has no points with azimuth in the missing 90-degree sector, that noise standard deviation is within 10 percent of the requested value, and that truth numbers equal those parsed from `fixtures.ts`.
- [ ] **Step 2**: `cd python && uv run pytest tests/test_synth_assets.py -q` (FAIL), implement, PASS.
- [ ] **Step 3**: `git add python/tests/synth_assets.py python/tests/test_synth_assets.py && git commit -m "test(python): seeded synthetic stacks, flares and towers"`

### Task 25: bounded crop, ground, axis and sections

**Files:** Create `python/src/aio_pipelines/engineer/__init__.py`, `engineer/cloud.py`, `engineer/axis.py`, `engineer/sections.py`; tests `python/tests/test_engineer_cloud.py`.

**Interfaces:**

```python
def read_region(layer_path: Path, fmt: str, region: Region | None, max_points: int, ctx) -> tuple[np.ndarray, dict]: ...  # PDAL readers.copc with bounds, or readers.las + filters.crop; voxel sample to max_points; returns local xyz and {'read': int, 'kept': int, 'crs': ..., 'bounds': ...}
def remove_ground(xyz: np.ndarray, dist: float) -> tuple[np.ndarray, int]: ...  # reuses modelfit.segment.ground_surface
def estimate_axis(xyz: np.ndarray) -> Axis: ...  # PCA on points above 20 percent height, RANSAC refine on slice centres; Axis(point, dir, tilt_deg)
def fit_sections(xyz: np.ndarray, axis: Axis, step: float, max_slices: int = 256) -> list[SliceFit]: ...  # per slice ransac_circle (modelfit.ransac) with residual, support, coverage (share of 10-degree azimuth bins with points)
def fit_taper(slices: list[SliceFit], max_knots: int = 8) -> Taper: ...  # piecewise linear fit, knots by Douglas-Peucker on (y, r) with 1 percent tolerance
```

- [ ] **Step 1: Failing tests**: `test_partial_noisy_stack_taper` (radius error under 2 percent at 0, 30 and 100 m on the partial noisy stack; coverage on missing-sector slices about 0.75); `test_axis_tilt` (a 2-degree tilted stack gives tilt within 0.2 degree); `test_ground_removed` (no kept point below ground + 0.15 m); `test_large_cloud_bounded` (a 5M-point generated LAS with a region covering 10 percent: `read` counts only region points as reported by PDAL, `kept <= max_points`, peak RSS growth under 600 MB using `tracemalloc` on the numpy side).
- [ ] **Step 2**: `uv run pytest tests/test_engineer_cloud.py -q` (FAIL); implement; PASS.
- [ ] **Step 3**: `git add python/src/aio_pipelines/engineer/__init__.py python/src/aio_pipelines/engineer/cloud.py python/src/aio_pipelines/engineer/axis.py python/src/aio_pipelines/engineer/sections.py python/tests/test_engineer_cloud.py && git commit -m "feat(pipelines): bounded crop, axis and taper sections for engineering models"`

### Task 26: repeated members and family hints

**Files:** Create `python/src/aio_pipelines/engineer/members.py`; test `python/tests/test_engineer_members.py`.

**Interfaces:** `find_flues(xyz, axis, taper) -> MemberGroup` (top 8 percent of height, points inside the crown radius, DBSCAN in the horizontal plane, circle fit per cluster); `find_light_candidates(xyz, axis, taper, colours) -> MemberGroup` (points proud of the shaft surface by 0.1 to 1.0 m, clustered in (height, azimuth); clusters grouped into levels by height with a 2 m gap); `find_legs(xyz, axis) -> MemberGroup` (per slice, cluster horizontal points; 3 or 4 stable clusters across slices = legs); `find_antenna_candidates`; `find_platforms` (slices whose radius jumps by more than 40 percent over 1 m); `family_hints(xyz, axis, slices, members) -> FamilyHints` (fill ratio = occupied share of the convex hull area per slice, mean; slenderness = height / base diameter; suggested: lattice when fill < 0.35 and 3 to 4 legs; monopole when fill > 0.6 and slenderness > 15 and no flues; flare when a top feature narrower than 0.5 x shaft r exists and no flues; else chimney).

- [ ] **Step 1: Failing tests**: stack gives 3 flues (centres within 0.15 m of truth) and light levels `[40, 80]` with 3 candidates each; lattice gives 4 legs and suggested `telecom-lattice`; monopole suggested `telecom-monopole`; flare suggested `flare`; the partial stack (one sector missing) still gives 3 flues when the crown is fully seen.
- [ ] **Step 2**: run `uv run pytest tests/test_engineer_members.py -q`; implement; PASS.
- [ ] **Step 3**: `git add python/src/aio_pipelines/engineer/members.py python/tests/test_engineer_members.py && git commit -m "feat(pipelines): repeated members and family hints"`

### Task 27: renders and photo ingestion

**Files:** Create `python/src/aio_pipelines/engineer/render.py`, `engineer/photos.py`; tests `python/tests/test_engineer_render.py`, `python/tests/test_engineer_photos.py`.

**Interfaces:** `render_ortho(xyz, rgb, view: Literal['north','east','south','west','top'], px: int) -> Image` (numpy z-buffer splat, point size 2 px, depth shading when no colour); `render_slice(slice_points, fit, px)`; `crop_views(xyz, axis, taper, members, px) -> list[(name, Image)]` (crown, base, each light level); `colour_bands(xyz, rgb, axis, step) -> list[band]`; `ingest_photos(paths, out_dir, max_px, max_images) -> list[PhotoItem]` applying `ImageOps.exif_transpose`, sha1 exact duplicates dropped, dhash Hamming distance <= 4 near duplicates dropped with `dupOf`, blur via the existing `exif.py` Laplacian, review copies at `max_px`, camera GPS recorded as `gpsCamera` only, originals linked by path.

- [ ] **Step 1: Failing tests**: renders are `px` wide, non-empty, deterministic for a seed (sha1 stable); top view of the stack shows 3 flue holes (count dark blobs inside the crown circle); photos: an EXIF-rotated synthetic image comes out upright (`w < h` after transpose for orientation 6), a byte duplicate and a 1-pixel-shifted near duplicate are both dropped with `dupOf`, `max_images` caps the kept list by blur score, review copies never exceed `max_px`.
- [ ] **Step 2**: `uv run pytest tests/test_engineer_render.py tests/test_engineer_photos.py -q`; implement; PASS.
- [ ] **Step 3**: `git add python/src/aio_pipelines/engineer/render.py python/src/aio_pipelines/engineer/photos.py python/tests/test_engineer_render.py python/tests/test_engineer_photos.py && git commit -m "feat(pipelines): evidence renders and photo ingestion with orientation and dedupe"`

### Task 28: the `model.evidence` pipeline, registration and pack 0.8.0

**Files:** Create `python/src/aio_pipelines/engineer/pipeline.py`; modify `python/src/aio_pipelines/pipelines.py` (register), `python/pyproject.toml` (`version = "0.8.0"`), `python/src/aio_pipelines/__init__.py` (app range comment and value if the app version moves), `apps/desktop/src/renderer/jobs.ts` and `apps/desktop/src/renderer/processing/pipelines.ts` (label, steps, params builder); tests `python/tests/test_model_evidence.py`, `apps/desktop/src/renderer/processing/pipelines.test.ts` (if present; else the jobs test that lists pipelines).

**Interfaces:** `class ModelEvidence(Pipeline)` with `name = 'model.evidence'`, `validate(params)`, `plan()` returning the eight steps, `inputs()` fingerprints (cloud files, mesh files, photo paths with size and mtime); writes `engineering/<run>/evidence.json` (validated against the JSON schema exported by `tools/compat/extract-schema.mjs` for `EvidencePack`), `engineering/<run>/img/*.png`; `reconstruction` is `'not-needed'` with a cloud, `'unavailable'` when only photos and the photogrammetry probe says unavailable (never `'used'` unless a reconstruction cloud layer was passed in `clouds`).

- [ ] **Step 1: Failing tests**: `test_partial_noisy_stack_pack` (end to end on a temp project with a COPC made by PDAL: pack validates, has taper, 3 flues, 2 light levels, <= `maxImages` images, no file in the pack larger than the review size, no `.npy` or point array in the pack folder); `test_photos_only_pack` (no clouds: `axis`, `taper` null, photos ingested, `reconstruction == 'unavailable'` when the probe is patched to unavailable); `test_resume_skips_done_steps`; `test_cancel_leaves_completed_steps`; `test_changed_params_refuse_resume`.
- [ ] **Step 2**: `uv run pytest tests/test_model_evidence.py -q`; implement; PASS. Also `pnpm --filter @aio/desktop exec vitest run src/renderer/processing` PASS.
- [ ] **Step 3**: `git add python/src/aio_pipelines/engineer/pipeline.py python/src/aio_pipelines/pipelines.py python/pyproject.toml python/uv.lock python/src/aio_pipelines/__init__.py python/tests/test_model_evidence.py apps/desktop/src/renderer/jobs.ts apps/desktop/src/renderer/processing/pipelines.ts <its test> && git commit -m "feat(pipelines): model.evidence job and pipeline pack 0.8.0"`

### Task 29: S3 stage gate

- [ ] `cd python && uv sync --frozen && uv run pytest -q` green; `pnpm check` green; independent review; `finish-task.mjs`; merge per CLAUDE.md. Announce that the pack is 0.8.0 and testers get it only with an installer the founder asks for.

---

# Stage S4: AI identify step

### Task 30: capability table and the `engineer` route

**Files:** Create `packages/ai/src/capabilities.ts` (+ test); modify `packages/ai/src/routes.ts` (default `engineer` route = the `vision` route; `routeFor('engineer')`), settings schema in `packages/schema/src/ipc.ts` (`routes[].treatAsVision?: boolean`), `docs/architecture/contract-changes.md` (row 8).

**Interfaces:**

```ts
export interface ModelCaps {
  vision: boolean;
  structured: boolean;
  maxImages: number;
  maxImagePx: number;
}
export function capsFor(
  provider: string,
  model: string,
  o?: { treatAsVision?: boolean },
): ModelCaps | null; // null = unknown
export function engineerReady(
  route: ModelRoute,
): { ok: true; caps: ModelCaps } | { ok: false; reason: string };
```

Table entries are patterns, not exact ids: anthropic `/^claude-(opus|sonnet)-/` and `/^claude-haiku-/` vision true, structured true, maxImages 20, maxImagePx 1568; openai `/^gpt-(4o|4\.1|5|6)/` vision true, structured true, maxImages 20, maxImagePx 2048; `local` from the existing capability probe; anything else `null`.

- [ ] **Step 1: Failing tests**: known patterns give caps; an unknown cloud model is refused with a reason naming "Treat as vision model" in Settings; with `treatAsVision` it is accepted with conservative caps (8 images, 1024 px); a text-only local model is refused; `routeFor('engineer')` follows the `vision` route by default.
- [ ] **Step 2**: `pnpm --filter @aio/ai exec vitest run src/capabilities.test.ts src/routes.test.ts` FAIL, implement, PASS.
- [ ] **Step 3**: `git add packages/ai/src/capabilities.ts packages/ai/src/capabilities.test.ts packages/ai/src/routes.ts packages/ai/src/routes.test.ts packages/schema/src/ipc.ts docs/architecture/contract-changes.md && git commit -m "feat(ai): capability table and the engineer route"`

### Task 31: structured, cached, budgeted engineer call

**Files:** Create `packages/ai/src/engineer.ts`, `packages/ai/src/engineerPrompt.ts`; modify `packages/ai/src/errors.ts` (`InvalidProposalError`, `BudgetReachedError`), `packages/ai/src/index.ts`; test `packages/ai/src/engineer.test.ts`.

**Interfaces:**

```ts
export interface EngineerCall {
  projectId: string;
  runId: string;
  pass: number;
  images: {
    id: string;
    kind: 'photo' | 'side' | 'top' | 'slice' | 'crop' | 'generated';
    dataUrl: string;
    bytes: number;
  }[];
  summary: string;
  setup: EngineerSetup;
  previous?: EngineerProposal;
}
export interface EngineerHost {
  route(): ModelRoute;
  key(provider: string): Promise<string | null>;
  offlineOnly(): boolean;
  policy(): { ai: 'allow' | 'forbid'; photos: boolean; scans: boolean };
  cache: {
    get(key: string): Promise<EngineerProposal | null>;
    put(key: string, p: EngineerProposal): Promise<void>;
  };
  spent(runId: string): number;
  usage(u: UsageEvent): void;
  budgetUsd: number;
  signal: AbortSignal;
  providers: ProviderRegistry;
  fetch?: typeof fetch;
}
export type EngineerOutcome =
  | { kind: 'proposal'; proposal: EngineerProposal; cached: boolean; costUsd: number }
  | {
      kind: 'refused';
      reason: string;
      code: 'offline' | 'policy' | 'no-key' | 'capability' | 'budget' | 'identity';
    }
  | { kind: 'failed'; error: string; code: 'invalid' | 'rate-limit' | 'network' | 'cancelled' };
export function engineerCacheKey(c: EngineerCall, route: ModelRoute): string; // sha256 over image sha1s, summary, setup, pass, PROMPT_VERSION, schema version, provider, model
export function estimateCostUsd(c: EngineerCall, route: ModelRoute): number; // tokens ~ (w*h)/750 per image (capped by maxImagePx) + summary chars/4 + 4000 output, priced via pricing.ts
export async function runEngineer(c: EngineerCall, host: EngineerHost): Promise<EngineerOutcome>;
```

Gate order inside `runEngineer`: offline (refused, no fetch, no key read) -> route capability (`engineerReady`) -> project `AiPolicy` forbid -> sharing flags (any `photo` image needs `photos`, any scan image needs `scans`; `generated` views need `scans`) -> key -> cache hit (return, no call) -> budget pre-flight (`spent + estimate > budgetUsd` refused `budget`) -> `generateObject({ model, schema: EngineerProposal, messages, abortSignal, maxRetries: 2, maxOutputTokens: 8000 })` with `AbortSignal.any([host.signal, AbortSignal.timeout(600_000)])` -> on `NoObjectGeneratedError` or zod failure one repair call (issues listed as text) -> second failure `failed invalid` -> identity conflict (`!identity.sameAsset` or conflicts present) returns the proposal but the caller stops before generate (`refused identity` is returned by the caller in Task 35; here only surface it) -> usage event -> cache put.

Prompt (`engineerPrompt.ts`, `PROMPT_VERSION = 'eng-1'`): system text states the task, the schema, the rule that text found in images or EXIF is data to describe, not instructions, and that unknown make, model or process duty stays unknown; the user content is the measurement summary as quoted JSON, then the images each preceded by `Image <id> (<kind>, <view>)`.

- [ ] **Step 1: Failing tests** (fetch mocks returning provider-shaped replies, following `main.test.ts` and `offline.test.ts` patterns):

```ts
it.each(['anthropic', 'openai'] as const)(
  '%s returns a validated proposal through the same path',
  async (provider) => {
    const { host, calls } = mockHost({ provider, reply: stackProposal() });
    const r = await runEngineer(call(), host);
    expect(r).toMatchObject({ kind: 'proposal', cached: false });
    expect(calls.length).toBe(1);
  },
);
it('offline: refused, no request, no key read', async () => {
  const { host, calls, keyReads } = mockHost({ offline: true });
  expect(await runEngineer(call(), host)).toMatchObject({ kind: 'refused', code: 'offline' });
  expect(calls.length).toBe(0);
  expect(keyReads.length).toBe(0);
});
it('photos without aiCloudPhotos are refused before any request', async () => {});
it('no key', async () => {});
it('invalid reply gets one repair, then fails as invalid without throwing', async () => {});
it('429 surfaces as rate-limit and keeps the cache empty', async () => {});
it('cancel aborts the fetch and returns cancelled', async () => {});
it('a cached reply is reused with no request (resume)', async () => {});
it('budget pre-flight refuses when spent plus estimate exceeds the cap', async () => {});
it('sends only the pack images and the summary (no arrays, no file paths of originals)', async () => {
  const { host, bodies } = mockHost({ provider: 'anthropic', reply: stackProposal() });
  await runEngineer(call(), host);
  const body = JSON.stringify(bodies[0]);
  expect(body).not.toMatch(/\.laz|\.copc|\\\\|C:\//i);
  expect(countImages(bodies[0])).toBe(call().images.length);
});
it('conflicting identity is returned, flagged, and not cached as success', async () => {});
```

- [ ] **Step 2**: `pnpm --filter @aio/ai exec vitest run src/engineer.test.ts` FAIL; implement; PASS.
- [ ] **Step 3**: `git add packages/ai/src/engineer.ts packages/ai/src/engineerPrompt.ts packages/ai/src/engineer.test.ts packages/ai/src/errors.ts packages/ai/src/index.ts && git commit -m "feat(ai): structured engineer proposals with cache, budget and policy gates"`

### Task 32: send preview for evidence and the sharing flags

**Files:** Create `apps/desktop/src/renderer/engineer/EvidencePreview.tsx` (+ test); modify `apps/desktop/src/main/engineering.ts` (main-side re-check helper `evidencePolicy(projectRoot)` used by Task 33), `docs/architecture/contract-changes.md` (row 9 is added in Task 33; nothing here).

**Interfaces:** `EvidencePreview({ images: { id; kind; thumb: string; bytes: number }[]; summary: string; route: ModelRoute; estimateUsd: number; flags: { photos: boolean; scans: boolean }; onAllowProject(kind: 'photos' | 'scans'): void; onSendOnce(): void; onCancel(): void })`.

- [ ] **Step 1: Failing tests**: lists every image with its kind and size, total bytes and count, the route's provider and model, the estimate formatted in US$; "Allow for this project" per kind calls `onAllowProject`; "Send once" is disabled while any required flag is off unless a one-time allow box for that kind is ticked; Cancel sends nothing.
- [ ] **Step 2**: `pnpm --filter @aio/desktop exec vitest run src/renderer/engineer/EvidencePreview.test.tsx` FAIL; implement; PASS.
- [ ] **Step 3**: `git add apps/desktop/src/renderer/engineer/EvidencePreview.tsx apps/desktop/src/renderer/engineer/EvidencePreview.test.tsx apps/desktop/src/main/engineering.ts && git commit -m "feat(desktop): evidence send preview with per-project photo and scan consent"`

### Task 33: `ai:engineer` IPC in main and scripted replies

**Files:** Modify `packages/ai/src/main.ts` (register `ai:engineer` using the existing `runs` map and `ai:cancel`; host built from settings, key vault, manifest flags re-read from disk through `evidencePolicy`, cache in `engineering/<run>/ai/`), `packages/ai/src/scripted.ts` (engineer marker: returns `stackProposal`-shaped fixtures; a keyword in the summary picks `flare`, `lattice`, `monopole`, `invalid` or `conflict`), `packages/schema/src/ipc.ts` (row 9 shapes), `docs/architecture/contract-changes.md` (row 9); tests `packages/ai/src/main.test.ts` (new cases), `packages/ai/src/scripted.test.ts`.

- [ ] **Step 1: Failing tests**: `ai:engineer` with `QUADRION_AI_TEST_PROVIDER`-style scripted provider returns a proposal and emits a usage event recorded to the project tally; cancel mid-call returns `cancelled`; the main process refuses photos when the manifest flag on disk is off even if the renderer claims consent; offline returns `refused offline` and the fetch mock sees nothing.
- [ ] **Step 2**: `pnpm --filter @aio/ai exec vitest run src/main.test.ts src/scripted.test.ts` FAIL; implement; PASS.
- [ ] **Step 3**: `git add packages/ai/src/main.ts packages/ai/src/main.test.ts packages/ai/src/scripted.ts packages/ai/src/scripted.test.ts packages/schema/src/ipc.ts docs/architecture/contract-changes.md && git commit -m "feat(ai): ai:engineer IPC with main-side policy checks and scripted replies"`

### Task 34: S4 stage gate

- [ ] `pnpm check` green; `offline-cloud-ai.spec.ts` and `model-builder.spec.ts` the CI way; independent review; `finish-task.mjs`; merge per CLAUDE.md.

---

# Stage S5: workflow, review and entry points

### Task 35: run orchestration (renderer store and main run files)

**Files:** Create `apps/desktop/src/renderer/engineer/runStore.ts` (+ test), `apps/desktop/src/renderer/engineer/summary.ts` (measurement summary text for the AI, + test).

**Interfaces:**

```ts
export interface RunDeps {
  ipc: {
    runRead;
    runWrite;
    evidenceImage;
    engineer;
    cancel;
    enqueueJob;
    jobStatus;
    modelWrite;
    modelBuild;
  };
  now(): string;
  online(): boolean;
}
export function createRunStore(deps: RunDeps): StoreApi<RunState>;
export interface RunState {
  run: EngineerRun | null;
  evidence: EvidencePack | null;
  proposal: EngineerProposal | null;
  model: ProcModel | null;
  report: GlbReport | null;
  stage: EngineerStage | null;
  error: string | null;
  start(setup: EngineerSetup): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  rebuild(user: UserOverrides): Promise<void>;
  accept(): Promise<void>;
}
export function measurementSummary(e: EvidencePack | null, setup: EngineerSetup): string; // compact text, numbers rounded, no arrays over 16 items
```

Stage logic: inspect = enqueue `model.evidence` (job id = run id, so retry resumes) and wait; estimate = read `evidence.json`; identify = for each pass up to `DETAIL_BUDGETS[detail].passes`: build images (pack images plus, from pass 2, generated views rendered by the existing engine offscreen snapshot of the draft at the same views) -> show `EvidencePreview` (await consent) -> `ai:engineer`; offline or refused keeps going with `proposal = null` and records the reason; identity conflict stops with the flagged images listed; generate = `assemble` (Task 10) then `model:write`; validate = `model:build` returning `GlbReport` plus silhouette IoU (rendered model views vs pack side renders, computed in the renderer with a canvas threshold mask); review = done. Every stage writes `run.json` via `engineer:runWrite` with its input hash; `resume` skips stages whose hash matches.

- [ ] **Step 1: Failing tests** (store with fake deps): cloud plus photos run reaches `review` with stages in order; offline: identify is `skipped` with the message "Needs a vision model. Offline mode is on, so nothing is sent." and the model is measured-only; photos-only single image: `scale.status === 'provisional'` and `placement` in setup `unplaced` gives a model whose georef horizontal status is `unplaced`; reconstruction unavailable recorded as `unavailable`; cancel during identify leaves inspect and estimate `done`; resume after reopen does not call `ai:engineer` again (cache via same key) and does not re-enqueue the job; accept twice creates one layer; no IPC payload contains a typed array or an array longer than 10 000 (assert on the fake deps' recorded calls).
- [ ] **Step 2**: `pnpm --filter @aio/desktop exec vitest run src/renderer/engineer` FAIL; implement; PASS.
- [ ] **Step 3**: `git add apps/desktop/src/renderer/engineer/runStore.ts apps/desktop/src/renderer/engineer/runStore.test.ts apps/desktop/src/renderer/engineer/summary.ts apps/desktop/src/renderer/engineer/summary.test.ts && git commit -m "feat(desktop): resumable engineering model runs"`

### Task 36: setup dialog and stage progress

**Files:** Create `apps/desktop/src/renderer/engineer/SetupDialog.tsx`, `apps/desktop/src/renderer/engineer/StageList.tsx`, `apps/desktop/src/renderer/engineer/EngineerLayer.tsx` (mount point; follows `ModellerLayer.tsx`; renders nothing unless `ENGINEERING_MODEL_UI`), `apps/desktop/src/renderer/engineer/flags.ts` (`export const ENGINEERING_MODEL_UI = false;`), tests for each. Load the design skills (`impeccable`, `frontend-design`) before building.

- [ ] **Step 1: Failing tests**: sources multi-select lists pointcloud, mesh and photos layers and "Add photos..." opens the file picker; region pick sets centre and radius; family shows the suggestion from `familyHints` (when an evidence pack exists) with an override select; scope, detail (standard default), reference dimension, placement (from source, pick anchor, unplaced); provider and model read-only with a Settings link; "Preview what is sent" disabled offline with the offline message; Start calls `runStore.start(setup)` with a schema-valid `EngineerSetup`. StageList shows six stages with states, Cancel and Retry.
- [ ] **Step 2**: `pnpm --filter @aio/desktop exec vitest run src/renderer/engineer/SetupDialog.test.tsx src/renderer/engineer/StageList.test.tsx` FAIL; implement; PASS.
- [ ] **Step 3**: `git add apps/desktop/src/renderer/engineer/SetupDialog.tsx apps/desktop/src/renderer/engineer/SetupDialog.test.tsx apps/desktop/src/renderer/engineer/StageList.tsx apps/desktop/src/renderer/engineer/StageList.test.tsx apps/desktop/src/renderer/engineer/EngineerLayer.tsx apps/desktop/src/renderer/engineer/flags.ts && git commit -m "feat(desktop): engineering model setup and stage progress"`

### Task 37: review in Model Builder

**Files:** Create `packages/modelling/src/ComponentTree.tsx`, `packages/modelling/src/ComponentCard.tsx`, `packages/modelling/src/assemblyEdit.ts` (+ tests); modify `packages/modelling/src/ModelBuilder.tsx` (a Components section when `model.assemblies.length > 0`; KIND_LABEL entries), `packages/modelling/src/index.ts`.

**Interfaces:** `assemblyFields(a: Assembly): { key: string; label: string; value: number | string | boolean; unit?: 'm' | 'deg'; basis: ValueBasis; min?: number; max?: number }[]`; `applyAssemblyField(m: ProcModel, id: string, key: string, value): UserOverrides` (returns overrides for `rebuild`); `ComponentTree({ model, selected, hidden, onSelect, onToggle, onStatus, onRemove, onAdd(kind) })`; `ComponentCard({ assembly, evidence, onField, onFocus })`.

- [ ] **Step 1: Failing tests**: tree groups by category with counts, search filters, keyboard A/R/D like parts; card shows each value with its basis label (Measured, Observed, Inferred, Entered by you), residual and coverage where present, sources with thumbnails, unobserved surfaces, and never shows a percentage confidence; editing a field returns overrides with that key as `user`; Add component by kind adds a draft with the next free id for its role; Remove on an accepted component asks for confirmation (inline, not a browser dialog).
- [ ] **Step 2**: `pnpm --filter @aio/modelling exec vitest run src/ComponentTree.test.tsx src/ComponentCard.test.tsx src/assemblyEdit.test.ts src/ModelBuilder.test.tsx` FAIL; implement; PASS.
- [ ] **Step 3**: `git add packages/modelling/src/ComponentTree.tsx packages/modelling/src/ComponentTree.test.tsx packages/modelling/src/ComponentCard.tsx packages/modelling/src/ComponentCard.test.tsx packages/modelling/src/assemblyEdit.ts packages/modelling/src/assemblyEdit.test.ts packages/modelling/src/ModelBuilder.tsx packages/modelling/src/ModelBuilder.test.tsx packages/modelling/src/index.ts && git commit -m "feat(modelling): component review with evidence, editing and status"`

### Task 38: agent corrections

**Files:** Modify `packages/ai/src/modelling-tools.ts` (tools `list_components`, `edit_component`, `set_count`, `add_component`, `remove_component`, `set_levels`), `apps/desktop/src/renderer/modeller/agentTools.ts` (executors calling `runStore.rebuild(overrides)`), `apps/desktop/src/renderer/modeller/store.ts` (hold the engineering model alongside), tests `packages/ai/src/modelling-tools.test.ts`, `apps/desktop/src/renderer/modeller/agentTools.test.ts`, and scripted keywords in `packages/ai/src/scripted.ts` ("four flues" -> `set_count {role:'flue', count:4}`; "intermediate warning lights" -> `set_levels {role:'light-l', levels:[...]}`).

- [ ] **Step 1: Failing tests**: `set_count flue 4` on a 3-flue model adds `flue-4` and leaves every other assembly deep-equal (accepted ones included); `set_levels` for one level changes only that level's lights; `edit_component` refuses params outside the zod bounds with the zod message; `remove_component` on an accepted component is refused without an explicit `confirm: true`; tools are `write` risk and wait for approval like the existing write tools.
- [ ] **Step 2**: `pnpm --filter @aio/ai exec vitest run src/modelling-tools.test.ts` and `pnpm --filter @aio/desktop exec vitest run src/renderer/modeller/agentTools.test.ts` FAIL; implement; PASS.
- [ ] **Step 3**: `git add packages/ai/src/modelling-tools.ts packages/ai/src/modelling-tools.test.ts packages/ai/src/scripted.ts apps/desktop/src/renderer/modeller/agentTools.ts apps/desktop/src/renderer/modeller/agentTools.test.ts apps/desktop/src/renderer/modeller/store.ts && git commit -m "feat(ai): agent corrections for engineering components"`

### Task 39: entry points switched on

**Files:** Modify `apps/desktop/src/renderer/engineer/flags.ts` (flip `ENGINEERING_MODEL_UI` to `true`; Task 36 created it as `false`), `apps/desktop/src/renderer/shell/DateMenus.tsx` (one "Create engineering model..." item for pointcloud, mesh and photos layers, next to Place model), `apps/desktop/src/renderer/shell/Palette.tsx` (action), `packages/modelling/src/ModelBuilder.tsx` ("Create engineering model" button via an `onEngineer` prop), `apps/desktop/src/renderer/builder/ImportPanel.tsx` and `apps/desktop/src/renderer/builder/importSummary.ts` (a structured action on compatible import items; never auto-starts), tests for the menu item, palette and import action.

- [ ] **Step 1: Failing tests**: the menu shows the item for a pointcloud layer and not for a vector layer; the import result for a LAZ shows "Create engineering model" as a button that opens the setup with that layer preselected and starts nothing; read-only packages hide it.
- [ ] **Step 2**: run the touched tests FAIL; implement; PASS.
- [ ] **Step 3**: `git add <listed files and tests> && git commit -m "feat(desktop): Create engineering model entry points"`

### Task 40: help, conventions, limits and the local comparison tool

**Files:** Create `docs/guide/44-engineering-models.md` (workflow, Place model, exports, honest limits from spec section 8), `tools/agent/engineering-compare.mjs` (+ `tools/agent/engineering-compare.test.mjs` on synthetic GLBs); modify `docs/KNOWN-LIMITS.md`, `docs/architecture/data-conventions.md` (final pass), `docs/guide/images` only with synthetic screenshots.

`engineering-compare.mjs <run-or-glb> <reference-glb> [--out <dir outside git>]`: loads both GLBs (`readGlb`), lists node names, categories (from extras when present) and counts side by side, renders full, rear, crown, base and light-detail views of both offscreen through Playwright's Chromium with three.js (no Electron window), and when the run has `evidence.json` prints residual and coverage per component. It refuses an `--out` inside the repository.

- [ ] **Step 1: Failing test**: on two synthetic GLBs the inventory diff lists the missing and extra categories; `--out` inside the repo exits with an error.
- [ ] **Step 2**: `node --test tools/agent/engineering-compare.test.mjs` FAIL; implement; PASS; `node tools/agent/check-public-text.mjs docs/guide/44-engineering-models.md docs/KNOWN-LIMITS.md` clean.
- [ ] **Step 3**: `git add docs/guide/44-engineering-models.md docs/KNOWN-LIMITS.md docs/architecture/data-conventions.md tools/agent/engineering-compare.mjs tools/agent/engineering-compare.test.mjs && git commit -m "docs(guide): engineering models, placement and honest limits"`

### Task 41: end-to-end acceptance specs

**Files:** Create `apps/desktop/e2e/engineering-model.spec.ts` (uses `engineeringFixtures.ts` from Task 22, extended with a synthetic COPC and photos written by the Python synth via `QUADRION_E2E_PYTHON`, plus `QUADRION_AI_TEST_PROVIDER=1`).

Cases:

1. **Cloud plus photos (A, H)**: right-click the cloud layer, Create engineering model, Start, approve the preview (allow scans and photos for this project), reach "Ready to review"; component list has 3 flues and lights at two intermediate levels plus the crown; validate report shows zero validator errors; accept; the new layer exists once.
2. **Photos only (C)**: one synthetic photo; run completes; scale shows provisional and asks for a reference dimension; placement banner says unplaced; reconstruction line says unavailable.
3. **Correction and reopen (D)**: in the agent panel, "there are four flues, not three"; approve; `flue-4` appears, `flue-1` id and accepted state unchanged; move light level 1 in the card to 45 m; reload the window; values persist.
4. **Offline (H)**: Settings offline on; Start; identify shows the offline message; the network guard reports zero requests; the measured-only draft is reviewable.
5. **Export (F, E)**: Export engineering model writes four files; reopen in the second project (Task 22 helper) lands within 1 mm.

- [ ] **Step 1**: write the spec; **Step 2**: run it the CI way with `--workers=1` (demo built); PASS; **Step 3**: `git add apps/desktop/e2e/engineering-model.spec.ts apps/desktop/e2e/engineeringFixtures.ts && git commit -m "test(e2e): create engineering model from cloud, photos and offline"`

### Task 42: S5 stage gate and hand-off

- [ ] `pnpm check` green; every spec added or changed in S2 and S5 the CI way; `cd python && uv run pytest -q` green.
- [ ] Whole-branch independent review (strongest model, high effort) against the brief, the spec and acceptance A to I; fix findings.
- [ ] `finish-task.mjs`; merge per CLAUDE.md; announce (mention `DateMenus.tsx`).
- [ ] Closing message with the numbered "How to test" (import data, Create engineering model, review, correct, accept, export, Place model, import into a differently anchored project), and `/wrapup`.

---

## Self-review notes

- Spec coverage: 5.1 contracts (T1 to T4, T17, T30, T33), 5.2 stages (T25 to T28, T31, T35), 5.3 interface (T20, T36, T37, T39), 5.4 ids (T10), 5.5 inspection (T19, T20, T22), 5.6 placement and exchange (T15 to T18), 5.7 Place model (T21), 5.8 errors (T31, T35), section 7 tests (coverage table), section 8 limits (T40).
- Types used across tasks: `EngineerSetup`, `EngineerProposal`, `EvidencePack`, `Detail`, `DETAIL_BUDGETS` (T3); `Assembly`, `AssemblyKind`, `ProcModel` (T1); `Georef`, `Placement`, `readGlbGeoref` (T2); `MeshSink`, `Prim`, `Opening` (T5); `buildEngineeringGlb`, `validateGlb`, `GlbReport` (T9); `assemble`, `UserOverrides`, fixtures (T10); `georefToLayerTransform`, `layerTransformToGeoref`, `worldOfModelPoint`, `ProjectGeo` (T15); `ComponentInfo` (T19); `runEngineer`, `EngineerCall` (T31); `createRunStore` (T35).

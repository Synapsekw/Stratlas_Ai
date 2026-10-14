# Import placement fixes: textures, Z-up models, far data. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** importing a Pix4D chimney export, its point cloud and handheld camera photos ends with a textured, upright model where it belongs, a cloud that Home frames, and a clear offer to move the project origin when data lands far from it.

**Architecture:** one MTL statement parser keeps texture names with spaces. An imported OBJ is stood upright and placed by its layer `transform` (data-conventions section 1 already says importers bake rotation and offset there): Z up when a Pix4D offset file is reachable or the vertices are map grid coordinates, Y up otherwise; the up axis is read back from the transform, so the Georeference panel can flip it without a new field. Point clouds register their header bounds with the stage as solid content bounds, so Home, auto-fit and the zoom-out cap include them. A renderer watcher asks main for the extent of every layer whenever layers are added; a layer more than 10 km from the origin and from every older layer raises a non-blocking notice with "Re-centre project here" (offered only when every placed thing in the project can be shifted) and "Keep". A last, separable task prefers survey data over handheld camera GPS.

**Tech Stack:** TypeScript (strict), Vitest, three.js (engine), copc.js 0.0.9 (`header.min`/`header.max`), zustand, React, Electron IPC through `@aio/schema` `ipc`, Playwright with Electron.

**Spec:** this plan carries the brief (root causes found 14 Oct 2026 on a Pix4D chimney export, founder decisions: auto-detect plus override for the up axis, warn plus offer re-centre for far data, survey data over handheld GPS as a droppable last task). Read `docs/architecture/data-conventions.md` section 1 (scene frame) and section 4 (COPC is in the project CRS) first.

## Global Constraints

- Scene frame (data-conventions section 1): x east, y up, z south; `E = origin[0] + x`, `N = origin[1] - z`, `H = origin[2] + y` (`@aio/geo` `projectToLocal` / `localToProject`).
- Z up to scene: `(x, y, z) → (x, z, -y)`, column-major `Z_UP = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]`; its inverse `[1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1]`.
- A model's up axis is never stored: `upAxisOf(transform)` is `'z'` when `transform[9] > max(transform[5], 0)`, else `'y'`. No manifest schema change.
- OBJ placement rule, in order: (1) a `*_offset.xyz` in `<project>/1_initial/params/` where the OBJ sits in `<project>/2_densification/3d_mesh/` → Z up, translated by the offset; (2) vertex bounds centre at least 10,000 m from 0 in x or y → map grid coordinates: Z up, vertices stored minus their rounded centre, the centre put in the transform; (3) otherwise Y up, identity transform (today's behaviour).
- Far rule: a newly added layer is far when the plan (x, z) distance from the origin to its extent box, and from that box to every older layer's box, both exceed `FAR_M = 10_000` m.
- Re-centre moves `origin[0]` and `origin[1]` to the rounded centre of the far layers' boxes; `origin[2]` stays. It is offered only when `recentreBlockers` is empty (only mesh, copc point cloud, photos, non-drawing image raster and basemap layers; no issues; no non-empty project folder or file outside `manifest.json*`, `issues.json`, `thumbnail.jpg`, `models`, `clouds`, `photos`, `rasters`, `journal`, `.trash`, `report`).
- Repository rules: no em or en dashes in user-facing text; conventional commits (header and body lines at most 100 characters, lower-case subject), each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no client, site or person names (the repo is public): fixtures say "tower" and use made-up coordinates; never commit on `main`.
- Local test load: one heavy run at a time (`pnpm check`, a Playwright run); Playwright with `--workers=1`, never a visible window (the fixtures keep it off-screen).

## Review Focus

1. **A texture statement whose file is missing and has spaces in its name.** The warning must name the whole file (`Texture my tower.jpg was not found ...`), not its last word. Pinned in Task 1 (`warns with the whole name when a spaced texture is missing`).
2. **A Z-up model that is neither a Pix4D export nor in map grid coordinates** (a local scan). It stays Y up; after the person flips it to Z up, a Level fit in Georeference must keep it standing. Pinned in Task 2 (`a level fit of a z-up model keeps it upright`).
3. **A far layer arriving in a project that already holds issues, flights or a drawing.** Re-centre must be refused with the reasons and never half-applied. Pinned in Task 6 (`refuses with reasons when the project holds issues or other placed files`, `writes nothing when refused`).
4. **A cloud and a mesh of the same far site imported together.** One notice listing both, one re-centre target covering both. Pinned in Task 8 (`two far layers of one site make one notice and one target`).
5. **A hidden point cloud.** It must not drive Home or the zoom cap; showing it again counts again. Pinned in Task 5 (`a hidden cloud leaves the framing to the rest`).

---

## Before you start (every implementer)

- Worktree: `E:\Dev\AIO Software\.claude\worktrees\import-placement-fixes`, branch `fix/import-placement-fixes`. Work only there; never edit the main checkout. Never launch the Electron app by hand.
- Unit tests: `pnpm vitest run <file>` from the worktree root. Type checks: `pnpm typecheck`. The whole gate: `pnpm check` (one at a time).
- Parallel batches share this one worktree. The controller commits each finished task with `git commit -F <message file>` (never two commits at once: the lint-staged hook uses the shared stash). Write commit messages to a scratch file outside the worktree.
- No Python changes: `pointcloud.to_copc` keeps its unused `origin` parameter; the far check reads the finished COPC header in main instead.

## File structure

| File                                                                                                                                                   | Responsibility                                                                                   | Task  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----- |
| `packages/project/src/builder/mtl.ts` (new)                                                                                                            | MTL texture statement parser: options skipped, spaced names kept                                 | 1     |
| `packages/project/src/builder/obj.ts`                                                                                                                  | `parseMtl` uses the parser (Task 1); `shift` option, `bounds` and `shift` in the result (Task 3) | 1, 3  |
| `packages/project/src/builder/modelTextures.ts`                                                                                                        | texture names through the parser                                                                 | 1     |
| `packages/project/src/builder/raw.ts`                                                                                                                  | texture bytes by the parser, model textures of any type skipped (Task 1); OBJ placement (Task 3) | 1, 3  |
| `packages/geo/src/meshUp.ts` (new), `packages/geo/src/index.ts`                                                                                        | Z-up matrices, `upAxisOf`, `withUpAxis`, `placeZUp`, `fitModelPlacement`                         | 2     |
| `packages/project/src/builder/objPlacement.ts` (new)                                                                                                   | Pix4D offset lookup, map grid test, placement transform                                          | 3     |
| `apps/desktop/src/renderer/builder/AlignModel.tsx`, `apps/desktop/src/renderer/shell/Palette.tsx`                                                      | Up axis switch; fits keep the up axis (Task 4); palette keywords (Task 4) and command (Task 8)   | 4, 8  |
| `packages/engine/src/stage/Stage.ts`, `packages/engine/src/types.ts`                                                                                   | `addContentBounds(..., { solid: true })`                                                         | 5     |
| `packages/pointcloud/src/copc.ts`, `packages/pointcloud/src/adapter.ts`                                                                                | header bounds; clouds register solid bounds                                                      | 5     |
| `packages/project/src/builder/extents.ts` (new), `recentre.ts` (new), `builder/index.ts`                                                               | layer extents from files; re-centre blockers and the shift                                       | 6     |
| `packages/schema/src/ipc.ts`, `apps/desktop/src/main/builder.ts`, `main/index.ts`, `main/journal.ts`, `preload/index.ts`                               | `builder:layerExtents`, `builder:recentre`                                                       | 7     |
| `docs/architecture/data-conventions.md`, `docs/architecture/contract-changes.md`                                                                       | section 1 rules; contract rows                                                                   | 7, 10 |
| `apps/desktop/src/renderer/builder/farContent.ts` (new), `farSession.ts` (new), `FarContentNotice.tsx` (new), `renderer/exports/Toasts.tsx`, `App.tsx` | far rule, notice store, watcher, toast                                                           | 8, 10 |
| `apps/desktop/e2e/builder.spec.ts`                                                                                                                     | Pix4D export end to end (Task 9); photos far from survey data (Task 10)                          | 9, 10 |
| `packages/schema/src/builder.ts`, `packages/project/src/builder/create.ts`, `photos.ts`, `renderer/builder/NewProjectWizard.tsx`                       | `photoPositions: 'clear'`, drone test, wizard hint                                               | 10    |

## Execution DAG

```
Batch 1 (parallel, no shared files):  T1 MTL parser   T2 up-axis maths (geo)   T5 clouds frame Home   T6 extents + re-centre core
Batch 2 (parallel, no shared files):  T3 OBJ placement (needs T1, T2)   T4 Up axis in Georeference (needs T2)   T7 IPC + docs (needs T6)
Batch 3:                              T8 far notice in the renderer (needs T7)
Batch 4:                              T9 e2e: Pix4D export end to end (needs T3, T4, T8)
Batch 5 (droppable by the founder):   T10 survey data over handheld GPS (needs T8, T9)
```

| Task | Depends on | Files it may touch (no other task in its batch touches them)                                                                                                                                                                                                                                                        | Packages                                   |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| T1   | none       | `project/src/builder/mtl.ts` (+test), `obj.ts`, `obj.test.ts`, `modelTextures.ts`, `raw.ts`, `raw.test.ts`                                                                                                                                                                                                          | `@aio/project`                             |
| T2   | none       | `geo/src/meshUp.ts` (+test), `geo/src/index.ts`                                                                                                                                                                                                                                                                     | `@aio/geo`                                 |
| T5   | none       | `engine/src/stage/Stage.ts`, `Stage.test.ts`, `engine/src/types.ts`; `pointcloud/src/copc.ts`, `copc.test.ts`, `adapter.ts`, `adapter.test.ts`, `changeCloud.test.ts`, `pick.test.ts`                                                                                                                               | `@aio/engine`, `@aio/pointcloud`           |
| T6   | none       | `project/src/builder/extents.ts` (+test), `recentre.ts` (+test), `builder/index.ts`                                                                                                                                                                                                                                 | `@aio/project`                             |
| T3   | T1, T2     | `project/src/builder/objPlacement.ts` (+test), `obj.ts`, `obj.test.ts`, `raw.ts`, `raw.test.ts`                                                                                                                                                                                                                     | `@aio/project`                             |
| T4   | T2         | `desktop/src/renderer/builder/AlignModel.tsx`, `desktop/src/renderer/shell/Palette.tsx`                                                                                                                                                                                                                             | desktop renderer                           |
| T7   | T6         | `schema/src/ipc.ts`, `desktop/src/main/builder.ts`, `main/index.ts`, `main/journal.ts`, `main/journal.test.ts`, `main/builder.test.ts`, `desktop/src/preload/index.ts`, `docs/architecture/data-conventions.md`, `docs/architecture/contract-changes.md`                                                            | `@aio/schema`, desktop main, preload, docs |
| T8   | T7         | `desktop/src/renderer/builder/farContent.ts` (+test), `farSession.ts`, `FarContentNotice.tsx`, `renderer/exports/Toasts.tsx`, `renderer/App.tsx`, `renderer/shell/Palette.tsx`                                                                                                                                      | desktop renderer                           |
| T9   | T3, T4, T8 | `desktop/e2e/builder.spec.ts`                                                                                                                                                                                                                                                                                       | desktop e2e                                |
| T10  | T8, T9     | `schema/src/builder.ts`, `schema/src/ipc.ts`, `project/src/builder/create.ts`, `raw.test.ts`, `photos.ts`, `photos.test.ts`, `desktop/src/main/builder.ts`, `renderer/builder/NewProjectWizard.tsx`, `farContent.ts` (+test), `FarContentNotice.tsx`, `farSession.ts`, `e2e/builder.spec.ts`, `contract-changes.md` | `@aio/schema`, `@aio/project`, desktop     |

**Critical path:** T6 → T7 → T8 → T9 → T10. T1 → T3 and T2 → T4 run beside it.

**Tests per task:** T1 `mtl.test.ts`, `obj.test.ts`, `raw.test.ts`; T2 `meshUp.test.ts`; T3 `objPlacement.test.ts`, `obj.test.ts`, `raw.test.ts`; T4 typecheck, covered end to end in T9; T5 `Stage.test.ts`, `copc.test.ts`, `adapter.test.ts`; T6 `extents.test.ts`, `recentre.test.ts`; T7 `builder.test.ts` (main), `journal.test.ts`, `pnpm check`; T8 `farContent.test.ts`; T9 the e2e below; T10 `raw.test.ts`, `photos.test.ts`, `farContent.test.ts`, its e2e test.

**E2E specs:** `apps/desktop/e2e/builder.spec.ts` gains one test in T9 and one in T10. No point cloud e2e (it needs PDAL; the cloud framing is pinned by unit tests in T5). Run them the CI way from `apps/desktop`: `pnpm demo:build --quick`, then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/builder.spec.ts --workers=1` (the run must print `[e2e] window 1100 x 720 px at display scale 1`).

**Contract changes:** T7 adds IPC channels `builder:layerExtents` and `builder:recentre` (additive) and two clarifying bullets in data-conventions section 1. T10 adds the `LayerPatch` variant `{ photoPositions: 'clear' }` and the optional `handheld` field of the `builder:photoGps` response. No manifest field changes.

---

### Task 1: Texture names with spaces (one MTL statement parser)

**Files:**

- Create: `packages/project/src/builder/mtl.ts`, `packages/project/src/builder/mtl.test.ts`
- Modify: `packages/project/src/builder/obj.ts:20-39` (`parseMtl`), `packages/project/src/builder/modelTextures.ts:21-31` (`TEXTURE_LINE`, `mtlTextures`), `packages/project/src/builder/raw.ts:487-494` (texture branch) and `raw.ts:685-691` (texture bytes)
- Test: `packages/project/src/builder/obj.test.ts`, `packages/project/src/builder/raw.test.ts`

**Interfaces:**

- Produces: `mtlMapFile(args: string): string | null`; `mtlDiffuseMaps(mtl: string): string[]` (every `map_Kd` file, in order, no duplicates). `mtlTextures` keeps its signature.

- [ ] **Step 1: Write the failing tests**

`packages/project/src/builder/mtl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mtlDiffuseMaps, mtlMapFile } from './mtl';

describe('mtlMapFile', () => {
  it('keeps a file name with spaces whole', () => {
    expect(mtlMapFile('Tower stack 3D_texture.jpg')).toBe('Tower stack 3D_texture.jpg');
  });
  it('skips options and their values before a spaced name', () => {
    expect(mtlMapFile('-s 1 1 1 -bm 0.5 my tex.png')).toBe('my tex.png');
    expect(mtlMapFile('-clamp on tex.png')).toBe('tex.png');
    expect(mtlMapFile('-o 0.5 tex.png')).toBe('tex.png');
    expect(mtlMapFile('-mm 0 1 tex.png')).toBe('tex.png');
  });
  it('turns backslashes into slashes and drops quotes', () => {
    expect(mtlMapFile('textures\\wall a.jpg')).toBe('textures/wall a.jpg');
    expect(mtlMapFile('"my tex.png"')).toBe('my tex.png');
  });
  it('is null when only options are left', () => {
    expect(mtlMapFile('-s 1 1 1')).toBeNull();
    expect(mtlMapFile('   ')).toBeNull();
  });
});

describe('mtlDiffuseMaps', () => {
  it('lists every map_Kd once, tabs and spaces alike', () => {
    const mtl = 'newmtl a\nmap_Kd a b.jpg\nnewmtl b\nmap_Kd\t-s 2 2 2 a b.jpg\nmap_Bump n.png\n';
    expect(mtlDiffuseMaps(mtl)).toEqual(['a b.jpg']);
  });
});
```

Append to `obj.test.ts` (inside its `describe`; it already builds a quad OBJ, reuse its text as `quad`):

```ts
it('embeds a texture whose name has spaces', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const r = objToGlb(`mtllib m.mtl\nusemtl a\n${quad}`, 'newmtl a\nmap_Kd my tower.jpg\n', (n) =>
    n === 'my tower.jpg' ? jpeg : null,
  );
  expect(r.warnings).toEqual([]);
});
it('warns with the whole name when a spaced texture is missing', () => {
  const r = objToGlb(
    `mtllib m.mtl\nusemtl a\n${quad}`,
    'newmtl a\nmap_Kd my tower.jpg\n',
    () => null,
  );
  expect(r.warnings.join(' ')).toContain('Texture my tower.jpg was not found');
});
```

(If `obj.test.ts` has no reusable quad, define `const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n';` at the top of the file.)

Append to `raw.test.ts`:

```ts
it('imports an OBJ with a spaced texture and does not file its JPEG as a photo', async () => {
  const root = await project();
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n';
  await writeFile(join(src, 'tower.obj'), `mtllib tower.mtl\nusemtl a\n${quad}f 1/1 2/2 3/3 4/4\n`);
  await writeFile(join(src, 'tower.mtl'), 'newmtl a\nmap_Kd tower stack_texture.jpg\n');
  const tex = join(src, 'tower stack_texture.jpg');
  await writeFile(tex, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
  const r = await importRawFiles(root, [join(src, 'tower.obj'), tex], deps());
  const mesh = r.items.find((i) => i.kind === 'mesh');
  expect(mesh?.status).toBe('imported');
  expect(mesh?.message).not.toContain('not found');
  expect(r.items.find((i) => i.file === 'tower stack_texture.jpg')?.status).toBe('skipped');
  expect(r.manifest.layers.some((l) => l.kind === 'photos')).toBe(false);
});
```

(Add `mkdir` to the `node:fs/promises` import of `raw.test.ts`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run packages/project/src/builder/mtl.test.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/raw.test.ts`
Expected: FAIL (`./mtl` does not exist; the OBJ warning names `tower.jpg`; the JPEG is imported as a photo).

- [ ] **Step 3: Write `mtl.ts`**

```ts
/**
 * Texture statements of a Wavefront material file (`map_Kd`, `map_Bump`, `bump`, `disp`, ...):
 * options first, then the file name, which may hold spaces (Pix4D writes
 * `map_Kd <project name>_texture.jpg`).
 */

/** Options and how many values each takes; `-o`, `-s` and `-t` take one to three numbers. */
const OPTION_ARGS: Readonly<Record<string, number>> = {
  '-blendu': 1,
  '-blendv': 1,
  '-bm': 1,
  '-boost': 1,
  '-cc': 1,
  '-clamp': 1,
  '-imfchan': 1,
  '-mm': 2,
  '-o': 3,
  '-s': 3,
  '-t': 3,
  '-texres': 1,
  '-type': 1,
};
const VECTOR_OPTIONS = new Set(['-o', '-s', '-t']);
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** The file a texture statement names (what follows `map_Kd`), or null when there is none. */
export function mtlMapFile(args: string): string | null {
  let rest = args.trim();
  for (;;) {
    const opt = /^(-[a-z]+)(\s+|$)/i.exec(rest);
    const name = opt?.[1]?.toLowerCase() ?? '';
    const n = OPTION_ARGS[name];
    if (!opt || n === undefined) break;
    rest = rest.slice(opt[0].length);
    for (let i = 0; i < n; i++) {
      const v = /^(\S+)(\s+|$)/.exec(rest);
      if (!v) break;
      // a vector option may give fewer than three numbers: the file name follows
      if (VECTOR_OPTIONS.has(name) && i > 0 && !NUMBER.test(v[1] ?? '')) break;
      rest = rest.slice(v[0].length);
    }
  }
  const file = rest
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\/g, '/');
  return file || null;
}

/** The diffuse textures (`map_Kd`) a material file names, in order, each once. */
export function mtlDiffuseMaps(mtl: string): string[] {
  const out: string[] = [];
  for (const m of mtl.matchAll(/^\s*map_Kd\s+(.+?)\s*$/gm)) {
    const f = mtlMapFile(m[1] ?? '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}
```

- [ ] **Step 4: Use it in `obj.ts`, `modelTextures.ts` and `raw.ts`**

`obj.ts`, in `parseMtl`, replace the `map_Kd` branch:

```ts
    } else if (cur && /^map_Kd\s/.test(t)) {
      const file = mtlMapFile(t.slice(6));
      if (file) cur.map = file;
    }
```

and add `import { mtlMapFile } from './mtl';`.

`modelTextures.ts`: keep `TEXTURE_LINE`, and in `mtlTextures` replace the last-word split with `const file = mtlMapFile(m[1] ?? '');` (import from `./mtl`). Update the doc comment: "as written (options skipped, spaces kept)".

`raw.ts:687`: replace the regex loop with

```ts
for (const n of mtlDiffuseMaps(mtl)) {
  const p = join(dir, n);
  textures.set(n, (await exists(p)) ? new Uint8Array(await readFile(p)) : null);
}
```

`raw.ts:487`: a picture picked with its model is part of the model whatever its type (a Pix4D texture is a JPEG, which would otherwise be filed as a photo). Replace `} else if (isDrawingFile(ext, deps.drawings === true) && textures.has(file)) {` with `} else if (textures.has(file)) {` and keep the branch body.

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run packages/project/src/builder/mtl.test.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/raw.test.ts packages/project/src/builder/drawings.test.ts`
Expected: PASS (`drawings.test.ts:660` still finds `tex/normal.png` behind `-bm 0.5`).

- [ ] **Step 6: Commit**

```bash
git add packages/project/src/builder/mtl.ts packages/project/src/builder/mtl.test.ts packages/project/src/builder/obj.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/modelTextures.ts packages/project/src/builder/raw.ts packages/project/src/builder/raw.test.ts
git commit -F <msg>   # fix(project): keep obj texture names with spaces and skip model textures as photos
```

### Task 2: Up-axis maths in `@aio/geo`

**Files:**

- Create: `packages/geo/src/meshUp.ts`, `packages/geo/src/meshUp.test.ts`
- Modify: `packages/geo/src/index.ts` (add `export * from './meshUp';` beside `./similarity`)

**Interfaces:**

- Produces: `type UpAxis = 'y' | 'z'`; `Z_UP: Mat4`; `IDENTITY: Mat4`; `mulMat4(a, b): Mat4` (column-major, `a × b`); `applyMat4(t, p: Vec3): Vec3`; `placeZUp(at: Vec3): Mat4`; `upAxisOf(t): UpAxis`; `withUpAxis(t, up): Mat4`; `fitModelPlacement(pairs: readonly PointPair[], mode: SimilarityMode, opts: { heightOffset?: number }, up: UpAxis): SimilarityFit` (the fit's `matrix` already contains the up turn).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  Z_UP,
  applyMat4,
  fitModelPlacement,
  mulMat4,
  placeZUp,
  upAxisOf,
  withUpAxis,
} from './meshUp';

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] ?? NaN, 9);
  });

describe('up axis', () => {
  it('turns z up into the scene frame: (x, y, z) to (x, z, -y)', () => {
    expect(applyMat4(Z_UP, [1, 2, 3])).toEqual([1, 3, -2]);
  });
  it('places a z-up model at a local point', () => {
    expect(applyMat4(placeZUp([10, 20, 30]), [1, 2, 3])).toEqual([11, 23, 28]);
  });
  it('reads the up axis back from a transform, scaled and turned about the vertical too', () => {
    expect(upAxisOf(IDENTITY)).toBe('y');
    expect(upAxisOf(Z_UP)).toBe('z');
    const yaw = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 5, 6, 7, 1]; // 90 deg about y, scale 2
    expect(upAxisOf(yaw)).toBe('y');
    expect(upAxisOf(mulMat4(yaw, Z_UP))).toBe('z');
  });
  it('flips the up axis in place and keeps the translation', () => {
    const t = placeZUp([5, 6, 7]);
    const y = withUpAxis(t, 'y');
    close(y, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    close(withUpAxis(y, 'z'), t);
    expect(withUpAxis(t, 'z')).toEqual(t);
  });
  it('a level fit of a z-up model keeps it upright', () => {
    // a tower 10 m tall along model z, moved 100 m east and 50 m north (z -50)
    const src: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 10],
    ];
    const truth = (p: [number, number, number]) => {
      const q = applyMat4(Z_UP, p);
      return [q[0] + 100, q[1], q[2] - 50] as [number, number, number];
    };
    const fit = fitModelPlacement(
      src.map((s) => ({ src: s, dst: truth(s) })),
      'upright',
      {},
      'z',
    );
    expect(upAxisOf(fit.matrix)).toBe('z');
    expect(fit.rms).toBeLessThan(1e-6);
    close(applyMat4(fit.matrix, [0, 4, 10]), truth([0, 4, 10]));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run packages/geo/src/meshUp.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `meshUp.ts`**

```ts
import type { Mat4, Vec3 } from '@aio/schema';
import {
  fitSimilarity3D,
  type PointPair,
  type SimilarityFit,
  type SimilarityMode,
} from './similarity';

/**
 * Which model axis points up. glTF is Y up; Pix4D and survey software write Z up (x east, y north,
 * z up). The answer is never stored: the mesh layer `transform` carries the turn
 * (data-conventions section 1) and `upAxisOf` reads it back.
 */
export type UpAxis = 'y' | 'z';

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Z up to the scene frame (x east, y up, z south): (x, y, z) becomes (x, z, -y). */
export const Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const Z_UP_INV: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** `a × b` for column-major 4x4 matrices (three.js `Matrix4.elements` order). */
export function mulMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  return out;
}

export function applyMat4(t: readonly number[], p: Vec3): Vec3 {
  const e = (i: number) => t[i] ?? 0;
  return [
    e(0) * p[0] + e(4) * p[1] + e(8) * p[2] + e(12),
    e(1) * p[0] + e(5) * p[1] + e(9) * p[2] + e(13),
    e(2) * p[0] + e(6) * p[1] + e(10) * p[2] + e(14),
  ];
}

/** A Z-up model stood upright with its model origin at `at` (local frame). */
export function placeZUp(at: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, at[0], at[1], at[2], 1];
}

/** The model axis the transform turns closest to scene up: `z` when model z points up. */
export function upAxisOf(t: readonly number[]): UpAxis {
  const y = t[5] ?? 0;
  const z = t[9] ?? 0;
  return z > Math.max(y, 0) ? 'z' : 'y';
}

/** The transform with the model turned to `up` about its own origin; everything else kept. */
export function withUpAxis(t: readonly number[], up: UpAxis): Mat4 {
  if (upAxisOf(t) === up) return [...t];
  return mulMat4(t, up === 'z' ? Z_UP : Z_UP_INV);
}

/**
 * Point-pair fit for a model whose up axis is `up`: the pairs' model points are turned upright
 * first, so a Level fit (turn about the vertical only) keeps a Z-up model standing; the fit's
 * matrix includes the turn.
 */
export function fitModelPlacement(
  pairs: readonly PointPair[],
  mode: SimilarityMode,
  opts: { heightOffset?: number },
  up: UpAxis,
): SimilarityFit {
  if (up === 'y') return fitSimilarity3D(pairs, mode, opts);
  const f = fitSimilarity3D(
    pairs.map((p) => ({ ...p, src: applyMat4(Z_UP, p.src) })),
    mode,
    opts,
  );
  return { ...f, matrix: mulMat4(f.matrix, Z_UP) };
}
```

Check before exporting that `@aio/geo` has no other `IDENTITY`, `applyMat4` or `mulMat4` export (`rg "export (const|function) (IDENTITY|applyMat4|mulMat4)" packages/geo/src`); rename to `MAT4_IDENTITY` if one exists.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run packages/geo/src/meshUp.test.ts packages/geo/src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/geo/src/meshUp.ts packages/geo/src/meshUp.test.ts packages/geo/src/index.ts
git commit -F <msg>   # feat(geo): read and flip a model's up axis in its transform
```

### Task 3: Stand Z-up OBJ exports up and place them

**Files:**

- Create: `packages/project/src/builder/objPlacement.ts`, `packages/project/src/builder/objPlacement.test.ts`
- Modify: `packages/project/src/builder/obj.ts` (`objToGlb` options and result), `packages/project/src/builder/raw.ts:672-712` (mesh branch)
- Test: `packages/project/src/builder/obj.test.ts`, `packages/project/src/builder/raw.test.ts`

**Interfaces:**

- Consumes: `placeZUp`, `projectToLocal`, `fromWgs84`, `toWgs84`, `IDENTITY` from `@aio/geo` (Task 2); `mtlDiffuseMaps` (Task 1); `epsgFromPrj` from `./tiff`.
- Produces: `objToGlb(objText, mtlText, loadFile, opts?: { shift?: (b: ObjBounds) => Vec3 }): ObjResult` where `ObjResult` gains `bounds: ObjBounds` (raw vertex bounds, before the shift) and `shift: Vec3`; `interface ObjBounds { min: Vec3; max: Vec3 }`; `findPix4dOffset(objPath): Promise<Pix4dOffset | null>`; `looksProjected(b): boolean`; `objShift(pix4d, b): Vec3`; `objPlacement(o): ObjPlacement` with `ObjPlacement = { up: UpAxis; transform: Mat4; note: string | null; warnings: string[] }`.

- [ ] **Step 1: Write the failing tests**

`objPlacement.test.ts`:

```ts
import { applyMat4, projectToLocal } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPix4dOffset,
  looksProjected,
  objPlacement,
  objShift,
  parseOffsetXyz,
} from './objPlacement';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-objplace-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ORIGIN: Vec3 = [500_000, 3_200_000, 20];

/** A Pix4D folder layout with the offset file; returns the OBJ path. */
async function pix4d(offset = '530000 3200000 12\n'): Promise<string> {
  const mesh = join(dir, 'tower', '2_densification', '3d_mesh');
  const params = join(dir, 'tower', '1_initial', 'params');
  await mkdir(mesh, { recursive: true });
  await mkdir(params, { recursive: true });
  await writeFile(join(params, 'tower_offset.xyz'), offset);
  return join(mesh, 'tower_simplifiedmesh.obj');
}

describe('Pix4D offset', () => {
  it('reads "E N H"', () => {
    expect(parseOffsetXyz('243 3178 97\n')).toEqual([243, 3178, 97]);
    expect(parseOffsetXyz('1 2')).toBeNull();
    expect(parseOffsetXyz('a b c')).toBeNull();
  });
  it('finds the offset two folders above the mesh folder', async () => {
    const obj = await pix4d();
    expect(await findPix4dOffset(obj)).toEqual({
      offset: [530000, 3200000, 12],
      file: 'tower_offset.xyz',
    });
  });
  it('finds nothing for an OBJ outside a Pix4D layout', async () => {
    expect(await findPix4dOffset(join(dir, 'loose.obj'))).toBeNull();
  });
});

describe('placement', () => {
  const small = { min: [-5, -5, 0] as Vec3, max: [5, 5, 40] as Vec3 };
  it('stands a Pix4D export up at its offset', () => {
    const p = objPlacement({
      pix4d: { offset: [530000, 3200000, 12], file: 'tower_offset.xyz' },
      bounds: small,
      shift: [0, 0, 0],
      origin: ORIGIN,
      epsg: 32639,
    });
    expect(p.up).toBe('z');
    // the model's top (0, 0, 40) is 40 m above the offset in the scene
    expect(applyMat4(p.transform, [0, 0, 40])).toEqual(
      projectToLocal([530000, 3200000, 52], ORIGIN),
    );
    expect(p.note).toContain('Z up');
  });
  it('takes map grid coordinates as z up and stores them shifted by their centre', () => {
    const b = { min: [499_990, 3_199_990, 15] as Vec3, max: [500_010, 3_200_010, 60] as Vec3 };
    expect(looksProjected(b)).toBe(true);
    const shift = objShift(null, b);
    expect(shift).toEqual([500_000, 3_200_000, 38]);
    const p = objPlacement({ pix4d: null, bounds: b, shift, origin: ORIGIN, epsg: 32639 });
    const v: Vec3 = [500_010, 3_199_990, 60];
    const stored: Vec3 = [v[0] - shift[0], v[1] - shift[1], v[2] - shift[2]];
    expect(applyMat4(p.transform, stored)).toEqual(projectToLocal(v, ORIGIN));
  });
  it('keeps a small local model y up with no transform', () => {
    expect(looksProjected(small)).toBe(false);
    const p = objPlacement({
      pix4d: null,
      bounds: small,
      shift: [0, 0, 0],
      origin: ORIGIN,
      epsg: 1,
    });
    expect(p.up).toBe('y');
    expect(p.transform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(p.note).toBeNull();
  });
});
```

Append to `obj.test.ts`:

```ts
it('reports the raw bounds and stores the vertices minus the shift', () => {
  const far = 'v 500000 3200000 10\nv 500002 3200000 10\nv 500000 3200002 12\nf 1 2 3\n';
  const r = objToGlb(far, null, () => null, { shift: () => [500000, 3200000, 10] });
  expect(r.bounds).toEqual({ min: [500000, 3200000, 10], max: [500002, 3200002, 12] });
  expect(r.shift).toEqual([500000, 3200000, 10]);
  // the GLB's POSITION accessor max is small: the shift was taken off before float32
  const json = JSON.parse(
    new TextDecoder().decode(
      r.glb.subarray(20, 20 + new DataView(r.glb.buffer, r.glb.byteOffset).getUint32(12, true)),
    ),
  ) as { accessors: { max?: number[] }[] };
  expect(Math.max(...json.accessors.flatMap((a) => a.max ?? []))).toBeLessThanOrEqual(2);
});
```

Append to `raw.test.ts` (uses `fromWgs84`, `ORIGIN`, `project()`; add `mkdir` if Task 1 did not):

```ts
it('stands a Pix4D OBJ export up and places it by its offset', async () => {
  const root = await project();
  const mesh = join(dir, 'tower', '2_densification', '3d_mesh');
  const params = join(dir, 'tower', '1_initial', 'params');
  await mkdir(mesh, { recursive: true });
  await mkdir(params, { recursive: true });
  const off = [ORIGIN[0] + 300, ORIGIN[1] - 200, 12];
  await writeFile(join(params, 'tower_offset.xyz'), `${off.join(' ')}\n`);
  const obj = join(mesh, 'tower.obj');
  await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 0 10\nf 1 2 3\n');
  const r = await importRawFiles(root, [obj], deps());
  const layer = r.manifest.layers.find((l) => l.kind === 'mesh');
  expect(layer?.kind === 'mesh' ? layer.transform : []).toEqual([
    1,
    0,
    0,
    0,
    0,
    0,
    -1,
    0,
    0,
    1,
    0,
    0,
    300,
    12 - ORIGIN[2],
    200,
    1,
  ]);
  expect(r.items[0]?.message).toContain('Pix4D export: stood upright (Z up)');
});
it('leaves a small OBJ outside a Pix4D layout as it is', async () => {
  const root = await project();
  const obj = join(dir, 'pad.obj');
  await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const r = await importRawFiles(root, [obj], deps());
  const layer = r.manifest.layers.find((l) => l.kind === 'mesh');
  expect(layer?.kind === 'mesh' ? layer.transform : []).toEqual([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  expect(r.items[0]?.message).toContain('Up axis');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/project/src/builder/objPlacement.test.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/raw.test.ts`
Expected: FAIL (module missing; `bounds` undefined; identity transform on the Pix4D export).

- [ ] **Step 3: `objToGlb` options and result (`obj.ts`)**

Add to the exports:

```ts
export interface ObjBounds {
  min: Vec3;
  max: Vec3;
}
```

(import `type Vec3` from `@aio/schema`), add `bounds: ObjBounds; shift: Vec3;` to `ObjResult`, and give `objToGlb` a fourth parameter `opts: { shift?: (b: ObjBounds) => Vec3 } = {}`. After the parse loop (before `const nv = ...`):

```ts
const lo: Vec3 = [Infinity, Infinity, Infinity];
const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i + 2 < v.length; i += 3) {
  const x = v[i] ?? 0;
  const y = v[i + 1] ?? 0;
  const z = v[i + 2] ?? 0;
  if (x < lo[0]) lo[0] = x;
  if (y < lo[1]) lo[1] = y;
  if (z < lo[2]) lo[2] = z;
  if (x > hi[0]) hi[0] = x;
  if (y > hi[1]) hi[1] = y;
  if (z > hi[2]) hi[2] = z;
}
const bounds: ObjBounds = { min: lo, max: hi };
// map grid coordinates lose centimetres in float32: the caller's shift is taken off first
const s: Vec3 = v.length ? (opts.shift?.(bounds) ?? [0, 0, 0]) : [0, 0, 0];
```

In `vertex`, push `(v[vi * 3] ?? 0) - s[0], (v[vi * 3 + 1] ?? 0) - s[1], (v[vi * 3 + 2] ?? 0) - s[2]`. Return `{ glb, triangles, warnings, bounds, shift: s }`. Update the file comment: "Coordinates as given, minus `shift` (the importer stands Z-up exports up through the layer transform, `objPlacement.ts`)."

- [ ] **Step 4: Write `objPlacement.ts`**

```ts
import { IDENTITY, fromWgs84, placeZUp, projectToLocal, toWgs84, type UpAxis } from '@aio/geo';
import type { Mat4, Vec3 } from '@aio/schema';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ObjBounds } from './obj';
import { epsgFromPrj } from './tiff';

/**
 * Where an imported OBJ goes (data-conventions section 1): a Pix4D export (its offset file two
 * folders up) and a model in map grid coordinates are Z up and placed through the layer
 * transform; anything else is taken as Y up and placed by hand (Align, Georeference model).
 */

/** Map grid coordinates: the vertices' centre at least this far from 0 in x or y (metres). */
const GRID_M = 10_000;

export interface Pix4dOffset {
  offset: Vec3;
  file: string;
  /** EPSG of a `.prj` beside the offset file, when there is one. */
  epsg?: number;
}

export interface ObjPlacement {
  up: UpAxis;
  transform: Mat4;
  /** What the import message says about the placement; null for a model placed by hand. */
  note: string | null;
  warnings: string[];
}

/** Pix4D's `<project>_offset.xyz`: "E N H" that the mesh vertices are relative to. */
export function parseOffsetXyz(text: string): Vec3 | null {
  const n = text.trim().split(/\s+/).map(Number);
  if (n.length !== 3 || n.some((v) => !Number.isFinite(v))) return null;
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
}

/**
 * The offset of the Pix4D project an OBJ belongs to: the mesh in
 * `<project>/2_densification/3d_mesh/`, the offset in `<project>/1_initial/params/*_offset.xyz`.
 */
export async function findPix4dOffset(objPath: string): Promise<Pix4dOffset | null> {
  const meshDir = dirname(objPath);
  if (basename(meshDir).toLowerCase() !== '3d_mesh') return null;
  if (basename(dirname(meshDir)).toLowerCase() !== '2_densification') return null;
  const params = join(dirname(dirname(meshDir)), '1_initial', 'params');
  let names: string[];
  try {
    names = await readdir(params);
  } catch {
    return null;
  }
  const file = names.filter((n) => n.toLowerCase().endsWith('_offset.xyz')).sort()[0];
  if (!file) return null;
  const offset = parseOffsetXyz(await readFile(join(params, file), 'utf8'));
  if (!offset) return null;
  const prj = names.find((n) => n.toLowerCase().endsWith('.prj'));
  const epsg = prj ? epsgFromPrj(await readFile(join(params, prj), 'utf8')) : undefined;
  return { offset, file, ...(epsg !== undefined ? { epsg } : {}) };
}

export function looksProjected(b: ObjBounds): boolean {
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  return Math.max(Math.abs(cx), Math.abs(cy)) >= GRID_M;
}

/** What `objToGlb` takes off the vertices: the rounded centre of map grid coordinates, else 0. */
export function objShift(pix4d: Pix4dOffset | null, b: ObjBounds): Vec3 {
  if (pix4d || !looksProjected(b)) return [0, 0, 0];
  const r = (lo: number, hi: number) => Math.round((lo + hi) / 2);
  return [r(b.min[0], b.max[0]), r(b.min[1], b.max[1]), r(b.min[2], b.max[2])];
}

export function objPlacement(o: {
  pix4d: Pix4dOffset | null;
  bounds: ObjBounds;
  shift: Vec3;
  origin: Vec3;
  epsg: number;
}): ObjPlacement {
  if (o.pix4d) {
    const warnings: string[] = [];
    let at = o.pix4d.offset;
    if (o.pix4d.epsg !== undefined && o.pix4d.epsg !== o.epsg) {
      const p = fromWgs84(toWgs84(at, o.pix4d.epsg), o.epsg);
      at = [p[0], p[1], at[2]];
      warnings.push(
        `The export is in EPSG:${String(o.pix4d.epsg)}, the project in EPSG:${String(o.epsg)}: its offset was converted; the turn between the two grids is not applied.`,
      );
    }
    return {
      up: 'z',
      transform: placeZUp(projectToLocal(at, o.origin)),
      note: `Pix4D export: stood upright (Z up) and placed by ${o.pix4d.file}.`,
      warnings,
    };
  }
  if (looksProjected(o.bounds))
    return {
      up: 'z',
      transform: placeZUp(projectToLocal(o.shift, o.origin)),
      note: 'Map grid coordinates: stood upright (Z up) and placed in the project CRS.',
      warnings: [],
    };
  return { up: 'y', transform: [...IDENTITY], note: null, warnings: [] };
}
```

- [ ] **Step 5: Use it in the mesh branch of `raw.ts`**

Before the `if (ext === '.glb')` of the mesh branch declare `let transform: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];` and `let placedNote: string | null = null;` (import `type Mat4`). In the OBJ part:

```ts
const pix4d = await findPix4dOffset(file);
const r = objToGlb(text, mtl, (n) => textures.get(n) ?? null, {
  shift: (b) => objShift(pix4d, b),
});
const placed = objPlacement({
  pix4d,
  bounds: r.bounds,
  shift: r.shift,
  origin: m.origin,
  epsg,
});
transform = placed.transform;
placedNote = placed.note;
await writeFile(join(root, rel), r.glb);
message = [
  `${String(r.triangles)} triangles converted to GLB.`,
  ...placed.warnings,
  ...r.warnings,
].join(' ');
```

Write `transform` into the layer instead of the literal identity, and the item message as:

```ts
          message: [
            message,
            placedNote ?? 'Place it with Align, Georeference model. If it lies on its side, set its Up axis to Z there.',
            placedNote ? 'Fine-tune it with Align, Georeference model.' : null,
          ]
            .filter(Boolean)
            .join(' '),
```

A `.glb` keeps the identity transform and the old message (glTF is Y up by its specification).

- [ ] **Step 6: Run to see them pass**

Run: `pnpm vitest run packages/project/src/builder/objPlacement.test.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/raw.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/project/src/builder/objPlacement.ts packages/project/src/builder/objPlacement.test.ts packages/project/src/builder/obj.ts packages/project/src/builder/obj.test.ts packages/project/src/builder/raw.ts packages/project/src/builder/raw.test.ts
git commit -F <msg>   # fix(project): stand pix4d and map grid obj exports up and place them on import
```

### Task 4: Up axis switch in Georeference model

**Files:**

- Modify: `apps/desktop/src/renderer/builder/AlignModel.tsx` (the fit memo at about line 60, the first `.sec` block after "Fit"), `apps/desktop/src/renderer/shell/Palette.tsx:520-530` (keywords of `builder:align-mesh`)

**Interfaces:**

- Consumes: `fitModelPlacement`, `upAxisOf`, `withUpAxis`, `type UpAxis` from `@aio/geo` (Task 2).

- [ ] **Step 1: Fits keep the up axis**

In `AlignModel.tsx` import `fitModelPlacement, upAxisOf, withUpAxis, type UpAxis` from `@aio/geo` (drop `fitSimilarity3D` from the import). After `const layer = ...`:

```tsx
const up: UpAxis = layer ? upAxisOf(layer.transform) : 'y';
```

In the `fit` memo replace the `fitSimilarity3D(...)` call with

```tsx
        fit: fitModelPlacement(
          pairs,
          mode,
          { heightOffset: layer ? (layer.transform[13] ?? 0) : 0 },
          up,
        ),
```

and add `up` to the memo's dependencies.

- [ ] **Step 2: The switch**

Below the Fit `b-inline` block and its `say` paragraph, in the same `.sec`:

```tsx
          <div className="b-inline">
            <span className="faint">Up axis</span>
            <div className="seg" role="group" aria-label="Up axis">
              {(['y', 'z'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={up === a}
                  disabled={saving}
                  onClick={() => {
                    if (up !== a) void save(withUpAxis(layer.transform, a));
                  }}
                >
                  {a === 'y' ? 'Y up' : 'Z up'}
                </button>
              ))}
            </div>
          </div>
          <p className="say">
            Z up for survey and photogrammetry exports, Y up for most 3D apps. Switching turns the
            model about its own origin.
          </p>
```

`save` already backs up, sets `previous` (Undo) and shows "Saved."; the point pairs stay valid (they are model coordinates).

- [ ] **Step 3: Palette keywords**

In `Palette.tsx`, entry `builder:align-mesh`, add `'up axis'`, `'z up'`, `'y up'`, `'lying down'` to `keywords`.

- [ ] **Step 4: Check**

Run: `pnpm typecheck` and `pnpm lint` (the end to end check is Task 9).
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/AlignModel.tsx apps/desktop/src/renderer/shell/Palette.tsx
git commit -F <msg>   # feat(desktop): switch a model between y up and z up in georeference model
```

### Task 5: Point clouds frame Home and the zoom-out cap

**Files:**

- Modify: `packages/engine/src/stage/Stage.ts:164-175` (fields), `:368-376` (`addContentBounds`), `:1028-1050` (`contentBox`); `packages/engine/src/types.ts:96-104` (`addContentBounds` doc and options); `packages/pointcloud/src/copc.ts:34-46` (`CopcSource.bounds`), `:78-92` (`readCopcSource`); `packages/pointcloud/src/adapter.ts:115-200` (`create`)
- Test: `packages/engine/src/stage/Stage.test.ts`, `packages/pointcloud/src/copc.test.ts`, `packages/pointcloud/src/adapter.test.ts`; add `addContentBounds: () => () => undefined` to the fake handles of `adapter.test.ts`, `changeCloud.test.ts`, `pick.test.ts` (and any other fake `SceneHandle` a pointcloud test builds: `rg "addRaycastProvider: \(\) =>" packages`).

**Interfaces:**

- Produces: `SceneHandle.addContentBounds(bounds, opts?: { always?: boolean; solid?: boolean })`; with `solid` the bounds count like a model for Home, auto-fit, shadows and the zoom-out cap. `CopcSource.bounds?: { min: [n, n, n]; max: [n, n, n] }` (LAS header bounds, file CRS).

- [ ] **Step 1: Write the failing tests**

`Stage.test.ts`, beside `lets always-bounds widen only the camera reach beside a model`:

```ts
it('solid bounds frame like a model, and a hidden cloud leaves the framing to the rest', async () => {
  const { stage, store, resize } = make();
  resize(800, 600);
  store.getState().openProject(project([meshLayer('plant')]));
  await flush();
  const range = stage.controls.maxDistance;
  let shown = true;
  const cloud = new Box3(new Vector3(300, 0, -20), new Vector3(400, 30, 20));
  const off = stage.addContentBounds(() => (shown ? cloud : null), { solid: true });
  expect(stage.contentBounds()?.max.x).toBe(400);
  expect(stage.controls.maxDistance).toBeGreaterThan(range);
  stage.setViewPreset('home');
  expect(stage.saveView().target[0]).toBeGreaterThan(100);
  shown = false;
  stage.contentUpdated();
  // hidden: Home and the bounds follow the model again (the cap may stay held where the
  // camera stands, as `applyDistanceCap` does for a reach that shrinks)
  expect(stage.contentBounds()?.max.toArray()).toEqual([5, 10, 5]);
  off();
  stage.dispose();
});
```

`copc.test.ts`, in `reads the header, the cube and the root hierarchy page`:

```ts
expect(src.bounds).toBeDefined();
for (let k = 0; k < 3; k++) {
  expect(src.bounds?.min[k]).toBeGreaterThanOrEqual(src.cube.min[k] ?? NaN);
  expect(src.bounds?.max[k]).toBeLessThanOrEqual(src.cube.max[k] ?? NaN);
}
```

`adapter.test.ts`: give the shared `source` `bounds: { min: [10, 20, 0], max: [30, 60, 5] }`, let `fakeHandle` record registrations:

```ts
  const bounds: { get: () => Box3 | null; solid: boolean }[] = [];
  // in `handle`:
    addContentBounds: (get: () => Box3 | null, o?: { solid?: boolean }) => {
      const entry = { get, solid: o?.solid === true };
      bounds.push(entry);
      return () => bounds.splice(bounds.indexOf(entry), 1);
    },
  // return { handle, frame, requestRender, frames, bounds };
```

(`import { Box3 } from 'three'`), return `bounds` from `open`, and add:

```ts
it('frames Home by the header bounds in the local frame while shown', async () => {
  const { bounds, layer } = await open(
    { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } },
    [32, 500, 32],
  );
  expect(bounds).toHaveLength(1);
  expect(bounds[0]?.solid).toBe(true);
  // origin E 0, N 64, H 0: x = E, y = H, z = 64 - N
  expect(bounds[0]?.get()?.min.toArray()).toEqual([10, 0, 4]);
  expect(bounds[0]?.get()?.max.toArray()).toEqual([30, 5, 44]);
  layer.setVisible(false);
  expect(bounds[0]?.get()).toBeNull();
  layer.dispose();
  expect(bounds).toHaveLength(0);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/engine/src/stage/Stage.test.ts packages/pointcloud/src/copc.test.ts packages/pointcloud/src/adapter.test.ts`
Expected: FAIL (solid ignored beside a model; `bounds` undefined; no registration).

- [ ] **Step 3: `Stage.ts` and `types.ts`**

Field beside `alwaysBounds`:

```ts
  /** The providers of `boundsProviders` that frame like a model (point clouds), model or not. */
  private readonly solidBounds = new Set<() => Box3 | null>();
```

`addContentBounds(bounds, opts?: { always?: boolean; solid?: boolean })`: add `if (opts?.solid) this.solidBounds.add(bounds);` and in the returned function `this.solidBounds.delete(bounds);`. In `contentBox`, right after the targets loop:

```ts
for (const bounds of this.solidBounds) {
  const b = bounds();
  if (b && !b.isEmpty()) box.union(b);
}
```

and in the "no model or cloud yet" loop skip solid providers (`if (this.solidBounds.has(bounds)) continue;`). In `types.ts` extend the option type and the doc: "With `solid`, the bounds count as content like a model (a point cloud): Home, auto-fit, the shadows and the zoom-out cap include them; return null while hidden."

- [ ] **Step 4: Header bounds and the adapter**

`copc.ts`: add to `CopcSource`

```ts
  /** The points' bounds from the LAS header, file CRS (x east, y north, z up); tighter than `cube`. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
```

and in `readCopcSource` after `cube`: `bounds: { min: [...c.header.min], max: [...c.header.max] },` (copc.js `Header.min`/`max` are `[x, y, z]`; spread them so the worker posts plain arrays).

`adapter.ts`, in `create`: keep a `let box: Box3 | null = null;` (import `Box3` from three). For COPC, after `copc = { url, source, origin }`:

```ts
const b = source.bounds ?? source.cube;
// CRS to the local frame (data-conventions section 1): z = origin N - N
box = new Box3(
  new Vector3(b.min[0] - origin[0], b.min[2] - origin[2], origin[1] - b.max[1]),
  new Vector3(b.max[0] - origin[0], b.max[2] - origin[2], origin[1] - b.min[1]),
);
```

For png-packed: `box = new Box3(new Vector3(...idx.bounds.min), new Vector3(...idx.bounds.max));`. Kit-packed clouds carry no bounds: none. After `m.addLayer(...)`:

```ts
let shown = layer.visible;
const framed = box;
const unframe = framed
  ? handle.addContentBounds(() => (shown ? framed : null), { solid: true })
  : () => undefined;
```

`setVisible: (v) => { shown = v; m.setVisible(layer.id, v); (handle as Partial<{ contentUpdated(): void }>).contentUpdated?.(); }` and `dispose: () => { unframe(); m.removeLayer(layer.id); release(handle, m); }`.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run packages/engine packages/pointcloud`
Expected: PASS (the fakes updated in Step 1 keep the other pointcloud suites green).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/stage/Stage.ts packages/engine/src/stage/Stage.test.ts packages/engine/src/types.ts packages/pointcloud/src
git commit -F <msg>   # fix(pointcloud): point clouds frame home, auto-fit and the zoom-out cap
```

### Task 6: Layer extents and the re-centre core

**Files:**

- Create: `packages/project/src/builder/extents.ts`, `extents.test.ts`, `recentre.ts`, `recentre.test.ts`
- Modify: `packages/project/src/builder/index.ts` (export them)

**Interfaces:**

- Consumes: `projectToLocal` from `@aio/geo` (already there; Task 2's `applyMat4` is not used, so this task does not wait for it); `updateManifestFile` (`./create`); `drawingStemOf` (`./drawingPlacement`).
- Produces: `interface LocalExtent { min: Vec3; max: Vec3 }`; `lasBounds(head: Uint8Array): LocalExtent | null` (file CRS); `glbBounds(json: unknown): LocalExtent | null`; `layerExtent(root, m, layer): Promise<LocalExtent | null>`; `layerExtents(root, m): Promise<{ layerId: string; min: Vec3; max: Vec3 }[]>` (layers without an extent left out); `recentreBlockers(root, m): Promise<string[]>`; `recentreProject(root, at: [number, number]): Promise<{ manifest: ProjectManifest; backup: string }>` (throws `Re-centring is not possible: <blockers>.`).

- [ ] **Step 1: Write the failing tests**

`extents.test.ts`:

```ts
import { encodeGlb } from '../import/glb';
// helpers: mkdtemp dir, createProject(dir, { name: 'Tower', type: 'inspection', epsg: 32639,
// origin: [500000, 3200000, 20], severityTemplate: null }) as in raw.test.ts

/** A 227-byte LAS header with the given bounds. */
function lasHead(min: Vec3, max: Vec3): Uint8Array {
  const b = new Uint8Array(375);
  b.set(new TextEncoder().encode('LASF'), 0);
  const v = new DataView(b.buffer);
  [max[0], min[0], max[1], min[1], max[2], min[2]].forEach((x, i) => {
    v.setFloat64(179 + i * 8, x, true);
  });
  return b;
}

it('reads LAS header bounds and refuses other files', () => {
  expect(lasBounds(lasHead([1, 2, 3], [4, 5, 6]))).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  expect(lasBounds(new Uint8Array(400))).toBeNull();
});

it('gives each placed layer its local extent', async () => {
  const root = await project();
  await writeFile(
    join(root, 'clouds', 'c.copc.laz'),
    lasHead([530000, 3199900, 10], [530100, 3200000, 40]),
  );
  const glb = encodeGlb({
    generator: 't',
    nodes: [{ name: 'm', mesh: 0 }],
    scene: [0],
    meshes: [
      {
        name: 'm',
        primitives: [
          {
            material: 0,
            positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
            normals: new Float32Array(9),
            indices: new Uint32Array([0, 1, 2]),
          },
        ],
      },
    ],
    materials: [{ name: 'a' }],
    images: [],
  });
  await writeFile(join(root, 'models', 'm.glb'), glb);
  const m = await readManifestFile(root);
  m.layers.push(
    {
      kind: 'pointcloud',
      id: 'cloud-c',
      name: 'c',
      visible: true,
      src: { path: 'clouds/c.copc.laz' },
      format: 'copc',
    },
    {
      kind: 'mesh',
      id: 'mesh-m',
      name: 'm',
      visible: true,
      src: { path: 'models/m.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1],
    },
    {
      kind: 'photos',
      id: 'photos',
      name: 'P',
      visible: true,
      items: [
        { id: 'a', src: { path: 'photos/a.jpg' }, pos: [1, 2, 3] },
        { id: 'b', src: { path: 'photos/b.jpg' } },
      ],
    },
  );
  const out = await layerExtents(root, m);
  expect(out).toEqual([
    { layerId: 'cloud-c', min: [30000, -10, 0], max: [30100, 20, 100] },
    { layerId: 'mesh-m', min: [100, 0, 0], max: [102, 3, 0] },
    { layerId: 'photos', min: [1, 2, 3], max: [1, 2, 3] },
  ]);
});
```

(Adapt the `encodeGlb` argument to its real type in `packages/project/src/import/glb.ts` if a field differs.)

`recentre.test.ts`:

```ts
it('a new project with one model and one cloud can be re-centred', async () => {
  const root = await withModelAndCloud(); // a project as above: mesh at x 100, copc cloud
  const m = await readManifestFile(root);
  expect(await recentreBlockers(root, m)).toEqual([]);
  const r = await recentreProject(root, [530050, 3199950]);
  expect(r.manifest.origin).toEqual([530050, 3199950, 20]);
  // the model stays where it was in the CRS: x 100 was E 500100, now 500100 - 530050
  const mesh = r.manifest.layers.find((l) => l.id === 'mesh-m');
  expect(mesh?.kind === 'mesh' ? mesh.transform.slice(12, 15) : []).toEqual([-29950, 0, -50]);
  // photos keep their CRS place too; the cloud (project CRS) needs nothing
  const photos = r.manifest.layers.find((l) => l.id === 'photos');
  expect(photos?.kind === 'photos' ? photos.items[0]?.pos : []).toEqual([-30049, 2, -47]);
});

it('refuses with reasons when the project holds issues or other placed files', async () => {
  const root = await withModelAndCloud();
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [{ id: 'i1' }] }),
  );
  await mkdir(join(root, 'flights'), { recursive: true });
  await writeFile(join(root, 'flights', 'f.json'), '{}');
  const m = await readManifestFile(root);
  const b = await recentreBlockers(root, m);
  expect(b).toEqual(expect.arrayContaining(['1 issue', 'files in "flights"']));
});

it('writes nothing when refused', async () => {
  const root = await withModelAndCloud();
  await mkdir(join(root, 'survey'), { recursive: true });
  await writeFile(join(root, 'survey', 'x.json'), '{}');
  const before = await readFile(join(root, 'manifest.json'), 'utf8');
  await expect(recentreProject(root, [1, 2])).rejects.toThrow(/Re-centring is not possible/);
  expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
});
```

(`withModelAndCloud()` is the setup of the extents test moved into a helper in `recentre.test.ts`; empty folders `createProject` makes, such as `video` and `flights`, do not block.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/project/src/builder/extents.test.ts packages/project/src/builder/recentre.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write `extents.ts`**

```ts
import { projectToLocal } from '@aio/geo';
import type { Layer, ProjectManifest, Vec3 } from '@aio/schema';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const applyMat4 = (t: readonly number[], p: Vec3): Vec3 => {
  const e = (i: number) => t[i] ?? 0;
  return [
    e(0) * p[0] + e(4) * p[1] + e(8) * p[2] + e(12),
    e(1) * p[0] + e(5) * p[1] + e(9) * p[2] + e(13),
    e(2) * p[0] + e(6) * p[1] + e(10) * p[2] + e(14),
  ];
};

/**
 * Where a layer lies, read from its files: an axis-aligned box in the local frame
 * (data-conventions section 1). Used to notice data that lands far from the project origin.
 */
export interface LocalExtent {
  min: Vec3;
  max: Vec3;
}

function boxOf(points: readonly Vec3[]): LocalExtent | null {
  if (points.length === 0) return null;
  const axis = (k: 0 | 1 | 2) => points.map((p) => p[k]);
  const lo = (k: 0 | 1 | 2) => Math.min(...axis(k));
  const hi = (k: 0 | 1 | 2) => Math.max(...axis(k));
  return { min: [lo(0), lo(1), lo(2)], max: [hi(0), hi(1), hi(2)] };
}

function corners(b: LocalExtent): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const r = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, r.bytesRead);
  } finally {
    await fh.close();
  }
}

/** LAS public header bounds: max X at 179, min X 187, max Y 195, min Y 203, max Z 211, min Z 219. */
export function lasBounds(head: Uint8Array): LocalExtent | null {
  if (head.length < 227 || new TextDecoder().decode(head.subarray(0, 4)) !== 'LASF') return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const d = (o: number) => v.getFloat64(o, true);
  return { min: [d(187), d(203), d(219)], max: [d(179), d(195), d(211)] };
}

interface GltfJson {
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

/** The POSITION accessors' bounds of a glTF (node transforms are not applied). */
export function glbBounds(json: unknown): LocalExtent | null {
  const j = json as GltfJson;
  const pts: Vec3[] = [];
  for (const m of j.meshes ?? [])
    for (const p of m.primitives ?? []) {
      const a = j.accessors?.[p.attributes?.POSITION ?? -1];
      if (a?.min && a.max && a.min.length >= 3 && a.max.length >= 3)
        pts.push(
          [a.min[0] ?? 0, a.min[1] ?? 0, a.min[2] ?? 0],
          [a.max[0] ?? 0, a.max[1] ?? 0, a.max[2] ?? 0],
        );
    }
  return boxOf(pts);
}

async function glbJson(file: string): Promise<unknown> {
  const head = await readHead(file, 20);
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (
    head.length < 20 ||
    v.getUint32(0, true) !== 0x46546c67 ||
    v.getUint32(16, true) !== 0x4e4f534a
  )
    return null;
  const all = await readHead(file, 20 + v.getUint32(12, true));
  return JSON.parse(new TextDecoder().decode(all.subarray(20)));
}

export async function layerExtent(
  root: string,
  m: ProjectManifest,
  l: Layer,
): Promise<LocalExtent | null> {
  try {
    if (l.kind === 'mesh' && 'path' in l.src) {
      const b = glbBounds(await glbJson(join(root, l.src.path)));
      return b ? boxOf(corners(b).map((p) => applyMat4(l.transform, p))) : null;
    }
    if (l.kind === 'pointcloud' && 'path' in l.src) {
      if (l.format === 'copc') {
        const b = lasBounds(await readHead(join(root, l.src.path), 227));
        return b ? boxOf(corners(b).map((p) => projectToLocal(p, m.origin))) : null;
      }
      if (l.format === 'png-packed') {
        const idx = JSON.parse(await readFile(join(root, l.src.path), 'utf8')) as {
          bounds?: LocalExtent;
        };
        return idx.bounds ?? null;
      }
      return null;
    }
    if (l.kind === 'photos') return boxOf(l.items.flatMap((p) => (p.pos ? [p.pos] : [])));
    if (l.kind === 'raster' && l.corners) {
      const { tl, tr, bl } = l.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      return boxOf([tl, tr, bl, br]);
    }
  } catch {
    // a file that cannot be read has no extent; the layer itself reports it
  }
  return null;
}

export async function layerExtents(
  root: string,
  m: ProjectManifest,
): Promise<{ layerId: string; min: Vec3; max: Vec3 }[]> {
  const out: { layerId: string; min: Vec3; max: Vec3 }[] = [];
  for (const l of m.layers) {
    const e = await layerExtent(root, m, l);
    if (e) out.push({ layerId: l.id, ...e });
  }
  return out;
}
```

- [ ] **Step 4: Write `recentre.ts`**

```ts
import { projectToLocal } from '@aio/geo';
import type { Layer, ProjectManifest, Vec3 } from '@aio/schema';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateManifestFile } from './create';
import { drawingStemOf } from './drawingPlacement';

/**
 * Moving the project origin (data-conventions section 1). The COPC clouds are in the project CRS
 * and follow by themselves; models, photo places and pictures laid on the ground are in the
 * local frame and are shifted so they stay where they are. Anything else placed against the
 * origin (issues, flights, walks, drawings, survey files, runs, tilesets) refuses the move.
 */
const SHIFTABLE_TOP = new Set([
  'manifest.json',
  'issues.json',
  'thumbnail.jpg',
  'models',
  'clouds',
  'photos',
  'rasters',
  'journal',
  '.trash',
  'report',
]);

function shiftable(l: Layer): boolean {
  if (l.kind === 'mesh' || l.kind === 'photos' || l.kind === 'basemap') return true;
  if (l.kind === 'pointcloud') return l.format === 'copc';
  if (l.kind === 'raster') return l.format === 'image' && drawingStemOf(l) === null;
  return false;
}

export async function recentreBlockers(root: string, m: ProjectManifest): Promise<string[]> {
  const out: string[] = [];
  for (const l of m.layers) if (!shiftable(l)) out.push(`the layer "${l.name}"`);
  try {
    const doc = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as {
      issues?: unknown[];
    };
    const n = doc.issues?.length ?? 0;
    if (n > 0) out.push(`${String(n)} issue${n === 1 ? '' : 's'}`);
  } catch {
    // no issues file: nothing placed there
  }
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (SHIFTABLE_TOP.has(e.name) || e.name.startsWith('manifest.json')) continue;
    if (e.isDirectory()) {
      if ((await readdir(join(root, e.name))).length > 0) out.push(`files in "${e.name}"`);
    } else out.push(`"${e.name}"`);
  }
  return out;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const plus = (p: Vec3, d: Vec3): Vec3 => [r6(p[0] + d[0]), r6(p[1] + d[1]), r6(p[2] + d[2])];

/** The manifest with its origin at `at` (E, N; height kept) and local positions shifted. */
export function recentred(m: ProjectManifest, at: [number, number]): ProjectManifest {
  const origin: Vec3 = [Math.round(at[0]), Math.round(at[1]), m.origin[2]];
  const d = projectToLocal(m.origin, origin);
  const layers = m.layers.map((l): Layer => {
    if (l.kind === 'mesh') {
      const t = [...l.transform];
      t[12] = r6((t[12] ?? 0) + d[0]);
      t[13] = r6((t[13] ?? 0) + d[1]);
      t[14] = r6((t[14] ?? 0) + d[2]);
      return { ...l, transform: t };
    }
    if (l.kind === 'photos')
      return { ...l, items: l.items.map((p) => (p.pos ? { ...p, pos: plus(p.pos, d) } : p)) };
    if (l.kind === 'raster' && l.corners)
      return {
        ...l,
        corners: {
          tl: plus(l.corners.tl, d),
          tr: plus(l.corners.tr, d),
          bl: plus(l.corners.bl, d),
        },
      };
    return l;
  });
  return { ...m, origin, layers };
}

export async function recentreProject(
  root: string,
  at: [number, number],
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, async (m) => {
    const blockers = await recentreBlockers(root, m);
    if (blockers.length > 0)
      throw new Error(`Re-centring is not possible: this project holds ${blockers.join(', ')}.`);
    return { manifest: recentred(m, at) };
  });
  return { manifest: r.manifest, backup: r.backup };
}
```

Export from `builder/index.ts`: `export { glbBounds, lasBounds, layerExtent, layerExtents, type LocalExtent } from './extents';` and `export { recentreBlockers, recentreProject, recentred } from './recentre';`.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run packages/project/src/builder/extents.test.ts packages/project/src/builder/recentre.test.ts`
Expected: PASS. If `createProject` writes another top-level file a new project needs (the test `a new project with one model and one cloud can be re-centred` fails naming it), add that name to `SHIFTABLE_TOP` only when it holds nothing placed against the origin; otherwise say so in the hand-off.

- [ ] **Step 6: Commit**

```bash
git add packages/project/src/builder/extents.ts packages/project/src/builder/extents.test.ts packages/project/src/builder/recentre.ts packages/project/src/builder/recentre.test.ts packages/project/src/builder/index.ts
git commit -F <msg>   # feat(project): layer extents from files and a guarded project re-centre
```

### Task 7: IPC `builder:layerExtents` and `builder:recentre`, journal, docs

**Files:**

- Modify: `packages/schema/src/ipc.ts` (beside `builder:updateLayers`, about line 1492), `apps/desktop/src/main/builder.ts` (after `builderUpdateLayers`), `apps/desktop/src/main/index.ts` (beside `handle('builder:updateLayers', ...)`, about line 1445), `apps/desktop/src/main/journal.ts:982-1000` and its header comment, `apps/desktop/src/preload/index.ts` (channel allowlist), `docs/architecture/data-conventions.md` section 1, `docs/architecture/contract-changes.md`
- Test: `apps/desktop/src/main/builder.test.ts`, `apps/desktop/src/main/journal.test.ts` (the journaled channel list, about line 1006)

**Interfaces:**

- Consumes: `layerExtents`, `recentreBlockers`, `recentreProject` (Task 6).
- Produces (renderer, Task 8): `bridge.call('builder:layerExtents', { projectId })` → `{ ok: true, extents: { layerId, min: Vec3, max: Vec3 }[], recentre: { blockers: string[] } } | { ok: false, error }`; `bridge.call('builder:recentre', { projectId, at: [E, N] })` → `{ ok: true, manifest, backup } | { ok: false, error }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/main/builder.test.ts` (it already has `base`, `writeProject`, `sampleManifest` and `ProjectRegistry`; import `builderLayerExtents` and `builderRecentre` from `./builder`):

```ts
it('answers layer extents and the re-centre blockers, and re-centres an open project', async () => {
  const dir = join(base, 'projects', 'placed');
  await writeProject(dir, sampleManifest({ layers: [] }));
  const registry = new ProjectRegistry();
  const projectId = registry.register(dir);
  const ex = await builderLayerExtents({ projectId }, registry);
  expect(ex).toEqual({ ok: true, extents: [], recentre: { blockers: [] } });
  const r = await builderRecentre({ projectId, at: [245984.4, 3179697.6] }, registry);
  expect(r.ok && r.manifest.origin).toEqual([245984, 3179698, 0]);
  expect(await builderRecentre({ projectId: 'nope', at: [0, 0] }, registry)).toMatchObject({
    ok: false,
  });
});
```

In `journal.test.ts`, add `'builder:recentre'` wherever `'builder:updateLayers'` is listed as a channel diffed after it writes.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run apps/desktop/src/main/builder.test.ts apps/desktop/src/main/journal.test.ts`
Expected: FAIL (functions and channel missing).

- [ ] **Step 3: Schema**

```ts
  /**
   * Where each placed layer lies, read from its files (local frame boxes), and what would stop a
   * re-centre (`builder:recentre`). Layers without an extent are left out. Reads only.
   */
  'builder:layerExtents': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        extents: z.array(z.object({ layerId: z.string().min(1), min: Vec3, max: Vec3 })),
        recentre: z.object({ blockers: z.array(z.string()) }),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Move the project origin to `at` (E, N in the project CRS; height kept) and shift the local
   * positions the manifest holds so nothing moves on the ground (data-conventions section 1).
   * Refused, writing nothing, while the project holds anything else placed against the origin.
   */
  'builder:recentre': {
    request: z
      .object({ projectId: z.string().min(1), at: z.tuple([z.number(), z.number()]) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

- [ ] **Step 4: Main, preload, journal**

`main/builder.ts`:

```ts
export async function builderLayerExtents(
  req: IpcRequest<'builder:layerExtents'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:layerExtents'>> {
  const root = registry.root(req.projectId);
  if (root === undefined) return { ok: false, error: `Project "${req.projectId}" is not open.` };
  try {
    const l = await lib();
    const m = await l.readManifestFile(root);
    return {
      ok: true,
      extents: await l.layerExtents(root, m),
      recentre: { blockers: await l.recentreBlockers(root, m) },
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function builderRecentre(
  req: IpcRequest<'builder:recentre'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:recentre'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then try again.` };
  try {
    const r = await (await lib()).recentreProject(root, req.at);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
```

`main/index.ts`: `handle('builder:layerExtents', (req) => builderLayerExtents(req, registry));` and `handle('builder:recentre', (req) => packageRefusal(req.projectId) ?? builderRecentre(req, registry));`. `preload/index.ts`: `'builder:layerExtents': true, 'builder:recentre': true,` in the allowlist beside `'builder:updateLayers'`. `journal.ts`: add `channel === 'builder:recentre'` to the after-write diff branch (and to its `IpcRequest<...>` union and the header comment list).

- [ ] **Step 5: Docs**

Data-conventions section 1, two bullets after the "Source data in another frame" bullet:

```markdown
- **Imported OBJ files** (14 Oct 2026): a Pix4D export (the OBJ in `<project>/2_densification/3d_mesh/`, a `*_offset.xyz` in `<project>/1_initial/params/`) is Z up with its vertices relative to that offset; an OBJ whose vertex centre lies 10 km or more from 0 is in map grid coordinates, Z up, and is stored minus its rounded centre. Both are stood up and placed through the layer `transform` (`(x, y, z)` to `(x, z, -y)`, then the offset or centre in the local frame); any other OBJ keeps the identity. A model's up axis is not stored: it is the model axis the transform turns closest to +Y (`@aio/geo` `upAxisOf`), and Georeference model flips it there.
- **Moving the origin** (`builder:recentre`, 14 Oct 2026): `origin[0]` and `origin[1]` move, `origin[2]` stays; COPC clouds follow by themselves (project CRS), and the mesh transforms, photo positions and image raster corners in the manifest are shifted by the same amount so nothing moves on the ground. It is refused while the project holds anything else placed against the origin (issues, flights, walks, panoramas, drawings, survey files, photogrammetry runs, tilesets, or any non-empty folder outside `models`, `clouds`, `photos`, `rasters`, `journal`, `.trash` and `report`).
```

Contract row (after the last row, same columns):

```markdown
| 2026-10-14 | IPC additive: `builder:layerExtents` (`{ projectId }` → `{ extents: { layerId, min, max }[], recentre: { blockers } }`, reads only) and `builder:recentre` (`{ projectId, at: [E, N] }` → `{ manifest, backup }`, journaled like `builder:updateLayers`); data-conventions section 1 gains the imported OBJ orientation rule and the origin move | Data from a far source (a Pix4D chimney export and its cloud ~90 km from an origin taken from a handheld camera's GPS) landed out of view with no word; the up axis of Z-up exports needed a home | `@aio/schema`, `@aio/project`, desktop main, preload, renderer | pending founder review |
```

- [ ] **Step 6: Run to see it pass, then the gate**

Run: `pnpm vitest run apps/desktop/src/main/builder.test.ts apps/desktop/src/main/journal.test.ts`, then `pnpm check`.
Expected: PASS, `pnpm check` green.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/ipc.ts apps/desktop/src/main apps/desktop/src/preload/index.ts docs/architecture/data-conventions.md docs/architecture/contract-changes.md
git commit -F <msg>   # feat(desktop): ipc for layer extents and moving the project origin
```

### Task 8: The far notice

**Files:**

- Create: `apps/desktop/src/renderer/builder/farContent.ts`, `farContent.test.ts`, `farSession.ts`, `FarContentNotice.tsx`
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (mount the notice after `<ProjectMapNotice />`), `apps/desktop/src/renderer/App.tsx` (start the watcher beside `stopJobReload`, stop it in the same cleanup), `apps/desktop/src/renderer/shell/Palette.tsx` (command)

**Interfaces:**

- Consumes: `builder:layerExtents`, `builder:recentre` (Task 7); `localToProject` from `@aio/geo`; `workspace` from `@aio/workspace`.
- Produces: `FAR_M = 10_000`; `planGap(a, b)`; `farLayers(extents, older, limitM?)`; `recentreTarget(far, origin)`; `createFarNotice(deps)` store with `check(projectId, fresh: ReadonlySet<string> | 'all')`, `recentre()`, `dismiss()`; `farNotice` instance and `startFarWatch()` in `farSession.ts`; `<FarContentNotice />` (`data-testid="far-content-notice"`).

- [ ] **Step 1: Write the failing tests**

`farContent.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createFarNotice, farLayers, planGap, recentreTarget } from './farContent';

const box = (x: number, z: number, s = 50) =>
  ({ min: [x - s, 0, z - s], max: [x + s, 20, z + s] }) as const;

describe('far rule', () => {
  it('measures plan gaps between boxes, 0 when they overlap', () => {
    expect(planGap(box(0, 0), box(0, 0))).toBe(0);
    expect(planGap(box(0, 0), box(1100, 0))).toBe(1000);
  });
  it('a new layer far from the origin and every older layer is far', () => {
    const ex = [
      { layerId: 'photos', ...box(0, 0) },
      { layerId: 'cloud', ...box(91_000, -2_000) },
    ];
    const far = farLayers(ex, new Set(['photos']));
    expect(far.map((f) => f.layerId)).toEqual(['cloud']);
    expect(far[0]?.distanceM).toBeCloseTo(Math.hypot(90_950, 1_950), 0);
  });
  it('a new section next to an older one is not far, wherever the origin is', () => {
    const ex = [
      { layerId: 'old', ...box(15_000, 0) },
      { layerId: 'new', ...box(16_000, 0) },
    ];
    expect(farLayers(ex, new Set(['old']))).toEqual([]);
  });
  it('two far layers of one site make one notice and one target', () => {
    const ex = [
      { layerId: 'cloud', ...box(30_000, 0) },
      { layerId: 'mesh', ...box(30_020, 10, 5) },
    ];
    const far = farLayers(ex, new Set());
    expect(far.map((f) => f.layerId)).toEqual(['cloud', 'mesh']);
    expect(recentreTarget(far, [500_000, 3_200_000, 20])).toEqual([530_000, 3_200_000]);
  });
});

describe('notice', () => {
  const project = {
    id: 'p',
    root: '/p',
    manifest: {
      origin: [500_000, 3_200_000, 20],
      layers: [
        { kind: 'pointcloud', id: 'cloud', name: 'Cloud' },
        { kind: 'photos', id: 'photos', name: 'Photos' },
      ],
    },
  };
  const deps = (blockers: string[] = []) => {
    const call = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'builder:layerExtents'
          ? {
              ok: true,
              extents: [
                { layerId: 'photos', ...box(0, 0) },
                { layerId: 'cloud', ...box(91_250, 0) },
              ],
              recentre: { blockers },
            }
          : {
              ok: true,
              manifest: { ...project.manifest, origin: [591_250, 3_200_000, 20] },
              backup: 'b',
            },
      ),
    );
    const reopen = vi.fn();
    return { call, reopen, project: () => project };
  };
  it('names the far layer and its distance, and re-centres on request', async () => {
    const d = deps();
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['cloud']));
    // 91,250 m to the box centre, 91,200 m to its near edge
    expect(s.getState().notice?.text).toContain('Cloud lies 91.2 km from the project origin');
    expect(s.getState().notice?.canRecentre).toBe(true);
    await s.getState().recentre();
    expect(d.call).toHaveBeenCalledWith('builder:recentre', {
      projectId: 'p',
      at: [591_250, 3_200_000],
    });
    expect(d.reopen).toHaveBeenCalled();
    expect(s.getState().notice?.text).toContain('Re-centred');
  });
  it('says why re-centring is not offered', async () => {
    const s = createFarNotice(deps(['2 issues']));
    await s.getState().check('p', new Set(['cloud']));
    expect(s.getState().notice?.canRecentre).toBe(false);
    expect(s.getState().notice?.text).toContain('not offered: this project holds 2 issues');
  });
  it('stays quiet when nothing is far', async () => {
    const s = createFarNotice(deps());
    await s.getState().check('p', new Set(['photos']));
    expect(s.getState().notice).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/farContent.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `farContent.ts`**

```ts
import { localToProject } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Data that lands far from the project origin (a cloud in the right place, an origin from a
 * camera's wrong GPS): named in a notice that offers to move the origin there.
 */
export const FAR_M = 10_000;

export interface Extent {
  layerId: string;
  min: readonly number[];
  max: readonly number[];
}
export interface FarLayer {
  layerId: string;
  /** Plan distance from the origin to the layer's box, metres. */
  distanceM: number;
  min: readonly number[];
  max: readonly number[];
}

const gap1 = (aLo: number, aHi: number, bLo: number, bHi: number) =>
  Math.max(0, bLo - aHi, aLo - bHi);

/** Plan (x, z) distance between two boxes; 0 when they overlap in plan. */
export function planGap(a: Omit<Extent, 'layerId'>, b: Omit<Extent, 'layerId'>): number {
  return Math.hypot(
    gap1(a.min[0] ?? 0, a.max[0] ?? 0, b.min[0] ?? 0, b.max[0] ?? 0),
    gap1(a.min[2] ?? 0, a.max[2] ?? 0, b.min[2] ?? 0, b.max[2] ?? 0),
  );
}

/**
 * The layers not in `older` that lie more than `limitM` from the origin and from every older
 * layer, nearest first.
 */
export function farLayers(
  extents: readonly Extent[],
  older: ReadonlySet<string>,
  limitM = FAR_M,
): FarLayer[] {
  const origin = { min: [0, 0, 0], max: [0, 0, 0] };
  const old = extents.filter((e) => older.has(e.layerId));
  return extents
    .filter((e) => !older.has(e.layerId))
    .map((e) => ({ ...e, distanceM: planGap(origin, e) }))
    .filter((e) => e.distanceM > limitM && old.every((o) => planGap(o, e) > limitM))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** The new origin (E, N): the rounded centre of the far layers' boxes. */
export function recentreTarget(far: readonly FarLayer[], origin: Vec3): [number, number] {
  const lo = (k: number) => Math.min(...far.map((f) => f.min[k] ?? 0));
  const hi = (k: number) => Math.max(...far.map((f) => f.max[k] ?? 0));
  const c: Vec3 = [(lo(0) + hi(0)) / 2, 0, (lo(2) + hi(2)) / 2];
  const p = localToProject(c, origin);
  return [Math.round(p[0]), Math.round(p[1])];
}

type Call = (channel: string, req: Record<string, unknown>) => Promise<unknown>;
interface FarProject {
  id: string;
  manifest: { origin: Vec3; layers: readonly { id: string; name: string }[] };
}

export interface FarNoticeState {
  notice: {
    projectId: string;
    text: string;
    canRecentre: boolean;
    target: [number, number] | null;
    busy: boolean;
    done: boolean;
  } | null;
  check(projectId: string, fresh: ReadonlySet<string> | 'all'): Promise<void>;
  recentre(): Promise<void>;
  dismiss(): void;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

export function createFarNotice(deps: {
  call: Call;
  project: () => FarProject | null;
  /** Reopen the project with this manifest: the local frame moved under every layer. */
  reopen: (manifest: unknown) => void;
}): StoreApi<FarNoticeState> {
  return createStore<FarNoticeState>((set, get) => ({
    notice: null,
    async check(projectId, fresh) {
      const p = deps.project();
      if (!p || p.id !== projectId) return;
      const r = (await deps.call('builder:layerExtents', { projectId })) as
        | { ok: true; extents: Extent[]; recentre: { blockers: string[] } }
        | { ok: false; error: string };
      if (!r.ok) return;
      const older = new Set(
        fresh === 'all' ? [] : r.extents.map((e) => e.layerId).filter((id) => !fresh.has(id)),
      );
      const far = farLayers(r.extents, older);
      if (far.length === 0) {
        set({
          notice:
            fresh === 'all'
              ? {
                  projectId,
                  text: `Every layer lies within ${km(FAR_M)} of the project origin.`,
                  canRecentre: false,
                  target: null,
                  busy: false,
                  done: true,
                }
              : null,
        });
        return;
      }
      const name = (id: string) => p.manifest.layers.find((l) => l.id === id)?.name ?? id;
      const lines = far.map(
        (f) => `${name(f.layerId)} lies ${km(f.distanceM)} from the project origin.`,
      );
      const blockers = r.recentre.blockers;
      const why = blockers.length
        ? ` Re-centring is not offered: this project holds ${blockers.join(', ')}.`
        : ' Re-centre the project there, or keep it as it is.';
      set({
        notice: {
          projectId,
          text: `${lines.join(' ')}${why}`,
          canRecentre: blockers.length === 0,
          target: recentreTarget(far, p.manifest.origin),
          busy: false,
          done: false,
        },
      });
    },
    async recentre() {
      const n = get().notice;
      if (!n?.canRecentre || !n.target) return;
      set({ notice: { ...n, busy: true } });
      const r = (await deps.call('builder:recentre', { projectId: n.projectId, at: n.target })) as
        { ok: true; manifest: unknown } | { ok: false; error: string };
      if (!r.ok) {
        set({ notice: { ...n, busy: false, canRecentre: false, text: r.error } });
        return;
      }
      deps.reopen(r.manifest);
      set({
        notice: {
          ...n,
          busy: false,
          done: true,
          canRecentre: false,
          text: `Re-centred: the project origin is now E ${String(n.target[0])}, N ${String(n.target[1])}. The previous manifest is kept as manifest.json.bak.`,
        },
      });
    },
    dismiss() {
      set({ notice: null });
    },
  }));
}
```

Before relying on the `deps.call` shape, check what `bridge.call` returns (`{ ok, value }` around the channel's response, as `NewProjectWizard.tsx` reads it): `farSession.ts` unwraps it so `farContent.ts` sees the channel response.

- [ ] **Step 4: Session, watcher, toast, palette**

`farSession.ts`:

```ts
import { workspace } from '@aio/workspace';
import type { ProjectManifest } from '@aio/schema';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { createFarNotice, type FarNoticeState } from './farContent';

export const farNotice = createFarNotice({
  call: async (channel, req) => {
    const r = await bridge.call(channel as 'builder:layerExtents', req as { projectId: string });
    return r.ok ? r.value : { ok: false, error: r.error };
  },
  project: () => workspace.getState().project,
  reopen: (manifest) => {
    const ws = workspace.getState();
    const p = ws.project;
    if (p) ws.openProject({ ...p, manifest: manifest as ProjectManifest }, ws.issues);
  },
});

export function useFarNotice<T>(selector: (s: FarNoticeState) => T): T {
  return useStore(farNotice, selector);
}

/** Layers added to the open project (an import, a finished conversion) are checked for distance. */
export function startFarWatch(): () => void {
  let seen: { projectId: string; ids: ReadonlySet<string> } | null = null;
  return workspace.subscribe((s) => {
    const p = s.project;
    if (!p) {
      seen = null;
      return;
    }
    const ids = new Set(p.manifest.layers.map((l) => l.id));
    const before = seen?.projectId === p.id ? seen.ids : null;
    seen = { projectId: p.id, ids };
    if (!before) return; // a project just opened is its own baseline
    const fresh = new Set([...ids].filter((id) => !before.has(id)));
    if (fresh.size > 0) void farNotice.getState().check(p.id, fresh);
  });
}
```

(Type the `call` cast properly: if `bridge.call` is generic over channel names, write two small wrappers `layerExtents(projectId)` and `recentre(projectId, at)` instead of the cast, and give `createFarNotice` those two functions in place of `call`; adjust the test's `deps` the same way.)

`FarContentNotice.tsx`:

```tsx
import { Icon } from '@aio/ui';
import { farNotice, useFarNotice } from './farSession';

/** A layer far from the project origin, with "Re-centre project here" and "Keep". */
export function FarContentNotice() {
  const n = useFarNotice((s) => s.notice);
  if (!n) return null;
  return (
    <div className="toast" data-testid="far-content-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>{n.done ? 'Project origin' : 'Far from the project origin'}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label="Dismiss"
          onClick={() => {
            farNotice.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="far-content-text">
        {n.text}
      </div>
      {!n.done && (
        <div className="toast-p acts">
          {n.canRecentre && (
            <button
              type="button"
              className="btn sm primary"
              disabled={n.busy}
              onClick={() => void farNotice.getState().recentre()}
            >
              Re-centre project here
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              farNotice.getState().dismiss();
            }}
          >
            Keep
          </button>
        </div>
      )}
    </div>
  );
}
```

`Toasts.tsx`: import and mount `<FarContentNotice />` after `<ProjectMapNotice />`. `App.tsx`: `const stopFarWatch = startFarWatch();` beside `stopJobReload`, and `stopFarWatch();` in the same cleanup. `Palette.tsx`, beside `builder:align-mesh` (whenever a project is open):

```ts
list.push({
  id: 'builder:check-placement',
  title: 'Check where layers lie against the project origin',
  group: 'Actions',
  icon: 'target',
  keywords: ['origin', 're-centre', 'recenter', 'far', 'placement', 'out of view'],
  run: () => void farNotice.getState().check(ws.project?.id ?? '', 'all'),
});
```

(Match the variable that holds the open project in that part of `Palette.tsx`.)

- [ ] **Step 5: Run to see it pass**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/farContent.test.ts`, then `pnpm typecheck` and `pnpm lint`.
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/builder/farContent.ts apps/desktop/src/renderer/builder/farContent.test.ts apps/desktop/src/renderer/builder/farSession.ts apps/desktop/src/renderer/builder/FarContentNotice.tsx apps/desktop/src/renderer/exports/Toasts.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/shell/Palette.tsx
git commit -F <msg>   # feat(desktop): notice data far from the project origin and offer to re-centre
```

### Task 9: End to end, a Pix4D chimney export

**Files:**

- Modify: `apps/desktop/e2e/builder.spec.ts` (one new test after the first; helpers at the top)

**Interfaces:**

- Consumes: everything above. Uses the spec's own `nextOpenDialog`, `sharp`, `fromWgs84`, the Ctrl+K palette path the first test uses.
- Produces: `writePix4dExport(base, name, offset): Promise<string>` (the OBJ path) for Task 10.

- [ ] **Step 1: Write the test**

```ts
/** A Pix4D folder layout: a 10 m tall Z-up quad with a spaced texture name and its offset file. */
async function writePix4dExport(base: string, name: string, offset: number[]): Promise<string> {
  const mesh = join(base, name, '2_densification', '3d_mesh');
  const params = join(base, name, '1_initial', 'params');
  await mkdir(mesh, { recursive: true });
  await mkdir(params, { recursive: true });
  await writeFile(join(params, `${name}_offset.xyz`), `${offset.join(' ')}\n`);
  const tex = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#b06030' } })
    .jpeg()
    .toBuffer();
  await writeFile(join(mesh, `${name} stack_texture.jpg`), tex);
  await writeFile(
    join(mesh, `${name}.mtl`),
    `newmtl a\nKd 1 1 1\nmap_Kd ${name} stack_texture.jpg\n`,
  );
  const obj = join(mesh, `${name}.obj`);
  await writeFile(
    obj,
    `mtllib ${name}.mtl\nusemtl a\nv -2 0 0\nv 2 0 0\nv 2 0 10\nv -2 0 10\n` +
      'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n',
  );
  return obj;
}

test('a Pix4D export stands up with its texture, and a far one offers to re-centre', async ({
  app,
  win,
  dataRoot,
}) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Tower e2e');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
  const root = join(dataRoot.root, 'projects', 'tower-e2e');
  const o = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { origin: number[] };
  const [oe = 0, on = 0, oh = 0] = o.origin;
  // the export's offset lies 30 km east of the origin
  const offset = [Math.round(oe) + 30_000, Math.round(on), 12];
  const obj = await writePix4dExport(dataRoot.base, 'tower', offset);

  await nextOpenDialog(app, [obj]);
  await win.getByRole('button', { name: 'Import files' }).click();
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 30_000 });
  await expect(panel).toContainText('stood upright (Z up)');
  await expect(panel).not.toContainText('was not found');
  type M = {
    origin: number[];
    layers: { id: string; kind: string; transform?: number[]; src?: { path: string } }[];
  };
  const read = async () => JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as M;
  const mesh = (m: M) => m.layers.find((l) => l.kind === 'mesh');
  const t = mesh(await read())?.transform ?? [];
  expect(t.slice(0, 12)).toEqual([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0]);
  expect(t[12]).toBeCloseTo(offset[0] - oe, 3);
  expect(t[13]).toBeCloseTo(12 - oh, 3);
  // the texture is inside the GLB
  const glb = await readFile(join(root, mesh(await read())?.src?.path ?? ''));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    images?: unknown[];
  };
  expect(json.images).toHaveLength(1);
  await panel.getByRole('button', { name: 'Close' }).click();

  // far from the origin: the notice offers to move it
  const notice = win.getByTestId('far-content-notice');
  await expect(notice).toContainText('lies 30.0 km from the project origin', { timeout: 30_000 });
  await notice.getByRole('button', { name: 'Re-centre project here' }).click();
  await expect(notice).toContainText('Re-centred');
  const after = await read();
  expect(after.origin[0]).toBe(offset[0]);
  expect(Math.abs(mesh(after)?.transform?.[12] ?? NaN)).toBeLessThan(5);

  // the person flips the up axis in Georeference model
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Georeference');
  await win.keyboard.press('Enter');
  const align = win.getByTestId('align-model');
  await expect(align.getByRole('button', { name: 'Z up' })).toHaveAttribute('aria-pressed', 'true');
  await align.getByRole('button', { name: 'Y up' }).click();
  await expect(align).toContainText('Saved.');
  expect(mesh(await read())?.transform?.[5]).toBeCloseTo(1, 6);
});
```

Add `mkdir` to the spec's `node:fs/promises` import. The project folder name follows `slug('Tower e2e')`; if it differs, read it as the first test does.

- [ ] **Step 2: Run it the CI way**

From `apps/desktop`: `pnpm demo:build --quick`, then (PowerShell) `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; npx playwright test e2e/builder.spec.ts --workers=1`.
Expected: all `builder.spec.ts` tests pass; the log prints `[e2e] window 1100 x 720 px at display scale 1`. Add `--repeat-each=3` once to catch timing problems.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/builder.spec.ts
git commit -F <msg>   # test(desktop): e2e for a pix4d export placed upright and a far project re-centred
```

### Task 10 (droppable): survey data over handheld camera GPS

The founder may drop this task; Tasks 1 to 9 stand without it.

**Files:**

- Modify: `packages/schema/src/builder.ts:203-230` (`LayerPatch`), `packages/schema/src/ipc.ts` (`builder:photoGps` response), `packages/project/src/builder/create.ts:185-260` (`patchLayers`), `packages/project/src/builder/photos.ts:44` (`isDronePhoto`), `apps/desktop/src/main/builder.ts:88-118` (`photoGps`), `apps/desktop/src/renderer/builder/NewProjectWizard.tsx:139-170` (`fromPhoto`), `apps/desktop/src/renderer/builder/farContent.ts`, `FarContentNotice.tsx`, `apps/desktop/e2e/builder.spec.ts`, `docs/architecture/contract-changes.md`
- Test: `packages/project/src/builder/raw.test.ts` (patch), `packages/project/src/builder/photos.test.ts`, `farContent.test.ts`

**Interfaces:**

- Consumes: Task 8's store and `farLayers`; Task 9's `writePix4dExport`.
- Produces: `LayerPatch` variant `{ photoPositions: 'clear' }`; `isDronePhoto(meta: PhotoMeta): boolean`; `builder:photoGps` response field `handheld?: boolean`; `FarNoticeState.notice.photoLayers: string[]` and `FarNoticeState.ignorePhotoGps(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`raw.test.ts`, beside `saves a mesh transform after a backup`:

```ts
it('clears the positions of a photos layer and refuses it on other layers', async () => {
  const root = await withGpsPhotos(); // the GPS photo import the existing tests make
  const id = (await readManifest(root)).layers.find((l) => l.kind === 'photos')?.id ?? '';
  const r = await updateLayers(root, [id], { photoPositions: 'clear' });
  const l = r.manifest.layers.find((x) => x.id === id);
  expect(l?.kind === 'photos' && l.items.every((p) => !p.pos && !p.q)).toBe(true);
  await expect(updateLayers(root, ['mesh-m'], { photoPositions: 'clear' })).rejects.toThrow(
    /not photos/,
  );
});
```

`photos.test.ts`:

```ts
it('tells drone photos from other cameras', () => {
  expect(isDronePhoto({ make: 'DJI' })).toBe(true);
  expect(isDronePhoto({ make: 'Hasselblad', dji: { lat: 1, lon: 2 } })).toBe(true);
  expect(isDronePhoto({ make: 'SONY', gps: { lat: 1, lon: 2 } })).toBe(false);
});
```

`farContent.test.ts`:

```ts
it('a far photos layer beside survey data offers to ignore its GPS, not to re-centre', async () => {
  // extents: cloud near the origin (older), photos 91 km away (fresh)
  const s = createFarNotice(depsWith([{ layerId: 'cloud', ...box(0, 0) }, { layerId: 'photos', ...box(91_000, 0) }]));
  await s.getState().check('p', new Set(['photos']));
  expect(s.getState().notice?.canRecentre).toBe(false);
  expect(s.getState().notice?.photoLayers).toEqual(['photos']);
  expect(s.getState().notice?.text).toContain("a camera's GPS can be kilometres out");
  await s.getState().ignorePhotoGps();
  expect(call).toHaveBeenCalledWith('builder:updateLayers', { projectId: 'p', layerIds: ['photos'], patch: { photoPositions: 'clear' } });
});
it('after a re-centre on survey data, photos left far away are offered the same', async () => {
  // photos near the old origin, cloud fresh and far; re-centre; the second extents answer has
  // the photos 91 km from the new origin
  ...
  await s.getState().recentre();
  expect(s.getState().notice?.photoLayers).toEqual(['photos']);
});
```

(`depsWith` is Task 8's `deps` with the extents passed in, and the `builder:updateLayers` answer `{ ok: true, manifest, backup }`.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/project/src/builder/raw.test.ts packages/project/src/builder/photos.test.ts apps/desktop/src/renderer/builder/farContent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Schema, project and main**

`builder.ts` `LayerPatch`, a new union member:

```ts
  /** Forget the GPS places of a photos layer (a camera whose GPS is wrong): they stay in Media. */
  z.object({ photoPositions: z.literal('clear') }).strict(),
```

`create.ts` `patchLayers`, before the `'transform' in patch` branch:

```ts
if ('photoPositions' in patch) {
  if (l.kind !== 'photos')
    throw new Error(`"${l.name}" is not photos; only photos have GPS places.`);
  return {
    ...l,
    items: l.items.map((p) => {
      const next = { ...p };
      delete next.pos;
      delete next.q;
      return next;
    }),
  };
}
```

`photos.ts`: `export function isDronePhoto(meta: PhotoMeta): boolean { return DJI_MAKES.test(meta.make ?? '') || meta.dji !== undefined; }` (and use it in `photoLens`). `ipc.ts` `builder:photoGps` success object: `/** Not a drone photo: its GPS may come from a linked phone and be kilometres out. */ handheld: z.boolean().optional(),`. `main/builder.ts` `photoGps`: `...((await lib()).isDronePhoto(meta) ? {} : { handheld: true }),` (export `isDronePhoto` from `builder/index.ts` through `./photos`, already `export *`).

- [ ] **Step 4: Wizard hint and notice**

`NewProjectWizard.tsx` `fromPhoto`, append to the note string when `g.handheld`:

```ts
${g.handheld ? " Not a drone photo: a camera's GPS (often from a linked phone) can be kilometres out. A drone photo or a typed survey coordinate is safer." : ''}
```

`farContent.ts`: add `photoLayers: string[]` to the notice; in `check`, when every far layer is a photos layer and at least one older layer is not photos, set `canRecentre: false`, `photoLayers: far ids`, text `<lines> These photos are far from the survey data: a camera's GPS can be kilometres out. Ignore their GPS to keep them in Media without a place.`; when some far layer is not photos and every older placed layer is photos, append ` Only photos placed this project so far; survey data is the better place for the origin.`. Add `ignorePhotoGps()` (calls `builder:updateLayers` with `{ photoPositions: 'clear' }` for `photoLayers`, then `reopen`, then `done` with `GPS places of the photos were cleared; they stay in Media.`). After a successful `recentre()`, run the photo rule once more with `older` = the non-photo layers and `fresh` = the photo layers, so photos left far away get the offer. The layer kind comes from `deps.project().manifest.layers` (add `kind` to `FarProject`). `FarContentNotice.tsx`: an "Ignore their GPS" button when `photoLayers.length > 0`.

- [ ] **Step 5: End to end**

Append to `builder.spec.ts`:

```ts
test('camera photos far from the survey data can drop their GPS', async ({ app, win, dataRoot }) => {
  // wizard with the typed origin as in the Pix4D test; then a Sony photo 40 km away and the
  // Pix4D export at the origin
  ...
  const photo = join(dataRoot.base, 'DSC00001.JPG');
  const far = toWgs84([oe + 40_000, on, 30], 32639);
  await writeFile(photo, withExif({ make: 'SONY', lat: far[1], lon: far[0], alt: 30, focal35: 35, width: 64, height: 48 }, jpeg));
  const obj = await writePix4dExport(dataRoot.base, 'tower', [Math.round(oe), Math.round(on), 12]);
  await nextOpenDialog(app, [obj]);
  // import the model first (older), then the photo (fresh)
  ...
  const notice = win.getByTestId('far-content-notice');
  await expect(notice).toContainText("a camera's GPS can be kilometres out", { timeout: 30_000 });
  await notice.getByRole('button', { name: 'Ignore their GPS' }).click();
  await expect(notice).toContainText('stay in Media');
  const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { layers: { kind: string; items?: { pos?: number[] }[] }[] };
  expect(m.layers.find((l) => l.kind === 'photos')?.items?.every((p) => !p.pos)).toBe(true);
});
```

(Fill the `...` with the wizard and import steps of the Task 9 test: same calls, a second `nextOpenDialog` and Import for the photo.)

- [ ] **Step 6: Contract row**

```markdown
| 2026-10-14 | `LayerPatch` gains `{ photoPositions: 'clear' }` (photos layers only: removes every item's `pos` and `q`); `builder:photoGps` response gains optional `handheld` (not a drone photo) | Handheld cameras with phone-linked GPS placed photos and an origin ~90 km off; the far notice offers to ignore such GPS, and the wizard warns before such a photo sets the origin | `@aio/schema`, `@aio/project`, desktop main, renderer | pending founder review |
```

- [ ] **Step 7: Run, then the gate and the e2e**

Run the unit tests of Step 2, `pnpm check`, and `builder.spec.ts` the CI way (Task 9, Step 2).
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/schema/src packages/project/src/builder apps/desktop/src docs/architecture/contract-changes.md apps/desktop/e2e/builder.spec.ts
git commit -F <msg>   # feat(desktop): prefer survey data over handheld camera gps for placement
```

---

## Hand-off checks (controller)

- `pnpm check` green; `builder.spec.ts` green the CI way; `node tools/agent/check-public-text.mjs` on this plan and the session note.
- How to test (for the founder): 1. New project with any origin. 2. Import the OBJ of a Pix4D chimney export from its `2_densification/3d_mesh` folder: the import says "stood upright (Z up)", the model stands and shows its texture. 3. When the export lies far from the origin, the "Far from the project origin" notice names the distance: click **Re-centre project here**; the model is in view and Home frames it. 4. Import the point cloud (processing tools installed): it converts, and Home frames the cloud too. 5. Open **Georeference model** (Ctrl+K): Up axis shows Z up; switching to Y up lays it down, Undo restores it. 6. (Task 10) Import the handheld camera photos: the notice offers **Ignore their GPS**.
- Follow-ups not in this plan: a far check when a project is opened (the palette command covers it by hand); turning grid convergence between two CRSs for a Pix4D export in another CRS; `pointcloud.to_copc` still ignores its `origin` parameter.

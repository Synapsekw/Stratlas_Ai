# Remove the original review: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The original review (the delivered HTML viewer hosted as a `legacy` layer) is gone from the app, the importers and new packages, while old projects and delivered packages still open and stockpile volumes keep working.

**Architecture:** The `legacy` layer kind stays in the schema as a retired variant so old manifests parse; every consumer ignores it. The viewer host in the main process and the Review screen are deleted. New stockpile imports keep their grids in `volumes/grids/`; readers keep the `legacy/data/` default.

**Tech stack:** TypeScript, React, Electron, zod, vitest, Playwright.

**Spec:** `docs/plans/2026-10-11-remove-original-review-design.md`

## Global constraints

- Existing projects and packages already delivered still open.
- Nothing on disk is deleted or rewritten for old projects, a re-import included: no importer prunes `legacy/`.
- `Layer` keeps the `legacy` variant; no schema version change; `tools/compat` is untouched.
- `DEFAULT_GRIDS` in `packages/volumetric/src/store.ts` stays `legacy/data/...`.
- No IPC channel is added, changed or removed. `dialog:saveFile` stays.
- The word "review" also names the detections review (shortcut scope `review`, change item `review`): that is another feature and is not touched.
- No client, site or person names in code comments, documents or commit messages (`node tools/agent/check-public-text.mjs <files>`). Importer files are named here by role for that reason.
- Agents of one batch share the worktree: edit only the files of your task, do not commit, do not run repo-wide fixers. The lead commits per task.

## Review focus

1. A project whose manifest holds only a `legacy` layer (and maybe a basemap) opens on Scene with an empty stage, with no error. Test: renderer store test (Task 4) and the new e2e spec (Task 7).
2. A package built from an old stockpile project still carries `legacy/data/` so its volumes open. Test: package plan test (Task 3).
3. A package already delivered, whose manifest has a `legacy` layer and viewer files, still opens. Test: the reference check in `package.ts` does not fail on a `legacy` layer (Task 3); e2e package spec as regression (Task 8).
4. A stockpile source without the viewer HTML but with grids still gets `grids` in `volumes.json`. Test: stockpile importer test (Task 2).
5. A saved setting or deep link that names the removed `review` screen falls back to Scene. Test: renderer store test if such a path exists (Task 4 checks and adds it).

## Execution DAG

```
Batch 1 (parallel, no shared files, dispatched in one message)
  T1 shared packages   packages/ai, packages/ui, packages/schema (comment),
                       packages/workspace (comment), packages/sync (comment),
                       packages/volumetric (tests, README)
  T2 importers         packages/project/src/import, packages/project/README.md
  T3 packaging         packages/project/src/package
  T4 renderer          apps/desktop/src/renderer
  T5 main process      apps/desktop/src/main
  T6 documents         docs/guide, docs/architecture, docs/KNOWN-LIMITS.md

Batch 2 (after batch 1)
  T7 end to end        apps/desktop/e2e, tools/ci/e2e-timings.json   needs T1, T4, T5
  T8 integrate         pnpm check, CI-style e2e runs, finish-task     needs all

Critical path: T4 -> T7 -> T8.
```

Cross-task interfaces:

- T1 removes `openReview` from the app hooks type in `packages/ai/src/tool-kit.ts`; T4 removes the property from `apps/desktop/src/renderer/bootstrap.ts`.
- T1 removes the string key `nav.review` from `packages/ui/src/i18n/en.ts`; T4 removes its only use in `shell/Sidebar.tsx`.
- T3 makes `planPackage` leave `legacy` layers out; T5 updates `apps/desktop/src/main/packages.test.ts`, which packs and serves a viewer file today.
- Type errors that only appear across packages are fixed in T8, not by reaching into another task's files.

Tests per task are listed in each task. End to end: `legacy.spec.ts` deleted, `retired-review.spec.ts` added, `a11y.ts` helper changed; `package.spec.ts` and the stockpile specs run as regression. Contract change: one row in `docs/architecture/contract-changes.md` (T6).

---

### Task 1: Shared packages

**Files:**

- Modify: `packages/ai/src/tools.ts`, `packages/ai/src/analysis-tools.ts`, `packages/ai/src/tool-kit.ts`, `packages/ai/src/analysis-tools.test.ts`, `packages/ai/README.md`
- Modify: `packages/ui/src/tree/model.ts`, `packages/ui/src/tree/model.test.ts`, `packages/ui/src/i18n/en.ts`
- Modify (comments only): `packages/schema/src/layers.ts`, `packages/schema/src/volumes.ts`, `packages/schema/src/ipc.ts`, `packages/workspace/src/captures.ts`, `packages/sync/src/blobs/index.ts`
- Modify: the volumes model test in `packages/volumetric/src/model/` that reads real project grids, `packages/volumetric/README.md`

**Interfaces:** Produces: no `open_original_review` tool, no `openReview` hook, no `nav.review` key; `buildTree` (the tree model) returns no item for a `legacy` layer.

- [ ] Step 1, tests first. In `packages/ui/src/tree/model.test.ts` replace the case that expects an "Original review" item with one that builds the tree for a manifest holding a mesh and a `legacy` layer and expects no item whose `layerKind` is `legacy` and no empty group left behind by it. In `packages/ai/src/analysis-tools.test.ts` delete the `describe('open_original_review', ...)` block and add, next to the test that lists the tool names (or as a new test), `expect(toolNames).not.toContain('open_original_review')` using the registry export the file already uses.
- [ ] Step 2: run `pnpm exec vitest run packages/ui/src/tree packages/ai/src --retry=0`; the new tree case and the tool-name case fail.
- [ ] Step 3: `packages/ui/src/tree/model.ts`: skip `legacy` layers where layers become items (keep the `groupOf` record entry, the type needs it; mark it retired). Keep `NEVER_DATED`. Remove `'nav.review'` from `en.ts`.
- [ ] Step 4: `packages/ai`: delete the `open_original_review` zod schema and `spec(...)` in `tools.ts`, the `define('open_original_review', ...)` block in `analysis-tools.ts` (fix the file header and the section comment), the `openReview` member in `tool-kit.ts`, and `'legacy'` from the layer kind enum of the layer listing tool in `tools.ts`. Update the README row. Check with grep that no tool takes a screen name enum containing `review` for this screen; if one does, remove the value.
- [ ] Step 5: comments. `layers.ts`: above the `legacy` variant, "Retired (11 Oct 2026): the delivered viewer is no longer shown. Kept so manifests and packages written before then still parse; importers no longer write it." `volumes.ts`: the `VolumeGrids` comment says new imports write `volumes/grids/` and that readers use `legacy/data/` when `grids` is absent. `ipc.ts`: the `dialog:saveFile` comment no longer names the legacy viewer. `captures.ts` and `blobs/index.ts`: "retired viewers" wording.
- [ ] Step 6: the volumes model test that reads `legacy/data/piles/...` from a real project folder: read `volumes.json` of that folder, take `grids` (`piles`, `dsm`, `coarse`) and fall back to `legacy/data/piles/{id}.js`, `legacy/data/dsm_{epoch}.js`, `legacy/data/vol.js`; build the paths by replacing `{id}` and `{epoch}`. The test keeps skipping when the real data is absent, as now.
- [ ] Step 7: run `pnpm exec vitest run packages/ui packages/ai packages/schema packages/workspace packages/sync packages/volumetric --retry=0`: all pass. Run `pnpm exec prettier --check` on the files you changed.

### Task 2: Importers

**Files:**

- Modify: `packages/project/src/import/aik.ts`, `aik.test.ts`
- Modify: the stockpile importer and its test (the importer that writes `volumes.json`)
- Modify: the road importer and its test (the importer that defines `LEGACY_DIR`)
- Modify: the plant importer that reports "No legacy viewer layer" (one report line), `packages/project/README.md`

**Interfaces:** Produces: no importer writes under `legacy/` or adds a `legacy` layer; the stockpile importer writes `volumes/grids/piles/{id}.js`, `volumes/grids/dsm_{epoch}.js`, `volumes/grids/vol.js` and `grids: { format: 'vs-kit-js', piles: 'volumes/grids/piles/{id}.js', dsm: 'volumes/grids/dsm_{epoch}.js', coarse: 'volumes/grids/vol.js' }`.

- [ ] Step 1, tests first. Kit importer test: replace the assertions that the viewer HTML and `legacy/photos/...` exist with `expect(existsSync(join(out(), 'legacy'))).toBe(false)` and `expect(manifest.layers.some((l) => l.kind === 'legacy')).toBe(false)`. Stockpile importer test: expect the three `grids` paths above, `existsSync(join(out(), 'volumes/grids/piles/P01.js'))` true, `existsSync(join(out(), 'legacy'))` false, no `legacy` layer; add a case where the source has no viewer HTML but has `data/piles`, `data/dsm_*.js` and `data/vol.js`, and expect `grids` to be written all the same. Road importer test: the layer id list no longer has `road-review`, no `legacy` layer, `existsSync(join(out(), 'legacy'))` false, and `isRoad`-style expectations on the class catalogue stay. Add to one importer test a re-import case: create `legacy/keep.txt` in the output folder before the run and expect it to exist after.
- [ ] Step 2: run `pnpm exec vitest run packages/project/src/import --retry=0`; the changed cases fail.
- [ ] Step 3: kit importer: delete the "Legacy viewer" block (the hard links, the layer, the two report lines), remove `'legacy'` from the prune list, and fix the report line about `legacy/`.
- [ ] Step 4: stockpile importer: delete the viewer copy and the layer; copy `data/piles/*.js` to `volumes/grids/piles/`, `data/dsm_*.js` to `volumes/grids/` and `data/vol.js` to `volumes/grids/vol.js` with the writer's `copy`; write `grids` when at least the pile grids and one site surface grid exist (omit `coarse` when `vol.js` is missing), else warn in the report that volumes cannot be recomputed; keep the PDF and the register going to `report/`; reword the comment above `grids` and the report lines that describe the viewer.
- [ ] Step 5: road importer: delete the "Legacy viewer" block, `writeLegacyOrtho`, `LEGACY_DIR` and its use in the prune list, and the report section about the viewer. Check that nothing else in the file reads what that block wrote.
- [ ] Step 6: The plant importer: drop the report line "No legacy viewer layer ...". README: remove the viewer bullets of the three importers, say where the stockpile grids go, and replace the packaging paragraph about leaving the legacy layer out with "A retired `legacy` layer of an older project is never packed; the grids of a stockpile project travel."
- [ ] Step 7: run `pnpm exec vitest run packages/project/src/import --retry=0`: all pass. Prettier check on changed files.

### Task 3: Packaging

**Files:**

- Modify: `packages/project/src/package/plan.ts`, `plan.test.ts`, `package.ts` (and `package.test.ts` if a case there packs a viewer)

**Interfaces:** Produces: `planPackage(manifest, files, exclude)` with the same signature; a `legacy` layer is always in `excluded`, never in `manifest.layers` or `layers` (the shares) of the result, and its folder's files are not in `members`, except `<folder>/data/` of a layer with `viewer: 'volumetric'`.

- [ ] Step 1, tests first, in `plan.test.ts` (the fixture has a `legacy` layer `legacy` with entry `legacy/OPEN Review.html` and the files `legacy/OPEN Review.html` and `legacy/data/model.js`):

```ts
it('never packs a retired viewer', () => {
  const p = planPackage(manifest(), files, []);
  expect(paths(p)).not.toContain('legacy/OPEN Review.html');
  expect(paths(p)).not.toContain('legacy/data/model.js');
  expect(p.manifest.layers.some((l) => l.kind === 'legacy')).toBe(false);
  expect(p.layers.some((l) => l.kind === 'legacy')).toBe(false);
  expect(p.excluded).toContain('legacy');
});

it('keeps the grids beside a retired stockpile viewer', () => {
  const m = manifest();
  const stockpile = {
    ...m,
    layers: m.layers.map((l) =>
      l.kind === 'legacy' ? { ...l, viewer: 'volumetric' as const } : l,
    ),
  };
  const p = planPackage(stockpile, files, []);
  expect(paths(p)).toContain('legacy/data/model.js');
  expect(paths(p)).not.toContain('legacy/OPEN Review.html');
});
```

Change the existing cases that expect the viewer files in a package or that exclude `legacy` by hand so they say the same thing.

- [ ] Step 2: run `pnpm exec vitest run packages/project/src/package --retry=0`; the new cases fail.
- [ ] Step 3: in `plan.ts`, `ownership` returns a third list `kept` (folder prefixes the layer does not own): for `legacy`, own the entry and its folder as now and, when `layer.viewer === 'volumetric'` and the entry has a folder, add `<folder>/data/` to `kept`. `ownersOf` skips a layer for a path that starts with one of its `kept` prefixes. In `planPackage`, add the ids of `legacy` layers to the excluded set next to the drafts, and build `shares` without `legacy` layers. Update the function comment.
- [ ] Step 4: in `package.ts`, the `legacy` case of the reference list does nothing (`break`), with the comment "retired: a package need not carry the viewer".
- [ ] Step 5: run the package tests: all pass. Prettier check on changed files.

### Task 4: Renderer

**Files:**

- Delete: `apps/desktop/src/renderer/screens/Review.tsx`, `apps/desktop/src/renderer/legacy.ts`, `apps/desktop/src/renderer/legacy.test.ts`
- Modify: `store.ts`, `store.test.ts`, `App.tsx`, `bootstrap.ts`, `player.ts`, `packageModel.ts`, `packageModel.test.ts`, `stageDefault.ts`, `styles.css`, `screens/Welcome.tsx`, `shell/Sidebar.tsx`, `shell/Palette.tsx`, `shell/TitleBar.tsx`, `workspace/StageTools.tsx`, `workspace/CompareScene.tsx`, `workspace/SelectionCard.tsx`, `workspace/timelinePref.test.ts`, `change/SurveyDate.tsx` (all under `apps/desktop/src/renderer`)
- Not modified: `road/model.ts` keeps accepting a `legacy` layer with `viewer: 'road'` as a sign of a road survey; only its comment changes ("a road review imported before 11 Oct 2026").

**Interfaces:** Consumes: no `nav.review` key, no `openReview` hook (Task 1). Produces: the screen union has no `review`.

- [ ] Step 1, tests first. `store.test.ts`: the case "opens a project that only has an original review straight into the review" becomes "opens a project that only holds a retired viewer on Scene" and expects `screen` to be `'scene'`. `packageModel.test.ts`: a share of kind `legacy` in the input gives no group and is not counted. If the store restores a remembered screen or takes one from a link, add a case that the value `'review'` gives `'scene'`.
- [ ] Step 2: run `pnpm exec vitest run apps/desktop/src/renderer --retry=0`; the changed cases fail.
- [ ] Step 3: delete the three files; in `store.ts` remove `'review'` from the screen union and replace `landingScreen(manifest)` with `'scene'`; in `Welcome.tsx` go to `'scene'`; in `App.tsx` remove the route; in `bootstrap.ts` remove `openReview`.
- [ ] Step 4: `Sidebar.tsx`: remove `REVIEW`, `hasReview` and the insertion after Scene. `Palette.tsx`: remove the command "Open the original review", the `legacy` label and the layer hint; a `legacy` layer is not listed among the layers the palette offers. `TitleBar.tsx`: remove the crumb for the screen. `player.ts`: remove the tip. `styles.css`: remove the block under "original review (legacy viewer host)".
- [ ] Step 5: `packageModel.ts`: remove the group and ignore shares of kind `legacy`. `StageTools.tsx`: `Models` is `['mesh']`. `stageDefault.ts`: `legacy` is not 3D content. `CompareScene.tsx`: `legacy` leaves `SECOND_VIEW_DROPS` if nothing else needs it. `SelectionCard.tsx`: the record entry stays for the type with the label "Retired viewer". `SurveyDate.tsx` keeps returning null for it. Adjust `timelinePref.test.ts` only if its expectation changes.
- [ ] Step 6: run `pnpm exec vitest run apps/desktop/src/renderer --retry=0`: all pass. Run `pnpm exec tsc -b` and report errors that come from other tasks' files instead of fixing them. Prettier check on changed files.

### Task 5: Main process

**Files:**

- Delete: `apps/desktop/src/main/protocol/legacy.ts`, `legacy.test.ts`, `shim.ts`, `shim.test.ts`
- Modify: `apps/desktop/src/main/csp.ts` (and its test, or a new `csp.test.ts` case), `protocol/handler.ts`, `protocol/handler.test.ts`, `popup.ts`, `popup.test.ts`, `index.ts`, `packages.test.ts`
- Not modified: `legacyEnv.ts`, `userDataMigration.ts`, `settings.ts`, `appLink.ts` (they are about the product rename, another meaning of "legacy").

**Interfaces:** Produces: `cspForUrl(url: string, appCsp: string): string | null` exported from `csp.ts`; `popupAction` returns only `{ kind: 'external', url }` or `{ kind: 'deny' }`.

- [ ] Step 1, tests first. Move the `cspForUrl` cases to the test of `csp.ts`: Chromium's own pages and a project PDF give `null`; `aio://project/p/legacy/Old%20Review.html` now gives the app policy; everything else as before. `handler.test.ts`: the viewer document case becomes "serves HTML under legacy/ as a plain file": the body equals the file on disk byte for byte (no injected script) and there is no `content-security-policy` header from the handler; a `Range` request on it now answers like any file. `popup.test.ts`: a project file URL gives `{ kind: 'deny' }`; https still gives `external`. `packages.test.ts`: remove the viewer file from the fixture and the assertion that fetches it.
- [ ] Step 2: run `pnpm exec vitest run apps/desktop/src/main --retry=0`; the changed cases fail.
- [ ] Step 3: `csp.ts`: add `cspForUrl` without the legacy branch and fix the file comment. Delete the four files. `handler.ts`: remove `serveLegacyDocument`, both `isLegacyDocument` branches, the import and the comment line.
- [ ] Step 4: `popup.ts`: remove the `viewer` action and reword the comment. `index.ts`: import `cspForUrl` from `./csp`, delete `openViewerWindow` and its branch in the window open handler, reword the clipboard comment to "the app's own copy buttons". Remove imports that are now unused.
- [ ] Step 5: run the main tests: all pass. `pnpm exec tsc -b`, reporting errors from other tasks' files. Prettier check on changed files.

### Task 6: Documents

**Files:**

- Modify: `docs/guide/02-projects.md`, `docs/guide/28-survey-dates.md`, `docs/architecture/data-conventions.md`, `docs/architecture/SPEC.md`, `docs/architecture/contract-changes.md`, `docs/KNOWN-LIMITS.md`

- [ ] Step 1: guide. `02-projects.md`: remove the sentence about a project opening on Original review, the sidebar sentence about it and the whole section "The original review". `28-survey-dates.md`: "An offline basemap in the group stays where it is." and "Offline basemaps never belong to a date and cannot be dragged."
- [ ] Step 2: `data-conventions.md`: the folder list line for `legacy/` reads "kept by projects imported before 11 Oct 2026 (the delivered viewer, no longer shown)"; the paragraph on the `legacy` layer says the kind is retired, still parsed and ignored, and that HTML under `legacy/` gets no special serving; the road paragraph keeps both signs; the grids paragraph says new imports write `volumes/grids/piles/{id}.js`, `volumes/grids/dsm_{epoch}.js`, `volumes/grids/vol.js` and that readers use the `legacy/data/` layout when `grids` is absent; the survey date rule lists "retired viewers".
- [ ] Step 3: `SPEC.md` section 6: add one line at the top, "Removed on 11 October 2026: the legacy host and the original review screen (see `docs/plans/2026-10-11-remove-original-review-design.md`). The rest of this section is history." `KNOWN-LIMITS.md`: delete the line about notes saved in the legacy viewers.
- [ ] Step 4: `contract-changes.md`: one row dated 2026-10-11 in the table's column order: the `legacy` layer kind is retired (still parsed, never shown, never written by importers); `aio://project/<id>/legacy/*.html` is no longer served with shims and its own policy (`protocol/legacy.ts` and `protocol/shim.ts` deleted); the assistant tool `open_original_review` and the `openReview` hook are removed; additive: new stockpile imports keep grids in `volumes/grids/` and name them in `volumes.json` `grids`, the default for a missing `grids` is unchanged; packages no longer carry a `legacy` layer or its viewer files. No IPC change.
- [ ] Step 5: `pnpm exec prettier --write` on the six files, then `node tools/agent/check-public-text.mjs` on them: no names.

### Task 7: End to end

**Files:**

- Delete: `apps/desktop/e2e/legacy.spec.ts`
- Create: `apps/desktop/e2e/retired-review.spec.ts`
- Modify: `apps/desktop/e2e/a11y.ts`, `tools/ci/e2e-timings.json`

- [ ] Step 1: read `legacy.spec.ts` for its fixture (a project folder with a manifest holding one `legacy` layer, `legacy/Legacy Review.html` and data files) and how it starts the app; write `retired-review.spec.ts` with the same fixture and one test: the project opens, the breadcrumb shows Scene, `.sb-nav .nav-item` with the text "Original review" has count 0, the palette (opened the way other specs open it) finds nothing for "original review", the project tree has no row named like the layer, and no `iframe` is on the page.
- [ ] Step 2: delete `legacy.spec.ts`; in `tools/ci/e2e-timings.json` replace its entry with one for the new spec (same number); in `a11y.ts` remove the iframe exclusion and the comment about it.
- [ ] Step 3: from `apps/desktop`: `pnpm exec electron-vite build`, then with `QUADRION_WINDOW_SIZE=1100x700` and `QUADRION_E2E_SWGL=1`: `npx playwright test e2e/retired-review.spec.ts --workers=1 --repeat-each=3`: passes. The window stays off-screen as the config sets it.

### Task 8: Integrate and hand off

- [ ] Step 1: `pnpm check`; fix what only shows across packages.
- [ ] Step 2: `pnpm demo:build --quick`, then one run at a time, CI style, `--workers=1`: `retired-review.spec.ts`, `a11y.spec.ts`, `package.spec.ts`, and the stockpile specs (`volumes-general.spec.ts`, `volumetric-build.spec.ts` and the real-data stockpile spec).
- [ ] Step 3: `node tools/agent/check-public-text.mjs` on the changed documents; commits per task with conventional messages.
- [ ] Step 4: `node tools/agent/finish-task.mjs`, then the hand-off message to the Orchestrator with the contract row called out.

## How to test (for the founder)

1. Open a project that used to show **Original review** in the sidebar: the item is gone and the project opens on Scene.
2. Press the command palette shortcut and type "original": nothing about a review is offered.
3. Open a stockpile project and its volumes: piles, volumes and sections work as before.
4. Build a package of that stockpile project: the list of what to include has no "Original review viewer"; open the package: volumes work.
5. Import a new delivered review: the project has no `legacy` folder and no Original review.

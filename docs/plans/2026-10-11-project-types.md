# Project types in the new project wizard: implementation plan

**Goal:** The new project wizard offers six cards (Survey, Construction, Vertical asset inspection, Confined space inspection, Data fusion, Road). The choice is stored in a new optional manifest field beside the unchanged `type`, an empty project says which data to add first for its type, and nothing else changes by type.

**Architecture:** One additive contract change in `@aio/schema` (`purpose` on the manifest and on the create request). `@aio/project` writes it. The desktop renderer keeps all labels, hints and starter lists in `builder/model.ts` as pure data and functions; the wizard and the empty project hint only render them. Behaviour keeps following `manifest.type`, which no task changes.

**Tech stack:** TypeScript (strict, `exactOptionalPropertyTypes`), zod 4, React, vitest (jsdom for the component test), Playwright on Electron.

**Spec:** `docs/plans/2026-10-11-project-types-design.md`

## Global constraints

- Work only in the worktree `.claude/worktrees/project-types` on `feat/project-types`. Never edit the main checkout or another worktree.
- `ProjectType` keeps exactly its five values. No value is added, removed or renamed.
- No tool, tab or navigation entry is shown or hidden by type or purpose.
- Stage by path, never `git add -A`. Never `git stash`. Never `--no-verify`.
- User-facing text and docs: plain English, no emoji, no em or en dashes, no client, site, tester or person names.
- Heavy commands (check, demo builds, Playwright, commits, `finish-task`) go through the shared one-at-a-time runner.
- If the additive field cannot be added without failing `tools/compat`, drop Task 1's manifest field and Task 2, keep the relabelled cards over the existing values, and say so in the hand-off.

## Review focus

1. A manifest whose `purpose` this build does not know opens, shows what its `type` says and keeps the value on save. Pinned in Task 1 (schema test) and Task 6 (end to end).
2. A manifest without `purpose` parses to exactly what it was (the `tools/compat` round trips). Pinned in Task 1.
3. `type` on disk always matches the purpose's row of the mapping. Pinned in Task 2.
4. Every starter line names only file kinds the import takes today. Pinned in Task 3 (the test reads the extensions out of the lines and compares them with the import's own list).
5. The specs that pick a type card by name still pick exactly one card. Task 6.

## Execution DAG

```
T1 (schema: purpose) ──┬──> T2 (project: write it) ──────────────┐
                       ├──> T3 (renderer model) ──┬──> T4 (wizard) ──┬──> T6 (e2e)
                       │                          └──> T5 (hint) ────┘
                       └──> T7 (docs, contract row) ── needs only T1's names and T3's wording
```

| Batch | Tasks      | Why they can run together                                                              |
| ----- | ---------- | -------------------------------------------------------------------------------------- |
| 1     | T1         | Everything else imports its names                                                      |
| 2     | T2, T3     | Different packages, no shared file                                                     |
| 3     | T4, T5, T7 | `NewProjectWizard.tsx`; `ImportPanel.tsx` and `builder.css`; docs only. No shared file |
| 4     | T6         | Needs the wizard (T4), the hint (T5) and the written manifest (T2) in the built app    |

**Critical path:** T1, T3, T4, T6.

**How it is run:** by one agent, task by task in batch order. The tasks are small and the workstation is shared (one heavy command at a time), so parallel subagents would only queue behind each other.

**Packages touched:** T1 `@aio/schema`; T2 `@aio/project`; T3, T4, T5 `@aio/desktop` (renderer `builder/`); T6 `@aio/desktop` (e2e); T7 docs.

**Contract change:** one, additive: `ProjectManifest.purpose?` and `NewProjectRequest.purpose?`, with `ProjectPurpose`, `PURPOSE_TYPE` and `projectPurpose()`. Row in `docs/architecture/contract-changes.md` (T7), approval "pending founder review".

**End to end specs:** new `apps/desktop/e2e/project-types.spec.ts`; changed `inspection.spec.ts`, `volumetric-build.spec.ts`, `samples.spec.ts` (card names only). `road-builder.spec.ts`, `builder.spec.ts`, `builder-real.spec.ts`, `a11y.spec.ts` and `small-window.spec.ts` need no change: Road keeps its name and the default card still writes `inspection`.

---

### Task 1: `purpose` in the contracts (`@aio/schema`)

**Files:** `packages/schema/src/builder.ts`, `packages/schema/src/manifest.ts`, `packages/schema/src/builder.test.ts`.

- [ ] Tests first, in `builder.test.ts` (`describe('project purpose')`):
  - a manifest without `purpose` parses and has no `purpose` key; one with `purpose: 'confined-space'` keeps it;
  - `purpose: 'tunnel'` (a later build's value) parses, is kept in the parsed manifest, and `projectPurpose()` answers `undefined`;
  - a malformed value (`7`, `'Has Spaces'`) parses and reads as absent;
  - `projectPurpose()` answers each of the six known values;
  - `PURPOSE_TYPE` has exactly the six purposes and maps them to `volumetric`, `fusion`, `inspection`, `inspection`, `fusion`, `road`; every target is a `ProjectType` option;
  - `NewProjectRequest` accepts a known `purpose`, refuses an unknown one, and still parses without it.
- [ ] `builder.ts`: `ProjectPurpose` (`survey`, `construction`, `vertical-asset`, `confined-space`, `data-fusion`, `road`), `PURPOSE_TYPE`, `purpose: ProjectPurpose.optional()` on `NewProjectRequest`, the type export.
- [ ] `manifest.ts`: `purpose` on `ProjectManifest` as a short lower-case name with `.optional().catch(undefined)` (the pattern of `GlobeSettings.style`), and `projectPurpose(manifest)`.
- [ ] Run: `builder.test.ts`, `m11.test.ts`, `tools/compat/corpus.test.mjs`, `tools/compat/m11-additive.test.mjs`, `tools/compat/m10-additive.test.mjs`. All green with no change under `tools/compat`.

### Task 2: the new project carries its purpose (`@aio/project`)

**Files:** `packages/project/src/builder/templates.ts`, `packages/project/src/builder/templates.test.ts`.

- [ ] Tests first: a request with `purpose: 'survey'` and a stale `type: 'fusion'` gives a manifest with `purpose: 'survey'` and `type: 'volumetric'` that parses; a request without `purpose` gives a manifest with its own `type` and no `purpose` key (the existing tests stay as they are).
- [ ] `newProjectManifest`: write `purpose` when the request has one and take `type` from `PURPOSE_TYPE` then.
- [ ] Run: `templates.test.ts`.

### Task 3: cards, labels and starter lists as data (`@aio/desktop` renderer)

**Files:** `apps/desktop/src/renderer/builder/model.ts`, `apps/desktop/src/renderer/builder/model.test.ts`.

- [ ] Tests first:
  - `PROJECT_TYPES` lists the six cards in order, each with a label and a one-line hint without dashes; exactly one card label starts with "Road" and one with "Survey";
  - `defaultTemplateFor` takes the mapped type: the road card gets the road catalogue, every other card the first other one (the existing type-based test stays);
  - `projectKind(manifest)`: the purpose when known; else `survey` for `volumetric`, `road`, `data-fusion` for `fusion`, `inspection` for `inspection`, `twin` for `twin`, `null` without a type; an unknown purpose falls back to the type;
  - `kindLabel` gives "Inspection" and "Digital twin" for the two older kinds;
  - `starterFor(kind)`: three or four lines for every kind, and every file extension a line names is one the import takes (`jpg`, `mp4`, `mov`, `srt`, `glb`, `obj`, GeoTIFF, `las`, `laz`, `e57`, `ply`, `dxf`, LandXML, `12da`).
- [ ] `model.ts`: `WizardForm.type` becomes `purpose`; `PROJECT_TYPES` is keyed by `ProjectPurpose`; `ProjectKind`, `projectKind`, `kindLabel`, `starterFor`.
- [ ] Run: `model.test.ts`.

### Task 4: the wizard offers the six cards (`@aio/desktop` renderer)

**Files:** `apps/desktop/src/renderer/builder/NewProjectWizard.tsx`.

- [ ] The form holds `purpose` (default `vertical-asset`, which writes `inspection`, the default until now); `type` is derived with `PURPOSE_TYPE` for the survey data block, the severity default and the create call; the create call sends both; the review step shows the card's label; one icon per card from the existing icon set.
- [ ] Tests: covered by Task 3 (data) and Task 6 (end to end); the typecheck proves the icon table is complete.

### Task 5: the empty project says what to add first (`@aio/desktop` renderer)

**Files:** `apps/desktop/src/renderer/builder/ImportPanel.tsx`, `apps/desktop/src/renderer/builder/builder.css`, new `apps/desktop/src/renderer/builder/ProjectStarter.test.tsx`.

- [ ] Test first (jsdom): `ProjectStarter` renders the type label and the starter lines for a manifest with a purpose, the older label for one with only a `type`, and nothing for one with neither.
- [ ] `ImportPanel.tsx`: export `ProjectStarter({ manifest })` and render it inside `EmptyProjectHint` (type above the heading, the list under the paragraph, before the button). `builder.css`: the two small rules it needs, in the tokens the hint already uses.
- [ ] Run: `ProjectStarter.test.tsx`.

### Task 6: end to end, the way CI runs it

**Files:** new `apps/desktop/e2e/project-types.spec.ts`; `apps/desktop/e2e/inspection.spec.ts`, `volumetric-build.spec.ts`, `samples.spec.ts`.

- [ ] `project-types.spec.ts`:
  1. the wizard shows the six cards, Vertical asset inspection pressed; pick Confined space inspection; the review step names it; create; `manifest.json` has `type: 'inspection'` and `purpose: 'confined-space'`; the empty project shows the type and its starter list, and Import files is still the button a click reaches;
  2. three projects written by hand into the data folder open: one of type `twin` without a purpose (shows Digital twin), one with a purpose this build does not know (opens, shows what its type says), one without a type (the hint as before, no list).
- [ ] `inspection.spec.ts`: the default card is `/^Vertical asset inspection/`. `volumetric-build.spec.ts`: `/^Survey/`. `samples.spec.ts`: `/^Vertical asset inspection/` and `/^Survey/`.
- [ ] Build the demos (`pnpm demo:build --quick`), then run each of the four specs at 1100 x 700 on the software renderer with `--workers=1`, one at a time. Also run `a11y.spec.ts` (it checks the wizard's first step) and `road-builder.spec.ts` (it picks the Road card).

### Task 7: docs and the contract row

**Files:** `docs/architecture/contract-changes.md`, `docs/guide/08-building-projects.md`, `docs/TESTING.md`, `docs/PRD.md`, `docs/guide/images/new-project.png` (retaken by `guide-shots.spec.ts`, that one shot only).

- [ ] Contract row: "Additive:", what older builds do, "pending founder review".
- [ ] Guide: the six cards and the starter list. TESTING: the type names in P1, P2 and the "one project of each type" line, plus a short check of the new cards. PRD BLD-1: the six types.
- [ ] Run: `pnpm format:check` on the docs, `node tools/agent/check-public-text.mjs` on the two plan files, the guide test (`help/guide.test.ts`).

## After the last task

`pnpm check` green, the specs above green, then `node tools/agent/finish-task.mjs` in the worktree. The hand-off message goes to whoever dispatched this branch; this branch does not merge itself.

## How to test (for the founder)

1. Projects, **New project**. Under **Type** there are six cards: Survey, Construction, Vertical asset inspection (selected), Confined space inspection, Data fusion, Road. Each has one line saying what it is for.
2. Name it, pick **Confined space inspection**, **Next**. Set an origin (**Typed coordinate**, for example `25.1000, 55.2000, 12`), **Next**, **Next**. The summary reads "Type: Confined space inspection". **Create project**.
3. The empty project says "Confined space inspection" above "Add raw data to ..." and lists what to add first. **Import files** works as before.
4. Create one more with **Survey**: the last wizard step has the **Survey data** block, as Volumetric had.
5. Create one with **Road**: it opens in the road workspace, as before.
6. Open any project made before this change: it opens as before. An empty older project shows what its old type says (Inspection, Survey, Road, Digital twin or Data fusion).

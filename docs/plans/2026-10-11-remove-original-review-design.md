# Remove the original review: design

Date: 11 October 2026. Branch: `feat/remove-original-review`.

## What the founder asked for

"Original review" shows up in several projects and is not needed at all: remove it. Of the three depths offered, the founder chose **remove the feature**: every way to reach it goes, the code that hosts it goes, importers stop copying the viewer, existing projects still open, and nothing on disk is touched.

## What it is today

A project imported from a delivered review keeps the delivered HTML viewer as a `legacy` layer. The app shows it read-only in an iframe on the **Original review** screen. It is wired in at these places:

- Renderer: the Review screen, the sidebar item after Scene, the landing rule (a project that holds only a viewer opens on it), the command palette (a command and a layer hint), a row in the project tree, a welcome tip, the "what to include" group when building a package, the selection card label.
- Main process: `aio://project/<id>/legacy/*.html` is served with injected shims (downloads, storage) and a looser content security policy; a plain viewer window opens the PDFs and photos the viewer links with `target="_blank"`.
- Assistant: the `open_original_review` tool and the `openReview` app hook.
- Importers (kit, stockpile, road): copy or hard-link the viewer into `legacy/` and add the `legacy` layer.
- Packaging: the `legacy` layer owns its whole folder; unticking it drops the folder.
- Stockpile volumes: the native volumes workspace reads the pile grids, site surface grids and coarse grids from `legacy/data/`, the path the stockpile importer writes into `volumes.json` (`grids`), and the default when `grids` is absent.

## Hard requirements

1. Existing projects and packages already delivered still open.
2. Nothing on disk is deleted or rewritten for old projects, a re-import included: an old `legacy/` folder stays where it is.
3. The stockpile volumes keep working, in old projects and in new imports.
4. The new grid location is additive: readers keep the `legacy/data/` default.

## Design

### Schema: the layer kind stays, retired

`Layer` keeps the `legacy` variant (`packages/schema/src/layers.ts`), with a comment that it is retired: read so that older manifests and packages parse, never shown, never written by an importer. No schema version change, and the compatibility corpus (`tools/compat`) is untouched.

Consumers ignore the entry one by one. The manifest is not filtered when a project loads, because a manifest sent back for saving would then lose the entry on disk (requirement 2).

One reader stays on purpose: `isRoadProject` still accepts a `legacy` layer with `viewer: 'road'` as a sign of a road survey, beside the road class catalogue, so a road project imported at any time keeps opening the road workspace.

### Renderer (`apps/desktop/src/renderer`)

- Delete `screens/Review.tsx`, `legacy.ts` and its test, and the review block in `styles.css`.
- `store.ts`: the `review` screen leaves the screen union; a project lands on Scene (a read-only package on Welcome, as now).
- `Sidebar.tsx`, `Palette.tsx`, `App.tsx`, `Welcome.tsx`, `bootstrap.ts`, `player.ts`: drop the nav item, the command, the layer hint, the route, the hook and the tip.
- `packageModel.ts`: no "Original review viewer" group; a retired layer is not offered.
- `workspace/StageTools.tsx`, `stageDefault.ts`, `CompareScene.tsx`, `SelectionCard.tsx`, `change/SurveyDate.tsx`: a retired layer is no content: it is not counted as 3D content and has no group. Where a `Record<Layer['kind'], ...>` needs an entry for the type, it stays with a neutral value.

### Shared packages

- `packages/ui`: the tree model gives a `legacy` layer no row; `nav.review` leaves the strings.
- `packages/ai`: `open_original_review` (schema, spec, handler, tests, README row) and the `openReview` hook go; `legacy` leaves the layer kind filter of the layer listing tool.
- `packages/workspace`, `packages/sync`: comments only.

### Main process (`apps/desktop/src/main`)

- Delete `protocol/legacy.ts`, `protocol/shim.ts` and their tests. `cspForUrl` moves to `csp.ts` without the legacy branch: Chromium's own pages and PDFs get no policy, everything else the app policy.
- `protocol/handler.ts`: no special case; an HTML file under `legacy/` is a plain project file served under the app policy, where its inline scripts do not run.
- `popup.ts` and `index.ts`: the viewer window goes (nothing in the app opens a new window); https links still go to the system browser, everything else is refused. The clipboard permission rule stays (the app's own copy buttons use it).
- `dialog:saveFile` stays: exports, the assistant and the accuracy report use it.

### Importers (`packages/project/src/import`)

- Kit importer: no hard links into `legacy/`, no `legacy` layer.
- Road importer: no viewer copy, no plain ortho tiles and basemap for the viewer, no `legacy` layer. The road class catalogue still marks the project as a road survey.
- Stockpile importer: no viewer copy and no `legacy` layer. The grids the volumes need are copied to `volumes/grids/` (`piles/{id}.js`, `dsm_{epoch}.js`, `vol.js`) and `volumes.json` names those paths in `grids`, whenever the source has them (no longer tied to the viewer HTML being present). The PDF report and the register still go to `report/`.
- All three stop pruning `legacy/`, so a re-import leaves an older folder alone.
- Import reports lose their viewer lines.

### Packaging (`packages/project/src/package`)

- A `legacy` layer is always left out of a package, like a draft layer: its entry leaves the package manifest and the files of its folder are not packed.
- One exception keeps requirement 3: for a `viewer: 'volumetric'` layer the `data/` folder beside the viewer is not owned by the layer, so the grids travel with every package. This also fixes today's gap where unticking the viewer dropped the grids.
- The reference check in `package.ts` no longer needs a case that does work for `legacy`.

### Documents

- User guide: `02-projects.md` loses the original review section and mentions; `28-survey-dates.md` loses its two mentions.
- `docs/architecture/data-conventions.md`: the `legacy/` folder and layer are described as retired, the grids paragraph names `volumes/grids/` for new imports and keeps the `legacy/data/` default.
- `docs/architecture/SPEC.md`: one note at section 6 that the legacy host was removed on this date.
- `docs/KNOWN-LIMITS.md`: the line about notes in the viewers goes.
- `docs/architecture/contract-changes.md`: one row (below).
- Package READMEs follow their code.

## Contract and data-layout changes

One row in `contract-changes.md`:

- The `legacy` layer kind is retired: still parsed, never shown, never written by importers.
- `aio://project/<id>/legacy/*.html` is no longer served with shims and its own policy.
- The assistant tool `open_original_review` and the `openReview` app hook are removed.
- Additive: new stockpile imports keep their grids in `volumes/grids/` and say so in `volumes.json` `grids`; the `legacy/data/` default for a missing `grids` is unchanged.
- Packages no longer carry a `legacy` layer or its viewer files.

No IPC channel changes.

## Tests

- Unit: every touched package's tests are changed first to say the new behaviour, then the code follows. New or changed cases: a legacy-only project lands on Scene; the tree has no row for a `legacy` layer; the package plan leaves a `legacy` layer and its files out and keeps a volumetric layer's `data/`; the three importers write no `legacy/` and no `legacy` layer; the stockpile importer writes `volumes/grids/` and the matching `grids`; an HTML under `legacy/` is served unchanged under the app policy; a popup for a project file is refused.
- The volumes model tests that read real project grids take the paths from `volumes.json` with the default, so they pass on an old and on a fresh import.
- End to end: `legacy.spec.ts` is deleted with its timing entry. A new `retired-review.spec.ts` opens a project whose manifest still has a `legacy` layer and viewer files: it lands on Scene, the sidebar and the palette have no Original review, the tree has no row for it. The a11y helper loses the iframe exclusion.
- Regression, run the CI way: the package spec and the stockpile specs.

## Not in scope

- Deleting or migrating `legacy/` folders in existing projects (the purge option, not chosen).
- Removing the `legacy` variant from the schema.
- Renaming `legacy/data/` in existing stockpile projects.

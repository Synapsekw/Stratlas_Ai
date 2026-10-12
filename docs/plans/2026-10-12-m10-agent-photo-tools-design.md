# Agent photo tools and the Globe in the compact profile: design

Date: 12 Oct 2026. Branch `feat/m10-agent-photo-tools`. Plan: `docs/plans/2026-10-12-m10-agent-photo-tools.md`.

## Why

The M10 plan (`docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Integration follow-ups", Agent bullet) asks for two agent tools and one profile change that M10's streams left out:

- `process_photos` (write, asks for approval): start `photo.align` with a quality preset, the way the Builder's **Create maps from photos** dialog does.
- `accuracy_summary` (read): a run's checkpoint and control RMSE and a summary of its ground control table.
- The Globe tools in the compact tool profile. `docs/KNOWN-LIMITS.md` (Globe) says today: "The Globe tools are not in the compact tool profile."

Success: a person can say "make maps from the photos" to the agent, approve the card, and get the same run the dialog would have started (maps start by themselves after alignment); "how accurate is the last run?" answers with the numbers the Accuracy tab shows; and a small local model (compact profile) can list sites and open the Globe.

## What exists

- **Tool catalogue** (`packages/ai/src/tools.ts`): `ToolSpec` = `ToolMeta` (`@aio/schema`) + a zod input; `COMPACT_TOOLS` names the compact profile with short descriptions (at most 100 characters, no dashes, test in `tools.test.ts`, which also caps the compact list at 24). Specs in their own files (`change-tool-specs.ts`, `show-tool-specs.ts`) are spread into `BUILT_IN`.
- **Executors** run in the renderer (`registerRendererTool` / `define` in `tool-kit.ts`). Host-only abilities come in through `AppHooks` (`tool-kit.ts`), registered by the desktop app in `apps/desktop/src/renderer/bootstrap.ts`: `listSites` and `showOnGlobe` are the pattern to follow. Approval follows `risk` (`needsApproval`: `write` and `send` ask).
- **The dialog's start** (`apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx`, `go`): `photo:runs` for the ids taken, `newRunId` (`estimate.ts`), `startAlign` (`actions.ts`, `jobs:start` with `photo.align`), then `photoUi.setDate(run, pickParams(pick))` and, unless ground control comes first, `photoUi.setPending(run, { root, preset, products, ...date })`. `PhotoProcessLayer` (mounted app-wide through `BuilderLayer`) starts the queued products when the alignment job finishes. Defaults: `SIMPLE_DEFAULTS` (`standard`, GNSS `auto`, ground control first off) and `defaultProducts(preset)`. The survey date for a photos layer is `pickSurveyDate(daysOfItems(layer.items), captures, layer.capture)` (`surveyDate.ts`). The disk check is `diskNeed(estimate)` on `photo:estimate`.
- **Reading a run**: IPC `photo:runs` (`PhotoRunSummary[]`, newest first, with an `AccuracySummary`), `photo:readRun` (`PhotoRun` and `AccuracyReport | null`), `photo:readGcp` (`GcpFile | null`). All types are in `packages/schema/src/photogrammetry.ts`.
- **Scripted model** for e2e (`packages/ai/src/scripted.ts`): `#tool <name> <json>` lines in a message make the calls, so no script change is needed.
- **Photo e2e fixtures** (`apps/desktop/e2e/photoPack.ts`): a synthetic photo project with one photos layer and the stand-in pipelines (`e2e/photo-fake`), which write an accuracy report (GNSS only) on alignment.

## Approaches considered

1. **App hooks (recommended).** The `@aio/ai` executors validate input, resolve the photos layer and shape the answer; two new `AppHooks` members do the host work (`processPhotos`, `photoRuns`), implemented in a new desktop module next to the photogrammetry actions and registered in `bootstrap.ts`. Same seam as `listSites` and `showOnGlobe`, unit-testable with fakes on both sides, and `@aio/ai` needs neither the bridge nor the desktop's `photoUi` store.
2. **Bridge calls from `@aio/ai`** (as `change-tools.ts` does with `globalThis.aio`). Works for `accuracy_summary`, but `process_photos` must also queue the products in the desktop's `photoUi` store, which `@aio/ai` cannot reach; the start would then be split over two seams.
3. **Register the tools from the desktop** (as the modelling tools register executors in `modeller/agentTools.ts`). Puts tool logic where it cannot be tested with the shared agent fixtures, and the spec still has to live in `@aio/ai` for main.

Approach 1 is taken.

## Design

### `process_photos` (write, approval, `scope: project`, every window)

Input (strict):

| Field                | Type                                       | Default                                          |
| -------------------- | ------------------------------------------ | ------------------------------------------------ |
| `layer`              | photos layer id or name                    | the project's only photos layer                  |
| `preset`             | `fast`, `standard`, `high` (`PhotoPreset`) | `standard`                                       |
| `gnss`               | `auto`, `rtk`, `standard`, `ignore`        | `auto`                                           |
| `products`           | array of `PhotoProduct`, at least one      | the dialog's default for the preset              |
| `groundControlFirst` | boolean                                    | false (maps start by themselves after alignment) |

The executor (in `@aio/ai`):

1. Needs an open project (`project(ctx)`); a package (player mode) is refused by main's `jobs:start` as today, the refusal comes back as the tool error.
2. Resolves the layer among the manifest's `photos` layers: by id, else by name (case-insensitive). None in the project: "This project has no photos layer. Import photos first, or use Create maps from photos in the Builder to read a folder." Several and none named: an error listing their ids and names. A name that matches nothing: an error listing them.
3. Calls `ctx.app.processPhotos({ layerId, preset, gnss, products, groundControlFirst })`. No hook: "Processing photos is only in the desktop app."
4. Answers `{ run, layer, preset, gnss, products, groundControlFirst, estimate, surveyDate, note }` with the summary `Run <id> started`. `note` says that progress shows in Jobs and under **Create maps from photos**, that the maps come as layers when done (or that ground control comes first), and that `accuracy_summary` reads the result.

The desktop hook (`apps/desktop/src/renderer/photogrammetry/agentHooks.ts`, `agentProcessPhotos`), the dialog's `go` without the dialog:

1. `photo:estimate` for `{ layer }`, the preset and products. A refused estimate is answered as the error; `diskNeed` gives the dialog's disk sentence as the error; an estimate of no time (`minutes[1] === 0`) answers "There are no photos to process in this layer."
2. `photo:runs` for the ids taken, `newRunId(new Date(), taken)`.
3. `startAlign({ root, run, photos: { layer }, preset, gnss })`; an error sentence is thrown as the tool error. The CRS is the project's (the dialog's CRS choice is not offered).
4. The survey date as the dialog picks it automatically: `pickParams(pickSurveyDate(daysOfItems(layer.items), captures, layer.capture))`; `photoUi.setDate(run, date)`, and unless `groundControlFirst`, `photoUi.setPending(run, { root, preset, products, ...date })`.
5. Answers `{ run, estimate: formatMinutes(estimate.minutes), surveyDate }` (`surveyDate`: the existing capture's date, the new day, or null).

It does not open the run panel: the panel is a dialog over the stage and would cover the agent's reply. The person opens it from Jobs or the Builder.

### `accuracy_summary` (read, `scope: project`, every window)

Input (strict): `run` (optional run id; default the newest run that has an accuracy report, else the newest run).

The executor calls `ctx.app.photoRuns.list()` and `ctx.app.photoRuns.read(run)` and answers:

- `run`, `status`, `preset`, `createdAt`, `photos` (`count`, `registered`).
- `accuracy`: null when the run has no report yet (with a `note` naming its status), else `check` and `control` RMSE (`n`, `horizontalM`, `verticalM`, rounded to millimetres), `meanReprojPx`, `gsdCm`, `cameraResiduals` (when present), `basis`: `"ground control"` when control RMSE has points, else `"GNSS only"` (the Accuracy tab's headline).
- `gcp`: null without `gcp.json`, else `{ control, check, disabled, marked }` counts and `points` (at most 30, worst horizontal error first): `id`, `role`, `dxM`, `dyM`, `dzM`, `horizontalM`, `marks`, `used` (from `usedInAdjustment`), joined from the report's points.
- `warnings`: at most 10 of the report's warnings (`code`, `message`).
- `otherRuns`: up to five other runs (`id`, `status`, `createdAt`).

No runs: "No photo runs in this project yet. Use process_photos to start one." A run id that is not there: an error listing the ids. Summary: `Check RMSE 0.031 m horizontal, 0.048 m vertical (5 points)`, else `GNSS only`, else `<run>: <status>, no accuracy report yet`.

The desktop hook `photoRuns` (same module): `list` is `photo:runs` for the open project; `read` is `photo:readRun` and `photo:readGcp` in parallel, answered as `{ run, accuracy, gcp }`. Bridge refusals become `ToolError`s with main's sentence.

### The compact profile

`COMPACT_TOOLS` gains four entries:

- `list_sites`: "List the sites of the project library on the Globe."
- `show_on_globe`: "Open the Globe at a site. Ends your reply: the panel closes."
- `process_photos`: "Make maps from a photos layer. Asks for approval first."
- `accuracy_summary`: "How accurate a photo run is: checkpoint RMSE and ground control."

The compact cap in `tools.test.ts` goes from 24 to 28.

### Errors and edge cases

- Approval: `risk: 'write'` makes the panel ask; nothing runs on a refusal (existing behaviour, `approvalFor`).
- A second `process_photos` while a run aligns starts a second run with its own id (the dialog allows that too); `newRunId` keeps the ids apart.
- Processing impossible on this computer (`processingVerdict` in main) or no pipeline pack: `jobs:start` refuses with its sentence, which the tool returns.
- The project changes while the hook runs: the hook reads the project once at the start and passes its root, like the dialog.

## Contract changes

None. No `@aio/schema` change: `ToolMeta`, `PhotoPreset`, `PhotoProduct`, `PhotoRunSummary`, `PhotoRun`, `AccuracyReport`, `GcpFile` and the `photo:*` and `jobs:start` channels are used as they are. `AppHooks` (in `@aio/ai`, not a contract) gains two optional members.

## Testing

- Unit (`@aio/ai`): `photo-tools.test.ts` for both executors (defaults, layer resolution, errors, answer shape, summaries, ordering and caps); `tools.test.ts` for the compact profile and risks.
- Unit (`@aio/desktop`): `agentHooks.test.ts` with the bridge and stores mocked as in `actions.test.ts` (estimate, disk refusal, run id, `jobs:start` parameters, survey date, pending products, ground control first, readers).
- e2e: a new `apps/desktop/e2e/agent-photo.spec.ts` on the photo fixtures and the scripted model: approve `process_photos`, the run aligns on the stand-ins and its maps come back as layers, then `accuracy_summary` answers "GNSS only" for that run. `agent-eval.cases.ts` lists `accuracy_summary` among the read tools.

## Decisions taken (founder to confirm)

The founder was not available while this was scoped; each answer below is the recommended option.

1. **Photos source: a photos layer only, not folders.** A model guessing folder paths is a poor fit for an approved write; folders stay in the dialog. A project without a photos layer is told to import photos first.
2. **The maps start by themselves**, as in the dialog's simple flow: `products` default to the dialog's choice for the preset, and `groundControlFirst` (default off) holds them for ground control marking.
3. **The survey date is picked automatically** the way the dialog does it (the layer's date, else the photos' main day, existing or new). The agent does not offer a date choice or a CRS choice.
4. **The run panel does not open** when the agent starts a run; the reply says where progress shows.
5. **A disk shortfall refuses the start** with the dialog's sentence, and the answer carries the time estimate so the agent can say how long it takes.
6. **All four tools join the compact profile** (`list_sites`, `show_on_globe`, `process_photos`, `accuracy_summary`); approval keeps the write safe for small models.
7. **No system prompt change**: the tool descriptions carry the guidance.
8. **`accuracy_summary` defaults to the newest run with a report**, so "how accurate is it" after a fresh run without a report yet still answers about the last measured one, and names the newer run in `otherRuns`.

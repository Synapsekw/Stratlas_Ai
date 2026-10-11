# Processing belongs to the project (design)

Date: 11 Oct 2026. Branch: `feat/project-processing`.

## What the founder asked for

1. "What does the jobs tab mean? What does it exactly do? Right now it's not really very intuitive."
2. "The jobs will be either map processing or AI analytics. They shouldn't be completely standalone on their own. The jobs themselves should be really individual per project."
3. "Later on, when we add building and training AI models, that can stay in that tab, but we will have to rename it so that it's clear."
4. From the photo maps work: "Is there a way to make this more intuitive so that we know exactly what we are processing and for which project?"

## What is wrong today

The Jobs screen does five things at once:

| What                                                               | Problem                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Lists running and finished jobs                                    | Every project on the computer mixed together; a row shows a folder name, not the project's name |
| **New job**: nine task cards                                       | None starts anything. Each one only opens a screen that already has its own way in              |
| **Advanced: run a pipeline directly**: 38 pipelines with raw forms | Asks for internal ids ("Capture id", "Prepared surface id", "Run id"); ten forms are empty      |
| **Maps from photos**: the open project's runs                      | Project data inside a machine-wide screen                                                       |
| Processing tools version, or "missing"                             | Already in Settings                                                                             |

Three features can only be started from the raw forms: the AI inspection (detections to issues), the road survey build, and 3D Tiles for one layer.

"Job" is also the wrong word for this audience: in survey and inspection work a job is a site or a contract.

## The decision

- Processing is seen and managed inside the project it belongs to. The word is **Processing**.
- Work is started where it lives in the app, never from a list of pipelines.
- The raw pipeline forms and the machine-wide list are support tools. They move to Settings.
- The Jobs item leaves the sidebar. It returns later, renamed, for building and training AI models. That is a milestone of its own and is not designed here.

## Scope

In this branch:

- A **Processing** chip in the title bar and a drawer that shows the open project's processing.
- **Create maps from photos** starts from the drawer.
- The AI inspection starts from the Detections screen; the road survey build starts from the road setup panel.
- The raw pipeline forms, the self-test and the list of every job on the computer move to **Settings**, **Processing tools**, under **Advanced**.
- The Jobs screen, its nine task cards and its sidebar item are removed.
- The guide, the first-start text and the end to end specs follow.

Not in this branch:

- The AI model training screen.
- A guided way to make 3D Tiles for one layer. It stays a raw form, now under Settings, Advanced. A **Make 3D Tiles** item on the layer itself is a follow-up. Maps made from photos already get their tiles without it.
- Processing status on each survey date in the Datasets list (considered, kept for later).
- The processing tools (the Python pack) and how jobs run. Nothing in the pack changes, so no pack update is needed.
- The photo wizard and the run panel, which the photo maps branch has just changed. Only the place the runs list is shown moves.

## Behaviour

### The chip

A button in the title bar's status group, on every screen.

It shows when a project folder is open, or when anything is running on this computer. A read-only package has no processing, so it shows there only while another project is running something.

| State                                              | The chip reads                      |
| -------------------------------------------------- | ----------------------------------- |
| Nothing running in this project                    | `Processing`                        |
| One job running in this project                    | `Processing 40%`                    |
| Several running in this project                    | `Processing · 3 running`            |
| A job failed or was interrupted, not yet looked at | a warning mark, `1 needs attention` |
| Nothing here, something running elsewhere          | `Processing · 1 running elsewhere`  |

"Not yet looked at" lasts until the drawer is next opened. It is kept for the session only. At start, a job of the open project that was interrupted by quitting counts as not looked at, because it waits for **Resume**.

The running count that the Jobs item showed in the sidebar is replaced by the chip.

### The drawer

The chip opens a drawer on the right, over the screen, about 400 px wide. It does not block the rest of the app. Esc or its close button closes it and focus returns to the chip.

From top to bottom:

1. **Header:** `Processing`, and under it the project's name.
2. **Create maps from photos:** the one start button. It opens the wizard and closes the drawer.
3. **Tools missing:** only when the processing tools are missing or too old: "Processing cannot run yet: the processing tools are missing or need an update", with **Update processing tools**, which opens Settings. The version itself is shown in Settings only.
4. **Running:** this project's running jobs.
5. **Finished:** this project's finished jobs, newest first. The last 20, then **Show older**.
6. **Maps from photos:** the project's runs, with **Open run**, **Create maps again**, **Export as OPF** and **Delete work files**, as today.
7. **Running in other projects:** only when there is any. Each row names its project. It can be opened and cancelled from here.

With nothing to show: "Nothing is processing in _name_ and nothing has finished yet."

With no project open, the drawer has only part 7.

### A row

- The job's title in plain words (the photo jobs already read "Maps from photos: matching the photos").
- A kind tag, so map processing and AI work are told apart at a glance.
- Status, when it started, how long it took or has run, and a progress bar.

The kinds:

| Tag             | Jobs                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Maps and models | Maps from photos (three steps), model from a point cloud                                                   |
| Survey          | Stockpile volumes, change between dates, survey tools, site calibration, water and haul roads, road survey |
| AI analysis     | Inspection: detections to issues, and the three inspection kit steps                                       |
| Files           | Imports, conversions (point cloud, drawing, design, OPF, 3D Tiles) and the survey export                   |
| System          | The self-test and map packs, when one was run against this project's folder                                |

### A job's details

Clicking a row shows the job in the drawer, with **Back** to the list:

- Title, status, progress and the current message.
- **Cancel** while it runs. **Resume** after a failure, a cancel or an interruption. **Open output**. **Log file**.
- The error, when there is one.
- **Steps**, as today.
- **Outputs**, as today.
- **Open run**, for a maps from photos job.
- Folded by default: **Settings used** (the parameters, the job id, the tools version) and **Log** (the live log).

### Starting work

| Work                                                                                 | Starts from                                                                            | Change                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Maps from photos                                                                     | The drawer's button                                                                    | Moved from the Jobs screen                                                                    |
| AI inspection                                                                        | **Detections**, a new button **Turn detections into issues**, on an inspection project | New. Opens a small dialog with the six options the raw form has, then **Start**               |
| Road survey build                                                                    | The road setup panel's existing button                                                 | Opens a dialog with the road form, the drawn centreline filled in, instead of the Jobs screen |
| Stockpiles from the new project wizard                                               | The wizard, as today                                                                   | After **Create project** the new project opens on the Scene with the drawer open              |
| Compare dates, cut and fill, survey check, overlays, model builder, imports, exports | Their own panels, as today                                                             | None. Only the nine shortcut cards go                                                         |
| Map packs                                                                            | **Settings**, **Map packs**, which already shows their progress                        | None                                                                                          |

The two dialogs do not ask for a project folder. They name the open project: "Runs in _name_." When the job has started, the dialog closes and the drawer opens on it.

After **Update processing tools** was reached from the wizard, finishing the update leads back to the wizard as today, on the Scene instead of the Jobs screen.

The command palette's **Jobs** entry becomes **Processing** and opens the drawer.

### Settings, Processing tools, Advanced

At the bottom of the page, folded by default: **Advanced: run a pipeline directly**. It holds what support and the automated tests need:

- The pipeline form as it is today: the pipeline, the project folder (the open project by default) and the pipeline's fields.
- **All jobs on this computer:** the list from every project, and the details of the one picked.

A job started here for the open project also shows in that project's drawer.

### The notice about missing tools

The start notice ("The processing tools need an update") keeps its rules. The Jobs screen no longer exists to say the same thing, so the only change is that the notice stays away while the drawer is open and says it.

## Known limit

The list of jobs is an index on this computer, keyed by the project's folder. So a project's history is what this computer ran for it in that folder. A project that was moved, or opened on another computer, starts with an empty history. Its layers, runs and reports are unaffected, and the **Maps from photos** part of the drawer is read from the project itself, so it does travel. Reading the history from the project's own `jobs` folder is a possible follow-up.

## How it is built

No change to the main process, to `@aio/schema` or to the pack.

| Piece          | Where                                                                                                                                                                                              | What                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The rules      | `renderer/processing/model.ts` (new)                                                                                                                                                               | Pure functions: a project's jobs, running elsewhere, the chip's state, not yet looked at, the kind of every pipeline   |
| Drawer state   | `renderer/processing/store.ts` (new)                                                                                                                                                               | Open or closed, the picked job, when it was last opened                                                                |
| Chip           | `renderer/processing/ProcessingChip.tsx` (new), `shell/TitleBar.tsx`                                                                                                                               | The button and its states                                                                                              |
| Drawer         | `renderer/processing/ProcessingDrawer.tsx` (new), `App.tsx`                                                                                                                                        | The parts above; renders `photogrammetry/PhotoRuns.tsx` unchanged                                                      |
| Shared parts   | `renderer/processing/JobList.tsx`, `JobDetail.tsx`, `PipelineForm.tsx`                                                                                                                             | Moved out of `screens/Jobs.tsx` so the drawer and Settings use the same ones                                           |
| Start dialog   | `renderer/processing/PipelineDialog.tsx` (new)                                                                                                                                                     | One pipeline's fields for the open project; used by Detections and road setup                                          |
| Pipeline names | `renderer/processing/pipelines.ts`                                                                                                                                                                 | `jobTitle` and the pipelines by area, moved from `screens/jobTasks.ts`                                                 |
| Advanced       | `screens/settings/ProcessingTools.tsx`                                                                                                                                                             | The folded section                                                                                                     |
| Entry points   | `screens/Detections.tsx`, `road/RoadSetup.tsx`, `builder/NewProjectWizard.tsx`, `processingTools.ts`, `shell/Palette.tsx`                                                                          | As in "Starting work"                                                                                                  |
| Removed        | `screens/Jobs.tsx`, `screens/jobTaskActions.ts`, the tasks of `screens/jobTasks.ts`, the `jobs` screen in `store.ts`, `App.tsx`, `shell/Sidebar.tsx`, `shell/TitleBar.tsx`, the draft in `jobs.ts` | A saved last screen of `jobs` opens the Scene                                                                          |
| Words          | `packages/ui` messages, `screens/FirstStart.tsx`, `ProcessingToolsNotice.tsx`                                                                                                                      | New strings go through the message catalogue; "in Jobs" is reworded                                                    |
| Guide          | `docs/guide/` chapters 01, 02, 08, 09, 12, 13, 15, 16, 28, 31, 32, 33, 36, 38                                                                                                                      | Every "Jobs" becomes the chip, the drawer or Settings, Advanced; chapter 08's "Run a job" is rewritten as "Processing" |

Each new unit has one purpose and can be tested alone: the rules without React, the chip and the drawer against a fake jobs store.

## Contract changes

None. No schema, IPC or pack change, so no row in `docs/architecture/contract-changes.md`.

## Edge cases

- Another project is opened while a job runs: the job carries on. The chip follows the open project and the job shows under **Running in other projects**.
- No project open and a job running: the chip still shows, so the work is never invisible.
- The same folder under another spelling (case, slashes, a trailing slash): compared the way the app already compares project folders.
- A job finishes while the drawer is closed: said aloud as today, and the open project reloads its layers as today. Only a failure or an interruption marks the chip.
- A read-only package: no start button and no jobs of its own.
- A narrow window (1100 x 700, the size CI uses): the drawer overlays the right panel and never pushes the page sideways.
- A draft road form prepared before this change: the draft is gone with the Jobs screen; the dialog fills the centreline itself.

## Tests

- Renderer, `processing/model.test.ts`: a project's jobs by folder; running elsewhere; every chip state; not yet looked at, including an interrupted job at start; every pipeline has a kind (a pipeline added to the schema without one does not compile).
- Renderer: the chip and the drawer against a fake store (the parts and their order, the empty state, the no-project state, Back, the folded sections); the start dialog builds the same parameters the raw form does.
- Existing `jobs.test.ts` and its M10, M11 and OPF siblings keep covering the forms and the events. The task tests of `jobTasks.test.ts` go with the tasks.
- End to end, new `processing-drawer.spec.ts`: the chip's states through a real self-test job; start, cancel, resume and finish from the drawer; a job of another project shows only under **Running in other projects**; the Advanced section in Settings starts a pipeline and lists every job; accessibility of the chip, the drawer and the start dialog.
- End to end, changed, because they reach a feature through the Jobs screen today: `jobs.spec.ts`, `jobs-chooser.spec.ts` (replaced by the new spec), `a11y.spec.ts`, `inspection.spec.ts`, `samples.spec.ts`, `road-builder.spec.ts`, `opf.spec.ts`, `photo-process.spec.ts` and its helper `photoPack.ts`, `processing-tools.spec.ts`, `volumetric-build.spec.ts`, and the helper `openPipelineForm` in `fixtures.ts`.
- Every changed or added spec is run the way CI runs it before the hand-off, one worker at a time.

## Merge order

The branch touches many files (the shell, Settings, about a dozen specs and the guide), so it goes last in its round.

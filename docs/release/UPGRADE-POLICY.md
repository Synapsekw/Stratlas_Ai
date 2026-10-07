# Upgrade and compatibility policy (1.x)

How Stratlas 1.x treats files written by older and newer versions, and how it proves it. Owned by stream T8. The code is `packages/schema/src/versions.ts`; the proof is `tools/compat/`.

## The rules

1. **Every `/1` file stays readable by every 1.x build.** All file schemas are at version 1 in 1.0 (the registry lists 42 families). A file written by 0.4 or later opens in 1.0 with nothing lost.
2. **New data goes into new files, never into existing records** (M9 global constraint). Fields are only ever added as optional, and never inside `Issue`, `ChangeReview`, `Detection`, `BoundaryEdit`, `ProcPart` or `NarrativeFile`, so an older build keeps reading what a newer one writes.
3. **A file from a newer build is refused, never rewritten.** The message names the file and says what to do: "issues.json was saved by a newer version of Stratlas (aio.issues/2). Update the app to open it. The file was not changed."
4. **A future `/2` comes with**:
   - a migrator in `MIGRATIONS` (`versions.ts`), one step per version, pure and tested on the corpus;
   - a one-time **Upgrade project** that keeps a backup of every file it converts (`<file>.v1.bak`);
   - a warning before the upgrade that builds older than the new version can no longer open the project.
5. **Downgrade within 1.x and to 0.8** (rollback, or a second installed copy) keeps working for project data. Settings keep everything the older build knows; settings it does not know are dropped by that build when it saves.
6. **The pipeline pack declares the app versions it works with** (`appRange`, `>=0.9.0 <2.0.0` for pack 1.0.0). The app refuses a pack outside the range with "This pipeline pack works with Stratlas >=0.9.0 <2.0.0, and this is 0.8.0. Install the pipeline pack made for this version." A pack without a range (0.3 and older) is accepted as before.

## The reader

`readVersioned(raw, { family, schema, appName, what })` is the one way to read a versioned file:

| Found                         | Answer                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| This build's version          | the parsed file                                                                                |
| An older version              | the file after each migrator step (on a copy), then parsed; `migratedFrom` says from which one |
| An older version, no migrator | refused: "saved by an older version ... that this version cannot convert"                      |
| A newer version               | refused with the update message; the input is not touched                                      |
| Another family                | refused: "issues.json is not an aio.issues file (aio.road/1)."                                 |
| Not an object, or invalid     | refused with the first problem and where it is                                                 |

It never throws, whatever the JSON (fuzzed in `tools/compat/fuzz.test.mjs`). `newerRefusal(raw, appName)` is the one-line form for readers that keep their own parse.

## Reader wiring (integration follow-up)

An audit of every reader (7 Oct 2026) found that only the manifest, the package header and `road.json` say "newer". The others treat a newer file as invalid or missing, and some then write over it. Each needs one line before its own parse: `const newer = newerRefusal(raw, brand.productName); if (newer) return { ok: false, error: newer };`, and the writer must not run after a refused read.

| File                                        | Reader                                             | Today, on a `/2` file                                      | Risk of overwrite                                                |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `ai-projects.json` (userData)               | `main/aiProjects.ts`                               | read as empty                                              | **Yes**: the next consent or usage update rewrites it, no `.bak` |
| `change/*.json`                             | `main/change.ts`                                   | listed as a problem; compute treats it as absent           | **Yes**: recomputing the same pair writes the same id            |
| `report/narrative.json`                     | `main/narrative.ts`, `NarrativeEditor.tsx`         | error shown, editor still offers Save                      | **Yes**: Save replaces it                                        |
| `detections/*.json`                         | `main/detections.ts`, `main/inference/electron.ts` | listed as "a kit list or COCO file"; hidden from inference | **Yes**: a new box or a resumed run writes over it               |
| `updates/journal.json` (userData)           | `main/update/rollback.ts`                          | logged and started again                                   | **Yes**, most likely right after a rollback                      |
| `library.json` (userData, no version field) | `main/library.ts`                                  | read as an empty list                                      | **Yes**: the next add saves the list without the old entries     |
| `issues.json`                               | `main/project.ts`                                  | project does not open; message says "invalid"              | No                                                               |
| `volumes.json`, `edits/boundaries.json`     | `main/boundaries.ts`                               | error                                                      | No in practice                                                   |
| `models/*.procmodel.json`                   | `main/modelBuilder.ts`                             | left out of the list silently                              | Low                                                              |
| `package-origin.json`                       | `main/project.ts`                                  | ignored                                                    | No                                                               |
| `conversations/*.json`                      | `main/conversations.ts`                            | left out of the list                                       | Unlikely                                                         |
| pipeline pack `manifest.json`               | `main/jobs/pack.ts`                                | "runtime not found"                                        | No                                                               |
| `models/detect/*/model.json`                | `main/inference/models.ts`                         | model left out                                             | No                                                               |
| `drawings/*/placement.json`                 | `packages/modelling/src/drawing.ts`                | throws, advice is "import the drawing again"               | Through the advice                                               |
| tiles, flight poses, panoramas              | `packages/engine`, `packages/video`                | throws or defaults                                         | No (read only)                                                   |

`library.json` should gain a schema id when it next changes shape (`aio.library/1`), so a newer list is refused rather than read as empty.

A single `.bak` protects only the first overwrite: the second save copies the app's own file over it.

## Settings and downgrade

`settings.json` has no schema id. An 0.8 build keeps each top-level setting its own schema accepts and drops the rest when it next saves. 0.8 reads the house report choices (`reportContents`) with a strict schema over its eight sections, so a later section id (`audit`, `approvals`, M9) would have lost every report choice on that machine. 0.9 and later keep the sections 0.8 does not know in a separate top-level key, `reportSectionsExtra`, which 0.8 ignores (`apps/desktop/src/main/settings.ts`, tested in `tools/compat/settings-0.8.test.mjs`). After a rollback to 0.8 and a settings change there, the M9 sections fall back to their default (shown) on return to 1.0; nothing else is lost.

## How it is proved

- `tools/compat/corpus/`: synthetic projects (tank farm, access road, change site) and userData files as the builds 0.4, 0.5, 0.6, 0.7, 0.8 and the current one wrote them. `build-corpus.mjs` takes the current sample through each milestone's own schema, extracted from git (`extract-schema.mjs`); `corpus/index.json` lists what each build could not hold (0.4 and 0.5 had no road units along the chainage, for example).
- `tools/compat/schema-0.8/`: the 0.8.0 schema as plain modules, committed so CI needs no git history; a drift test re-extracts it when the history is there.
- `tools/compat/corpus.test.mjs`: every corpus file opens in this build with nothing lost; every file this build writes parses with the 0.8 schema with nothing lost; every versioned file as `/2` is refused with the update message and left unchanged.
- `apps/desktop/e2e/upgrade.spec.ts`: an 0.8 project is edited in the app and still parses with the 0.8 schema; a newer project is refused and left unchanged.

Milestone builds (`tools/compat/milestones.mjs`): 0.4 `a8bf0c5`, 0.5 `8847687`, 0.6 `eafae4a`, 0.7 `af820d6`, 0.8 `7faf945`. The app version stayed 0.1.0 until M7, so 0.4 to 0.6 are named by milestone.

Rebuild the corpus after a schema change: `node tools/compat/build-corpus.mjs` (add `--from-demo` after `pnpm demo:build --quick` to refresh the current sample). Refresh the 0.8 schema only if the 0.8.0 commit changes, which it should not: `node tools/compat/extract-schema.mjs 0.8`.

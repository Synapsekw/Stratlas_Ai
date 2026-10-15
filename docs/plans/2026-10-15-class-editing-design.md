# Classes on the fly and Accept all: design

Date: 2026-10-15. Branch: `feat/class-editing`. PRD: ANN-7 (editable class catalogues).

## Problem

A project's class catalogue (`manifest.classCatalogues`) is fixed when the project is created by a template, the new-project wizard or an importer. Nothing adds, renames, recolours or deletes a class afterwards. Every class picker lists only existing classes, `createIssue` refuses an unknown class (`packages/annotate/src/model/ops.ts`), `detections/accept.ts` blocks detections with no or an unknown class, and AI Detect and the assistant are limited to the catalogue. An inspector or the AI that finds something new has no way to record it. Accepting suggested detections is also one click per detection, which is slow across dozens of images.

## Goals

1. An inspector can create a class from wherever they pick one, with just a name.
2. A detection whose class the project does not know can become a new class in one click.
3. AI Detect and the assistant can propose a new class; a person confirms before it exists.
4. Classes can be renamed, recoloured, given a hotkey, a severity scale, and deleted (moving their issues) in a Classes panel in Settings.
5. A class can be saved to a class library on this computer, and new projects offer library classes.
6. The Detections panel can accept or reject every detection it is showing in one action, as one undo step.

Out of scope: per-class merging in team sync (the whole catalogue stays last-writer-wins, noted in `docs/KNOWN-LIMITS.md`), editing severity models, editing built-in templates.

## Founder decisions (15 Oct)

- New classes live in the project, with an option to also save to a class library on this computer (there are no user-editable templates).
- AI proposes, an inspector confirms; nothing is created silently.
- Deleting a used class asks which class takes over its issues and detections.
- Creating a class mid-work asks only for the name.
- Accept all and Reject all act on the filtered list, one undo step.

## Design

### 1. Data and writing

- No schema change: `IssueClass` and `ClassCatalogue` already hold id, label, colour, hotkey and severity model.
- New IPC channel `builder:updateClasses { projectId, catalogues }` (additive): the main handler validates and writes through `updateManifestFile` (serial per project, `parseManifest`, `.bak`, atomic rename), is added to the journal's manifest-writing wrapper so the team journal records it, and returns the new manifest. The renderer calls `workspace.replaceManifest`. Same pattern as `builder:updateCapture`.
- Pure module `packages/annotate/src/model/catalogueOps.ts`:
  - `addClass(catalogues, models, { label }) -> { catalogues, cls }`: id is a slug of the label, unique across all catalogues (suffix `-2`, `-3`); colour from `nextClassColour(used)`; severity model is the one most classes use, else `severityModels[0]`; target catalogue is the first `road` catalogue, else the first catalogue, else a new `{ id: 'classes', name: 'Classes', assetType: 'asset' }`. A label matching an existing class (case-insensitive) returns that class instead of a duplicate.
  - `updateClass(catalogues, id, patch)` for label, colour, hotkey, severityModel. Hotkey: one character, not `a` or `u` (reserved in the sighting picker), not used by another class.
  - `removeClass(catalogues, id)` and `classUsage(issues, detections, id)`.
- `nextClassColour(used)` in `packages/annotate/src/model/palette.ts`: a fixed palette of distinct, legible colours; returns the first unused, then cycles.
- Delete and move: the renderer moves issues (`classId`, and `severityModelId` and severity mapped to the new class's model when it differs: same value if the level exists, else nearest) through the issue editor as one labelled command, moves detections' class in the detections store, then writes the catalogue. A class with no usage is removed directly.
- Undo: a small class-edit history in the renderer (before/after catalogues, plus the issue change for delete-and-move). Ctrl+Z in the Classes panel and the "Undo" toast after a create or delete restore the previous catalogues (and issues).

### 2. Creating while working

- Shared component `NewClassRow` in `packages/annotate/src/components/`: a "+ New class..." row that turns into a text field; Enter creates and selects, Escape cancels. It takes an `onCreate(label) => Promise<IssueClass>` callback so the package stays IO-free.
- Added to: the sighting picker (`SightingPicker.tsx`), the Inspector's class dropdown, the Issues register's Set class, and LocalDetect's class mapping.
- Detections with no matching class show "Create class 'X'" in the Inspector: creates the class, maps every detection with that raw name to it (`loadDetections(id, true)` re-resolves), and the detection can then be accepted. The LocalDetect mapping for that model class is updated too.

### 3. AI

- AI Detect: `promptTaxonomy` adds "if none of these fit, answer `new:<short name>`". `convert.ts` keeps such answers as detections with `classId = ''` and `label = <name>`, flagged `suggestedNew`. The Inspector shows "Suggested class: X" with the same Create class button. Nothing is created without a click.
- Assistant: a `propose_class` tool in `packages/ai/src/tool-kit.ts` returns a confirm card ("Create class 'X'?" Create / Dismiss). The class exists only after Create. The "no issue classes yet" error now points at `propose_class`.

### 4. Classes panel

- New Settings page `classes` (group Data, next to Severity models), `apps/desktop/src/renderer/screens/settings/Classes.tsx`.
- Rows: colour swatch (palette picker), name (inline edit), hotkey, severity scale (select), issue count, delete. "+ New class" at the bottom. Without an open project: "Open a project to edit its classes."
- Delete of a used class opens a dialog: "N issues and M detections use 'X'. Move them to:" (class select) Move and delete / Cancel.
- Each row has "Save to my class library".

### 5. Class library

- `userData/class-library.json`: `{ classes: { label, color, hotkey?, severityLevels? }[] }`, read and written by main (`classLibrary:list`, `classLibrary:save`, `classLibrary:remove`, additive IPC).
- New-project wizard: a "From your class library" checklist under the template's classes; ticked classes are added with the template's severity model.

### 6. Accept all and Reject all

- Detections panel header: "Accept all (N)" and "Reject all (N)", N = pending detections in the current filtered list.
- Accept all confirms "Accept N detections as issues?" plus "K have no class and will be skipped" when K > 0. Uses a new `acceptMany` in `detections/accept.ts` that returns accepted and skipped; the issues are created through the editor as one command, so one Ctrl+Z reverts the batch (issues removed, detections back to pending).
- Reject all confirms and marks the list rejected, also one undo step.

### 7. Team sync

Catalogue changes travel in `manifest.json` as the `project` record (lww-field), so a concurrent class edit by two people keeps the later one. Recorded in `docs/KNOWN-LIMITS.md`.

## Errors

- Write failure: the toast shows the error and the renderer keeps the previous manifest.
- Duplicate label: returns the existing class (no error).
- Reserved or taken hotkey, empty label: inline field error.
- Project read-only (package or refusal guard): the "+ New class" row and panel are disabled with the reason.

## Contract changes

Row in `docs/architecture/contract-changes.md`: IPC additive `builder:updateClasses`, `classLibrary:list`, `classLibrary:save`, `classLibrary:remove`; detection field `suggestedNew` (optional) if detections are schema-typed.

## Tests

- Unit: `catalogueOps.test.ts` (ids, uniqueness, target catalogue, default model, hotkey rules, remove), `palette.test.ts`, delete-and-move mapping of severity, `acceptMany` (skips, one command), main handler test for `builder:updateClasses`, class library read/write, `convert.ts` `new:` parsing, `propose_class` tool.
- Component: `NewClassRow`, Classes panel rows and delete dialog, Accept all confirm.
- e2e `apps/desktop/e2e/classes.spec.ts`: create a class from the picker; rename in Settings > Classes; accept a filtered list in one click and undo it; Create class from an unknown detection; delete a used class moving its issues. Re-run `detections.spec.ts`, `inspection.spec.ts`, `issue-card.spec.ts`, `agent.spec.ts`.

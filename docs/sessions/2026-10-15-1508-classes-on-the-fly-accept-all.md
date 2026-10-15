---
type: session
date: 2026-10-15-1508
branch: feat/class-editing
status: complete
related: [plans/2026-10-15-class-editing-design.md, plans/2026-10-15-class-editing.md]
---

# Classes on the fly and Accept all

## What changed

- Landed `feat/class-editing` (#135, `86f6d617`, PRD ANN-7): an inspector or the AI can add a class while annotating or reviewing detections, not only at project creation.
- "+ New class..." (just a name) in every class picker; "Create class 'X'" on a detection whose class the project lacks. AI Detect prompt `detect-v2` may answer `new:<name>` (`Detection.suggestedNew`); the assistant's `propose_class` tool always needs Approve.
- Settings > Data > Classes: name, colour, hotkey, severity scale (locked while issues use the class), delete that asks which class takes over its issues and detections, and Save to class library (`userData/class-library.json`), offered in the new-project wizard.
- Accept all (N) / Reject all (N) in the Detections panel on the filtered list; Enter confirms, one Ctrl+Z undoes the batch.
- Contract: IPC `builder:updateClasses`, `classLibrary:list/save/remove`, `LibraryClass`, optional `Detection.suggestedNew` (rows in `contract-changes.md`, M9 key snapshot updated).

## Why

The founder asked that an inspector or the LLM can add a class or issue type on the go when it finds something new, and that accepting dozens of suggested anomalies takes one click.

## How to test

1. Open a project with photos, start a manual annotation, open the class picker and choose "+ New class...". Type a name and press Enter: the class appears and the annotation uses it.
2. Run AI Detect on a few photos. A detection the model labelled with a class the project lacks shows "Suggested class: X" with "Create class 'X'"; click it and the detection takes the new class.
3. In the Detections panel, filter to a few rows and click Accept all (N). Confirm with Enter: every filtered row becomes an issue. Press Ctrl+Z once: the whole batch is undone.
4. Ask the assistant to add a class: it shows a proposal card; nothing changes until Approve.
5. Settings > Data > Classes: rename and recolour a class, set a one-letter hotkey, delete a used class and pick where its issues go. Save a class to the library, then start a new project: the wizard offers it.

## Open threads

- Founder review of the rulings: hotkeys are one letter (not a, u or a digit); undoing a delete brings the class back but moved detections stay moved; team class edits are last writer wins; `Detection.suggestedNew` kept despite the M9 key snapshot (display only).
- Parked: an issue assigned during an undo's flush is not rechecked before the write (a millisecond window); a refused redo leaves two extra journal entries.

## Next session entry point

Nothing in flight from this block. The founder's model question (AI findings as tags, markers or masks on a point cloud or GLB) overlaps `feat/findings-on-model`; check that branch before starting it.

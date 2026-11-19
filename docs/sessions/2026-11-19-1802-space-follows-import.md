---
type: session
date: 2026-11-19-1802
branch: fix/space-follows-import
status: complete
related: []
---

# An import shows the space it filled

## What changed

- This PR makes the space an Inspector import filled the one on screen when the import finishes, with a notice that names it: "Imported: now showing Space B. Switch spaces in the title bar." Before, the app stayed on the first space, so a second and third import looked as if they did nothing. Storage was always right; only the view did not follow.
- Chambers queued one after the other (a mission folder) switch once, when none is left, to the last one imported. If the last one fails or is cancelled, the last one that did import shows.
- No switch for a job of a project that is not open, for a failed or cancelled job, or for a job that was already done when the app started. A project with one space gets no notice (there is nothing to switch). The same export imported again shows its space.
- The rule is in `apps/desktop/src/renderer/flyability/followImport.ts`, called from the job watchers in `App.tsx` after the manifest is read again. No importer change, no pack change, no contract change.

## Why

In a confined-space project every imported inspection is its own space and the left rail, the 3D view and the issue register show one space at a time. Nothing moved the view after an import, which read as an import that overwrote itself.

## How to test

1. Open or create a confined space project and import one Inspector export (Layers header, right-click, Flyability Inspector export...). It shows as before, with no notice.
2. Import a second export into the same project and do not touch the title bar. When the job ends, a notice reads "Imported: now showing" with the new space's name and "Switch spaces in the title bar.", the space crumb in the title bar names the new space, and the Layers column lists its point clouds, not the first one's.
3. Pick the first space in the crumb: its layers are back. Pick the second: its layers again.
4. Pick a mission folder that holds two or more exports. While they convert one after the other the view stays where it is; when the last one ends, the crumb names the last chamber and one notice shows.

Steps 1 to 4 are driven by `e2e/flyability-import.spec.ts` ("a second inspection is a second space", "a mission folder picked whole imports its two chambers as two spaces").

## Open threads

- The switch does not wait for work in progress: no shared "mid-edit" guard exists for space switches (Move point switches the space without one too), so none was added. A Move point pick that is open when an import ends is left as it is while the space changes under it.
- "None left" is read from the chamber spaces made ahead of their jobs. A chamber picked again while an old failed job of the same inspection is still in the job list counts as ended, so that rare line may switch once per job instead of once.

## Next session entry point

The founder runs the four steps with real exports as part of the confined spaces section.

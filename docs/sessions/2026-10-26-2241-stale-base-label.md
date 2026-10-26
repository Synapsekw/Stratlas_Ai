---
type: session
date: 2026-10-26-2241
branch: fix/stale-base-label
status: complete
related: [architecture/adr/0013-one-volume-engine.md]
---

# A pile's base change is saved with its new figure

## What changed

- Answered a founder question: on small piles on sloping ground the Lowest point base gives 27 to 61 % more volume than the Triangulated toe. An independent recomputation from the DSM matched the app within about 1 %, so this is geometry, not a bug. The flat plane at the lowest edge height counts a wedge of natural ground as stockpile.
- Found and fixed a save gap (this PR): switching a pile's base marked its result stale and Autosave wrote that, but the recompute that followed went through `setComputedResults` (`apps/desktop/src/renderer/survey/measureStore.ts`), which by design never saves. The file kept the stale result under the old base label until some later save.
- With Autosave on, a recomputed result that replaces one a person's edit marked stale is now saved at once. Results worked out on open, where nothing was stale, still wait for the next save.
- Three tests in `measureStore.test.ts` ("a recompute after a base change, with Autosave on"). No contract or pack change.

## Why

The founder saw a pile listed as stale under "Mean perimeter level" after switching it to Triangulated toe, while its history already held the new figure.

## How to test

1. Open a survey project with Autosave on and draw a stockpile volume.
2. In the pile panel, switch Base from Mean perimeter level to Triangulated toe and wait for the figure to update.
3. Close and reopen the project and open the Volumes list: the pile shows the triangulated-toe figure, not stale and not under the old base label.
4. In a project saved before this fix with a stale pile, open that pile once; its figure updates and stays after reopening.

## Open threads

- Files already holding this state are not repaired on load; they heal when the pile is opened.

## Next session entry point

Hand `fix/stale-base-label` to the merge coordinator.

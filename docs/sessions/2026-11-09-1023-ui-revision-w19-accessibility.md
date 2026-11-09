---
type: session
date: 2026-11-09-1023
branch: fix/ui-a11y
status: complete
related: [docs/plans/2026-10-30-ui-revision.md]
---

# UI revision W19: accessibility fixes

## What changed

- This PR rebuilds the issue register as a grid:
  - each row's tick is a real checkbox that Space or Enter toggles once;
  - only the selected row's tick sits in the Tab order;
  - an arrow key returns focus to the list;
  - the grid carries row count, row index and active descendant, so screen readers announce the selection.
- Every remaining `outline: none` now has a `:focus-visible` ring or edge beside it, in about 14 style files.
- An empty change list is no longer a listbox. It had failed axe on the Volumes view.
- `a11y.spec.ts` runs axe on Scene, Issues (an issue ticked by Space after Tab) and the tank farm Volumes view (a pile opened by Space). New vitests cover the tick's Space, arrow and press handling.
- The duplicate W15a session note (0926) is removed.

## Why

Wave 3 of the UI revision closes the keyboard and screen-reader gaps the review found. The independent review caught arrow keys leaving focus on a stale tick, and that is fixed here.

## How to test

1. Open a project, go to Issues and click a row. Tab to its tick and press Space: it ticks and "1 selected" shows. Press ArrowDown, then Space: the new row ticks.
2. Open the tank farm demo, go to Project > Volumes, Tab to a pile row and press Space: the pile opens in Selection.
3. Tab through Help, Reports and any dialog: each focused area shows a teal ring or edge. Mouse clicks show none.

## Open threads

- A ring after a click and then a key on Inspect or Classes is focus-visible working as designed.

## Next session entry point

W20 (glossary) and then W18 (token ratchet), the last branch of batch E.

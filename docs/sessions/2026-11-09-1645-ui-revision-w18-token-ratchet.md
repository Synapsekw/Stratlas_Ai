---
type: session
date: 2026-11-09-1645
branch: chore/token-ratchet
status: complete
related: [docs/plans/2026-10-30-ui-revision.md]
---

# UI revision W18: token ratchet and anti-patterns

## What changed

- This PR teaches the CSS guard four more counts: raw spacing, off-scale radii, a bare `outline: none` and transitions on layout properties. The allow file records today's numbers and only shrinks.
- Side-stripe accents are gone from help, Ask AI, findings, package, road, mission and the shell; each now uses a full border or a tint.
- Width and offset transitions are removed from progress bars, the gate, the builder and Ask AI.
- Dead rules left by earlier waves (old menus, dialogs, toast copies, the old connection chip) are deleted.
- Radii come from the 2, 4, 6 and pill tokens: off-scale radii go from 58 to 0. Small swatches stay square and finding borders keep their hue.
- A bare `outline: none` counts as covered only beside a focus style that lights an outline, a border or a shadow.
- Guard counts: spacing 1893 to 1873, layout transitions 11 to 5, shadows 79 to 74, colours 84 to 82, z-index 71 to 69, font sizes 72 to 71.

## Why

Wave 3 of the UI revision stops the style drift: new CSS takes tokens, and the guard keeps the counts from climbing back.

## How to test

1. Open Help, Ask AI and a road's defect list: highlighted items show a full border or a tint, with no thick coloured stripe down one side.
2. Export a package and open Ask AI: the progress bars and the Ask AI panel change width at once, without a sliding animation.
3. Tab through a dialog and the materials editor: each focused control shows a teal ring or edge.
4. Look over cards, chips and buttons: corners are even, with no odd rounding.

## Open threads

- Spacing still has 1873 raw pixel values in the allow file; later work ratchets it down.
- There is no before and after screenshot pair for Road; its spec only captures the start dialog.

## Next session entry point

Batch E is complete. The founder tests batches D and E together, then the coordinator pushes once.

---
type: session
date: 2026-10-12-0122
branch: feat/globe-project-chips
status: complete
related:
  - docs/plans/2026-10-11-globe-project-chips-design.md
  - docs/plans/2026-10-11-globe-project-chips-plan.md
---

# Sites are named chips on the Globe, and its side panel is gone

## What changed

- Every site on the Globe is a chip (a dot in its colour, its name, an amber badge with its open issues). Chips that would overlap gather into one ("3 sites") through the Globe package's own pass (`groupChips` in `packages/globe/src/chips.ts`), at any heading. A click on a gathered chip parts its sites, and lists them in the field when they stand at one place.
- A selected site's card opens at its chip, follows it, stays inside the window and clear of the buttons. With terrain, the chip, the card, the rings and the label under the pointer share one ground position.
- The side panel is gone. Its list is a **Find a site** field at the top centre (`GlobeSearch.tsx`), its map settings a **Map** button at the top right (`GlobeMapMenu.tsx`), and **Measure** the first button of the lower-right stack. No site, or a library that could not be read, shows a notice in the field's place.
- The opening view, **Show all sites** and a gathered chip's click frame the chips, not the sites' points (`padBounds` in `packages/globe/src/camera.ts`), so no chip is cut by the window's edge.
- Tests: unit tests for the geometry, the field, the Map dialog and the screen; `globe.spec.ts` rewritten to go through the field and the Map dialog, with new tests for gathering at any heading, the smallest window, the keyboard, chips inside the view, near sites parting and sites at one place being listed.
- Branch `feat/globe-project-chips`, handed to the Orchestrator. No contract, schema or dependency change.

## Why

The founder asked for the Globe's side panel to go, or to sit behind a dropdown, and was not happy with how sites showed on the map: glowing dots whose names appeared only under the pointer, so the list was the only place a name could be read. Of three sketched directions the founder picked project chips. The design and plan were then approved by the Orchestrator on the founder's delegation for the evening, not by the founder directly, so the branch is the first time the founder sees the built result.

## How to test

1. Open **Globe** from the sidebar. Every project is a chip with its name; a project with open issues has an amber dot and a number. No chip is cut by the window's edge, and there is no panel at the left.
2. Zoom out with the mouse wheel until two chips touch: they become one chip, "2 sites". Click it: the Globe flies in and each site has its own chip again. If two of your projects stand at the same place, the click opens the **Find a site** list with just those two.
3. Click a chip. It gets an outline and a card opens under it with the name, last capture, open issues, **Fly to** and **Open site here**. Drag the Globe: the card follows the chip and never leaves the window or covers the buttons at the lower right.
4. Click **Find a site** at the top. Every site is listed; type part of a name and the list narrows; press Down and Enter. The Globe flies there and the card opens. Press Esc: the card closes.
5. Click **Map** at the top right. Switch between **Street map**, **Satellite** and **Natural Earth**; **Terrain**, **Show issues of the open project** and the colour key are there too. Esc closes it.
6. Click the ruler at the lower right and click two points on the ground: the distance shows at the top, where the field was. Click the ruler again to stop.
7. Make the window as small as it goes: the field, **Map**, the card and the lower-right buttons still fit and none overlaps another.

## Open threads

- The Globe says "site" throughout, as it did; the founder's sketch said "project". Switching is a change of strings only.
- Three things were not tried in a real, visible window: the list staying shut when the window is activated again (unit-tested), the listing of same-place sites with reduced motion on, and chips on a terrain pack with real relief (checked on the graphics card with a flat test pack only; CI runs the Low preset, where terrain is off).
- On real relief with a terrain pack, a click from far out on the gathered chip of sites a short walk apart can land their chips partly out of view, because the ground is known from coarse tiles at that moment; a second click frames them right.
- Chip text is soft on the Low graphics preset on a display scaled above 100 percent (the Globe draws at one device pixel per CSS pixel there); it is crisp at 100 percent and on the other presets.
- Smaller follow-ups recorded in the hand-off: the listing of same-place sites arrives when the flight ends, whatever the person did meanwhile; a mouse click on **Close** after a mouse click on **Fly to** puts focus in the field; the card's insets are written in three places; libraries wider than about 60 degrees at a narrow window open as they did before this branch.
- `docs/NORTH-STAR.md` section 3 is not updated on this branch; the Orchestrator catches it up with the round.

## Next session entry point

Wait for the founder's look at the built Globe (the "How to test" steps above), then take the open threads that matter to them: "site" or "project", the real-relief terrain check with a terrain pack, and the follow-ups in the hand-off.

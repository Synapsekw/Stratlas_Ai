---
type: session
date: 2026-10-18-1930
branch: feat/create-maps-entry
status: complete
related:
  - docs/sessions/2026-10-18-0855-release-0-21-0.md
---

# Create maps from photos under the project name

## What changed

- A primary **Create maps from photos** button sits under the project switcher in the left sidebar (`shell/CreateMapsButton.tsx`, mounted in `SidebarTop.tsx`). It opens the same photo wizard as the Processing drawer's button.
- When the sidebar is folded to the rail, the button keeps its photo glyph and shows its name in a tooltip.
- It is not shown without a project, in a package, or to a reviewer who may only look.
- Guide: `28-processing-photos.md` step 1 names the new place first.
- Tests:
  - unit test `CreateMapsButton.test.tsx`;
  - e2e `processing-drawer.spec.ts` "sits under the project name" covers the wizard opening and the rail tip. It passed 3 out of 3 the CI way.

## Why

The founder could not find Create maps in 0.21.0. Since the stage-island rework its only entry points were:

- the Processing drawer, behind the "0 jobs" chip at the foot of the sidebar;
- a photos layer's menu;
- the palette.

Making maps from photos is the app's main job, so its button needs to be in plain sight.

## How to test

1. Open a project. **Create maps from photos** is the green button under the project name; click it and the wizard opens.
2. Fold the sidebar (Ctrl B). The photo button stays under the project icon, and hovering it names it.
3. Open a package: the button is not there.

## Open threads

None.

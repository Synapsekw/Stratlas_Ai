# UI foundation: tokens, one set of parts, resizable areas (design)

Written on 16 Oct 2026 for the founder's approval. It is project 1 of five that came out of the UI review of 16 Oct 2026 (component audit and three area audits, kept with the session's working files; the findings this design relies on are restated here so the document stands alone).

## Why

The app spans earthworks and survey, telecom towers, roads, industrial inspection and drone video. The founder's main pain is breadth: "it becomes hard to remember where is what very quickly". The founder also asked for the whole UI to feel more modern, responsive and intuitive, and said the look of "the buttons, side bars, etc." is part of that experience. Separately, the founder asked that areas be resizable so the data gets priority, with Media as the example: the library on the left and the opened image on the right should split by a handle the person drags.

The review found the colour tokens and the accessibility layer solid, and the edges drifted:

- **Nothing resizes.** 18 of 20 side by side layouts are fixed px widths. At the 1100 px minimum window the 3D stage gets 488 px (448 on volumetric projects), the Issues list about 220 px with the agent dock open, and the Media viewer about 355 px, less than the gallery.
- **One-off parts.** `.btn` covers 694 of about 950 buttons, but 85 other button classes exist at heights from 18 to 34 px. There are 11 menu and popover surfaces with three fills, two radii and three shadows (the shared context menu `.dmenu` is styled in `builder/builder.css`, toasts in `report/reports.css`), 3 tab styles, 12 chip classes, 18 empty state classes.
- **Flat type.** About 90% of text is 11, 12 or 13 px; panel titles are 12 px, the same as body text. 16 sizes sit outside the tokens.
- **No tokens for space, elevation, layers or time.** About 140 distinct paddings, about 30 shadows (7 hard-coded black, wrong in the light theme), 31 z-index values managed by comments, `3px` radius 29 times, six durations for the same kind of transition.
- **Uneven states.** Four looks for "selected" (one a side stripe), disabled buttons cannot say why (`pointer-events: none` kills the tooltip), no busy state, and the global `:focus-visible` also changes border radius.
- **Hidden affordances.** Tree eye toggles and row actions only appear on hover, the group eye is 20 px (under the 24 px minimum), and 219 native `title=` tooltips sit beside 7 custom ones.
- **Light theme contrast.** Amber text (`--s3`) is about 2.2:1 on `--bg-1`, used as text 26 times.
- **Motion.** Folding a panel animates `width` and `grid-template-columns`, so the three.js and MapLibre canvases resize on every frame.

This project fixes the parts every screen is built from. It does not re-lay out screens: that is projects 2 to 4, and they build on these parts.

## The five projects (founder, 16 Oct 2026)

1. **UI foundation** (this document).
2. **Shell and stage**: the dynamic island, the right sidebar as workbench, title bar removed, agent dock, overlays docked, Split and Compare fixed. Its design is written separately.
3. **Finding things**: Ctrl+K indexes everything with where it lives, Settings grouped and searchable, one icon and one verb per concept, tools by project data, wizard project types.
4. **Data screens**: one list and detail template for Issues, Media, Detections and Reports, Media photo-first, one home for export, empty states with a next step.
5. **Bug sweep** (`fix/ui-bug-sweep`): about 20 small defects found by the review.

Order: 1 and 5 now, in parallel. 2 after 1 (it is built from these parts). 3 and 4 after 2, in parallel.

## Goals

1. Tokens for spacing, elevation, z layers, durations, a caps letter-spacing and a role token for panel titles, plus `--warn-ink` for amber text. Guarded by a test so new raw values do not creep back.
2. One button family, one floating surface (menus and popovers), one page tab style, three chip kinds, one row base, one empty state, one tooltip. All in `packages/ui`.
3. Every state has one look: hover, pressed, selected, focus, disabled with a reason, busy.
4. One shared resizable split, adopted by the app shell and the layouts the founder named.
5. Panel folding that does not resize the 3D or map canvas every frame.
6. The light theme passes contrast for text.

## Non-goals

- **No new visual language.** The look stays dark first, IBM Plex Sans, Condensed and Mono, mint accent, hairlines, small radii. The founder prefers extending their own design language over adopting a new one. This project evolves it: same colours, clearer steps.
- **No screen re-layouts.** The island, the workbench, removing the title bar, the list and detail template, the Ctrl+K index and the Settings grouping belong to projects 2 to 4. Where this project touches a screen, the screen keeps its layout and only gains a handle or swaps a part.
- **No icon and verb renames.** "One glyph, one meaning, one verb" is project 3.
- **No colour palette change** beyond the amber text token.
- **Not the bug sweep's items** (below).

## Anti-goals

It fails, even if it technically works, if:

- the app looks like a generic component kit (rounded pill buttons, big shadows, gradients, bigger everything). Density stays; contrast is added at the edges of the scale.
- an e2e spec has to change its behaviour or its assertions on what the user sees, or a shortcut stopped working. Selectors may be rewritten when a class is migrated (see Constraints); what the spec does and checks may not. _My call_, settling the conflict between this anti-goal and the class migration.
- a resizable area makes the data side smaller than today by default. Defaults keep today's sizes except where noted; the person can give the data more room, chrome gives way first.
- a migration leaves two styles for one thing ("the old `.tool` and the new `.btn.tool`"). Each migrated class is deleted, not aliased forever.

## Constraints

- **Keep every `data-testid`, `aria-label`, `aria-keyshortcuts` and shortcut.** e2e specs in `apps/desktop/e2e/` find controls by test id and by accessible name. Run the changed and affected specs the way CI does (CONTRIBUTING.md, "End to end the way CI runs it": 1100 x 720 window, display scale 1, WARP renderer, every demo built).
- **e2e selectors when a class migrates** (_my call_):
  - A spec that finds a control by a migrated class gets its selector rewritten to a `data-testid` or to role and accessible name, in the same commit as the migration.
  - A spec that asserts a `title` on a control whose tooltip moves to `<Tip>`: the control keeps an accessible name or description (`aria-label` or `aria-describedby`) carrying that text, and the spec asserts that instead.
  - A native `<select>` replaced by a menu (decision 3): the spec switches from `selectOption` to opening the menu and clicking the item.
  - The plan has a step listing every spec touched and why.
- **e2e fixtures pin the left sidebar open** through a test pref by default, so the 1100 px CI window does not auto-fold it (decision 10, row 3) under existing specs. Dedicated specs cover the auto-fold and the remembered re-open (_my call_).
- **i18n.** Every new visible string (tooltip text, "why disabled" reasons, separator labels) goes through `packages/ui/src/i18n`. No em or en dashes in copy.
- **Reduced motion.** The global rule (`mission.css`, about line 1574, plus `data-motion`) stays; new motion is instant under it.
- **Dark stage surface.** `[data-surface='dark']` stays dark in every theme; parts placed on the stage use the dark values.
- **Themes.** Dark, light and `data-contrast='more'` all get every new token. `tokens.test.ts` already checks that every colour token has a light value; its `NON_COLOUR` list must learn the new non-colour prefixes.
- **1100 x 720** is the narrow case every change is checked at.
- **RTL.** Use logical properties (`inset-inline-end`, not `right`), as the code already does.
- **Performance.** Dragging a split must not drop frames on the demo tank farm: the size goes to a CSS variable through `requestAnimationFrame`, no React re-render per pointer move.

## Decisions

### 1. Tokens (`packages/ui/src/tokens.css`)

- **Spacing:** `--sp-1` to `--sp-8` = 2, 4, 6, 8, 12, 16, 24, 32 px.
- **Elevation:** `--el-1` hairline (inline popover), `--el-2` = `0 12px 32px var(--shadow)` (menus, popovers), `--el-3` = `0 24px 64px var(--shadow)` (dialogs). The seven hard-coded black shadows move to these, so the light theme gets its own shadow colour.
- **Layers:** `--z-stage-ui 10`, `--z-panel 20`, `--z-pop 40`, `--z-drawer 60`, `--z-toast 70`, `--z-modal 80`. Every existing z-index maps onto one of these (my call: values in between become the nearest layer; anything that must sit above another inside one layer uses a local stacking context, not a new number).
- **Durations:** `--d-1 120ms` (hover, colour), `--d-2 180ms` (popover, fold), `--d-3 260ms` (morphs). Bare `ease` is replaced by `var(--ease)`. The island's 0.4 s morph is project 2's own value and is added there.
- **Type:** the scale becomes 11 caps / 12 body / 13 row / **13 panel title (600, `--fg-0`)** / 20 page title. Panel titles stay at 13 px (founder, 16 Oct 2026; not 15) and stand apart from rows by weight and colour: rows are 13/400 in `--fg-1`, titles 13/600 in `--fg-0`. No `--t-15`: add a role token `--t-title` (= `--t-13`) with `--fw-title: 600`, so titles are styled by role and the size can change in one place. Drop 9, 9.5, 10, 10.5, 11.5, 12.5 and 14.5 px. Add `--caps-ls: .06em` for every caps label (10 values today). Mono stays for numbers.
- **Radius:** controls use `--r-4`; `--r-2` only for kbd and badges; a new `--r-pill` only for status dots. The 29 uses of `3px` become `--r-4`.
- **Amber text:** add `--warn-ink` (light `oklch(0.52 0.12 75)`, dark the same as `--s3`), on the pattern of `--danger-ink`. `--s3` stays for fills and swatches only.
- **Guard:** a test (beside `tokens.test.ts`, my call: a vitest that scans renderer and `packages/ui` CSS, not a new stylelint dependency) fails on raw px `font-size`, raw colours, raw `box-shadow` and raw `z-index` outside `reportPage/` (print styles keep their own values). Existing exceptions are listed in an allow list that only ever shrinks.

### 2. Buttons

- **Sizes:** 24 (`sm`, the default in panels: about 480 of the 694 uses already are), 28 (`md`, page and dialog actions), 32 (`lg`, stage tools).
- **Variants:** `primary` (mint fill, at most one per surface), `secondary` (today's bg-2 and line), `quiet` (today's ghost), `danger`, `icon`, and `link` (folds the four link button styles: `conn-link`, `link`, `mm-link`, `help-link`, `wplace-link`).
- **States:**
  - **Pressed toggle:** `aria-pressed="true"` = mint 20% fill and mint glyph. (The bug sweep fixes the one toggle that shows no difference today, "Only with findings"; this project makes the look part of `.btn` so every toggle gets it.)
  - **Disabled with a reason:** `aria-disabled="true"`, pointer events kept, the click does nothing, and the tooltip says why ("Add photos first"). `disabled` stays only where no reason applies. The project menu already does this (`styles.css`, about line 979); generalise it.
  - **Busy:** `.btn[aria-busy='true']`: a spinner replaces the icon, the width is locked, the click does nothing.
- **Migration:** the 85 other button classes fold into `.btn` with modifiers. Named in the review: `.tool`, `.tl-bar-btn`, `.search-btn`, `.help-btn`, `.tree-add`, `.tree-foot-btn`, `.ann-btn`, `.ag-btn`, `.rr-chip` (as a toggle), `.mm-chip`, `.dbar-date` (drops `all: unset`). `.cmdk-item` is a row, not a button (decision 5). The builder makes the full list from the CSS and migrates it; each old class is deleted when its last use goes. **Skip what project 2 deletes** (my call): the stage toolbar row (`.stbar` and the `.tool` buttons and popovers that live only in it, `StageToolbar`, `toolbarFit.ts`) and the date row (`.dbar-date`, `DateRow`) are replaced by the island, so they get tokens only, not a migration. `.tool` uses outside the stage toolbar are migrated.
- **`.btn.danger`** moves from the map packs section of `styles.css` into `mission.css`.
- Component: `<Button>` in `packages/ui/src/controls.tsx` (size, variant, pressed, busy, disabledReason, icon, shortcut). JSX that already writes `className="btn ..."` may stay as markup; new code uses the component.

### 3. One floating surface

- `.surface-pop` (bg-1, `--line`, `--r-6`, `--el-2`, `--z-pop`) for every menu and popover; `.surface-dlg` (`--el-3`, `--z-modal`) for dialogs.
- `<Popover>` and `<Menu>` in `packages/ui` become the only floating components (today `<Popover>` has one user). The shared context menu's styles move from `builder/builder.css` into `mission.css`. The 11 surfaces (`.dmenu`, `.proj-menu`, `.stage-pop`, `.xmenu` and the rest) adopt them.
- **Portals inherit the opener's surface** (_my call_): `<Tip>`, `<Popover>` and `<Menu>` render in a portal, and the portal root copies the nearest `data-surface` (and the theme attributes) from the opener, so a popover opened from the stage stays dark in the light theme.
- **Popover anatomy:** optional title row (the panel title step, 13/600 `--fg-0`) with close, body, optional footer. Checkboxes align on one column; native `<select>` inside popovers is replaced by the menu or `.seg` where it has 2 to 4 options (my call: longer lists keep a native select restyled to the token look, because a custom listbox is accessibility work this project does not need).
- **Stacking rule:** opening a popover from a menu closes the menu (the review saw More and its child popover half covering each other).
- **Toasts** move to `mission.css`: leading status icon, no side stripe, logical `inset-inline-end`.

### 4. Tabs and chips

- `.seg` stays for 2 to 4 option switches (view modes, Off/Key/All).
- Page level tabs use one underline style: promote `.ph-tabs` to `.tabs`. The right panel's `.seg ctx-tabs` keeps working until project 2 replaces it with the workbench tab bar.
- `Tabs` items may carry a live dot, a count, an icon, a pin toggle and a close button; `overflow: 'menu'` keeps one row and moves non-fitting tabs (caller-ordered, the selected one never) into a "⋯ n" menu that shows the accent while a live tab is inside. The workbench tab bar of project 2 is a plain consumer.
- **Chips:** three kinds only: `.tag` (metadata), `.chip-status` (live state with a dot), `.sev` (severity). The other nine chip classes are retired onto these.
- **No side stripes.** The six `border-left: 3px` accents (toast, help, package, road twice, the date folder) become a leading status icon or a tinted fill.

### 5. Rows

- One `.row` base for nav (32 px), tree (26), menu items (30) and palette items (34): hover `--bg-2`, **selected `--bg-3` with the row's label and icon in the mint accent (`--acc` as the text tint)** (the one selected look; replaces the four), focus the global ring. No leading bar, no dot and no reserved slot for one; never a side stripe (_my call_). Counts are mono 11 `--fg-3`, right aligned.
- **Visible affordances:** the eye toggle shows at `--fg-4` at rest and brightens on hover (no `opacity: 0`); row actions are one trailing "⋯" button, 24 x 24, visible on the selected row and on hover, opening the same menu as right-click. Every row action hit target is at least 24 px.

### 6. Tooltips

- One `<Tip>` in `packages/ui` (a portal, triggered by hover and keyboard focus): 400 ms delay on first show, 0 ms while moving between tips, 120 ms fade; content is the label plus the `.kbd` shortcut. `aria-label` stays the accessible name; the tip is `aria-hidden` when it repeats the name. When a native `title=` goes, its text stays on the control as `aria-label` or through `aria-describedby`, so specs that asserted the `title` assert that instead (Constraints).
- Every icon-only control uses it. The 219 native `title=` tooltips are replaced **progressively**: in this project, every icon-only control in `packages/ui`, the app shell (sidebars, title bar until project 2 removes it) and the stage toolbar's surroundings that project 2 does not replace. The rest are replaced as projects 2 to 4 touch their screens (my call: a full sweep of 219 now would touch files the other projects are about to rewrite). The guard in decision 1 counts `title=` and the count may only go down.

### 7. Focus

- The global `:focus-visible` drops its `border-radius`, so it never squares an element. Local overrides (`.dbar-date`) go.

### 8. Motion

- Animate `transform` and `opacity` only.
- **Panel fold:** `.sidebar { transition: width }` and `.ws { transition: grid-template-columns }` go. The full panel slides out with a transform, then the grid snaps once (at the end when closing, at the start when opening); the stage canvas keeps its size during the slide and resizes once. The 52 px rail is a separate element that fades in; nothing animates width (_my call_).
- Durations from decision 1. Nothing bounces. Reduced motion is instant.

### 9. Light theme contrast

- `--warn-ink` for the 26 amber text uses.
- Chips that sit on the dark stage in the light theme (the review saw the PAUSED chip and the telemetry title unreadable) take the dark surface values. (If the bug sweep already fixed these two by hand, this project makes the rule general: anything inside `[data-surface='dark']` uses the dark tokens.)
- Check every text pair in light at 4.5:1 (3:1 for 18 px or bold 14 px and up) with a small script over the tokens; the result goes in the test.

### 10. ResizableSplit (`packages/ui/src/split/`)

One primitive, `<ResizableSplit>` plus a `useResizableSplit` hook. (Named so it does not clash with the renderer's existing `SplitPane` / `useSplit` for the 3D/Map split view in `workspace/SplitPanes.tsx`.) FloatingVideo (per project memory, keyboard, double-click reset) and MapSwipe are the reference implementations.

1. **Handle.** At rest a 1 px `--line-soft` hairline (the border it replaces) with an 8 px invisible hit area. On hover, after 150 ms, it lights to 2 px `--acc-a40` with a `col-resize` or `row-resize` cursor. While dragging it is `--acc` and shows a kbd style readout ("420 px") beside the pointer. The existing `PanelHandle` tab (`shell/PanelHandle.tsx`) sits centred on the same edge and keeps its behaviour and test.
2. **Constraints.** Each side declares a min (px) and a max (px or %). Data panes get the larger min: viewer 360, gallery 200, list 280, workbench 280, chrome max 50%. When the window shrinks, chrome gives way first, proportionally.
3. **Memory.** Saved per screen and layout key in the existing prefs store, the way `useStagePrefs` (`workspace/stagePrefs.ts`) does, on pointer up (not every move). Chrome sizes in px, data to data splits (3D | Map, gallery | viewer) as a fraction. Per computer, not per project (my call: the founder said "width remembered"; per project memory is FloatingVideo's choice because a video's size depends on the project, a sidebar's does not).
4. **Keyboard.** `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, `aria-controls`, `tabIndex=0`, an accessible name ("Resize the library"). Arrows step 16 px, Shift 64 px, Home min, End max, Enter toggles collapse.
5. **Double-click** resets to the default.
6. **Collapse.** Dragging below min minus 48 px snaps to collapsed: a 12 px strip, or the 52 px rail for the left sidebar. `PanelHandle` re-opens it. Collapse and size are one state, so today's fold flags migrate into it (Ctrl+B and Ctrl+Alt+B keep working). The left sidebar uses the shared split for its width and the rail for collapsed (_my call_).
7. **Motion.** No transition while dragging. Snap, reset and collapse use a 180 ms transform (the full panel slides, then the grid snaps once; the rail fades in as its own element, decision 8); canvases resize once at the end. Instant under reduced motion.
8. **Content.** Panes get `container-type: inline-size` so their content adapts with `@container`, not `@media` on window width.

**Adopted in this project** (founder's priority first):

| #   | Layout                                                | Default                                     | Min / max                              | Notes                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------- | ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Media: gallery \| viewer                              | viewer 54% (today's 46% gallery, unchanged) | gallery 200, viewer 360                | The founder's example. Project 4 changes the default to photo first; this project makes it draggable.                                                                                                                            |
| 2   | Workspace: stage \| right panel                       | 360 px (400 on volumetric, as today)        | panel 280 to 50%                       | Project 2 builds the workbench on this split. The 360/400 jump stays until project 2 (it is a workbench decision).                                                                                                               |
| 3   | Left sidebar width                                    | 252 px                                      | 220 to 320, collapse to the 52 px rail | Folds to the rail on its own below about 1280 px window width when the Scene or a data screen is open (founder). If the person re-opens it, that choice is remembered in its own pref, separate from the split's collapse state. |
| 4   | Agent dock width (Issues, Media, Detections, Reports) | `min(360px, 33vw)` as today                 | 280 to 50%                             |                                                                                                                                                                                                                                  |
| 5   | Issues: list \| card                                  | card 420 px                                 | list 280, card 320                     |                                                                                                                                                                                                                                  |
| 6   | Right panel: context \| agent (vertical)              | 62% as today                                | context 160 px, agent 96 px            | Project 2 adds maximise and minimise on top of this split.                                                                                                                                                                       |

**Left to later projects**, which re-lay out these screens: Split 3D | Map, timeline height, the photo and video dock beside the view (project 2); Detections' three columns, Reports' controls | preview (project 4). Settings, Help and Photogrammetry nav columns stay fixed and shrink to icons when their container is narrow (project 3 moves the Settings list into the left sidebar anyway).

## What the founder decided

- The five project split and the order above (16 Oct 2026).
- Areas are resizable so data gets priority; Media library vs image is the named example.
- The sidebar width is set by a drag handle and remembered (decided for the island's workbench; applied here to every split).
- Keep the app's own look and evolve it; the review's eight principles (below) are the direction.
- **Panel titles are 13 px, not 15** (16 Oct 2026). They stand apart from rows by weight (600) and colour (`--fg-0`), not size (decision 1, type).
- **The left sidebar folds to its 52 px rail on its own below about 1280 px** when the Scene or a data screen is open (16 Oct 2026). If the person re-opens it, that choice is remembered in its own pref, separate from the split's collapse state (decision 10, row 3).

## Design direction (evolved Mission)

1. **Data first, chrome second.** Every column with data in it can be resized, and chrome gives way.
2. **One place per kind of thing.** Rail = where am I. Island = what am I doing. Workbench = what is selected. Palette = everything. (Projects 2 and 3 implement it; this project gives them the parts.)
3. **One glyph, one meaning, one verb.** (Project 3.)
4. **Quiet surfaces, loud selection.** Mint means active, selected or go; never decoration or a stripe. Amber, red and blue mean severity only.
5. **Hierarchy through steps, not boxes.** Five type steps; panel titles stand apart by weight and colour; caps for section labels; mono for numbers; space, not cards, to group.
6. **Show, then reveal.** Affordances are faintly visible at rest; hover brightens; every icon tells its name and shortcut within 400 ms.
7. **Motion explains, never decorates.** 120, 180, 260 ms, transform and opacity only, instant under reduced motion.
8. **Dense but touchable.** 24 px minimum hit target, a 4 and 8 px rhythm from tokens, 11 px only for caps and metadata.

## Bug sweep overlap

`fix/ui-bug-sweep` runs at the same time and owns its defects, including: checkboxes OS blue in Reports and Issues (accent colour set per surface), the "Only with findings" toggle that looks the same on and off, the clipped Cut / fill row, the stray tooltip in the import panel, "COLOURNAME", "1 clips" and the doubled video, "DATASETS10", the one word per line sidebar notice, default blue links in Processing tools, "Save key" enabled with an empty field. This project does not fix those one by one; where a bug sweep fix becomes a general rule here (pressed toggles, links, accent colour), this project generalises it and whichever branch merges second rebases onto the first.

## Left to the builder

- The order of work and how to split it into reviewable commits (tokens first is natural: everything else uses them). The project may land in **two merges** (my call): first tokens, the guard, `<ResizableSplit>` with its six adoptions, `<Tip>`, focus and motion fixes, light contrast, and the new `<Button>`, `<Menu>`, `.row`, chips and empty state in `packages/ui`; then the migration of the one-off classes and surfaces. Project 2 may start building after the first merge.
- The full list of one-off classes and which modifier each becomes.
- The exact API of `<Button>`, `<Tip>`, `<Menu>`, `<ResizableSplit>` / `useResizableSplit`, within the behaviour above.
- How the prefs key for each split is named.
- Unit tests for each primitive (keyboard on the separator, min and max, collapse snap, memory on pointer up, tip delay and skip delay, busy and disabled reason) and screenshots at 1100 x 720 and 1440 x 900, dark and light, of every screen touched, compared with the review's screenshots.

## Risks and open points

- **Size of the migration.** 85 button classes and 11 surfaces touch many files that projects 2 to 4 will also change. Merge this project before they start building, and keep each migration commit to one part kind so a conflict is easy to read.
- **Parallel work in the repo.** Other sessions work in `workspace/` and `survey/`. This branch touches CSS in many areas; it should merge early and announce the token names so other branches use them.
- **e2e selectors.** Some specs may find a button by a class. The builder greps `apps/desktop/e2e/` for class selectors of migrated classes before deleting them and rewrites them as set out in Constraints.
- **Light theme stage chips.** If the general rule in decision 9 changes how something on the stage reads in dark, it is wrong: dark must look exactly as today there.

## Questions for the founder

None open. Both questions were answered on 16 Oct 2026 (see "What the founder decided"): titles at 13 px, and the sidebar auto-folds with the re-open remembered.

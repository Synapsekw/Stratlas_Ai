# Timeline: survey dates as the project's main axis

Status: design approved by the founder 2026-10-07 (option 1, own milestone, T1 first). Spec for
review before the T1 implementation plan. Milestone number not yet assigned; M10 stays next until
the founder says otherwise.

## Problem

Construction progress monitoring flies the same site once a week or once a month and captures the
same set every time: video, photos, orthomosaic and other maps, panoramas, sometimes a model. The
project format already holds this (M8): `ProjectManifest.captures` lists the survey dates and each
layer can carry `capture`, resolved by `captureIndex()` in `packages/workspace/src/captures.ts`.
What the app lacks is a way to work with it:

- The Datasets tree groups by layer kind only. Nothing in the sidebar shows dates.
- There is no project-wide current date. Only 3D, map and raster follow a date, and only inside the
  compare split (`PER_CAPTURE`, `apps/desktop/src/renderer/workspace/splitModel.ts`). Video, photo
  and panorama panes ignore dates.
- Everything date-related works on two dates. There is no way to step through twelve surveys.
- There is no calendar or date picker component.

Reference project: `construction-progress-monitoring` (one survey, 2024-09-04; five video layers and
one photo layer, none tagged with `capture`).

## Milestone parts

| Part                    | Delivers                                                                                                                                                                                           | After |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T1 Date timeline        | Date-first tree, Every date folder, focus and visibility rules, date bar, calendar, date colour tags, viewer date badges, video/photo/panorama panes following visibility                          |       |
| T2 Add a survey date    | Import a flight folder as a new date into an existing project; date from metadata, editable; every new layer tagged. One-time tagging of existing untagged layers                                  | T1    |
| T3 Compare across dates | Side-by-side panoramas with linked look direction, paired by position; same pairing for photos; "Compare with..." on any date folder or layer, opening the existing ortho swipe/blend and 3D split | T1    |
| T4 Progress reporting   | "This survey against the previous one / the baseline" summary on M8 change detection                                                                                                               | T3    |

T2 to T4 get their own design pass when T1 is merged. The rest of this document is T1.

## Decisions

1. Dates are a view over the existing model. No manifest schema change. A layer's date is whatever
   `captureIndex()` resolves; layers it leaves out are "Every date".
2. Free mixing. Any layer from any date can be visible at the same time (for example the 15 Nov and
   1 Nov orthomosaics, or the 6 Nov and 1 Nov panoramas).
3. One date is focused. Focus is navigation plus a visibility swap: jumping swaps the focused date's
   layers and keeps layers the user turned on by hand from other dates ("extras").
4. No "group by type / group by date" toggle. Date-first whenever the project has at least one
   survey date; today's type-first tree when it has none.

## T1 design

### Sidebar tree

`buildDatasetTree` (`packages/ui/src/tree/model.ts`) gains a date-first mode used whenever the
capture index has at least one capture:

```
Every date                      (layers with no resolved date; only shown when non-empty)
  Maps / Models / ...           (the existing kind groups)
6 Nov 2024   [tag]  focused     (expanded, highlighted)
  Video (5) / Photos (214) / Maps (1) / Panoramas (3)
2 Oct 2024   [tag]  1 on        (collapsed; "1 on" = visible extras inside)
4 Sep 2024   [tag]
```

- Date folders newest first. Label from the existing `captureLabel`/`formatDate`; the capture's own
  label shows as secondary text when it differs from the date.
- Inside a date folder the existing kind groups and their rules apply unchanged (flight rows that
  group video clips, Issues and Drafts under Annotations).
- A capture with no layers still gets a folder, greyed, with no eye.
- Clicking a folder's name focuses that date. Clicking only the chevron expands or collapses it
  without focusing, so extras can be picked from another date.
- When focus changes, the focused folder expands and every other date folder collapses. Every date
  keeps whatever expansion the user gave it.
- A collapsed date folder with visible layers shows the count ("1 on").
- A folder's eye toggles all layers in that date (same as group eyes today) and follows the extras
  rules below for non-focused dates.

### Focus and visibility rules

Pure state and functions in `packages/workspace` (new `timeline.ts`), unit-tested without React.
Visibility stays in the existing `workspace.hidden`; the timeline adds:

- `focus: CaptureId | null`, the focused date.
- `extras: Set<LayerId>`, layers from non-focused dates that the user turned on.
- `remembered: Record<CaptureId, Record<LayerId, true>>`, per date, the layers the user hid while
  that date was focused.

Rules:

1. `focusDate(next)`:
   - every layer of the previous focused date that is not in `extras` is hidden;
   - every layer of `next` is shown, except those in `remembered[next]`;
   - a layer of `next` that was in `extras` leaves `extras` (it now belongs to the focus);
   - Every date layers are not touched.
2. Toggling a layer of the focused date updates `hidden` and `remembered[focus]`.
3. Turning on a layer of another date adds it to `extras`; turning it off removes it.
4. Folder and group eyes apply rules 2 and 3 to each layer they cover.
5. On project open, focus the persisted focus for that project if it still exists, else the latest
   date, else null. Persist focus, extras and remembered per project (where per-project workspace
   state lives today is confirmed in the plan).
6. A date removed from the manifest drops out of focus, extras and remembered on the next load.

Focus is set from the tree, the date bar, the calendar and the keyboard; all go through
`focusDate`.

### Date colour tags

Each capture gets a colour from a fixed categorical palette by chronological index (index modulo
palette length), so a date has the same colour everywhere in a session and across sessions as long
as no earlier date is inserted. Tags carry the short date as text ("6 Nov") so colour is never the
only cue. Shared helper in `packages/workspace` (`captureTag(index, captureId)` returning colour
token and short label) used by the tree, date bar, calendar, pane badges and the compare split's
date pickers.

### Date bar

A strip above the viewer area, shown when the project has at least one date:

`[<]  [tag] 6 Nov 2024  [>]   3 of 7 surveys`

- Arrows step to the previous or next date in chronological order. Hidden with a single date.
- Clicking the date opens the calendar.
- Keyboard: previous/next date shortcuts added to the app's shortcut handling and the
  Ctrl+K palette ("Go to previous survey", "Go to next survey", "Go to survey date..."). Keys and
  the shortcut mechanism are settled in the plan after checking for collisions.
- The bar is part of the workspace screen, not the compare controls; with the compare split open it
  drives the left side (see Viewers).

### Calendar

New `Calendar` component in `packages/ui` (there is none today), used as a popover from the date bar:

- Month grid, Monday first. Days with a survey are filled with their date's tag colour; the focused
  day has a ring.
- Opens on the focused date's month. Month arrows skip months with no survey; a year select jumps
  directly.
- A day with more than one capture opens a short list of those captures.
- Keyboard: arrows move by day, Page Up/Down by survey month, Enter focuses, Escape closes. Focus
  returns to the date bar on close.
- Accessible names on every survey day ("6 November 2024, survey, 9 layers").

### Viewers

- 3D and map: render visible layers as today. A small corner chip lists the dates currently on
  screen in tag colours ("6 Nov · 1 Nov"); hovering an entry names its layers. Hidden when only one
  date (or only Every date layers) is on screen.
- Video, photo and panorama panes: choose from visible layers instead of every layer in the
  project. On focus change a pane switches to the matching layer of the new date (by the existing
  `counterpart` rule, else the first visible layer of that kind in the focused date) unless the pane
  is showing an extra. The pane header shows the shown layer's date tag. The pane's layer picker
  groups visible layers by date.
- Compare split (M8): unchanged. Each side keeps its own date picker; the left side follows the date
  bar's focus, the right side keeps its own choice. The pickers use the date tags.

### Edge cases

- No captures: type-first tree, no date bar, no badges (today's behaviour).
- One capture: date-first tree with one folder, bar without arrows, calendar with one day.
- Layer dated by name token only (rule 3 of `captureIndex`): treated as dated; T2 tags it for real.
- Two captures on the same day: separate folders, both shown on the same calendar day.
- Large projects (50+ dates): the tree only renders expanded folders' children; the calendar is the
  fast path.

## Testing

- Unit (`packages/workspace`): every focus/visibility rule above, including extras surviving jumps,
  remembered hides, extras promoted into focus, removed dates, persistence round trip.
- Unit (`packages/ui`): date-first `buildDatasetTree` (ordering, Every date, empty capture,
  "n on" counts, fallback to type-first); `Calendar` month skipping, multi-capture day, keyboard.
- e2e (off-screen, `STRATLAS_USER_DATA`): synthetic three-date fixture project with video, photos,
  panoramas and an ortho per date plus one undated layer. Jump via calendar and arrows; check
  expansion, highlight and visibility; turn on another date's ortho, jump, check it stays on; check
  pane badges and that video/photo/panorama panes follow focus.
- TESTING.md: founder steps on the fixture and on `construction-progress-monitoring` once T2 has
  added a second date.
- User guide: new page on survey dates and the timeline; `04-compare-dates.md` links to it.

## Out of scope for T1

Importing new dates and tagging existing layers (T2), panorama and photo compare and "Compare
with..." (T3), reporting (T4), a type-first/date-first toggle, a slider or animated playback through
dates.

---
type: session
date: 2026-10-19-2004
branch: feat/measurement-filter
status: complete
related:
  - sessions/2026-10-18-2238-measurement-layers.md
---

# Measurement filter box and safer deletes

## What changed

- The Measurements group in the Datasets tree has a filter box (follow-up to measurement layers, #184; the founder chose it over keeping the old list's search). It matches name, tool, folder, custom field values and template items. If the whole query appears in one text, only those rows show ("Crew A" shows only Crew A); otherwise every word must appear somewhere. That is all or nothing across the project: one phrase match anywhere hides the rows that only match word by word ("pad 12" with both "Pad 12" and "Pad check 12" shows only "Pad 12"). Folders with matches open, empty folders hide, the header and each folder read "n of N", and nothing is saved. A screen reader hears how many match through the app's live region, and a folder under the filter says it stays open (it does not fold there).
- Marks on rows the filter hides are kept but never acted on: Delete, the menus and the "n selected" count use only visible marked rows, and the selection follows the visible marks too, so the Selected panel totals and the 3D and map right-click menus leave hidden rows alone. Clearing the filter brings the whole selection back. This holds after a marked measurement is deleted another way (the Selected panel, a 3D or map menu); a 3D pick, a plain click or a click on empty space takes over the selection and the filter leaves it alone.
- Deletes stack their Undo (last 10), so a second delete no longer drops the first one's Undo. A double-click on Undo takes back one deletion, not two.
- Saves and loads check a load counter, so switching projects and back cannot apply a stale save or a stale read, and a load waits for that project's write still in flight, so it reads what the write left (a measurement deleted with Autosave on stays deleted). A save is refused until the file has loaded.
- The search checks dropped with the old list are back in `templates.spec.ts` and `telecom-measurements.spec.ts`; `measurement-layers.spec.ts` has a filter step.

## Why

The measurement layers PR removed the Measure bench's list and with it search, sort and field filters; the founder asked for search back as a follow-up, plus the merge reviewer's three parked findings. Sort stays out: the tree sorts by name within folders.

## How to test

1. Open a project with several measurements, go to Scene and open Measurements in the left sidebar.
2. Type part of a name in the filter box: only matching rows show, their folders open, and the header shows "n of N". Clear it with the x or Escape: everything is back.
3. Give two measurements a Crew field of "Crew A" and "Crew B" (Selected panel), then type "Crew A": only the Crew A one shows.
4. Ctrl+click three rows, filter so one is hidden: the header says "2 selected" and the Selected panel totals two. Right-click one of the visible shapes in 3D: the menu says 2 measurements. Press Delete in the tree: only the visible ones go. Clear the filter: the hidden one is still marked and selected.
5. Delete one measurement, then another: Undo brings back the second, then Undo again brings back the first. A quick double-click on Undo brings back only one.
6. Picking a shape in 3D that the filter hides clears the filter, so its row can show (intended).

## Open threads

- Parked from the merge review: phrase-first is all or nothing across the project and the phrase is a plain substring ("Crew A" also matches "Crew AB"); a word boundary at the phrase's end was tried and dropped, since it breaks typing a prefix ("line 1" would stop finding "Line 12"). Showing phrase matches first needs an order the name-sorted tree does not have.
- Parked: no row cap under a filter, so a one-letter query on a project with thousands of measurements draws every match on each keystroke; keep the "more" cap with a count, or debounce.
- Predates this PR, worth its own ticket: `writeTemplates` and `saveSiteSettings` in `measureStore.ts` set state after their await with no project or load-counter guard, so a project switch while one is writing can put its result on the next project.
- Parked: the Undo notice could say "and N more" so the stack is visible.
- Later follow-ups from measurement layers: a map controller hook so a road PCI unit under a measurement does not also select it, issue areas and draped issue shapes in the 3D issue hit, Fly to onto `flyToLocalBox`, the live Measure bench tab order.

## Next session entry point

Land this PR through the merge train; then the map overlay click hook and the `flyToLocalBox` switch.

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

- The Measurements group in the Datasets tree has a filter box (follow-up to measurement layers, #184; the founder chose it over keeping the old list's search). It matches name, tool, folder, custom field values and template items. If the whole query appears in one text, only those rows show ("Crew A" shows only Crew A); otherwise every word must appear somewhere. Folders with matches open, empty folders hide, the header reads "n of N", and nothing is saved.
- Marks on rows the filter hides are kept but never acted on: Delete, the menu and the "n selected" count use only visible marked rows; clearing the filter brings the selection back.
- Deletes stack their Undo (last 10), so a second delete no longer drops the first one's Undo.
- A save checks a load counter, so switching projects and back while a save is writing cannot apply stale state, and a save is refused until the file has loaded.
- The search checks dropped with the old list are back in `templates.spec.ts` and `telecom-measurements.spec.ts`; `measurement-layers.spec.ts` has a filter step.

## Why

The measurement layers PR removed the Measure bench's list and with it search, sort and field filters; the founder asked for search back as a follow-up, plus the merge reviewer's three parked findings. Sort stays out: the tree sorts by name within folders.

## How to test

1. Open a project with several measurements, go to Scene and open Measurements in the left sidebar.
2. Type part of a name in the filter box: only matching rows show, their folders open, and the header shows "n of N". Clear it with the x or Escape: everything is back.
3. Give two measurements a Crew field of "Crew A" and "Crew B" (Selected panel), then type "Crew A": only the Crew A one shows.
4. Ctrl+click two rows, filter so one is hidden, press Delete: only the visible one goes. Clear the filter: the other is still marked.
5. Delete one measurement, then another: Undo brings back the second, then Undo again brings back the first.

## Open threads

- A measurement the filter hides stays selected, so the Selected panel totals and a right-click on its shape in 3D still include it.
- Later follow-ups from measurement layers: a map controller hook so a road PCI unit under a measurement does not also select it, issue areas and draped issue shapes in the 3D issue hit, Fly to onto `flyToLocalBox`, the live Measure bench tab order.

## Next session entry point

Land this PR through the merge train; then the map overlay click hook and the `flyToLocalBox` switch.

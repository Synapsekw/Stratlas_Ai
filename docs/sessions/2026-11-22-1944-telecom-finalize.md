---
type: session
date: 2026-11-22-1944
branch: feat/telecom-finalize
status: complete
related: [../plans/2026-11-22-telecom-finalize.md]
---

# Telecom finalized: one list, one name per thing, one test list

## What changed

- The telecom section is finalized in this PR against `plans/2026-11-22-telecom-finalize.md`: 77 punch-list items, the Do now ones built (tasks T0 to T12), each with its outcome in section 2 of the plan.
- Words and duplicates: Antennas, Azimuth, Downtilt, Electrical tilt, Centre altitude, Draft, "Entered by you", "Not measured" and "Not set" everywhere, guarded by the glossary test; one rule for Accept and Reject on every route; one run button; one sector rename; one formatter for angles and heights.
- Fixes: the empty Antennas list offers Detect antennas and shows the tower prompt; messages show in the list; a delete has an Undo notice that brings back the unit, its crop, its sector place and RF settings; "the plan changed" comes from what is saved; a stuck Running state ends; a hand outline on a dense cloud is measured; detection reports progress inside its long steps; stage clicks go to the nearest claim, so an outline click no longer picks the box behind it.
- Four items closed without a change, with evidence in the plan: 29 (the view draws a lined-up cloud with the shift only, so the turn was built, caught by the new spec and backed out), 38, 57 and part of 52.
- New: a generated Demo tower among the demos (`pnpm demo:tower`), `e2e/telecom-finalize.spec.ts` (13 tests), guide chapters 45 (Antennas) and 47 (Coverage), a Telecom stage in `TESTING.md`.
- Pipeline pack 0.36.0 (confirmed by the merge coordinator on 28 Nov 2026). No contract change.

## Why

Telecom is the second section under the feature freeze of 18 Nov 2026. The founder delegated the open calls and the testing on 22 Nov 2026, so the build started without waiting for his volumetrics test and was driven in the running app before this hand-over.

## How to test

The one list is section 5 of the plan (23 steps on the project "Demo tower" on the Projects screen), each step with what checked it. Install the processing tools of this build first. The short version:

1. Open **Demo tower**. **Project** > **Antennas** reads "No antennas yet" with **Detect antennas**; click it. Eight units fill the list.
2. Click a box in 3D: its row opens with **Azimuth**, **Downtilt** and **Centre altitude**; the 3D label shows the same altitude.
3. Press **A** twice on a Draft: accepted, then Draft again. The same from the details button, the bulk bar and right-click.
4. **Flag antenna**, outline the small radio by the ring, **Measure**: a measured unit.
5. Delete a unit, then **Undo** in the notice: it is back with its photo crop.
6. Right-click an accepted antenna > **Open in Coverage**; **Auto-plan**, **Apply**, **Run coverage** (one button). Change a power, **Save**, reopen the project: step 3 says the plan changed.

## Open threads

- For the founder's eye: the tower icon; whether the A and R keys feel right; the 2 cm rule and no Undo for a resize; per-unit hide on right-click; label pins that do not avoid each other; a photo frame nearer than a box takes the click; selecting a unit opens Split view.
- Not driven: Label with AI on antenna crops (no AI provider with a vision model on the build PC). Never run: a comparison with reference values on a real tower (the Demo tower passes against its generated truth, eight of nine units found, the ninth measured when flagged).
- Known limits kept: on a date lined up with a turn the box centre is placed with the turn while the cloud is not; a thin strip outline still reads "Not measured"; parked crops of deleted units are never removed; the Coverage legend lies across the photo pane in Split view; two comments and one label in the frozen schema package still use old words.
- Deferred past the freeze: section 2 of the plan (the telecom report first).

## Next session entry point

The founder tests section 5; his answers decide whether telecom is approved and confined spaces starts. The coordinator confirms the pack number at hand-over.

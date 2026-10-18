# Antenna review: lean list and floating card

Date: 2026-10-18. Status: approved by the founder 2026-10-18.

## Why

Reviewing a tower's detected antennas today takes too much scrolling and clicking. On a real site with 34 units the founder had to:

- switch off groups of antennas one row at a time, because hiding exists only per antenna (eye button per row) and everything starts visible;
- open the ⋯ menu on a row to accept or reject a draft;
- scroll to the bottom of the Measure bench to see azimuth, tilt and the photo, because `AntennaDetails` renders after the whole inventory list (`telecom/AntennaSection.tsx` ~414);
- look hard for the detection box, because the fill is 18 % opacity with thin dashed edges and the selection halo is a faint white outline (`telecom/antennaScene.ts`).

The goal is to review a tower by looking at the 3D view, not at the panel: pick an antenna, see it alone in the scene with its measurements, decide, move to the next.

## Goals

1. Decide on a draft in one click or one key, with no menu.
2. Everything needed to decide (photo crop, azimuth, downtilt, plumb, size, altitude, support points) is visible at once, next to the antenna, without scrolling.
3. Turn whole groups, or everything, off and on in one click.
4. Work one by one through a clean scene: with everything hidden, the selected antenna appears by itself, with its measurements and a label, on both the point cloud and the GLB model.
5. The selected box is obvious at a glance.

## Non-goals

- No change to detection, the `aio.antennas/1` file format or how statuses are stored (draft / accepted / rejected stay as they are).
- No new fields (operator, band, confidence). The user fields that exist (model, weight, frequencies, active) keep working.
- No change to the CSV tool, the AI-preview flow or RF coverage, beyond keeping them working.

## Anti-goals (failure even if it "works")

- The panel still grows into a long scroll with details at the bottom.
- The card hides the antenna being judged, or can't be moved out of the way.
- Hidden state the founder set by hand is lost or overwritten by the review walk.
- Labels and measurements disappear when the GLB model is shown instead of, or with, the point cloud.

## The design

A clickable mockup on the real app was approved: brainstorm file `option-c-real.html` (scratchpad, not committed). Screenshot attached to the PR when it lands.

### 1. Panel (Measure bench, Antenna inventory section)

Replaces the current inventory list and the details card below it.

- Header: "Antenna inventory", with **Hide all** / **Show all** on the right.
- Summary line as today (counts, "True north").
- **Filter tabs**: To review N · Accepted N · Rejected N · All N. "To review" (drafts) is the default when there are drafts, otherwise All.
- Groups as today (panel, short, dish, other equipment), each header with a colour swatch, count, **group eye** (hide/show every unit in the group) and **show only this group** (solo; click again to clear).
- Rows: name, azimuth, downtilt, status dot and word, eye. No ⋯ menu. "Not found in latest" tag stays.
- Clicking a row selects it; the row highlights (accent left edge). No details block in the panel.
- Picking a box in 3D selects it and scrolls its row into view, as `revealAntenna` does now.
- Run warnings and the AI-skipped note stay where they are.

### 2. Floating card (in the 3D stage)

Appears when an antenna is selected; closes with ✕ or Esc.

- Header: kind swatch, name, status chip, kind word, position in the filtered list ("3 / 17"), ◀ ▶, ✕. The header is the drag handle.
- Photo: the unit's crop, "photo 1 / 3" with stepping through its linked photos, and "open full photo" (the existing open-photo action).
- Values grid: Azimuth, Downtilt, Plumb (large); W × H × D, Altitude, Points. Dishes show elevation and diameter in place of downtilt/plumb, as `AntennaDetails` does today. Values not measured show "—". Azimuths are true north, as in the current UI.
- **Accept** (A) and **Reject** (R) as large buttons; pressing the active one again returns the unit to draft (current toggle behaviour).
- "▸ Model, weight, frequencies" collapsed section with the existing editable fields.
- Keys while the stage or panel has focus (not inside an input): A, R, ← / → (also ↑ / ↓) for previous / next in the filtered list, Esc closes.
- After Accept/Reject, if the unit no longer matches the active filter (e.g. "To review"), the card moves to the next unit in the list; when none are left, it closes and says the filter is done.
- Placement: beside the selected box on screen, with a leader line from box to card. The founder can drag it; once dragged, it stays where it was put for the rest of the session. If the box is off screen or the card would cover it, the card docks to the stage corner nearest free space.

### 3. Camera

Selecting an antenna (row, ◀ ▶, keys or 3D pick) moves the camera smoothly to frame that box, keeping the current viewing direction where possible. Today selection does not move the camera at all.

### 4. One-by-one visibility ("clean walk")

- Group eye, row eye, Hide all, Show all and solo set the founder's own visibility, as today's `hidden` map does, extended to groups.
- The **selected** antenna is always drawn, even when it is hidden by the founder's settings.
- When selection moves on, the previous antenna returns to whatever the founder's settings say (hidden stays hidden). The walk never writes into the founder's hidden map.
- Accept/Reject never changes visibility.
- Result: Hide all → step through with ◀ ▶ / keys → only the current antenna is in the scene → Show all at the end shows everything with status styling.

### 5. In-scene labels and measurements

For the selected antenna, drawn on top of the scene so they read over both the point cloud and the GLB model (no depth test, like today's halo and azimuth arrow):

- **Box**: stronger fill (around 30–40 %), thick solid edge in the kind colour, plus a white outer halo.
- **Label** above the box: name and height (e.g. "A14 · 2.60 m").
- **Measurements**: width, height and depth dimension lines with values along the box edges; the azimuth arrow with its value in degrees; downtilt shown with its value next to the facing arrow.
- Non-selected visible boxes stay faint (today's style), with a small name label each so the founder can tell them apart after Show all. Accepted / draft / rejected keep distinct edge styles.

The founder's answer on the GLB was "honestly any labels": labels and measurements must read over whatever is visible, the point cloud, a GLB model, or both. My call on what that means for alignment:

- Labels and dimension lines are drawn in the same frame as the boxes (the detection capture's line-up). They draw on top of every layer, so they never hide behind the mesh.
- When the visible GLB belongs to the same capture as the detection, they sit on it. For a GLB from another date or a hand-placed one, they follow the antennas' own frame like the boxes do. Re-projecting into the mesh's frame is out of scope.
- The antenna layer, with its labels, also draws when the project shows only the GLB and the point cloud layer is switched off. Today `AntennaRunner` draws nothing without a cloud layer. Detection itself still needs a cloud.

## Calls made by the design author (founder to check)

- **Filter tabs don't change the 3D view.** They only decide which rows are listed and what ◀ ▶ / arrows step through. What's drawn is governed by the eyes, Hide all / Show all, solo and the always-drawn selected unit. This keeps one visibility model.
- **Solo is a separate overlay.** It does not write into the founder's hidden map, so clearing it brings back exactly the hand-set state underneath.
- **Group eye with a partly hidden group:** if any unit in the group is visible, the click hides the whole group; if all are hidden, it shows them all.
- **Hidden state lasts for the session** (in memory, as today). It is not saved with the project, since the `aio.antennas/1` format stays unchanged.
- **Photo stepping:** "photo 1" is the unit's crop. Steps 2–N show the unit's linked full photos fitted in the card, with no per-photo crop, because detection stores one crop per unit. "Open full photo" opens the current one in the existing photo viewer.

## Constraints

- Desktop app renderer (`apps/desktop/src/renderer`), React with inline styles and `@aio/ui` components and tokens (`packages/ui/src/tokens.css`); no new CSS framework.
- Three.js scene layer in `telecom/antennaScene.ts`, mounted by `telecom/AntennaRunner.tsx` in `Stage.tsx`; state in `telecom/antennaStore.ts`.
- The inventory is stored in the capture date's frame and drawn with the capture lineUp (see the telecom detection design); labels and measurements must follow the same transform.
- Right panel width is 360 px; the card must fit on smaller stage widths (dock rather than overflow).
- Session notes and screenshots are public: no client or site names.
- e2e coverage with evidence screenshots, as for the earlier telecom merges.

## Coordination with the measurements session

A parallel session is moving saved measurements into the Datasets sidebar (no code yet as of 2026-10-18). Agreed:

- **Labels:** reuse the existing measurement renderer's approach in `survey/measureScene.ts` (HTML labels in the `.sv-labels` div, `shapesOf` / label helpers) for antenna dimension lines and values. No second label layer. Any helper exported from `measureScene.ts` is a pure extraction with no behaviour change, announced to that session first.
- **Fly-to:** this branch builds a shared "frame this box/point" camera helper. The measurements session will use it for its Fly to.
- **MeasureBench.tsx:** this branch doesn't reorder sections. That session removes the saved-measurements block. Whoever merges second rebases.
- This branch doesn't touch `survey/measureStore.ts`, the sidebar tree or the schema. That session doesn't touch `telecom/`.

## Left to the builder

- Exactly how the measureScene label approach is reused (shared helper vs. a small antenna-specific copy of the pattern), as long as labels read on top of both layers and stay legible at tower distances.
- Camera tween timing and framing margins.
- Card docking rule details and how its position is remembered within the session.
- Whether the old `AntennaDetails` component is removed or reused inside the card.
- How keyboard focus is scoped so A/R/arrows don't clash with other stage shortcuts.

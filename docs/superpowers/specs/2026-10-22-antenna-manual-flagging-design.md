# Antenna manual flagging and correction — design

Date: 2026-10-22. Branch: `docs/ai-corrections-design`. Status: approved by the founder in a brainstorming session for write-up; ready for a plan.

## Intent

Automatic antenna detection (`telecom.antennas`, spec `2026-10-17-telecom-antenna-detection-design.md`) misses units: small radio units, faces merged with neighbours, dishes on thick members (`docs/KNOWN-LIMITS.md`). When it misses one, the founder has no way to add it. Today a person can accept, reject, hide, relabel the kind and fill the typed fields (model, weight, frequencies, active), but cannot add an antenna, and cannot correct the box or the measured values of one the detector got slightly wrong. The 2026-10-17 spec left geometry editing out on purpose ("Users reject and re-run, or use the manual tools"); in use that is not enough.

The founder's words: "there should be some sort of tool that allows me to draw the polygon on the antenna to flag it so that then AI can add it to inventory", drawn "on the 3d point cloud", and "yes, I want to edit those too" for units that were found but measured wrong.

This piece is independent of the engineering model typed corrections (`2026-10-22-engineering-model-typed-corrections-design.md`). They touch different code and can be built in parallel.

## Goals

1. **Flag a missed antenna.** A **Flag antenna** tool in the tower view. The person draws an outline (a polygon, in screen space) around the antenna on the 3D point cloud. The app takes the points inside it, measures the unit from them and adds it to the inventory.
2. **Measure it with the code we already have.** The outlined points go through the existing measuring steps in `python/src/aio_pipelines/telecom/` (`faces.py`, `boxes.py`, `measure.py`) to get the box, azimuth, downtilt, plumb, size and centre height, each with its basis and quality as today. The optional AI labelling (`apps/desktop/src/main/telecomAi.ts`) sets the kind, under the same consent rules as detection.
3. **Never lose what the person flagged.** A flagged unit is marked as person-made, so a re-run of detection (`merge.py`) never drops it and the geometry rule in `packages/schema/src/antennas.ts:109-125` does not reject it for missing values.
4. **Too few points still counts.** If the outline holds too few points to measure (a small radio unit), the unit is added at the outline's centre on the cloud, marked "not measured", with a small default box, so the person can type the values.
5. **Fix a wrong antenna**, two ways, from its card (`AntennaCard.tsx`):
   - **Redraw:** draw a new outline; the unit is measured again from those points, keeping its id, name, status and typed fields.
   - **Type values:** azimuth, downtilt, height (centre elevation) and size (width, height, depth). A typed value is stored with basis `user`, shown as the person's, and wins over any measured value, including after a re-run.

## Non-goals

- Dragging, resizing or rotating boxes in 3D (founder: "redraw plus typed values is enough").
- A trained detector, or using flagged units as training data.
- Flagging on photos. The outline is drawn on the point cloud only.
- Changing the automatic detection itself.

## Anti-goals (a failure even if it technically works)

- **A re-run that drops or overwrites something the person flagged or typed.**
- **A typed value shown as measured**, or a "not measured" unit shown with made-up numbers. Every value keeps its basis.
- **AI producing a number.** As in the detection spec, AI only labels the kind.
- **Measuring on the Electron main thread.** The measuring runs in the Python job runner (or a short job), not in main.
- **A separate progress UI.** Use the jobs chip and live line, as detection does.

## Constraints

- Repo rules in `CLAUDE.md` and `CONTRIBUTING.md`. Public repo: no client or site names in text, fixtures or commits.
- The cloud's Z needs the layer's `heightOffsetM` applied, exactly as detection does (detection spec, "Evidence").
- Units are stored in their survey date's frame (`merge.py` docstring); a flagged unit is stored the same way.
- Offline by default: flagging and measuring work with no network; only the kind label needs AI.

## How it works

### 1. Drawing the outline

- Entry point: a **Flag antenna** button in the `AntennaInventory.tsx` header, and **Redraw outline** on `AntennaCard.tsx` for an existing unit.
- The tool takes the scene's clicks the way the tower-hint pick does (`armTowerPick` in `apps/desktop/src/renderer/telecom/antennaScene.ts:501`, which uses `stage.claimClicks` and `stage.raycast`). Each click adds a polygon vertex; double-click or Enter closes it; Escape cancels.
- **Our call: keep only the nearest group of points.** An outline drawn on screen also covers the far side of the tower. The app selects the cloud points whose screen position falls inside the polygon, then keeps the cluster nearest the camera (depth gap or connected-component split; the builder picks the method). The person sees the kept points highlighted before confirming.

### 2. Measuring

- The kept points (or their indices plus the polygon and camera, the builder's choice) go to a measuring step that reuses the telecom face, box and measure code on just those points. Our call: a new small pipeline job or a mode of `telecom.antennas` taking a point selection, so the code is shared and runs off the main thread.
- Result: one unit with box and measured values, or "not measured" when the faces can't be fitted.
- If AI labelling is allowed, the kind is labelled from photos as for detected units; otherwise the person picks the kind on the card (default `other`, our call).

### 3. Data (contract change)

- `AntennaUnit` gains an origin marker, our call: `origin: 'detected' | 'flagged'` (optional, absent means detected), so old files stay valid. A builder may instead extend `kindBasis`; either way the geometry rule at `antennas.ts:109-125` must skip flagged and not-measured units.
- A flagged unit starts as **accepted** (our call: the person made it on purpose, and accepted units are what `merge.py` keeps), can still be rejected, and keeps `support` as its point count.
- Typed values use the existing `AntennaValue` with basis `user` (`ValueBasis` already has `user`, `packages/schema/src/assemblies.ts:24`).
- `merge.py`: flagged units are always kept, never matched away; a matched detected unit never replaces a `user` value.
- Needs a row in `docs/architecture/contract-changes.md` at build time, and a schema version bump if the house rules call for one.

### 4. What stays the same

Accept, reject and hide (`antennaStore.ts:272`, `:406`), the typed equipment fields (`patchUnitUser`, `:281`), the 3D boxes and labels, and the CSV export (`AntennaCsvTool.tsx`); flagged and edited units appear there with their basis.

## Testing

- **Python unit tests:** measuring a known point selection gives the expected box and azimuth; too few points gives "not measured"; merge keeps flagged units and `user` values across a re-run.
- **Schema tests:** flagged and not-measured units validate; detected units still need their values.
- **Renderer unit tests:** polygon selection and nearest-cluster filtering; store actions for add, redraw and typed values.
- **E2E:** extend or add to `apps/desktop/e2e/telecom-antennas.spec.ts`: on the demo, flag an antenna by drawing an outline, see it in the inventory, type an azimuth, re-run detection, and check it is still there with the typed value. Run it the way CI does (`CONTRIBUTING.md`, "End to end the way CI runs it").

## Left to the builder

- How the point selection reaches Python, and the nearest-cluster method.
- The point count below which a unit is "not measured".
- Exact polygon UX (vertex handles, undo last vertex), within the existing tool look.
- Whether the measuring is a new pipeline or a mode of `telecom.antennas`.

# Antenna Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review a tower's detected antennas from the 3D view. The panel is a lean filtered list with group visibility. A floating card beside the selected box shows the photo, values and Accept/Reject, and the camera, labels and dimension lines follow the selection.

**Architecture:** Visibility, filter and stepping live in `antennaStore` as pure state plus a pure `isAntennaDrawn` rule. The scene layer reads it and draws a stronger selected box plus dimension lines on top of every layer. HTML labels are placed each frame the way `survey/measureScene.ts` places `.sv-label`s. The card is a React component portalled into the stage host, positioned by a pure placement function. The camera uses the existing `workspace.flyTo({ kind: 'box' })` through a small shared helper.

**Tech Stack:** React 18, zustand, three.js (`LineSegments2` / `LineMaterial` from `three/examples/jsm/lines`, already used in `packages/annotate`), `@aio/ui`, `@aio/engine`, `@aio/workspace`, vitest + Testing Library, Playwright `_electron` e2e.

**Spec:** `docs/superpowers/specs/2026-10-18-antenna-review-design.md`

All paths below are relative to `apps/desktop/src/renderer/` unless they start with `apps/`, `packages/` or `docs/`.

## Global Constraints

- No change to `aio.antennas/1` (`packages/schema/src/antennas.ts`), detection, the CSV tool, the AI preview or RF coverage.
- Statuses stay `draft | accepted | rejected`. Pressing the active Accept/Reject again returns the unit to draft (`setUnitStatus` toggle, as today).
- Azimuths show true north where the file has convergence (`trueAzimuth`, `formatDeg`, `azimuthLines` in `telecom/antennaFormat.ts`), the same as the current UI.
- Hidden state, solo and filter live only in memory for the session. Nothing about visibility is written to the file.
- The review walk never writes into `hidden`. Solo never writes into `hidden`.
- Styling uses inline styles and `@aio/ui` tokens and components only. All UI strings go through `t()` with keys in `packages/ui/src/i18n/en.ts`.
- Labels reuse the `.sv-labels` / `.sv-label` pattern and CSS from `survey/measure.css`. `survey/measureScene.ts` is not modified. If a helper must be shared, it is a pure extraction announced to the measurements session (d-bc) first.
- `MeasureBench.tsx` sections are not reordered. Only the `<AntennaSection>` line may change.
- Public text (session note, screenshots committed, commit messages) carries no client or site names (`node tools/agent/check-public-text.mjs`).
- Commits: conventional, `feat(telecom): …` / `test(telecom): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.

## Review Focus

1. **Selecting while the selected unit is hidden or soloed out:** it must still draw, and it must disappear again once the selection moves on. Pinned in Task 1 (`isAntennaDrawn`) and Task 2 (scene).
2. **Accept/Reject on the last unit of "To review":** the card closes and the status line says the filter is done. There's no crash, and it doesn't jump to a unit outside the filter. Pinned in Task 1 (`decideAntenna`).
3. **Keys while typing in the card's model/frequency inputs, or while a dialog (AI preview) is open:** A/R/arrows must not fire. Pinned in Task 5.
4. **Read-only project (package):** Accept/Reject are disabled with the read-only reason, and keys A/R do nothing. Pinned in Tasks 1 and 5.
5. **Narrow stage or box near the edge:** the card stays inside the stage and docks rather than overflowing or covering the box. Pinned in Task 4 (`placeCard`).

---

### Task 1: Store — filter, group visibility, solo, drawn rule, stepping and decide

**Files:**

- Modify: `telecom/antennaStore.ts`
- Test: `telecom/antennaStore.test.ts`

**Interfaces:**

- Produces:
  - `export type AntennaFilter = 'draft' | 'accepted' | 'rejected' | 'all'`
  - `AntennaState` gains `filter: AntennaFilter` (initial `'all'`), `solo: AntennaKind | null` (initial `null`), `note: string | null` (transient status text, initial `null`)
  - `export function filteredUnits(file: AntennasFile | null, filter: AntennaFilter): AntennaUnit[]` — file order
  - `export function isAntennaDrawn(s: Pick<AntennaState, 'selected' | 'hidden' | 'solo'>, unit: AntennaUnit): boolean` — `unit.id === s.selected` → true; else `s.solo !== null && unit.kind !== s.solo` → false; else `!s.hidden[unit.id]`
  - `export function setAntennaFilter(f: AntennaFilter): void` — if the selected unit isn't in the new filter, select the first unit of it, or null
  - `export function toggleGroupHidden(kind: AntennaKind): void` — if any unit of `kind` is not hidden, hide all of that kind; else show all of that kind
  - `export function hideAllAntennas(): void`, `export function showAllAntennas(): void` (clears `hidden` and `solo`)
  - `export function setAntennaSolo(kind: AntennaKind | null): void`
  - `export function stepAntenna(dir: 1 | -1): void` — cycles inside `filteredUnits(file, filter)`; with nothing selected, picks the first (dir 1) or last (dir -1)
  - `export function decideAntenna(status: 'accepted' | 'rejected'): Promise<void>` — no-op when `readOnly` or nothing selected; target = (unit.status === status ? 'draft' : status); awaits `setUnitStatus`; then if the unit no longer matches `filter` (and filter ≠ 'all'), selects the unit now at the same index of the new filtered list (clamped), or sets `selected: null` and `note: t('telecom.antennas.filterDone')` when the list is empty
- `loadAntennas`: when the project changes (not `same`), set `filter` to `'draft'` if the file has drafts, else `'all'`. A reload of the same project keeps `filter` and `solo`.

- [ ] **Step 1: Write the failing tests** in `telecom/antennaStore.test.ts`, using the file's existing bridge mocks and fixture helpers:

```ts
describe('review walk', () => {
  it('draws the selected unit even when hidden or soloed out, and only while selected', () => {
    const u = unit({ id: 'a', kind: 'short' });
    expect(isAntennaDrawn({ selected: null, hidden: { a: true }, solo: null }, u)).toBe(false);
    expect(isAntennaDrawn({ selected: 'a', hidden: { a: true }, solo: null }, u)).toBe(true);
    expect(isAntennaDrawn({ selected: null, hidden: {}, solo: 'panel' }, u)).toBe(false);
    expect(isAntennaDrawn({ selected: 'a', hidden: {}, solo: 'panel' }, u)).toBe(true);
  });
  it('group eye hides a partly hidden group, then shows it', () => {
    /* 2 panels, one hidden → toggleGroupHidden('panel') → both hidden → again → none hidden; other kinds untouched */
  });
  it('solo and walking never write the hidden map', () => {
    /* hidden {a}; setAntennaSolo('panel'); stepAntenna(1) x3; expect hidden toEqual {a:true}; setAntennaSolo(null) */
  });
  it('Show all clears hidden and solo', () => {});
  it('steps inside the filter and wraps', () => {
    /* filter draft, units d1,acc,d2 → step 1 → d1, step 1 → d2, step 1 → d1, step -1 → d2 */
  });
  it('Accept on the active filter moves to the next, and says done after the last', async () => {
    /* filter 'draft', d1 selected, drafts d1,d2 → decideAntenna('accepted') → status accepted, selected d2;
       decideAntenna('accepted') → selected null, note === 'Every antenna in this filter is done.' */
  });
  it('pressing the active decision again returns the unit to draft', async () => {});
  it('decide does nothing read-only', async () => {
    /* readOnly true → no telecom:writeAntennas call */
  });
  it('a new project starts on To review when it has drafts, else All', async () => {});
});
```

- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom/antennaStore.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** the interfaces above in `telecom/antennaStore.ts`. Add the i18n key `telecom.antennas.filterDone` = `'Every antenna in this filter is done.'` in `packages/ui/src/i18n/en.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS, plus the file's existing tests.
- [ ] **Step 5: Commit** `feat(telecom): antenna review state: filter, group visibility, solo, walk`.

---

### Task 2: Scene — drawn rule, stronger selected box, dimension lines

**Files:**

- Modify: `telecom/antennaScene.ts`
- Create: `telecom/antennaMeasure.ts` (pure geometry for dimension lines and label anchors)
- Test: `telecom/antennaScene.test.ts`, `telecom/antennaMeasure.test.ts`

**Interfaces:**

- Consumes: `isAntennaDrawn`, `AntennaState['solo']` (Task 1).
- Produces:
  - `AntennaSceneState` gains `solo: AntennaKind | null`. `buildAntennaGroup` skips a unit when `!isAntennaDrawn(state, unit)`, replacing the `state.hidden[unit.id]` check.
  - `export interface AntennaLabelSpot { key: string; text: string; at: Vec3 /* local frame */; kind: 'name' | 'dim' | 'angle'; selected: boolean }`
  - `export function antennaMeasure(unit: AntennaUnit, frame: Frame, shift: DateShift | null): { segments: [Vec3, Vec3][]; spots: AntennaLabelSpot[] }` in `telecom/antennaMeasure.ts`:
    - width along `axes[0]`, height along `axes[1]`, depth along `axes[2]`. Each line is drawn on the box's bottom-front edge (height on the right-front edge), offset outward by 0.08 m, with 0.05 m end ticks.
    - Dim texts are `${v.toFixed(2)} m` from `widthM` / `heightM` / `depthM`, anchored at each line's midpoint.
    - Angle spot at the facing-arrow tip: `az ${formatDeg(trueAzimuth or grid)} · tilt ${formatDeg(downtiltDeg)}`. Dishes show `elev ${formatDeg(elevationDeg)}` in place of tilt. There's no angle spot when `azimuthGridDeg` is absent.
    - Name spot above the box top centre: `${unit.name} · ${heightM.toFixed(2)} m`.
  - `export function antennaLabelSpots(state: AntennaSceneState, frame: Frame): AntennaLabelSpot[]` in `antennaScene.ts`. Every drawn unit gets a small name spot (`selected: false`). The selected unit gets its full `antennaMeasure` spots (`selected: true`).
  - Selected unit styling (named constants): fill opacity `SELECTED_FILL = 0.35`; edges `LineSegments2` + `LineMaterial({ color: kind colour, linewidth: 3 /* px */, depthTest: false })`; halo kept (white, `HIGHLIGHT_SCALE`) with `depthTest: false`. The selected fill mesh also uses `depthTest: false`, and all of the selected unit's objects use renderOrder 43, so they read over the GLB and the cloud. Dimension segments: `LineBasicMaterial({ color: '#ffffff', depthTest: false })`, named `antenna-dim:<id>`, renderOrder 43. Non-selected units keep today's styling.
  - `attachAntennaLayer` updates the `LineMaterial.resolution` from the canvas size on rebuild and on `stage.onFrame` when the size changes.

- [ ] **Step 1: Write failing tests.**
  - `antennaMeasure.test.ts`: for an axis-aligned unit (extents `[0.4, 2.6, 0.3]`, centre `[10, 20, 30]`, axes identity, azimuth 170, downtilt 0.3, convergence 0.9), expect 3 dimension spots with texts `'0.40 m'`, `'2.60 m'`, `'0.30 m'`; the height segment length `≈ 2.6` (±1e-6); one angle spot whose text is `'az 169.1° · tilt 0.3°'`; name spot text `'A14 · 2.60 m'` with `at[1]` (local y) greater than the box top. A unit without `azimuthGridDeg` gives no angle spot. A dish gives `elev …` instead of tilt.
  - `antennaScene.test.ts`: (a) a hidden unit that is selected is drawn (`antenna-box:<id>` present) and the halo exists; after `selected: null` it is gone; (b) with `solo: 'panel'` a short unit is absent; (c) the selected box's mesh material has `opacity === 0.35` and `depthTest === false`; (d) `antenna-dim:<id>` exists only for the selected unit; (e) `antennaLabelSpots` gives one name spot per drawn unit plus the selected unit's measure spots.
- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom/antennaScene.test.ts src/renderer/telecom/antennaMeasure.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `antennaMeasure.ts` and the `antennaScene.ts` changes. Box corners come from `unit.box` centre ± half-extents along the local axes (`axisToLocal`), after `shiftEN(…, shift)` and `frame.toLocal`, exactly as the box mesh is placed today.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): selected antenna drawn on top with dimension lines`.

---

### Task 3: Labels overlay and camera framing

**Files:**

- Create: `telecom/antennaLabels.ts`
- Create: `workspace/flyToBox.ts` (shared helper, announced to d-bc)
- Modify: `telecom/AntennaRunner.tsx`
- Test: `telecom/antennaLabels.test.ts`, `workspace/flyToBox.test.ts`, `telecom/AntennaBench.test.tsx`

**Interfaces:**

- Consumes: `antennaLabelSpots` (Task 2), `isAntennaDrawn`, `solo` (Task 1).
- Produces:
  - `export function attachAntennaLabels(stage: EngineStage, frame: Frame, getSpots: () => AntennaLabelSpot[]): () => void`. It creates a `div.sv-labels.antenna-labels` (aria-hidden) in `canvas.parentElement` and keeps one `span.sv-label` per spot (`data-key`, class `sel` when selected, class `antenna-label--name|dim|angle`). On each `stage.onFrame` it projects `at` with `stage.camera` the way measureScene's `toScreen` does, and hides a spot that's behind the camera or off canvas. Name spots of non-selected units use a smaller font (11px), and selected spots use 12px. The detach removes the div.
  - `export function boxOfPoints(points: readonly Vec3[], pad = 0.5): { min: Vec3; max: Vec3 }` and `export function flyToLocalBox(points: readonly Vec3[], pad?: number): void` in `workspace/flyToBox.ts`, calling `workspace.getState().flyTo({ kind: 'box', min, max })`. Points are in the local frame.
  - `export function antennaCorners(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3[]` exported from `telecom/antennaMeasure.ts` (8 local corners, reused by Task 2's measure lines).
  - `AntennaRunner` passes `solo` into the scene state, attaches the labels next to the layer with the same lifetime, and flies the camera whenever `selected` changes to a non-null id (subscribe to `antennaStore`, compare the previous `selected`). It uses `flyToLocalBox(antennaCorners(unit, frame, shift), 1.0)`.
- `hasCloud` gating stays. The layer already draws when a cloud layer exists but is hidden, and the selected objects now draw over the GLB. No other change is needed for "only the GLB visible".

- [ ] **Step 1: Write failing tests.**
  - `flyToBox.test.ts`: `boxOfPoints([[0,0,0],[2,4,6]], 0.5)` → `{ min: [-0.5,-0.5,-0.5], max: [2.5,4.5,6.5] }`; `flyToLocalBox` calls a mocked `workspace.getState().flyTo` with `{ kind: 'box', … }`.
  - `antennaLabels.test.ts`: with a stub stage (camera at z=10 looking at the origin, a 100×100 canvas, `onFrame` captured), two spots, one behind the camera → after a frame callback the container has 2 spans, the one behind is `display: none`, the visible one has a `translate(…)` transform and class `sel` when selected; detach removes the container.
  - `AntennaBench.test.tsx`: selecting a unit through `selectAntenna('u1')` calls the mocked `flyTo` once with `kind: 'box'`; selecting the same id again doesn't call it again.
- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom src/renderer/workspace/flyToBox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `.antenna-label--name { opacity: .85 }` and `.antenna-label--dim { background: rgba(0,0,0,.6) }` to `survey/telecom.css`; the other label styling comes from `.sv-label`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): antenna labels in 3D and camera framing on select`, then SendMessage d-bc the path and signature of `flyToLocalBox` / `boxOfPoints`.

---

### Task 4: Floating card

**Files:**

- Create: `telecom/AntennaCard.tsx`, `telecom/cardPlacement.ts`, `telecom/AntennaUserFields.tsx` (the model / weight / frequencies / active editor, moved out of `AntennaDetails.tsx` unchanged)
- Delete: `telecom/AntennaDetails.tsx` once nothing imports it; move its still-relevant tests to `AntennaCard.test.tsx` / `AntennaUserFields.test.tsx`
- Modify: `telecom/AntennaRunner.tsx` (portal the card into the stage host)
- Test: `telecom/AntennaCard.test.tsx`, `telecom/cardPlacement.test.ts`, `telecom/AntennaUserFields.test.tsx`

**Interfaces:**

- Consumes: store actions from Task 1, `antennaCorners` (Task 3), `openPhoto` (`builder/photoOpen`), `assetUrl` (`@aio/workspace`).
- Produces:
  - `export interface Rect { x: number; y: number; w: number; h: number }`
  - `export function placeCard(box: Rect | null, stage: Rect, card: { w: number; h: number }, dragged: { x: number; y: number } | null, gap = 16): { x: number; y: number; docked: boolean }`. A `dragged` position is clamped inside `stage` and wins. Otherwise the card goes to the right of `box` (vertically centred on it, clamped), then to the left, and if neither fits without overlapping `box`, or `box` is null or off stage, it docks to the top-right corner of the stage with an 8 px inset (`docked: true`).
  - `export function AntennaCard(props: { stageHost: HTMLElement; boxRect: Rect | null }): ReactElement | null`. It reads the store and renders nothing without a selected unit. Contents, in order:
    - Header (drag handle): swatch, name, status `Chip`, kind word, `"{i} / {n}"` within the filtered list, ◀ ▶ `IconButton`s (`stepAntenna`), ✕ (`selectAntenna(null)`).
    - Photo strip: index 0 = `unit.crop` via `assetUrl`, then one entry per `unit.photos[]`, with a "photo {i} / {n}" caption, previous/next, and "Open full photo" → `openPhoto(layer, id)` (for the crop, the first linked photo).
    - Values grid: Azimuth, Downtilt, Plumb (large); W × H × D, Altitude, Points. Dish: Elevation and Diameter in place of Downtilt/Plumb. Missing values show "—".
    - Accept / Reject `Button`s (`pressed` = current status, `disabledReason` when read-only) → `decideAntenna`.
    - Collapsed "Model, weight, frequencies" disclosure holding `AntennaUserFields`.
    - `data-testid`s: `antenna-card`, `antenna-card-accept`, `antenna-card-reject`, `antenna-card-prev`, `antenna-card-next`, `antenna-card-close`, `antenna-crop`, `antenna-card-position`.
  - Leader line: a 1 px SVG line from the box's right-middle (or left-middle) to the card edge, drawn in the same portal. None when docked.
  - Drag: pointer events on the header set a session-level `dragged` offset kept in module state (`let dragged: {x,y} | null`), reset when the project changes.
  - `AntennaRunner` measures the selected box's screen rect each frame by projecting `antennaCorners` with `stage.camera` (`stage.onFrame`; it only sets React state when the rounded rect changes) and renders `createPortal(<AntennaCard … />, canvas.parentElement)`.

- [ ] **Step 1: Write failing tests.**
  - `cardPlacement.test.ts`: stage `{0,0,1000,800}`, card `{320,420}`. Box `{400,200,60,300}` → `x === 476`, card vertically centred on the box. Box `{900,200,60,300}` → placed left, `x + 320 <= 884`. Box `null` → `{ x: 672, y: 8, docked: true }`. A box filling the stage → docked. `dragged {x: 2000, y: -50}` → clamped to `{ x: 680, y: 0 }`.
  - `AntennaCard.test.tsx`: with a store holding three drafts (filter `'draft'`, first selected): it shows `"1 / 3"`; clicking `antenna-card-accept` writes status accepted and the card shows the next unit; ▶ / ◀ step; ✕ clears the selection; a read-only store disables accept with the read-only reason; the crop `img` src comes from `assetUrl`; a dish shows Elevation and Diameter and no Downtilt; a unit with no azimuth shows "—".
  - `AntennaUserFields.test.tsx`: the moved weight-validation and onBlur patch tests from `AntennaDetails.test.tsx` pass unchanged against the new component.
- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the components and add i18n keys under `telecom.antennas.card.*` (`position`, `prev`, `next`, `close`, `photo`, `openPhoto`, `more`) in `packages/ui/src/i18n/en.ts`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): floating antenna card beside the selected box`.

---

### Task 5: Keyboard

**Files:**

- Create: `telecom/useAntennaKeys.ts`
- Modify: `telecom/AntennaCard.tsx` (calls the hook while mounted)
- Test: `telecom/AntennaCard.test.tsx`

**Interfaces:**

- Produces: `export function useAntennaKeys(enabled: boolean): void`. A `keydown` listener on `window`, active only while the card shows a unit. It ignores events when:
  - `e.defaultPrevented`, `e.ctrlKey`, `e.metaKey` or `e.altKey` is set;
  - the target is inside an `input`, `textarea`, `select` or `[contenteditable]`;
  - `document.querySelector('[aria-modal="true"]')` exists.

  Keys: `a` / `A` → `decideAntenna('accepted')`; `r` / `R` → `decideAntenna('rejected')`; `ArrowRight` / `ArrowDown` → `stepAntenna(1)`; `ArrowLeft` / `ArrowUp` → `stepAntenna(-1)`; `Escape` → `selectAntenna(null)`. Handled keys call `preventDefault()`.

- [ ] **Step 1: Write failing tests** in `AntennaCard.test.tsx`: pressing `a` accepts the selected draft; `ArrowRight` moves to the next; `Escape` closes; typing `a` in the model input changes the input and not the status; with an element `[aria-modal="true"]` in the document, `a` does nothing; read-only + `a` → no write.
- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom/AntennaCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `useAntennaKeys`.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): A/R and arrow keys for the antenna card`.

---

### Task 6: Lean inventory panel

**Files:**

- Modify: `telecom/AntennaInventory.tsx`, `telecom/AntennaSection.tsx`
- Test: `telecom/AntennaInventory.test.tsx`, `telecom/AntennaBench.test.tsx`

**Interfaces:**

- Consumes: Task 1 actions and `filteredUnits`.
- Produces: `AntennaInventoryProps` changes:
  - It becomes `{ file; selected; hidden; solo; filter; readOnly; onSelect(id); onToggleVisible(id); onToggleGroup(kind); onSolo(kind | null); onFilter(f); onHideAll(); onShowAll() }`.
  - `onSetStatus` and `onOpenDetails` are removed, along with the ⋯ `Menu` and its `telecom.antennas.more` usage.
  - Layout, top to bottom:
    - A header row: **Hide all** / **Show all** `Button size="sm"` (`data-testid` `antenna-hide-all` / `antenna-show-all`).
    - The summary line (unchanged text).
    - Filter tabs as a `role="tablist"` of four `role="tab"` buttons with `aria-selected`, labelled `"{label} {count}"` (keys `telecom.antennas.filter.{draft|accepted|rejected|all}` = "To review", "Accepted", "Rejected", "All"; `data-testid="antenna-filter-<f>"`).
    - The groups, listing only filtered units. A group with no units in the filter is not shown.
  - Group header: kind swatch (`KIND_COLOURS`), kind label, count, group eye `IconButton` (`eye` / `eye-off`, label `telecom.antennas.group.hide|show`, `data-testid="antenna-group-eye-<kind>"`) and solo `IconButton` (icon `target`, or the closest existing `@aio/ui` icon, `pressed` when `solo === kind`, `data-testid="antenna-group-solo-<kind>"`).
  - Rows keep `data-testid="antenna-row"`, `data-status`, `aria-selected`, Enter/Space select, the "not found in latest" tag and the eye. A row whose unit is not drawn (`!isAntennaDrawn`) renders at `opacity: 0.45`.
  - An empty filter shows `EmptyState` with `telecom.antennas.filter.empty` = "Nothing here. Every antenna in this filter is done."
  - `AntennaSection` no longer renders `AntennaDetails`. It shows the store `note` as a `role="status"` line under the tabs (cleared on the next select). Reveal, hold and scroll behaviour stay exactly as now.

- [ ] **Step 1: Write failing tests** in `AntennaInventory.test.tsx`: the tabs show counts `To review 2`, `Accepted 1`, `Rejected 0`, `All 3`, and clicking one calls `onFilter`; on filter `'draft'` only drafts are listed; the group eye calls `onToggleGroup('panel')`; solo calls `onSolo('panel')`, then `onSolo(null)` when already soloed; there is no `More for` button in any row; Hide all / Show all call their handlers; an empty filter shows the empty text. Update existing tests that used the ⋯ menu so they use the card (Task 4) or the store.
- [ ] **Step 2: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @aio/desktop exec vitest run src/renderer/telecom src/renderer/workspace` and `pnpm -F @aio/desktop typecheck` (or the repo's `pnpm typecheck`). Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(telecom): lean antenna inventory with filters and group visibility`.

---

### Task 7: End-to-end and visual evidence

**Files:**

- Modify: `apps/desktop/e2e/telecom-antennas.spec.ts`
- Evidence (not committed): screenshots under `AIO_EVIDENCE_DIR`, plus a manual run on the local site copy at `E:\Dev\tmp-mockup` (outside the repo, never named in public text)

**Interfaces:** consumes all `data-testid`s above.

- [ ] **Step 1: Update** the test `detects antennas, accepts one and keeps it after a reload`:
  - Replace the ⋯-menu accept with: select the first row → `antenna-card` visible → `antenna-card-position` reads `1 / 8` (filter defaults to To review after the run) → press `a` → the row is gone from the To review list and the card shows `1 / 7`.
  - Switch to the `All` tab and check the accepted row's `data-status`.
  - Add: `antenna-hide-all` → `sceneHas(win, 'antenna-box:')` false for every unit except the selected one → `ArrowRight` → previous unit's box gone, new one present → `antenna-show-all` → all 8 boxes present.
  - Add: the group eye for `panel` hides the panel boxes.
  - Evidence: `e-card-selected`, `g-hide-all-walk`, `h-show-all`.
  - Keep the reload check and the accessibility check (`expectAccessible` on `antenna-panel` and on `antenna-card`).
- [ ] **Step 2: Run** `pnpm -F @aio/desktop e2e -- telecom-antennas.spec.ts` (the repo's e2e script; build first if it requires). Expected: PASS.
- [ ] **Step 3: Manual evidence on the real site copy.** Open the copy, Hide all, step through three drafts with the GLB model visible and the cloud hidden, and take screenshots showing the card, labels and dimension lines over the GLB. Show them to the founder. Don't commit them.
- [ ] **Step 4: Commit** `test(telecom): e2e for the antenna card, filters and the hide-all walk`.

---

### Task 8: Wrap-up and hand-off

- [ ] Run `node tools/agent/finish-task.mjs` in the worktree: it rebases onto `origin/main` and runs the checks. Rebase on d-bc's branch if theirs landed first (`MeasureBench.tsx`).
- [ ] Run `/wrapup` on this branch: a session note saying "this PR", and north star section 3.
- [ ] Push the branch, open a draft PR, and watch CI (`node tools/agent/watch-ci.mjs pr <n>`). When it's fully green on the exact head, SendMessage d-ba the PR number, branch and full head SHA.

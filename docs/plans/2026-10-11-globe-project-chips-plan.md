# Project chips on the Globe: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to
> implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every site is a named chip on the Globe, its card opens at its pin, and the side panel
gives way to a search field, a Map dialog and a Measure button.

**Architecture:** the chips stay CesiumJS billboards drawn on small canvases (as the pins are), so
clustering, picking and terrain clamping do not change; only the card is HTML, placed by the
controller after each frame through a third tag slot. The screen's chrome is split into two small
components (`GlobeSearch`, `GlobeMapMenu`) that `GlobeScreen` composes.

**Tech stack:** TypeScript, React 18, CesiumJS (`@cesium/engine`), Vitest, Playwright (Electron).

**Spec:** `docs/plans/2026-10-11-globe-project-chips-design.md`

## Global constraints

- No new shortcut. The Globe keeps saying "site".
- No contract change, no schema change, no new dependency.
- Everything the panel did stays reachable by mouse and by keyboard.
- The Globe at the CI window (1100 wide, about 724 high, device scale 1): no control folds away,
  overlaps another, or reaches the title bar.
- Test ids that stay: `globe-screen`, `globe-canvas`, `globe-sites` (now the listbox),
  `globe-look-street|satellite|natural-earth`, `globe-card`, `globe-readout`, `globe-credits`,
  `globe-all-sites`, `globe-tag-hover`, `globe-tag-selected`.
- Public text: no client, site or person names in code, tests, docs or commit messages.
- Subagents do not commit (one worktree, one index); the lead reviews and commits each task.

## Review focus

1. A site name of 60 characters or one with wide glyphs: the chip is cut with an ellipsis and never
   wider than `CHIP.maxName` plus its fixed parts (T1 `fitLabel` tests; T2 draws with it).
2. A selected site at the right or bottom edge of the window: the card stays inside the view and
   clear of the screen's own controls (T1 `placeCard` tests; T7 e2e).
3. A library with no sites, and a library that could not be read: the notice shows, the field does
   not open an empty list (T4 test for the empty list; T6 notice; T7 does not regress the error).
4. Typing a name that matches nothing: the list says so and Enter does nothing (T4 test).
5. The Map dialog open while the look changes: it stays open, focus stays on the pressed look, and
   Esc gives focus back to the Map button (T5 test).

## Execution DAG

```
T1 chips.ts (pure) ──┬─> T2 chips on the Globe ──┐
T3 strings ──────────┼─> T4 GlobeSearch ─────────┼─> T6 GlobeScreen ─> T7 e2e + docs ─> T9 run fixes ─> T8 verify, hand off
                     └─> T5 GlobeMapMenu ────────┘
```

| Batch | Tasks (run at once, no shared files) | Packages                     |
| ----- | ------------------------------------ | ---------------------------- |
| 1     | T1, T3                               | `@aio/globe`, `@aio/ui`      |
| 2     | T2, T4, T5                           | `@aio/globe`, `apps/desktop` |
| 3     | T6                                   | `apps/desktop`, `@aio/ui`    |
| 4     | T7                                   | `apps/desktop` e2e, docs     |
| 5     | T8                                   | whole repo                   |

Critical path: T1 → T2 → T6 → T7 → T8. End-to-end specs changed: `apps/desktop/e2e/globe.spec.ts`
(rewritten helpers, one new test). Run unchanged because they open the Globe:
`basemap-picker.spec.ts`, `project-maps.spec.ts`.

---

### Task 1: the pure geometry (`@aio/globe`)

**Files:** create `packages/globe/src/chips.ts`, `packages/globe/src/chips.test.ts`; modify
`packages/globe/src/index.ts` (export it).

**Produces:**

```ts
export const CHIP: {
  height: 24;
  pad: 3;
  dotX: 12;
  dotRadius: 4;
  nameGap: 11;
  endPad: 11;
  badgeGap: 7;
  badgeHeight: 16;
  badgePadX: 5;
  badgeEnd: 4;
  maxName: 168;
};
export type Measure = (text: string) => number;
export function fitLabel(text: string, maxWidth: number, measure: Measure): string;
export function issueBadge(open: number): string | null; // null, '1'..'99', '99+'
export interface ChipMetrics {
  width: number;
  height: number;
  nameX: number;
  badge: { x: number; width: number } | null;
}
export function chipMetrics(nameWidth: number, badgeTextWidth: number | null): ChipMetrics;
export interface ViewSize {
  width: number;
  height: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface CardPlace {
  left: number;
  top: number;
  side: 'below' | 'above';
}
export const CARD_GAP = 18;
export function placeCard(
  pin: { x: number; y: number },
  card: ViewSize,
  view: ViewSize,
  insets: Insets,
): CardPlace;
```

- [ ] Write `chips.test.ts`: `fitLabel` returns the text when it fits, cuts to the longest prefix
      plus `…` that fits (a 10 px per character measure), never splits a surrogate pair, trims a
      space before the ellipsis, returns `…` when nothing fits; `issueBadge` 0, 1, 99, 100;
      `chipMetrics` with and without a badge (width is an integer, the badge is at least as wide
      as it is high); `placeCard` below the pin by default with its left edge at the chip's left
      edge, clamped at the left and right insets, above the pin when below does not fit, clamped
      inside the insets when neither fits, a card wider than the view pinned to the left inset.
- [ ] Run `pnpm --filter @aio/globe test -- chips` and see it fail (module missing).
- [ ] Write `chips.ts`, export it from `index.ts`, run again: green.
- [ ] Commit `feat(globe): the geometry of site chips and the card at a pin`.

### Task 3: strings (`@aio/ui`)

**Files:** modify `packages/ui/src/i18n/en.ts`.

- [ ] Add `'globe.find': 'Find a site'`, `'globe.findNone': 'No site with that name'`,
      `'globe.mapMenu': 'Map'`, `'globe.mapMenuTitle': 'Map settings'`; reword `'globe.look'` to
      `'Map type'`. Run `pnpm --filter @aio/ui test`: green.
- [ ] Commit `feat(ui): words for the Globe's search field and Map dialog`.

### Task 2: chips on the Globe (`@aio/globe` view)

**Files:** modify `packages/globe/src/view/pins.ts`, `controller.ts`, `GlobeView.tsx`,
`globe-view.css`, `view/index.ts` if it lists exports.

**Consumes:** everything Task 1 produces.

**Produces:**

```ts
// pins.ts (sitePin and clusterPin are removed)
export interface ChipSprite { canvas: HTMLCanvasElement; width: number; height: number } // CSS px, pad included
export function siteChip(name: string, open: number, tone: PinTone, state: PinState,
  palette: GlobePalette, ratio: number, font: string): ChipSprite;
export function clusterChip(label: string, tone: PinTone, palette: GlobePalette,
  ratio: number, font: string): ChipSprite;

// controller.ts
export type GlobeTagSlot = 'selected' | 'hover' | 'card';
interface GlobeControllerOptions { /* … */ clusterLabel?: (count: number) => string }
class GlobeController {
  setCard(pick: GlobePick | null): void;      // where the card slot is anchored
  setCardInsets(insets: Insets): void;        // room the screen's controls take
  layoutCard(): void;                         // place the slots again (the card's size changed)
}

// GlobeView.tsx props
card?: ReactNode; cardPick?: GlobePick | null; cardInsets?: Insets;
clusterLabel?: (count: number) => string;
```

- [ ] `siteChip`: a rounded rectangle (`CHIP.height` high, fully round ends) filled with
      `palette.space` at 0.94, a 1 px border of `palette.ink` at 0.16 (rest), 0.4 (hover), or a
      1.5 px border in the tone's colour with a slightly lighter fill (selected); the dot in the
      tone's colour at `CHIP.dotX`; the name in `600 12px <font>` in `palette.ink`, cut with
      `fitLabel(name, CHIP.maxName, measureText)`; the badge from `issueBadge(open)` as a pill in
      `palette.attention` with dark text (`palette.space`). The sprite is `CHIP.pad` larger on
      every side. Cache key: name, open, tone colour, state, palette.space, font, ratio.
- [ ] `clusterChip`: the same chip with the label where the name is and no badge.
- [ ] Controller: site billboards use `siteChip(...).canvas`, `horizontalOrigin: LEFT`,
      `verticalOrigin: CENTER` and a `pixelOffset` that puts the dot's centre on the site (check
      whether CesiumJS wants CSS or device pixels for it against `pinPosition` and a pixel sample
      in the Globe spec, at device scale 1 and 2). Keep the entity's name and open count in a map
      so `restyleSites` can redraw a state. Clustering: `pixelRange = 0` (the chips' own boxes
      decide); the cluster billboard is `clusterChip(clusterLabel(count), tone, …)`, centred.
- [ ] Controller: the `card` slot. `setCard(pick)` stores the pick; in `placeTags` its anchor is
      the site entity's or the issue entity's position; hidden when there is none or it is behind
      the Earth; else `placeCard({x, y}, {offsetWidth, offsetHeight}, canvas client size, insets)`
      sets `transform: translate3d(left, top, 0)` and `data-side`. Unlike the other two slots the
      card slot has a size (it holds the card).
- [ ] `GlobeView`: render `<div ref className="aio-globe-card-slot">{props.card}</div>` after the
      `aria-hidden` labels (it is not hidden from assistive technology and takes pointer events);
      call `setCard`, `setCardInsets` from effects and `layoutCard()` in a layout effect after
      every render that has a card. The selected slot keeps the rings and loses its `Chip`.
      `describe` is not asked for clusters. Pass `clusterLabel` through a ref so a language change
      is read.
- [ ] `globe-view.css`: the slot `.aio-globe-card-slot` is absolutely placed at the top left,
      `z-index: 2`, hidden until it is placed, with `will-change: transform`.
- [ ] Run `pnpm --filter @aio/globe test` and `pnpm --filter @aio/globe typecheck` (or the repo's
      equivalent): green. Lead commits `feat(globe): sites are named chips, and a card slot at the pin`.

### Task 4: the search field (`apps/desktop`)

**Files:** create `apps/desktop/src/renderer/globe/GlobeSearch.tsx`, `GlobeSearch.test.tsx`,
`globe-search.css`, `SiteFacts.tsx` (the component moved out of `GlobeScreen.tsx`, same markup).

**Produces:**

```ts
export function filterSites(sites: readonly GlobeSite[], query: string): GlobeSite[]; // case-insensitive, trims, keeps order
export interface GlobeSearchProps {
  sites: readonly GlobeSite[];
  selected: string | null;
  onPick: (site: GlobeSite) => void;
  onLight: (projectId: string | null) => void;
}
export function GlobeSearch(props: GlobeSearchProps): JSX.Element;
export function SiteFacts(props: { site: GlobeSite; tilesets?: boolean }): JSX.Element;
```

- [ ] Tests first (`GlobeSearch.test.tsx`, the style of `shell/ConnectionStatus.test.tsx`):
      focus lists every site as `role="option"` inside `data-testid="globe-sites"`; typing
      filters; a query that matches nothing shows `globe.findNone` and Enter calls nothing;
      ArrowDown, ArrowDown, Enter picks the second site, clears the query and closes; hovering an
      option calls `onLight(id)` and leaving calls `onLight(null)`; Esc closes and keeps focus in
      the field; with no sites the list does not open.
- [ ] Build it on the pattern of `packages/ui/src/palette/CommandPalette.tsx`:
      an `<input role="combobox">` with `aria-expanded`, `aria-controls`, `aria-activedescendant`
      and its label and placeholder from `globe.find`, a search icon, and a
      `role="listbox"` (`aria-label={t('globe.sites')}`) of options: the dot (`.globe-dot`, tone
      from open issues), the name, `SiteFacts`. The active option also lights its chip. A pointer
      press outside closes the list.
- [ ] `globe-search.css`: the field is 260 px wide, the list drops under it, at most 320 px high
      and scrolls; surfaces as `.globe-card` has them in `globe.css`.
- [ ] Run `pnpm --filter @aio/desktop test -- GlobeSearch`: green. Lead commits
      `feat(globe): find a site from a field on the Globe`.

### Task 5: the Map dialog (`apps/desktop`)

**Files:** create `apps/desktop/src/renderer/globe/GlobeMapMenu.tsx`, `GlobeMapMenu.test.tsx`,
`globe-map-menu.css`.

**Produces:**

```ts
export interface GlobeMapMenuProps {
  prefs: GlobeSettings;
  look: GlobeStyle;
  tier: GlobeTierName;
  imagery: readonly RasterPackInfo[];
  terrain: readonly RasterPackInfo[];
  streetPacks: number;
  online: boolean;
  onSave: (next: GlobeSettings) => void;
}
export function GlobeMapMenu(props: GlobeMapMenuProps): JSX.Element;
```

- [ ] Tests first: the button (`aria-haspopup="dialog"`, name `globe.mapMenu`) opens a
      `role="dialog"` named `globe.mapMenuTitle`; the current look is `aria-pressed`; clicking
      another look calls `onSave({ ...prefs, style })` and the dialog stays open; the imagery
      select is absent in the street look; the terrain select is disabled and the Low note shows
      on the Low tier; the two notes show under their conditions; Esc closes and focus is back on
      the button; the key lists both tones.
- [ ] Build it as `shell/ConnectionStatus.tsx` builds its menu (`useFocusTrap`, pointer press away
      closes). Its content is the `globe-options` block and the `globe-key` list of today's
      `GlobeScreen.tsx`, moved as they are (test ids kept).
- [ ] `globe-map-menu.css`: the dialog is 280 px wide, opens under the button, right-aligned.
- [ ] Run `pnpm --filter @aio/desktop test -- GlobeMapMenu`: green. Lead commits
      `feat(globe): the Globe's map settings open from a Map button`.

### Task 6: the screen (`apps/desktop`, `@aio/ui`)

**Files:** modify `apps/desktop/src/renderer/globe/GlobeScreen.tsx`, `globe.css`,
`packages/ui/src/i18n/en.ts` (remove strings nothing uses any more).

**Consumes:** Tasks 2, 4 and 5.

- [ ] Remove the `<aside className="globe-panel">`. Top centre: `GlobeSearch` (hidden while
      measuring, when the read-out takes its place). Top right: `GlobeMapMenu`. The card's JSX is
      passed to `GlobeView` as `card`, with `cardPick={pick}` and
      `cardInsets={{ top: 56, right: 12, bottom: 44, left: 12 }}`; `.globe-card` loses its fixed
      position (the slot places it) and keeps its look and its `globe-rise` animation. Esc in the
      card closes it. Measure joins `.globe-controls` as its first button (icon only,
      `aria-label` and `title` `globe.measure`, `aria-pressed`). `clusterLabel` is
      `(count) => t('globe.siteCount', { count })`. `describe` returns null for clusters.
- [ ] No sites or an error: `<p className="globe-notice" role="status">` at the top centre with
      `globe.noSites` or the error (the error also shows above a list that has sites).
- [ ] `globe.css`: drop every `.globe-panel`, `.globe-head`, `.globe-sites`, `.globe-site` rule and
      `--globe-panel-w`; the read-out is centred on the whole top edge.
- [ ] Remove `globe.cluster_*` and any other Globe string no code reads (`rg "'globe\.x'"` each).
- [ ] `pnpm check` green. Lead commits `feat(globe): the Globe without its side panel`.

### Task 7: end to end and docs

**Files:** modify `apps/desktop/e2e/globe.spec.ts`, `packages/globe/README.md`, `docs/TESTING.md`
and any guide page that describes the Globe's panel.

- [ ] Helpers: `flyToSite` opens the field (`getByRole('combobox', { name: 'Find a site' })`) and
      clicks the option; `setLook(win, style)` opens the Map dialog when it is closed, clicks
      `globe-look-<style>` and presses Esc. Every `globe-look-*` click and `globe-sites` use goes
      through them. The count test reads options. The hover test: the selected slot shows rings
      and no text, the card says the name and sits inside the Globe's box, an option under the
      pointer lights its chip. Measure is the same button name.
- [ ] New test, "the Globe's controls fit the smallest window": the field, the Map button, the
      card of a site picked at the far right, the Measure and zoom buttons and the credits are all
      inside the Globe's box, none overlaps another, and a click at the centre lands on the canvas.
- [ ] Docs say what the screen does now. `node tools/agent/check-public-text.mjs` on them.
- [ ] Lead commits `test(globe): the Globe's specs follow the chips, the field and the Map dialog`.

### Task 9: what the first real run showed (added 11 Oct, after Task 7)

Task 7's run found three defects no earlier test could see; they are fixed before the hand-off.

- [ ] **Framing.** The opening view, **Show all sites** and a click on a gathered chip frame the
      sites' chips, not their points: a pure `padBounds(bounds, view, pad)` in `camera.ts` (unit
      tests), used by `flyHome` and the gathered-chip flight with the screen's insets plus a chip's
      room; `inspect().chips` and an end-to-end test that every chip is inside the view.
- [ ] **Terrain.** The chip, the hover label, the rings, the card, `pinPosition` and the gathering
      pass use one ground position (public `Globe.getHeight`, exaggeration included), read when
      tiles load and when the view rests; no work with terrain off.
- [ ] **Focus.** Esc or Close in the card gives focus back to **Find a site**.
- [ ] Task 7's review fixes ride along: `putPinAt` asserts the pin arrived; the gather test looks
      at what is drawn; the issue-pin test asserts its site is not gathered; a unit test for the
      heading.

### Task 8: verify and hand off

- [ ] `pnpm check`; `pnpm demo:build --quick` and `pnpm demo:change --quick`; then, one run at a
      time with `QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1`:
      `npx playwright test globe.spec.ts --workers=1`, then `basemap-picker.spec.ts`,
      then `project-maps.spec.ts`.
- [ ] Look at the Globe at 1100 x 724 and device scale 1 (a screenshot from the spec run) for
      overlap with the title bar's chips.
- [ ] `node tools/agent/finish-task.mjs`, send the hand-off to the Orchestrator.

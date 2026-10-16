# UI foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every screen one set of parts (tokens, buttons, one floating surface, tabs, chips, rows, tooltips, empty state) and one resizable split, without re-laying out any screen.

**Architecture:** New tokens and every new part live in `packages/ui` (`tokens.css`, a `parts/` folder of CSS files imported by `mission.css`, and React components exported from `packages/ui/src/index.ts`). The desktop renderer adopts `<SplitPane>` for six layouts and drops the width and grid animations. The work lands in two merges: **Merge A** adds the parts and the six splits (project 2 starts after it lands); **Merge B** migrates the one-off classes onto them.

**Tech Stack:** React 19, TypeScript, plain CSS custom properties, zustand (prefs stores), vitest (jsdom for components), Playwright for Electron e2e.

**Spec:** `docs/superpowers/specs/2026-10-16-ui-foundation-design.md` (read it with this plan; decision numbers below refer to it).

## Global Constraints

- Keep every `data-testid`, `aria-label`, `aria-keyshortcuts` and shortcut (Ctrl+B and Ctrl+Alt+B included).
- An e2e spec may have its selector rewritten when a class migrates (to a `data-testid` or role and name, in the same commit); it may never change what it does or asserts the user sees.
- Every new visible string goes through `packages/ui/src/i18n` (`en.ts`); no em or en dashes in copy.
- Animate `transform` and `opacity` only; nothing animates `width` or `grid-template-columns`; everything new is instant under `prefers-reduced-motion` and `data-motion='reduce'`.
- `[data-surface='dark']` stays dark in every theme; dark must look exactly as today on the stage.
- Every new token has dark, light and `data-contrast='more'` values where it is a colour; non-colour tokens are shared.
- Logical properties only (`inset-inline-end`, `margin-inline-start`), as `rtl.test.ts` enforces.
- Dragging a split never re-renders React per pointer move: the size goes to a CSS variable through `requestAnimationFrame`, and is saved on pointer up.
- Spacing `--sp-1..8` = 2, 4, 6, 8, 12, 16, 24, 32 px; elevation `--el-2: 0 12px 32px var(--shadow)`, `--el-3: 0 24px 64px var(--shadow)`; layers `--z-stage-ui 10`, `--z-panel 20`, `--z-pop 40`, `--z-drawer 60`, `--z-toast 70`, `--z-modal 80`; durations `--d-1 120ms`, `--d-2 180ms`, `--d-3 260ms`.
- Type: 11 caps / 12 body / 13 row / 13 title at 600 in `--fg-0` (`--t-title`, `--fw-title: 600`) / 20 page title; `--caps-ls: .06em`; `--warn-ink` light `oklch(0.52 0.12 75)`, dark = `--s3`.
- Buttons: `sm` 24, `md` 28, `lg` 32 px; variants `primary`, `secondary`, `quiet`, `danger`, `icon`, `link`.
- Hit targets at least 24 x 24 px.
- 1100 x 720 is checked for every change; e2e run the way CI runs it (CONTRIBUTING.md, "End to end the way CI runs it").
- Conventional commits; no client or site names (`node tools/agent/check-public-text.mjs`).

## Review Focus

- **Window smaller than the saved sizes** (left 320 + right 50% saved on a 1440 window, reopened at 1100): chrome gives way first, proportionally; the data pane keeps its min. Pinned by `clampSplit` tests in Task 6 and the shell test in Task 7.
- **Corrupt, foreign or blocked split storage** (`"quadrion.splits"` holding `"x"`, `{"media.viewer":{"size":"wide"}}`, or `localStorage` throwing): every split opens at its default and nothing throws. Task 6.
- **Right to left**: dragging the handle and pressing ArrowLeft move the edge the way it looks, not the reverse. Task 6.
- **Fold by drag, unfold by shortcut**: a right panel dragged past its snap and then Ctrl+Alt+B comes back at its last size, not the default; Ctrl+B on an auto-folded sidebar opens it and remembers. Tasks 6 and 7.
- **A reason on a disabled control, by keyboard, on the dark stage in the light theme**: focusing an `aria-disabled` button shows its reason in a dark tooltip. Tasks 2 and 3.

## File Structure

`packages/ui/src/`

| File                                                                                             | Responsibility                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`                                                                                     | New tokens (decision 1).                                                                                                     |
| `tokens.test.ts`                                                                                 | `NON_COLOUR` learns `sp-`, `el-`, `z-`, `d-`, `caps-`, `fw-`; checks the new tokens exist.                                   |
| `cssGuard.test.ts` + `cssGuard.allow.json`                                                       | Fails on raw px `font-size`, raw colours, raw `box-shadow`, raw `z-index`, and counts `title=`; the allow list only shrinks. |
| `contrast.ts` + `contrast.test.ts`                                                               | oklch to sRGB contrast for token pairs; asserts every text pair in light at 4.5:1.                                           |
| `portal.ts` + `portal.test.ts`                                                                   | `portalSurfaceAttrs` and `PortalRoot`: a portal copies the opener's surface and theme.                                       |
| `mission.css`                                                                                    | Base styles; `@import`s the `parts/` files at its top; the global `:focus-visible` (decision 7).                             |
| `parts/button.css`, `controls.tsx` (`Button`, `IconButton`)                                      | Decision 2.                                                                                                                  |
| `parts/tip.css`, `Tip.tsx`                                                                       | Decision 6.                                                                                                                  |
| `parts/surface.css`, `Popover.tsx`, `Menu.tsx`                                                   | Decision 3 (menus, popovers, dialogs, toasts).                                                                               |
| `parts/tabs.css`, `Tabs.tsx`; `parts/chip.css`, `Chip.tsx`                                       | Decision 4.                                                                                                                  |
| `parts/row.css`, `Row.tsx`; `parts/empty.css`, `EmptyState.tsx`                                  | Decision 5 and the one empty state.                                                                                          |
| `split/` (`model.ts`, `prefs.ts`, `useSplit.ts`, `SplitPane.tsx`, `index.ts`), `parts/split.css` | Decision 10.                                                                                                                 |

`apps/desktop/`

| File                                                                          | Responsibility                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/renderer/App.tsx`, `src/renderer/styles.css` (shell, `.ws`, `.right`)    | Shell grid on splits; folds by transform.                                       |
| `src/renderer/shell/Sidebar.tsx`, `src/renderer/shell/autoFold.ts` (+ test)   | Left sidebar width split, the 52 px rail as its own element, auto-fold.         |
| `src/renderer/panelPrefs.ts` (+ test)                                         | Gains `sidebarReopened`.                                                        |
| `src/preload/index.ts`, `src/main/index.ts`                                   | `aio.flags.autoFold` (false when e2e pins the sidebar).                         |
| `src/renderer/workspace/WorkspaceScreen.tsx`                                  | Stage and right panel split; context and agent vertical split.                  |
| `src/renderer/screens/Media.tsx`, `screens/Issues.tsx`, `agent/AgentDock.tsx` | Three screen splits.                                                            |
| `e2e/fixtures.ts`, `e2e/split-resize.spec.ts`, `e2e/sidebar-autofold.spec.ts` | Pin the sidebar by default; new specs for drag, keyboard, memory and auto-fold. |

## Execution DAG

**Milestone A (Merge A: parts and splits; project 2 may start after it lands)**

| Batch | Tasks (one message each batch)         | Depends on    | Files shared within batch                                           |
| ----- | -------------------------------------- | ------------- | ------------------------------------------------------------------- |
| A1    | Task 1                                 | none          | n/a                                                                 |
| A2    | Task 2, Task 3, Task 4, Task 5, Task 6 | Task 1        | none (each owns its files; `index.ts` lines were written by Task 1) |
| A3    | Task 7                                 | Tasks 2, 3, 6 | n/a                                                                 |
| A4    | Task 8                                 | Tasks 6, 7    | n/a                                                                 |
| A5    | Task 9                                 | Tasks 1, 8    | n/a                                                                 |
| A6    | Task 10 (gate and merge A)             | Tasks 1 to 9  | n/a                                                                 |

Critical path A: Task 1 â†’ Task 6 â†’ Task 7 â†’ Task 8 â†’ Task 9 â†’ Task 10. Tasks 7 to 9 are serial because they all edit `apps/desktop/src/renderer/styles.css`.

**Milestone B (Merge B: migrations), after Merge A has landed on `main`**

| Batch | Tasks                      | Depends on     |
| ----- | -------------------------- | -------------- |
| B1    | Task 11                    | Merge A        |
| B2    | Task 12                    | Task 11        |
| B3    | Task 13                    | Task 12        |
| B4    | Task 14                    | Task 13        |
| B5    | Task 15                    | Task 14        |
| B6    | Task 16                    | Task 15        |
| B7    | Task 17 (gate and merge B) | Tasks 11 to 16 |

Critical path B: the whole chain. Every migration touches `styles.css` and the area CSS files, so they run one part kind at a time (spec, Risks). Before B1, rebase onto `main` (project 2 may have moved) and announce the token and part names to the other sessions.

## Tests, e2e, contract and packages per task

| Task | Unit tests                                                                                | e2e added or changed                                                                                                                                                      | Contract                                                                              | Packages                               |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | `tokens.test.ts`, `cssGuard.test.ts`, `contrast.test.ts`, `portal.test.ts`, `rtl.test.ts` | none                                                                                                                                                                      | none                                                                                  | ui, desktop (rtl test)                 |
| 2    | `Button.test.tsx`                                                                         | none                                                                                                                                                                      | none                                                                                  | ui                                     |
| 3    | `Tip.test.tsx`                                                                            | none                                                                                                                                                                      | none                                                                                  | ui                                     |
| 4    | `Popover.test.tsx` (extended), `Menu.test.tsx`                                            | none                                                                                                                                                                      | none                                                                                  | ui, desktop (CSS moves)                |
| 5    | `Tabs.test.tsx`, `Chip.test.tsx`, `Row.test.tsx`, `EmptyState.test.tsx`                   | none                                                                                                                                                                      | none                                                                                  | ui                                     |
| 6    | `split/model.test.ts`, `split/prefs.test.ts`, `split/SplitPane.test.tsx`                  | none                                                                                                                                                                      | none                                                                                  | ui                                     |
| 7    | `autoFold.test.ts`, `panelPrefs.test.ts`, `App` shell test                                | add `sidebar-autofold.spec.ts`; change `fixtures.ts` (pin); run `panels.spec.ts`, `shell.spec.ts`, `a11y.spec.ts`, `sidebar-menus.spec.ts`, `sidebar-multi.spec.ts`       | `aio.flags` on the preload bridge: one row in `docs/architecture/contract-changes.md` | desktop (main, preload, renderer, e2e) |
| 8    | `Media` split test, `Issues` split test, `AgentDock` test                                 | add `split-resize.spec.ts`; run the Media spec (`*-media.spec.ts`), `issue-card.spec.ts`, `agent.spec.ts`, `agent-show.spec.ts`                                           | none                                                                                  | desktop                                |
| 9    | `contrast.test.ts` (all light pairs), `cssGuard` amber count                              | run `a11y.spec.ts`                                                                                                                                                        | none                                                                                  | ui, desktop                            |
| 10   | `pnpm check`                                                                              | every spec above, the CI way                                                                                                                                              | none                                                                                  | n/a                                    |
| 11   | `cssGuard.test.ts` (allow list shrinks)                                                   | none expected                                                                                                                                                             | none                                                                                  | ui, desktop                            |
| 12   | `Button.test.tsx` (variants used), guard counts                                           | selector rewrites for migrated button classes (list in Task 12)                                                                                                           | none                                                                                  | ui, desktop                            |
| 13   | `Menu.test.tsx`, `Popover.test.tsx`                                                       | `selectOption` â†’ menu clicks where a select became a menu (list in Task 13)                                                                                             | none                                                                                  | ui, desktop                            |
| 14   | `Tabs.test.tsx`, `Chip.test.tsx`                                                          | selector rewrites for retired chip classes (`.dtag`)                                                                                                                      | none                                                                                  | ui, desktop                            |
| 15   | `Row.test.tsx`, `EmptyState.test.tsx`, `eyes.test.tsx`                                    | selector rewrite for `.lib-empty`; run `sidebar-menus.spec.ts`, `walk` and tree specs                                                                                     | none                                                                                  | ui, desktop                            |
| 16   | `Tip.test.tsx`, guard `title=` count                                                      | `title` assertions â†’ accessible name or description: `agent-show.spec.ts:964`, `connection.spec.ts:123,176`, `offline-cloud-ai.spec.ts:140`, `photo-change.spec.ts:276` | none                                                                                  | ui, desktop                            |
| 17   | `pnpm check`                                                                              | every changed spec, the CI way                                                                                                                                            | none                                                                                  | n/a                                    |

---

## Milestone A

### Task 1: Tokens, guard, contrast, portal surface and the parts scaffold

**Files:**

- Modify: `packages/ui/src/tokens.css`, `packages/ui/src/tokens.test.ts`, `packages/ui/src/mission.css`, `packages/ui/src/index.ts`, `apps/desktop/src/renderer/rtl.test.ts`
- Create: `packages/ui/src/cssGuard.test.ts`, `packages/ui/src/cssGuard.allow.json`, `packages/ui/src/contrast.ts`, `packages/ui/src/contrast.test.ts`, `packages/ui/src/portal.ts`, `packages/ui/src/portal.test.ts`, `packages/ui/src/parts/{button,tip,surface,tabs,chip,row,empty,split}.css`, stub modules `Tip.tsx`, `Menu.tsx`, `Tabs.tsx`, `Chip.tsx`, `Row.tsx`, `EmptyState.tsx`, `split/index.ts`, and `Button` / `IconButton` stubs in `controls.tsx`

**Interfaces:**

- Produces (every name exported from `@aio/ui` by this task, so batch A2 never touches `index.ts`):
  - `contrastRatio(a: string, b: string): number` (oklch strings as in tokens.css).
  - `portalSurfaceAttrs(opener: Element | null): Partial<Record<'data-surface' | 'data-theme' | 'data-contrast' | 'data-motion' | 'dir', string>>`: the nearest values walking up from the opener, falling back to `<html>`.
  - `PortalRoot({ opener, children, className }: { opener: Element | null; children: ReactNode; className?: string }): ReactPortal` rendering into `document.body` with those attributes on its wrapper.
  - Stub signatures for `Button`, `IconButton`, `Tip`, `Menu`, `Tabs`, `Chip`, `Row`, `EmptyState`, `SplitPane`, `useSplit` exactly as in Tasks 2 to 6 (body `throw new Error('not built')`), with their prop types exported.

- [ ] **Step 1: Write the failing token tests** in `tokens.test.ts`

```ts
it('has the spacing, elevation, layer, duration and type role tokens', () => {
  const want = {
    '--sp-1': '2px',
    '--sp-2': '4px',
    '--sp-3': '6px',
    '--sp-4': '8px',
    '--sp-5': '12px',
    '--sp-6': '16px',
    '--sp-7': '24px',
    '--sp-8': '32px',
    '--z-stage-ui': '10',
    '--z-panel': '20',
    '--z-pop': '40',
    '--z-drawer': '60',
    '--z-toast': '70',
    '--z-modal': '80',
    '--d-1': '120ms',
    '--d-2': '180ms',
    '--d-3': '260ms',
    '--t-title': 'var(--t-13)',
    '--fw-title': '600',
    '--caps-ls': '.06em',
    '--el-2': '0 12px 32px var(--shadow)',
    '--el-3': '0 24px 64px var(--shadow)',
  };
  for (const [k, v] of Object.entries(want)) expect(dark.get(k), k).toBe(v);
});
it('gives amber text its own ink in both themes', () => {
  expect(dark.get('--warn-ink')).toBe('var(--s3)');
  expect(light.get('--warn-ink')).toBe('oklch(0.52 0.12 75)');
});
```

Also extend `NON_COLOUR` to `/^--(f-|t-|r-|ease|sb-|tb-|sp-|el-|z-|d-|caps-|fw-)/`, and add `--r-pill` and `--el-1`.

- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/tokens.test.ts`; expected FAIL on the missing tokens.
- [ ] **Step 3: Add the tokens** to `tokens.css` (`:root` block; `--warn-ink` in the light and `data-contrast='more'` blocks too). `--el-1` is `0 0 0 1px var(--line)`; `--r-pill` is `999px`.
- [ ] **Step 4: Run** it again; expected PASS.
- [ ] **Step 5: Write `contrast.test.ts`**: `contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')` is `21` to 1 decimal; `contrastRatio` of light `--warn-ink` on light `--bg-1` is `>= 4.5`; light `--s3` on light `--bg-1` is `< 3` (the reason for the token). Implement `contrast.ts` (oklch â†’ OKLab â†’ linear sRGB â†’ WCAG relative luminance; clamp to gamut). Run; PASS.
- [ ] **Step 6: Write `portal.test.ts`** (jsdom): an opener inside `<div data-surface="dark">` under `<html data-theme="light">` gives `{ 'data-surface': 'dark', 'data-theme': 'light' }`; an opener with no ancestors gives the `<html>` attributes only; `null` gives `{}`. `PortalRoot` renders its child under `document.body` with those attributes. Implement `portal.ts`. Run; PASS.
- [ ] **Step 7: Write `cssGuard.test.ts`**: scans `packages/ui/src/**/*.css` and `apps/desktop/src/renderer/**/*.css` except `reportPage/`, collecting per file the count of: raw px `font-size` (not `var(`), raw colours (`#hex`, `rgb(`, `oklch(` outside `tokens.css`), raw `box-shadow` (no `var(--el-` / `none`), raw `z-index` (a number), and `title=` in `**/*.tsx`. It fails when any count is above `cssGuard.allow.json`, and fails when a count is below it with the message "lower the allow list" (so it only shrinks). Generate the allow list from today's counts with a `--write` script path inside the test file guarded by `process.env.CSS_GUARD_WRITE === '1'`. Run with the env to write, then without; PASS.
- [ ] **Step 8: Fix focus-visible** (decision 7): in `mission.css` the global `:focus-visible` rule (about line 40) drops `border-radius`; remove the local override on `.dbar-date` in `styles.css`. Add a test to `cssGuard.test.ts`: the `:focus-visible` block in `mission.css` contains no `border-radius`.
- [ ] **Step 9: Scaffold the parts.** Create the eight `parts/*.css` files; `mission.css` starts with `@import './parts/button.css';` etc. Move verbatim the existing `.btn*` block (mission.css about lines 114 to 172) to `parts/button.css`, `.tip` (about 439 to 460) to `parts/tip.css`, `.sev`, `.tag`, `.chip-status` (about 278 to 340) to `parts/chip.css`, `.seg` (about 173 to 205) to `parts/tabs.css`. Add the eight files to the file map in `rtl.test.ts`. Write the stub modules and their exports in `index.ts`.
- [ ] **Step 10: Run** `pnpm check`; expected green. Open the app once (`pnpm -F @aio/desktop dev`) and compare the Scene and Settings at 1100 x 720 with the review screenshots: the moved rules must look identical.
- [ ] **Step 11: Commit** `feat(ui): foundation tokens, CSS guard, contrast check and the parts scaffold`.

### Task 2: Button family

**Files:**

- Modify: `packages/ui/src/controls.tsx`, `packages/ui/src/parts/button.css`, `packages/ui/src/i18n/en.ts` (none expected; reasons come from callers)
- Test: `packages/ui/src/Button.test.tsx`

**Interfaces:**

- Consumes: `Tip`'s props type from Task 1's stub (render through it once Task 3 lands; until then the reason goes on `aria-describedby` only), `Icon`, `IconName`, `ShortcutId`, `ariaKeys`.
- Produces:

```ts
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'icon' | 'link';
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  size?: ButtonSize; // default 'sm'
  variant?: ButtonVariant; // default 'secondary'
  pressed?: boolean; // a toggle: sets aria-pressed
  busy?: boolean;
  disabled?: boolean; // no reason: native disabled
  disabledReason?: string; // aria-disabled, click ignored, reason in the tooltip
  icon?: IconName;
  shortcut?: ShortcutId;
  tip?: string;
}
export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>;
export interface IconButtonProps extends Omit<ButtonProps, 'variant' | 'children' | 'icon'> {
  icon: IconName;
  label: string; // the accessible name and the tooltip
}
export const IconButton: ForwardRefExoticComponent<
  IconButtonProps & RefAttributes<HTMLButtonElement>
>;
```

Class output: `btn` plus the size (`sm`, `md`, `lg`) plus the variant name.

- [ ] **Step 1: Write the failing tests**: `Button` renders `class="btn sm secondary"` and `type="button"` by default; `size="lg" variant="primary"` gives `btn lg primary`; `pressed` gives `aria-pressed="true"` and `pressed={false}` gives `aria-pressed="false"`; `disabledReason="Add photos first"` gives `aria-disabled="true"`, no `disabled` attribute, an `aria-describedby` pointing at text "Add photos first", and a click does not call `onClick`; `busy` gives `aria-busy="true"`, a `.spin` element instead of the icon, and a click does not call `onClick`; `disabled` alone gives the native attribute; `IconButton` has `aria-label` = `label` and `class` containing `icon`.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/Button.test.tsx`; FAIL.
- [ ] **Step 3: Implement** `Button` and `IconButton` in `controls.tsx` (forwardRef; the busy width lock is `min-width` set from the measured width on the busy edge).
- [ ] **Step 4: Style** in `parts/button.css`: heights 24 / 28 / 32 via `--sp` tokens and `--r-4`; `quiet` takes today's `.ghost` look (keep `.ghost` as is until Task 12); `link`; `[aria-pressed='true']` = `--acc-a20` fill and `--acc` glyph; `[aria-disabled='true']` keeps pointer events (remove `pointer-events: none` from today's rule) and dims to `--fg-3`; `[aria-busy='true']` hides the icon slot and shows `.spin`. Move `.btn.danger` here from `apps/desktop/src/renderer/styles.css` (map packs section).
- [ ] **Step 5: Run** the test; PASS. Run `pnpm vitest run packages/ui apps/desktop/src/renderer/rtl.test.ts`; PASS.
- [ ] **Step 6: Commit** `feat(ui): one button family with pressed, busy and disabled-with-reason states`.

### Task 3: Tooltip

**Files:**

- Modify: `packages/ui/src/Tip.tsx`, `packages/ui/src/parts/tip.css`
- Test: `packages/ui/src/Tip.test.tsx`

**Interfaces:**

- Consumes: `PortalRoot` (Task 1), `Kbd`, `shortcutHint`.
- Produces:

```ts
export const TIP_DELAY_MS = 400;
export const TIP_SKIP_MS = 0; // while moving from one tip to the next within 600 ms
export interface TipProps {
  content: ReactNode;
  shortcut?: ShortcutId;
  placement?: 'top' | 'bottom' | 'start' | 'end'; // default 'bottom'
  repeatsName?: boolean; // the content repeats the accessible name: aria-hidden
  children: ReactElement; // one focusable element; Tip adds aria-describedby unless repeatsName
}
export function Tip(props: TipProps): ReactElement;
```

- [ ] **Step 1: Write the failing tests** (fake timers): hovering shows nothing at 399 ms and the tip at 400 ms; keyboard focus shows it after 400 ms; after one tip hid less than 600 ms ago the next shows at 0 ms; Escape and blur hide it; with `repeatsName` the tip has `aria-hidden="true"` and the child has no `aria-describedby`; without it the child's `aria-describedby` points at the tip id; the tip renders under `document.body` and, for a child inside `[data-surface="dark"]` in `<html data-theme="light">`, its wrapper carries `data-surface="dark"`; on an `aria-disabled` child, focus still shows the tip.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/Tip.test.tsx`; FAIL.
- [ ] **Step 3: Implement** `Tip`: positions with the opener's `getBoundingClientRect`, kept 8 px inside the window; fade 120 ms (`--d-1`).
- [ ] **Step 4: Style** `.tip-pop` in `parts/tip.css` (`--z-toast` layer, `--r-4`, `--el-2`, mono `.kbd`); leave today's inline `.tip` rule as is (PanelHandle and the sidebar still use it until Task 16).
- [ ] **Step 5: Run**; PASS. **Step 6: Commit** `feat(ui): one tooltip for hover and keyboard focus`.

### Task 4: One floating surface: Popover, Menu, dialogs, toasts

**Files:**

- Modify: `packages/ui/src/Popover.tsx`, `packages/ui/src/Menu.tsx`, `packages/ui/src/parts/surface.css`, `apps/desktop/src/renderer/builder/builder.css` (remove `.dmenu` block at about line 720), `apps/desktop/src/renderer/report/reports.css` (remove `.toasts` and `.toast*` at about 360 to 410)
- Test: `packages/ui/src/Popover.test.tsx`, `packages/ui/src/Menu.test.tsx`

**Interfaces:**

- Consumes: `PortalRoot`, `useFocusTrap`, `arrowFocus`.
- Produces:

```ts
// PopoverProps gains (all optional, existing callers unchanged):
title?: ReactNode; // title row at --t-title / --fw-title with a close button
footer?: ReactNode;
closeLabel?: string; // the close button's name; default t('dialog.close')
// anchored popovers render through PortalRoot (opener's surface); the box has class 'surface-pop'

export type MenuEntry =
  | { id: string; label: string; icon?: IconName; shortcut?: ShortcutId; checked?: boolean;
      danger?: boolean; disabledReason?: string; onSelect: () => void }
  | 'separator';
export interface MenuProps {
  open: boolean;
  onClose: () => void;
  opener: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuEntry[];
  anchor?: 'above' | 'below'; // default 'below'
  testId?: string;
}
export function Menu(props: MenuProps): ReactElement | null;
```

- [ ] **Step 1: Write the failing tests.** Popover: with `title="Layers"` a heading "Layers" and a button named by `closeLabel` render and the button calls `onClose`; an anchored popover opened from inside `[data-surface="dark"]` renders a wrapper with `data-surface="dark"`; the box has class `surface-pop`. Menu: renders `role="menu"` named `label` with `role="menuitem"` rows (`menuitemcheckbox` when `checked` is defined); ArrowDown and ArrowUp move focus and wrap, Home and End jump; Enter on an item calls `onClose` **before** `onSelect` (record order in an array: `['close', 'select']`); an item with `disabledReason` has `aria-disabled="true"`, does not call `onSelect`, and its reason is its `aria-description`; Escape closes and focus returns to the opener.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/Popover.test.tsx packages/ui/src/Menu.test.tsx`; FAIL.
- [ ] **Step 3: Implement** the Popover additions and `Menu` (renders through `Popover` with `anchor`; item rows use class `row` with `data-kind="menu"`; the select-after-close order is the stacking rule of decision 3).
- [ ] **Step 4: Style** `parts/surface.css`: `.surface-pop` (`--bg-1`, `1px solid var(--line)`, `--r-6`, `--el-2`, `z-index: var(--z-pop)`), `.surface-dlg` (`--el-3`, `--z-modal`), the popover title row, checkbox column alignment; move `.dmenu` and every `.toast*` rule here verbatim, then change the toasts: no `border-left` stripe, a leading status icon slot, `inset-inline-end`, `--z-toast`.
- [ ] **Step 5: Run** the tests, then `pnpm vitest run apps/desktop/src/renderer/rtl.test.ts`; PASS. Open a tree context menu and trigger a toast (export something in the demo) at 1100 x 720: both look as before apart from the stripe.
- [ ] **Step 6: Commit** `feat(ui): one floating surface for menus, popovers, dialogs and toasts`.

### Task 5: Tabs, chips, rows and the empty state

**Files:**

- Modify: `packages/ui/src/{Tabs,Chip,Row,EmptyState}.tsx`, `packages/ui/src/parts/{tabs,chip,row,empty}.css`
- Test: `packages/ui/src/{Tabs,Chip,Row,EmptyState}.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface TabItem<K extends string> {
  id: K;
  label: string;
  count?: number;
}
export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  label: string; // the tablist's name
  idPrefix: string; // tab ids `${idPrefix}-tab-${id}`, panels `${idPrefix}-panel-${id}`
}
export function Tabs<K extends string>(props: TabsProps<K>): ReactElement;

export type ChipKind = 'tag' | 'status' | 'sev';
export interface ChipProps {
  kind: ChipKind;
  children: ReactNode;
  tone?: 'acc' | 'off' | 'warn' | 'danger'; // tag and status only
  color?: string; // sev only: the model colour (as SevChip)
}
export function Chip(props: ChipProps): ReactElement;

export type RowKind = 'nav' | 'tree' | 'menu' | 'palette'; // 32, 26, 30, 34 px
export interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  kind: RowKind;
  label: ReactNode;
  icon?: IconName;
  count?: number | string;
  selected?: boolean; // aria-current or aria-selected is the caller's; this sets data-selected
  actions?: ReactNode; // the trailing 24 x 24 "â‹¯" button
  as?: 'div' | 'button' | 'a' | 'li';
}
export function Row(props: RowProps): ReactElement;

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}
export function EmptyState(props: EmptyStateProps): ReactElement;
```

- [ ] **Step 1: Write the failing tests.** Tabs: `role="tablist"` named `label`, the selected tab has `aria-selected="true"` and `tabIndex 0`, others `-1`; ArrowRight and ArrowLeft move and call `onChange` (reversed under `dir="rtl"`); a `count` renders in a mono span. Chip: `kind="tag"` gives class `tag`, `status` gives `chip-status` with a `.dot`, `sev` gives `sev` with `--sev` set from `color`. Row: class `row`, `data-kind`, `data-selected` when selected; the count is in `.row-count`; `actions` render in `.row-acts`. EmptyState: a heading with `title`, the body, and the action.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/Tabs.test.tsx packages/ui/src/Chip.test.tsx packages/ui/src/Row.test.tsx packages/ui/src/EmptyState.test.tsx`; FAIL.
- [ ] **Step 3: Implement** the four components.
- [ ] **Step 4: Style.** `parts/tabs.css`: `.tabs` (today's `.ph-tabs` underline look from `photogrammetry/photo.css`, promoted; leave `.ph-tabs` until Task 14). `parts/chip.css`: `.tag` tones. `parts/row.css`: `.row` heights per `data-kind`; hover `--bg-2`; `[data-selected]` = `--bg-3` with label and icon in `--acc`; no leading bar; count mono 11 `--fg-3`; `.row-acts` visible on hover and on `[data-selected]`, each target at least 24 px. `parts/empty.css`: one `.empty` look.
- [ ] **Step 5: Run**; PASS. **Step 6: Commit** `feat(ui): tabs, chips, one row base and one empty state`.

### Task 6: SplitPane

**Files:**

- Create: `packages/ui/src/split/model.ts`, `split/prefs.ts`, `split/useSplit.ts`, `split/SplitPane.tsx`; modify `split/index.ts`, `parts/split.css`, `i18n/en.ts` (`split.readout`: "{px} px")
- Test: `split/model.test.ts`, `split/prefs.test.ts`, `split/SplitPane.test.tsx`

**Interfaces:**

- Produces:

```ts
// model.ts (pure)
export const SPLIT_STEP = 16;
export const SPLIT_STEP_BIG = 64;
export const SNAP_MARGIN = 48;
export interface SplitLimits {
  min: number; // sized pane, px
  max: number | `${number}%`; // sized pane
  otherMin: number; // the other pane, px
}
export function clampSplit(size: number, container: number, l: SplitLimits): number;
export function snapsToCollapse(size: number, l: SplitLimits): boolean; // size < min - SNAP_MARGIN
export function keyStep(key: string, shift: boolean, rtl: boolean, sized: 'start' | 'end'): number | 'min' | 'max' | 'toggle' | null;

// prefs.ts
export interface SplitPref { size: number; collapsed?: boolean }
export const SPLIT_PREFS_KEY = 'quadrion.splits';
export function createSplitPrefs(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): StoreApi<{
  byId: Record<string, SplitPref>;
  save(id: string, pref: SplitPref): void;
}>;
export const splitPrefs: StoreApi<...>; // the app's instance on localStorage

// useSplit.ts
export interface SplitOptions extends SplitLimits {
  id: string; // prefs key, e.g. 'media.viewer'
  orientation: 'horizontal' | 'vertical'; // horizontal: side by side, col-resize
  sized: 'start' | 'end'; // which pane carries the size
  unit: 'px' | 'fraction';
  defaultSize: number; // px, or 0..1 for fraction
  collapsedSize?: number; // 12 (strip) or 52 (rail); absent: not collapsible
  collapsed?: boolean; // controlled collapse (shortcuts keep working)
  onCollapsedChange?: (collapsed: boolean) => void;
}
export function useSplit(o: SplitOptions): {
  containerRef: RefObject<HTMLDivElement | null>;
  separatorProps: HTMLAttributes<HTMLDivElement> & { role: 'separator' };
  collapsed: boolean;
  reset(): void;
  toggle(): void;
};

// SplitPane.tsx
export interface SplitPaneProps extends SplitOptions {
  label: string; // the separator's accessible name, e.g. "Resize the library"
  start: ReactNode;
  end: ReactNode;
  className?: string;
}
export function SplitPane(p: SplitPaneProps): ReactElement;
```

The container carries `--split-size` (px, or a fraction times 100 as `%`); the panes are a grid `var(--split-size) minmax(0, 1fr)` (or reversed for `sized: 'end'`); each pane has `container-type: inline-size`.

- [ ] **Step 1: Write the failing model tests**: `clampSplit(600, 1100, { min: 280, max: '50%', otherMin: 360 })` is `550`; `clampSplit(100, 1100, { min: 280, max: 600, otherMin: 360 })` is `280`; with container `500` and `{ min: 280, max: 600, otherMin: 360 }` the result is `280` (the data pane gives way only after chrome reached its min); `snapsToCollapse(231, { min: 280, ... })` is `true` and `232` is `false`; `keyStep('ArrowLeft', false, false, 'end')` is `16` (the end pane grows when its edge moves left), `keyStep('ArrowLeft', false, true, 'end')` is `-16`, Shift gives 64, `Home` gives `'min'`, `End` `'max'`, `Enter` `'toggle'`.
- [ ] **Step 2: Write the failing prefs tests**: a fresh store has `{}`; `save('media.viewer', { size: 0.6 })` writes `{"media.viewer":{"size":0.6}}` under `quadrion.splits`; a store read from `"x"`, from `{"media.viewer":{"size":"wide"}}`, or from a `getItem` that throws has `{}`; a `setItem` that throws keeps the value in memory.
- [ ] **Step 3: Write the failing component tests** (jsdom, stubbed `getBoundingClientRect` and `requestAnimationFrame`): the separator has `role="separator"`, `aria-orientation="vertical"` for horizontal splits, `aria-valuenow/min/max`, `aria-controls` the sized pane, `tabIndex 0` and the `label`; pointer down, move by 40 px and up sets `--split-size` and calls `save` **once** (on up), not per move; ArrowLeft on a `sized: 'end'` split grows the end pane by 16; double-click resets to `defaultSize` and saves; dragging below `min - 48` sets `collapsed` and calls `onCollapsedChange(true)`; `toggle()` after a drag-collapse restores the last size, not the default; under `dir="rtl"` pointer moves invert; no React render happens during pointer moves (count renders with a ref).
- [ ] **Step 4: Run** `pnpm vitest run packages/ui/src/split`; FAIL.
- [ ] **Step 5: Implement** `model.ts`, `prefs.ts`, `useSplit.ts`, `SplitPane.tsx`. Pointer moves write the variable inside `requestAnimationFrame`; `save` runs on pointer up, double-click, key and toggle. FloatingVideo (`apps/desktop/src/renderer/workspace/videoWindow.ts`) and MapSwipe are the references for keyboard and reset.
- [ ] **Step 6: Style** `parts/split.css`: the handle is a 1 px `--line-soft` hairline with an 8 px hit area; after 150 ms hover, 2 px `--acc-a40` and the resize cursor; while dragging `--acc` and the `.kbd` readout "420 px" beside the pointer; snap, reset and collapse use a 180 ms transform; reduced motion instant.
- [ ] **Step 7: Run**; PASS. **Step 8: Commit** `feat(ui): one resizable split with keyboard, memory, reset and collapse`.

### Task 7: The shell on splits: left sidebar, auto-fold, stage and right panel, folds by transform

**Files:**

- Modify: `apps/desktop/src/renderer/App.tsx`, `shell/Sidebar.tsx`, `workspace/WorkspaceScreen.tsx` (outer layout and `ctx-wrap`), `panelPrefs.ts`, `styles.css` (`.app`, `.brand`, `.sidebar`, `.ws`, `.right`, `.ctx-wrap`), `src/preload/index.ts`, `src/main/index.ts`, `e2e/fixtures.ts`, `docs/architecture/contract-changes.md`
- Create: `apps/desktop/src/renderer/shell/autoFold.ts`, `shell/autoFold.test.ts`, `e2e/sidebar-autofold.spec.ts`
- Test: `panelPrefs.test.ts`, `autoFold.test.ts`, existing `shell` and `PanelHandle` tests

**Interfaces:**

- Consumes: `SplitPane`, `useSplit` (Task 6); `Tip` is not needed here (PanelHandle keeps its own tip until Task 16).
- Produces:

```ts
// shell/autoFold.ts
export const AUTO_FOLD_BELOW = 1280;
export type FoldScreen = 'scene' | 'issues' | 'media' | 'detections' | 'reports' | string;
export function sidebarFolded(i: {
  setting: boolean; // settings.sidebarCollapsed (the person's choice)
  windowWidth: number;
  screen: FoldScreen;
  autoFold: boolean; // window.aio.flags.autoFold
  reopened: boolean; // panelPrefs.sidebarReopened
}): boolean;
// panelPrefs.ts: PanelPrefs gains `sidebarReopened: boolean` (default false)
// preload: bridge.flags = { autoFold: boolean } (false when argv has --quadrion-autofold=0)
```

Split ids: `shell.sidebar` (px, default 252, min 220, max 320, collapsedSize 52), `scene.right` (px, sized `end`, default 360, or 400 on volumetric, min 280, max `50%`, collapsedSize 12), `scene.ctxAgent` (vertical, fraction, default 0.62, min 160, otherMin 96).

- [ ] **Step 1: Write the failing `autoFold` tests**: `sidebarFolded({ setting: false, windowWidth: 1100, screen: 'scene', autoFold: true, reopened: false })` is `true`; the same with `reopened: true` is `false`; `windowWidth: 1280` is `false`; `screen: 'settings'` is `false`; `autoFold: false` is `false`; `setting: true` is `true` at any width.
- [ ] **Step 2: Write the failing `panelPrefs` tests**: defaults gain `sidebarReopened: false`; `{"rightCollapsed":true}` parses to `sidebarReopened: false`; a stored `true` round-trips.
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/renderer/shell/autoFold.test.ts apps/desktop/src/renderer/panelPrefs.test.ts`; FAIL.
- [ ] **Step 4: Implement** `autoFold.ts` and the pref. In `App.tsx`, the effective `data-sb` uses `sidebarFolded` with `window.innerWidth` (listen to `resize`); Ctrl+B on an auto-folded sidebar sets `sidebarReopened: true` instead of writing the setting; Ctrl+B again writes the setting as today. Main adds `--quadrion-autofold=0` to `webPreferences.additionalArguments` when `QUADRION_E2E === '1'` and `QUADRION_E2E_AUTOFOLD !== '1'`; the preload exposes `flags.autoFold`. Add the contract row.
- [ ] **Step 5: Put the shell on splits.** The sidebar width comes from `shell.sidebar`; the 52 px rail is its own element that fades in (`opacity`, `--d-2`); remove `transition: width` from `.sidebar` and `.brand` and `transition: grid-template-columns` from `.ws`. Folding slides the panel out with `transform` for 180 ms, then the grid snaps once (on `transitionend`; at once under reduced motion). The workspace's stage and right panel use `scene.right`, with `rightCollapsed` as its controlled collapse so Ctrl+Alt+B keeps working; the right panel's context and agent use `scene.ctxAgent`. `PanelHandle` stays centred on each edge with its behaviour and test unchanged.
- [ ] **Step 5b: Wire the button tooltips.** Now that Task 3 has landed, `Button` and `IconButton` in `packages/ui/src/controls.tsx` render `tip`, `shortcut` and `disabledReason` through `Tip` (`repeatsName` when the tip equals the `aria-label`); extend `Button.test.tsx`: focusing a `disabledReason` button shows a tip with the reason after 400 ms.
- [ ] **Step 6: Pin the sidebar in e2e.** `launchApp` in `e2e/fixtures.ts` passes nothing new by default (main pins it); `sidebar-autofold.spec.ts` launches with `QUADRION_E2E_AUTOFOLD=1` at 1100 x 720 and checks: the sidebar is the 52 px rail on the Scene; Ctrl+B opens it; after a relaunch it is still open; on Settings it is open at 1100.
- [ ] **Step 7: Run** the unit tests, then `pnpm check`, then from `apps/desktop` the CI way: `sidebar-autofold.spec.ts`, `panels.spec.ts`, `shell.spec.ts`, `a11y.spec.ts`, `sidebar-menus.spec.ts`, `sidebar-multi.spec.ts`; all pass and print `[e2e] window 1100 x 720 px at display scale 1`.
- [ ] **Step 8: Commit** `feat(desktop): put the shell on resizable splits and fold panels without resizing the views`.

### Task 8: Media, Issues and the agent dock on splits

**Files:**

- Modify: `apps/desktop/src/renderer/screens/Media.tsx`, `screens/Issues.tsx`, `agent/AgentDock.tsx`, `styles.css` (`.media.with-viewer`, `.issues-screen`, `.agent-dock`, the `[data-agent-dock='open']` overrides at about lines 2403 to 2440)
- Create: `apps/desktop/e2e/split-resize.spec.ts`
- Test: component tests beside each screen (`screens/Media.split.test.tsx`, `screens/Issues.split.test.tsx`, `agent/AgentDock.test.tsx` extended)

**Interfaces:**

- Consumes: `SplitPane` (Task 6); `i18n` keys `split.media`, `split.issues`, `split.agentDock` ("Resize the library", "Resize the issue list", "Resize the assistant").

Split ids: `media.viewer` (fraction, sized `end`, default 0.54, gallery min 200 â†’ `otherMin: 200`, viewer `min: 360`, max `80%`), `issues.card` (px, sized `end`, default 420, min 320, otherMin 280, max `60%`), `agent.dock` (px, sized `end`, default `min(360, 33% of window)` computed at first open, min 280, max `50%`).

- [ ] **Step 1: Write the failing tests**: Media with a photo open renders a separator named "Resize the library" whose `aria-valuenow` corresponds to 54%; without a photo there is no separator; Issues renders "Resize the issue list" with `aria-valuenow` 420; the open dock renders "Resize the assistant"; the closed dock renders none.
- [ ] **Step 2: Run** the three tests; FAIL.
- [ ] **Step 3: Implement**: wrap each layout in `SplitPane`; delete the fixed `grid-template-columns` rules and their agent-dock overrides that the splits now own (chrome gives way through `clampSplit`).
- [ ] **Step 4: Write `split-resize.spec.ts`**: open the demo tank farm, Media, open a photo; drag the handle 200 px toward the gallery: the viewer grows; reload: the size is kept; double-click: back to the default; focus the handle and press ArrowLeft 3 times: `aria-valuenow` changes by 48 px; Issues: drag the card wider; open the agent dock and drag it.
- [ ] **Step 5: Run** the unit tests, `pnpm check`, then the CI way: `split-resize.spec.ts`, the Media spec (`*-media.spec.ts`), `issue-card.spec.ts`, `agent.spec.ts`, `agent-show.spec.ts`; pass.
- [ ] **Step 6: Commit** `feat(desktop): resizable Media viewer, Issues card and agent dock`.

### Task 9: Light theme contrast and the dark surface rule

**Files:**

- Modify: every CSS file using `--s3` or `--warn` as text `color` (26 uses; list them with `git grep -n -E "color: var\(--(s3|warn)\)" -- '*.css'`), `packages/ui/src/tokens.css` (if a light pair fails), `packages/ui/src/contrast.test.ts`, `packages/ui/src/cssGuard.test.ts`

- [ ] **Step 1: Write the failing tests**: `contrast.test.ts` lists every light text pair (`--fg-0..3`, `--acc` where used as text, `--danger-ink`, `--warn-ink` on `--bg-0..3`) and asserts 4.5:1; `cssGuard.test.ts` asserts `color: var(--s3)` and `color: var(--warn)` occur 0 times as text colour outside `tokens.css`.
- [ ] **Step 2: Run**; FAIL on the amber count (and any pair that fails).
- [ ] **Step 3: Implement**: the 26 text uses take `var(--warn-ink)`; fills and swatches keep `--s3`. Check that the stage's chips (PAUSED, telemetry title) sit inside `[data-surface='dark']`; where a stage overlay is outside it, add the attribute on the overlay root (skip anything the bug sweep already fixed; rebase first if it has merged).
- [ ] **Step 4: Run**; PASS. Compare the review's light screenshots of the Scene, Issues and Settings at 1440 x 900: amber text readable, stage unchanged in dark.
- [ ] **Step 5: Commit** `fix(ui): amber text and stage chips readable in the light theme`.

### Task 10: Gate and Merge A

- [ ] **Step 1:** `pnpm demo:build --quick` and `pnpm check`; green.
- [ ] **Step 2:** Run every spec named in Tasks 7 and 8 the CI way, plus `help.spec.ts` and `project-menu.spec.ts`; all pass.
- [ ] **Step 3:** Screenshots at 1100 x 720 and 1440 x 900, dark and light, of the Scene, Media with a photo, Issues with a card, Settings, compared with the review's set: nothing moved except the handles, the stripe-free toasts and the amber text.
- [ ] **Step 4:** `node tools/agent/finish-task.mjs`, then merge as `CLAUDE.md` sets out (announce, lock, draft PR, green CI, fast-forward). Announce the token names and the exported parts to the other sessions.

## Milestone B

Each task below: list the classes in scope with `git grep`, migrate one area at a time inside the task, delete each old class when its last use goes, rewrite e2e selectors for that class in the same commit, run `pnpm check` and the affected specs the CI way, and lower `cssGuard.allow.json`. **Skip** everything project 2 deletes: `.stbar`, the `.tool` buttons and popovers that live only in the stage toolbar, `StageToolbar`, `toolbarFit.ts`, `.dbar-date` and `DateRow` (tokens only). **Row role classes stay as modifiers** of `.row` holding only their differences (`.nav-item`, `.titem`, `.dfolder-row`, `.cmdk-item`), so the 105 `.nav-item`, 10 `.titem` and 8 `.dfolder-row` e2e selectors stay valid.

### Task 11: Token adoption sweep

- [ ] Replace the 7 hard-coded black shadows and every other raw `box-shadow` with `--el-1/2/3`; map the 31 z-index values onto the six layers (in-between values to the nearest layer; above-within-a-layer becomes a local stacking context); the 29 `3px` radii to `--r-4`; the 16 off-scale font sizes (9, 9.5, 10, 10.5, 11.5, 12.5, 14.5 px) onto the scale; the 10 caps letter-spacings to `--caps-ls`; panel titles to `--t-title` / `--fw-title`; bare `ease` to `var(--ease)` and durations to `--d-1/2/3`.
- [ ] Test: `cssGuard.test.ts` with the lowered allow list; `pnpm check`; screenshots of the Scene, Issues, Settings dark and light.
- [ ] Commit per kind (`style(ui): shadows on elevation tokens`, `style(ui): z-index on layer tokens`, ...).

### Task 12: Buttons

- [ ] Fold the 85 one-off button classes into `.btn` with size and variant (named in the spec: `.tool` outside the stage toolbar, `.tl-bar-btn`, `.search-btn`, `.help-btn`, `.tree-add`, `.tree-foot-btn`, `.ann-btn`, `.ag-btn`, `.rr-chip` as a toggle, `.mm-chip`; the link styles `conn-link`, `link`, `mm-link`, `help-link`, `wplace-link` into `variant="link"`; `.ghost` into `quiet`). Build the full list from `git grep -n -E "^\.[a-z-]+(-btn|btn)\b|button\." -- '*.css'`.
- [ ] Every toggle gets `aria-pressed`; every disabled control that has a reason gets `disabledReason`.
- [ ] e2e: rewrite `.search-btn` and `.tgroup-btn` selectors to test ids or role and name.
- [ ] Commit per area (`refactor(desktop): sidebar buttons on the button family`, ...).

### Task 13: Menus and popovers

- [ ] The 11 surfaces (`.dmenu`, `.proj-menu`, `.stage-pop` outside the stage toolbar, `.xmenu` and the rest, listed with `git grep -n -E "box-shadow" -- '*.css'` among floating boxes) adopt `Popover` / `Menu` and `.surface-pop`. Native `<select>` with 2 to 4 options inside a popover becomes `Menu` or `.seg`; longer lists stay native, restyled with tokens.
- [ ] e2e: `.proj-menu` selectors â†’ test id; `selectOption` on `map-pack`, `media-severity`, `media-order` â†’ menu clicks where those became menus (keep `selectOption` where they stayed native).
- [ ] Commit per surface group.

### Task 14: Tabs, chips and stripes

- [ ] `.ph-tabs` â†’ `.tabs` (keep `.seg ctx-tabs` until project 2); the nine other chip classes onto `tag`, `chip-status`, `sev`; the six `border-left: 3px` accents (toast is done, help, package, road twice, the date folder) become a leading status icon or a tinted fill.
- [ ] e2e: `.dtag` selectors â†’ test id.
- [ ] Commit per kind.

### Task 15: Rows, visible affordances and empty states

- [ ] Nav, tree, menu and palette rows use `.row` with their role class as modifier; the four "selected" looks become the one; the tree eye shows at `--fg-4` at rest (no `opacity: 0`) and the group eye grows to 24 px; row actions become one trailing "â‹¯" `IconButton` opening the same menu as right-click. The 18 empty state classes move onto `EmptyState`.
- [ ] Tests: `eyes.test.tsx` (eye visible at rest: computed opacity is not 0), `DatasetTree.test.tsx`, `walkRows.test.tsx` stay green; e2e `.lib-empty` â†’ test id; run `sidebar-menus.spec.ts`, `sidebar-multi.spec.ts`.
- [ ] Commit per kind.

### Task 16: Tooltips on the shell

- [ ] Every icon-only control in `packages/ui` and in the shell (`apps/desktop/src/renderer/shell/`, the title bar until project 2 removes it) uses `Tip` or `IconButton`; their native `title=` goes, and the text stays as `aria-label` or `aria-describedby`. `PanelHandle` and the sidebar's inline `.tip` move to `Tip`.
- [ ] e2e: `agent-show.spec.ts:964`, `connection.spec.ts:123` and `:176`, `offline-cloud-ai.spec.ts:140`, `photo-change.spec.ts:276` assert the accessible name or description instead of `title`.
- [ ] Test: `cssGuard` `title=` count lowered; `Tip.test.tsx`.
- [ ] Commit `refactor(desktop): shell tooltips on Tip`.

### Task 17: Gate and Merge B

- [ ] `pnpm check`; every spec changed in Tasks 11 to 16 the CI way; screenshots compared as in Task 10; list in the session note every e2e spec touched and why (spec, Constraints).
- [ ] Rebase on `main` (project 2 likely moved), `finish-task.mjs`, merge as `CLAUDE.md` sets out, announce.
</content>

</invoke>

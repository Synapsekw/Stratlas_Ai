# Raw 360 hint and stockpile reopen date: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the user that raw Insta360 files play unstabilised (and how to get a steady MP4), and make stockpile projects reopen on the survey date they were left on.

**Architecture:** Renderer-only changes in `apps/desktop` plus two strings in `@aio/ui`. The hint is decided from data the renderer already has (the import result's file names and statuses, the walk's `source.layout`). The reopen fix makes the saved date win over the volumes' default in `connectVolumeDates` and `timeline.attach`, and moves the timeline shown-or-hidden pref off the storage key the date prefs use.

**Tech Stack:** TypeScript, React, zustand, Vitest, Playwright with Electron.

**Spec:** [2026-10-12-insv-hint-and-stockpile-date-design.md](2026-10-12-insv-hint-and-stockpile-date-design.md)

## Global Constraints

- Worktree `E:\Dev\AIO Software\.claude\worktrees\insv-hint-and-stockpile-date`, branch `fix/insv-hint-and-stockpile-date`. Never edit the main checkout. Never `git add -A`; add the task's files by name. Never `--no-verify`.
- British spelling in strings and docs: "stabilised", "Not stabilised".
- Pane label text: `Not stabilised`. Hint sentence (exact): `Raw 360 camera files play unstabilised. For a steady picture, export the clip from Insta360 Studio with FlowState on and add that MP4 with Add 360 video.`
- Raw camera file test: `/\.(insv|lrv)$/i` on the file name. Walk test: `walk.source.layout !== 'equirect'`.
- New storage key for the timeline shown-or-hidden pref: `stratlas.timeline.shown`. The date prefs keep `stratlas.timeline`.
- No `@aio/schema` change, no IPC change, no `@aio/volumetric` change.
- No client, site or person names in code comments, tests, docs or commit messages (`node tools/agent/check-public-text.mjs <files>`).
- Electron windows stay off-screen (the e2e fixtures do it). e2e with `--workers=1`, one Playwright run at a time.
- Unit tests: `pnpm --filter @aio/desktop exec vitest run <file>` from the worktree root (or `npx vitest run <file>` in `apps/desktop`).

## Review Focus

1. **A raw file that did not import** (skipped proxy beside its clip, cancelled stitch, failed stitch): no hint for it; the hint shows only for an `imported` raw file. Pinned in Task 2 (unit) and Task 4 (the cancel test asserts no hint).
2. **A stitched MP4 walk next to a stitched camera walk**: the pane label follows the walk on screen when the chooser switches. Pinned in Task 4.
3. **Saved date the volumes no longer have** (a survey removed, a renamed capture): falls back to the last survey, no crash, no stuck focus. Pinned in Task 6.
4. **Compare split open while the volumes load**: the volumes are not pushed to the saved date (the pane rules). Pinned in Task 6.
5. **Toggling the timeline, then reopening**: the saved date survives, and the shown-or-hidden choice survives a date change. Pinned in Task 5 (unit, both stores on one storage) and Task 7 (e2e).

---

## Execution DAG

| Task                                | Depends on   | Packages / files                                                                                                                    | Size |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T1 Strings and the pane label       | none         | `@aio/ui` (`en.ts`), `@aio/desktop` (`walks/walkModel.ts`, `walks/walkModel.test.ts`, `walks/Walk360Pane.tsx`)                      | S    |
| T2 Import panel hint                | T1 (strings) | `@aio/desktop` (`builder/rawCamera.ts`, `builder/rawCamera.test.ts`, `builder/ImportPanel.tsx`)                                     | S    |
| T3 Docs                             | none         | `docs/KNOWN-LIMITS.md`, `docs/guide/08-building-projects.md`                                                                        | XS   |
| T4 360 e2e assertions               | T1, T2       | `apps/desktop/e2e/walk-360.spec.ts`                                                                                                 | S    |
| T5 Own key for timeline shown       | none         | `@aio/desktop` (`workspace/timelinePref.ts`, `workspace/timelinePref.test.ts`)                                                      | XS   |
| T6 Saved date wins over the volumes | none         | `@aio/desktop` (`workspace/volumeDates.ts`, `workspace/volumeDates.test.ts`, `workspace/timeline.ts`, `workspace/timeline.test.ts`) | S    |
| T7 Stockpile reopen e2e             | T5, T6       | `apps/desktop/e2e/stockpile-date.spec.ts` (new)                                                                                     | M    |

**Batches** (no shared files inside a batch; dispatch each batch in one message):

- **Batch 1:** T1, T3, T5, T6.
- **Batch 2:** T2, T7.
- **Batch 3:** T4.

**Critical path:** T1 → T2 → T4 (the 360 spec needs ffmpeg and runs a stitch, the slowest run). T6 → T7 runs beside it.

**E2E specs:** changed `apps/desktop/e2e/walk-360.spec.ts` (T4); added `apps/desktop/e2e/stockpile-date.spec.ts` (T7). Run both the CI way before the hand-off.

**Contract changes:** none (no row in `docs/architecture/contract-changes.md`).

**7 tasks**, about half a day of build: four S, two XS, one M.

---

### Task 1: Strings and the pane label

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (beside `'walk.lowRes'`, near line 1875)
- Modify: `apps/desktop/src/renderer/walks/walkModel.ts`
- Test: `apps/desktop/src/renderer/walks/walkModel.test.ts`
- Modify: `apps/desktop/src/renderer/walks/Walk360Pane.tsx:314`

**Interfaces:**

- Produces: i18n keys `walk.unstabilised` (`'Not stabilised'`) and `walk.rawHint` (the hint sentence); `walkUnstabilised(walk: { source: { layout: WalkLayout } }): boolean` exported from `walkModel.ts`.

- [ ] **Step 1: Write the failing test** (append to `walkModel.test.ts`, add `walkUnstabilised` to its import from `./walkModel`)

```ts
describe('walkUnstabilised', () => {
  it('is true for a walk stitched from a camera file, false for a stitched MP4', () => {
    expect(walkUnstabilised({ source: { layout: 'insv-dual-stream' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'dual-fisheye' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'equirect' } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`walkUnstabilised` is not exported)

Run: `npx vitest run src/renderer/walks/walkModel.test.ts` in `apps/desktop`.

- [ ] **Step 3: Implement** (append to `walkModel.ts`)

```ts
import type { WalkLayout } from '@aio/schema';

/**
 * A walk stitched in the app from a camera file plays unstabilised: the camera's gyro data is not
 * read yet. A stitched MP4 (from Insta360 Studio with FlowState, say) is taken as it is.
 */
export function walkUnstabilised(walk: { source: { layout: WalkLayout } }): boolean {
  return walk.source.layout !== 'equirect';
}
```

(Put the `import type` with the other imports at the top of the file.)

In `en.ts`, after `'walk.lowRes': 'Low resolution copy',`:

```ts
  'walk.unstabilised': 'Not stabilised',
  'walk.rawHint':
    'Raw 360 camera files play unstabilised. For a steady picture, export the clip from Insta360 Studio with FlowState on and add that MP4 with Add 360 video.',
```

In `Walk360Pane.tsx`, import `walkUnstabilised` from `./walkModel` and after the `walk.lowRes` span (line 314) add:

```tsx
{
  walkUnstabilised(walk) && (
    <span className="faint" title={t('walk.rawHint')} data-testid="walk-unstabilised">
      {t('walk.unstabilised')}
    </span>
  );
}
```

- [ ] **Step 4: Run the test and the i18n test, expect PASS**

Run: `npx vitest run src/renderer/walks/walkModel.test.ts` in `apps/desktop`; `pnpm --filter @aio/ui exec vitest run src/i18n` at the root. Then `pnpm --filter @aio/desktop typecheck` (or `pnpm typecheck`).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/i18n/en.ts apps/desktop/src/renderer/walks/walkModel.ts apps/desktop/src/renderer/walks/walkModel.test.ts apps/desktop/src/renderer/walks/Walk360Pane.tsx
git commit -m "feat(desktop): mark 360 walks stitched from camera files as not stabilised"
```

---

### Task 2: Import panel hint

**Files:**

- Create: `apps/desktop/src/renderer/builder/rawCamera.ts`
- Test: `apps/desktop/src/renderer/builder/rawCamera.test.ts`
- Modify: `apps/desktop/src/renderer/builder/ImportPanel.tsx` (`ImportStatus`, around lines 314-325)

**Interfaces:**

- Consumes: i18n key `walk.rawHint` (T1).
- Produces: `rawCameraImported(items: readonly { file: string; status: string }[]): boolean`.

- [ ] **Step 1: Write the failing test** (`rawCamera.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { rawCameraImported } from './rawCamera';

describe('rawCameraImported', () => {
  it('is true when a camera file was imported', () => {
    expect(
      rawCameraImported([
        { file: 'LRV_20260101_120000_01_001.lrv', status: 'skipped' },
        { file: 'VID_20260101_120000_00_001.insv', status: 'imported' },
      ]),
    ).toBe(true);
    expect(rawCameraImported([{ file: 'clip.LRV', status: 'imported' }])).toBe(true);
  });

  it('is false for a stitched MP4, a camera file that did not land, or nothing', () => {
    expect(rawCameraImported([{ file: 'Site tour.mp4', status: 'imported' }])).toBe(false);
    expect(rawCameraImported([{ file: 'VID_1.insv', status: 'skipped' }])).toBe(false);
    expect(rawCameraImported([{ file: 'VID_1.insv', status: 'failed' }])).toBe(false);
    expect(rawCameraImported([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (module missing): `npx vitest run src/renderer/builder/rawCamera.test.ts` in `apps/desktop`.

- [ ] **Step 3: Implement** (`rawCamera.ts`)

```ts
/** A file a 360 camera wrote itself, stitched in the app and so played unstabilised. */
const RAW_CAMERA = /\.(insv|lrv)$/i;

/** The import brought in at least one raw 360 camera file. */
export function rawCameraImported(items: readonly { file: string; status: string }[]): boolean {
  return items.some((i) => i.status === 'imported' && RAW_CAMERA.test(i.file));
}
```

In `ImportPanel.tsx`: import `useT` from `@aio/ui` (beside `Icon`) and `rawCameraImported` from `./rawCamera`. In `ImportStatus`, call `const t = useT();` with the other hooks at the top (before any early return). After the `heights` notice and before `<ImportSurveyDate ...>`, add:

```tsx
{
  result && rawCameraImported(result.items) && (
    <p className="notice small" style={{ margin: '0 12px 10px' }} data-testid="import-raw-360-hint">
      <Icon name="info" size={14} />
      {t('walk.rawHint')}
    </p>
  );
}
```

Check `IconName` has `info`; if not, use the icon the heights line uses for its non-warning state or none (`grep -n "'info'" packages/ui/src` first).

- [ ] **Step 4: Run, expect PASS**; then `pnpm typecheck` and `pnpm lint` for `apps/desktop`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/rawCamera.ts apps/desktop/src/renderer/builder/rawCamera.test.ts apps/desktop/src/renderer/builder/ImportPanel.tsx
git commit -m "feat(desktop): import panel says raw 360 camera files play unstabilised"
```

---

### Task 3: Docs

**Files:**

- Modify: `docs/KNOWN-LIMITS.md:44` ("360 video: stitch.")
- Modify: `docs/guide/08-building-projects.md:62-67` (notes under "360 video from a 360 camera")

- [ ] **Step 1: KNOWN-LIMITS.** Replace "the picture is not levelled or stabilised." in line 44 with:

  "the picture is not levelled or stabilised, because the camera's gyro data in the file is not read yet (the import panel and the **360 video** pane say so). For a steady picture, export the clip from Insta360 Studio with FlowState on and add that MP4 with **Add 360 video**."

- [ ] **Step 2: Guide.** Add a bullet in the notes after the `.lrv` bullet (line 66):

  "- A video stitched from the camera's own file plays **unstabilised**: every shake of the walk is in it, and the pane marks it **Not stabilised**. For a steady picture, export the clip from Insta360 Studio with FlowState on and bring that MP4 in with **Add 360 video**."

- [ ] **Step 3: Check.** `npx prettier --write docs/KNOWN-LIMITS.md docs/guide/08-building-projects.md`, `node tools/agent/check-public-text.mjs docs/KNOWN-LIMITS.md docs/guide/08-building-projects.md`. If the guide has a docs test (`grep -rn "08-building-projects" tools apps/desktop/src --include=*.test.*`), run it.

- [ ] **Step 4: Commit**

```bash
git add docs/KNOWN-LIMITS.md docs/guide/08-building-projects.md
git commit -m "docs: raw 360 camera files play unstabilised, export with FlowState instead"
```

---

### Task 4: 360 e2e assertions

**Files:**

- Modify: `apps/desktop/e2e/walk-360.spec.ts`

**Interfaces:**

- Consumes: `data-testid="import-raw-360-hint"` (T2), `data-testid="walk-unstabilised"` (T1), the strings in Global Constraints.

- [ ] **Step 1: Add assertions to the first test** ("a camera clip is stitched on import ..."):
  - after `await expect(panel).toContainText(`low resolution copy of ${CLIP}`);`:

```ts
// a raw camera file plays unstabilised, and the panel says how to get a steady picture
await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(1);
await expect(panel.getByTestId('import-raw-360-hint')).toContainText('FlowState');
```

- after the pane opens on the stitched walk (after `walk-view` is visible):

```ts
await expect(win.getByTestId('walk-unstabilised')).toHaveText('Not stabilised');
await expect(win.getByTestId('walk-unstabilised')).toHaveAttribute('title', /Insta360 Studio/);
```

- after the stitched MP4 has been added through **Add 360 video**: the import panel shows no hint (`await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(0);`), and with the MP4 walk chosen in `walk-which` the label is gone (`toHaveCount(0)`); choosing the camera walk again brings it back.

- [ ] **Step 2: Add to the cancel test**, after `await expect(panel).toContainText('cancelled while this 360 video was made');`:

```ts
// nothing of the raw file landed: no hint
await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(0);
```

- [ ] **Step 3: Run it the CI way** (needs ffmpeg with `v360` and libx264 on the PATH, otherwise the spec skips: say so in the hand-off). From `apps/desktop`:

```bash
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 npx playwright test e2e/walk-360.spec.ts --workers=1
```

Expected: PASS (or skipped with the ffmpeg message).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/walk-360.spec.ts
git commit -m "test(desktop): e2e for the raw 360 hint and the Not stabilised label"
```

---

### Task 5: Own key for the timeline shown-or-hidden pref

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/timelinePref.ts:23` and `createTimelinePref`
- Test: `apps/desktop/src/renderer/workspace/timelinePref.test.ts`

**Interfaces:**

- Produces: `TIMELINE_SHOWN_KEY = 'stratlas.timeline.shown'` exported from `timelinePref.ts`. `createTimelinePref(storage)` signature unchanged.

- [ ] **Step 1: Write the failing tests** (in `timelinePref.test.ts`; import `TIMELINE_SHOWN_KEY` from `./timelinePref` and `createTimelineStore, TIMELINE_KEY` from `./timeline`, `createWorkspace` from `@aio/workspace`)

Change the existing "ignores bad stored values" test to write `TIMELINE_SHOWN_KEY` instead of `'stratlas.timeline'`, then add:

```ts
it('saves under its own key and leaves the date prefs alone', () => {
  const storage = memory();
  storage.setItem('stratlas.timeline', JSON.stringify({ p: { focus: 's1' } }));
  const store = createTimelinePref(storage);
  toggleTimeline({ id: 'p', manifest: { layers: kinds('mesh') } }, store);
  expect(JSON.parse(storage.getItem(TIMELINE_SHOWN_KEY) ?? '{}')).toEqual({ p: true });
  expect(JSON.parse(storage.getItem('stratlas.timeline') ?? '{}')).toEqual({ p: { focus: 's1' } });
});

it('takes the choices saved under the old key once', () => {
  const storage = memory();
  storage.setItem('stratlas.timeline', JSON.stringify({ a: true, b: { focus: 's1' } }));
  expect(createTimelinePref(storage).getState().byProject).toEqual({ a: true });
  storage.setItem(TIMELINE_SHOWN_KEY, JSON.stringify({ c: false }));
  expect(createTimelinePref(storage).getState().byProject).toEqual({ c: false });
});
```

And one test with both stores on one storage (the bug): a `createTimelineStore(createWorkspace(), storage, () => undefined)` and a `createTimelinePref(storage)` sharing a `memory()` storage cast to `Storage` (add `removeItem`, `clear`, `key`, `length` stubs to a local copy, or reuse the `MemoryStorage` class pattern from `volumeDates.test.ts`): seed `TIMELINE_KEY` with `{ p: { focus: 's1' } }`, toggle the pref for `p`, then `createTimelineStore(...)` again on the same storage and assert `getState().byProject.p?.focus === 's1'`.

- [ ] **Step 2: Run, expect FAIL** (the toggle overwrites `stratlas.timeline`).

- [ ] **Step 3: Implement** in `timelinePref.ts`:

```ts
/** Shown or hidden per project. The date prefs (`timeline.ts`) own `stratlas.timeline`. */
export const TIMELINE_SHOWN_KEY = 'stratlas.timeline.shown';
/** Until this fix the choice shared the date prefs' key; its boolean entries are read once. */
const LEGACY_KEY = 'stratlas.timeline';
```

Remove `const KEY = 'stratlas.timeline';`. In `createTimelinePref`:

```ts
  try {
    const saved = storage?.getItem(TIMELINE_SHOWN_KEY);
    initial = parse(saved ?? storage?.getItem(LEGACY_KEY));
  } catch {
```

and in the subscriber `storage?.setItem(TIMELINE_SHOWN_KEY, JSON.stringify(s.byProject));`. (`parse` already keeps booleans only.)

- [ ] **Step 4: Run, expect PASS**; run `timeline.test.ts` too.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/workspace/timelinePref.ts apps/desktop/src/renderer/workspace/timelinePref.test.ts
git commit -m "fix(desktop): timeline shown pref no longer overwrites the saved survey dates"
```

---

### Task 6: The saved date wins over the volumes' default

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/volumeDates.ts` (`sync`, the `current?.projectId !== projectId` block)
- Modify: `apps/desktop/src/renderer/workspace/timeline.ts` (`attach`, the `if (vol)` branch)
- Test: `apps/desktop/src/renderer/workspace/volumeDates.test.ts`
- Test: `apps/desktop/src/renderer/workspace/timeline.test.ts` (only if a test there pins the old volumetric attach; adjust it, do not delete it)

**Interfaces:** none new; `connectVolumeDates` and `TimelineState` signatures unchanged.

- [ ] **Step 1: Make `setup` in `volumeDates.test.ts` take options**, keeping the current behaviour as the default:

```ts
interface SetupOpts {
  /** Date prefs already saved, as on a reopen. */
  saved?: Record<string, DatePref>;
  /** The volumes finish loading before the date bar attaches. */
  volumesFirst?: boolean;
  /** The compare split is open while the volumes load. */
  splitOpen?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  const ws = createWorkspace();
  const storage = new MemoryStorage();
  if (opts.saved) storage.setItem(TIMELINE_KEY, JSON.stringify(opts.saved));
  const tl = createTimelineStore(ws, storage, () => undefined);
  // ... deps and v exactly as today ...
  const compare = testSplit();
  if (opts.splitOpen) compare.set(true);
  const off = connectVolumeDates(v, tl, ws, compare.split);
  ws.getState().openProject({ id: 'm', root: '/m', manifest: stockpile });
  if (opts.volumesFirst) {
    await v.getState().load();
    tl.getState().attach('m', captureIndex(stockpile, volumeHints(v.getState())));
  } else {
    tl.getState().attach('m', captureIndex(stockpile));
    await v.getState().load();
    tl.getState().attach('m', captureIndex(stockpile, volumeHints(v.getState())));
  }
  const saved = () =>
    (JSON.parse(storage.getItem(TIMELINE_KEY) ?? '{}') as Record<string, DatePref>).m;
  return { ws, tl, v, off, saved, compare };
}
```

- [ ] **Step 2: Write the failing tests** (same `describe`):

```ts
it('reopens on the saved survey: the volumes are asked for it, not mirrored', async () => {
  const { tl, v, saved } = await setup({ saved: { m: { focus: 's1' } } });
  expect(tl.getState().owner).toBe('volumetric');
  expect(v.getState().epoch).toBe('e1');
  expect(tl.getState().focus).toBe('s1');
  expect(saved()?.focus).toBe('s1');
});

it('reopens on the saved survey when the volumes load before the date bar attaches', async () => {
  const { tl, v, saved } = await setup({ saved: { m: { focus: 's1' } }, volumesFirst: true });
  expect(v.getState().epoch).toBe('e1');
  expect(tl.getState().focus).toBe('s1');
  expect(saved()?.focus).toBe('s1');
});

it('a saved survey the volumes do not have falls back to their last survey', async () => {
  const { tl, v } = await setup({ saved: { m: { focus: 'gone' } } });
  expect(v.getState().epoch).toBe('e2');
  expect(tl.getState().focus).toBe('s2');
});

it('with the compare split open the volumes are not moved to the saved survey', async () => {
  const { v } = await setup({ saved: { m: { focus: 's1' } }, splitOpen: true });
  expect(v.getState().epoch).toBe('e2');
});

it('a survey picked, another project opened, the stockpile reopened: the picked survey', async () => {
  const { ws, tl, v } = await setup();
  tl.getState().focusSurvey('s1');
  ws.getState().openProject({ id: 'other', root: '/o', manifest: { ...stockpile, id: 'other' } });
  tl.getState().attach('other', captureIndex({ ...stockpile, id: 'other' }));
  await v.getState().load();
  ws.getState().openProject({ id: 'm', root: '/m', manifest: stockpile });
  tl.getState().attach('m', captureIndex(stockpile));
  await v.getState().load();
  expect(v.getState().epoch).toBe('e1');
  expect(tl.getState().focus).toBe('s1');
});
```

(The `volumesFirst` and `splitOpen` cases read the split as `compare.split`, which `connectVolumeDates` reads; `attach` does not know the split, so in `volumesFirst` + split open the pane hook later sets the date: not tested here.)

- [ ] **Step 3: Run, expect FAIL**: the first, second and fifth tests see `e2` / `s2`.

Run: `npx vitest run src/renderer/workspace/volumeDates.test.ts` in `apps/desktop`.

- [ ] **Step 4: Implement `connectVolumeDates`** (`volumeDates.ts`), replacing the `if (current?.projectId !== projectId) { ... }` block:

```ts
if (current?.projectId !== projectId) {
  current = {
    projectId,
    epochOf: (capture) => v.getState().file?.captures.find((c) => c.captureId === capture)?.epoch,
    epoch: () => v.getState().epoch,
    setEpoch: (epoch) => {
      v.getState().setEpoch(epoch);
    },
  };
  tl.getState().setVolumes(current);
  // The volumes always load on their last survey; the date bar holds the date the project
  // was left on (or picked before they loaded). Ask the volumes for that one instead of
  // mirroring their default over it. Their switch comes back through the subscription.
  const t = tl.getState();
  const wanted = t.projectId === projectId && t.focus ? current.epochOf(t.focus) : undefined;
  if (wanted && wanted !== s.epoch && !split.isOpen()) {
    v.getState().setEpoch(wanted);
    return;
  }
}
```

Update the file's doc comment: "...the date bar asks them for a survey and mirrors the one they show... When they load, they are asked for the date the project was left on, since they always start on their last survey."

- [ ] **Step 5: Implement `attach`** (`timeline.ts`), replacing the `if (vol) { ... }` body:

```ts
      if (vol) {
        // The volumes already show their survey (always their last one on load): the saved date
        // wins when they have it, else focus what they show. The layers stay theirs.
        const savedEpoch =
          pref.focus && index.captures.some((c) => c.id === pref.focus)
            ? vol.epochOf(pref.focus)
            : undefined;
        if (pref.focus && savedEpoch && savedEpoch !== vol.epoch()) {
          set({ projectId, index, owner, focus: pref.focus });
          vol.setEpoch(savedEpoch);
        } else {
          const shown = index.captures.find((c) => vol.epochOf(c.id) === vol.epoch());
          set({ projectId, index, owner, focus: shown?.id ?? initialFocus(index, pref.focus) });
        }
      } else {
```

- [ ] **Step 6: Run, expect PASS** for `volumeDates.test.ts`, `timeline.test.ts`, `timelinePref.test.ts`, and the compare tests (`npx vitest run src/renderer/workspace` in `apps/desktop`). The existing "hands the survey layers to the loaded volumes and mirrors their survey" test (no saved date: `e2` / `s2`) must still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/workspace/volumeDates.ts apps/desktop/src/renderer/workspace/volumeDates.test.ts apps/desktop/src/renderer/workspace/timeline.ts
git commit -m "fix(desktop): stockpile projects reopen on the saved survey date"
```

(Add `timeline.test.ts` only if Step 6 needed a change there.)

---

### Task 7: Stockpile reopen e2e

**Files:**

- Create: `apps/desktop/e2e/stockpile-date.spec.ts`

**Interfaces:**

- Consumes: `test`, `expect`, `openProject`, `tinyGlb`, `type DataRoot` from `./fixtures`; `SCHEMA_VERSION` and `type ProjectManifestInput` as `fixtures.ts` imports them (copy its import lines); `window.__stratlas.volumetric` (exposed in `src/renderer/bootstrap.ts`); test ids `date-bar-open`, `date-name-<capture>`, `timeline-bar`, `project-card`.

- [ ] **Step 1: Write the spec** with its own fixture writer (do not touch `fixtures.ts`):

```ts
/**
 * A stockpile project (volumes over two surveys) reopens on the survey it was left on, not on
 * the volumes' last survey, and showing the timeline does not forget that date. A minimal
 * synthetic project: two dated terrains, a volumes file, no height grids. Off-screen, no network.
 */
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test, tinyGlb, type DataRoot } from './fixtures';
// SCHEMA_VERSION / ProjectManifestInput: import them the way fixtures.ts does

const ID = 'e2e-stockpile-dates';
const NAME = 'E2E stockpile dates';
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const dates = [
  { id: 'd1', epoch: 'e1', date: '2024-09-04', label: '4 Sep 2024' },
  { id: 'd2', epoch: 'e2', date: '2024-10-02', label: '2 Oct 2024' },
];

async function writeStockpile(dataRoot: DataRoot): Promise<void> {
  const dir = join(dataRoot.root, 'projects', ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(join(dir, 'models', 'terrain.glb'), tinyGlb());
  const manifest: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic stockpile, 2 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: dates.map((d) => ({ id: d.id, label: d.label, date: d.date })),
    layers: dates.map((d) => ({
      kind: 'mesh' as const,
      id: `terrain-${d.id}`,
      name: `Terrain ${d.date}`,
      capture: d.id,
      src: { path: 'models/terrain.glb' },
      transform: I,
    })),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const fc = { fill: 0, cut: 0, net: 0 };
  await writeFile(
    join(dir, 'volumes.json'),
    JSON.stringify({
      schema: 'aio.volumes/1',
      densityTPerM3: 1.6,
      deadbandM: 0.1,
      defaultBase: 'tin',
      bases: [{ id: 'tin', label: 'Triangulated toe' }],
      captures: dates.map((d) => ({
        epoch: d.epoch,
        captureId: d.id,
        date: d.date,
        label: d.label,
      })),
      piles: [],
      totals: {},
      pileChange: fc,
      siteChange: fc,
    }),
  );
}

interface Probe {
  __stratlas: { volumetric: { getState(): { status: string; epoch: string } } };
}
const volumes = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.volumetric.getState();
    return { status: s.status, epoch: s.epoch };
  });

async function openStockpile(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(ID);
  await expect.poll(async () => (await volumes(win)).status, { timeout: 30_000 }).toBe('ready');
}

async function reopen(win: Page): Promise<void> {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openStockpile(win);
}

test.describe('stockpile survey date', () => {
  test.beforeEach(async ({ dataRoot, win }) => {
    await writeStockpile(dataRoot);
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
  });

  test('opens on the last survey the first time, then on the survey it was left on', async ({
    win,
  }) => {
    await openStockpile(win);
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await win.getByTestId('date-name-d1').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(async () => (await volumes(win)).epoch).toBe('e1');
    await reopen(win);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(async () => (await volumes(win)).epoch).toBe('e1');
  });

  test('showing the timeline does not forget the date', async ({ win }) => {
    await openStockpile(win);
    await win.getByTestId('date-name-d1').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await win.getByTestId('timeline-bar').click();
    await reopen(win);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
  });
});
```

Notes for the implementer:

- `date-name-<capture>` is the date folder's name button in the tree (as in `timeline.spec.ts`); if the folder is collapsed or the tree differs for a stockpile project, use the date bar calendar as `timeline.spec.ts`'s "calendar jump" test does (`date-bar-open`, `cal-day-2024-09-04`).
- If `status` never reaches `ready` (the volume worker wants height grids), check `packages/volumetric/src/testing.ts` and the volumetric unit fixtures for the smallest grids, and write them under the paths `DEFAULT_GRIDS` names. Record what was needed in the spec's header comment.
- `timeline-bar` is the thin bar that shows the timeline when it is hidden; a project without video starts with it hidden.

- [ ] **Step 2: Run it the CI way.** Tasks 5 and 6 are in by then (their unit tests carried the red step). From `apps/desktop`:

```bash
pnpm demo:build --quick   # once, from the worktree root, if not built yet
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 npx playwright test e2e/stockpile-date.spec.ts --workers=1
```

Expected: 2 passed. Also re-run `e2e/timeline.spec.ts` and `e2e/compare.spec.ts` (non-realdata parts) the same way, since both stores and the date bar changed.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/stockpile-date.spec.ts
git commit -m "test(desktop): e2e for a stockpile project reopening on its saved date"
```

---

## Verify and hand off

1. `pnpm check` green in the worktree.
2. The two e2e specs (and `timeline.spec.ts`) green the CI way, `--workers=1`. Say in the hand-off whether `walk-360.spec.ts` ran or skipped for lack of ffmpeg.
3. `node tools/agent/check-public-text.mjs` on every changed doc and spec.
4. `node tools/agent/finish-task.mjs`; hand off. No merge-order needs; touches `ImportPanel.tsx`, `timeline.ts` and `en.ts`, which other branches edit often, so a rebase may be needed.

## How to test (for the founder)

Raw 360 hint:

1. Open any project, press **Ctrl K**, **Import raw data**, and pick a raw Insta360 `.insv` file (with or without its `LRV_...lrv`).
2. When the import panel says **Imported**, it shows one line under the heading: raw 360 camera files play unstabilised; export from Insta360 Studio with FlowState and add that MP4 with **Add 360 video**.
3. Click the video under **360 video** in the sidebar. The **360 video** pane opens; beside the video's name it says **Not stabilised**. Hover it: the same advice shows as a tooltip.
4. **Ctrl K**, **Add 360 video**, pick a stitched MP4. The import panel shows no such line. Pick the MP4 in the pane's chooser: no **Not stabilised** label. Switch back to the camera clip: the label is back.

Stockpile reopen date:

5. Open a stockpile project (one with volumes over two or more surveys). It opens on the last survey.
6. Pick the earlier survey in the date bar (or the Volumes toolbar). The terrain and the volumes switch to it.
7. Go back to **Projects** and open the project again: it opens on the earlier survey. Close and restart the app, open it again: still the earlier survey.
8. Press **T** to show the timeline (or click the thin bar at the bottom), then pick the other survey, restart the app and open the project: it opens on that survey, and the timeline is still shown.
9. Open a project with a single survey or a plain three-date project: it behaves as before (opens on the date it was left on).

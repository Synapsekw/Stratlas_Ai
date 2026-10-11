# Maps from photos: survey date and project name, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layers from a photo run land under the survey date of the photos by themselves, and the wizard and the run panel name the project the maps are added to.

**Architecture:** The estimate that already reads the photo heads also counts the days they were taken. A pure renderer module turns those days and the project's survey dates into a pick; the pick travels with the run and, just before the map-building job starts, a new IPC channel finds or creates the survey date in the manifest. The Python pack is not touched.

**Tech stack:** TypeScript, zod (`@aio/schema`), Electron main and preload, React (renderer), vitest, Playwright.

**Spec:** `docs/plans/2026-10-11-photo-maps-project-and-date-design.md`

## Global constraints

- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\photo-maps-project-and-date`, branch `feat/photo-maps-project-and-date`. Never edit the main checkout.
- Do not edit `apps/desktop/src/renderer/screens/Jobs.tsx`, `screens/jobTasks.ts` or `screens/jobTaskActions.ts`, and add no `go('jobs')` call: another session owns the Jobs screen.
- Do not change the signatures of `photoUi.openWizard()` and `photoUi.openRun()`, nor the props of `PhotoRuns` (`{ selected?: JobRecord }`).
- Do not change anything under `python/`. The pack's `photo.products` refuses unknown parameters, so only `capture` (an id) may be sent to it, never a date.
- Stage files by path. Never `git add -A`, never `git stash`, never `--no-verify`.
- Conventional commit messages; no client, site or person names in code, tests, docs or commit messages.
- User-facing text: plain words, no emoji, no em or en dashes.
- Electron windows stay off-screen in every e2e run (the fixtures do this; do not override them).
- A new survey date is `{ id: 'capture-<date>', label: 'Survey', date }`, the same as an import makes.

## Review focus

1. Photos with no date in them (stripped EXIF, TIFF): the wizard must still start, with "No survey date", and never invent today's date.
2. Photos from several days: the day with the most photos wins; a tie goes to the earlier day, so the pick never flips between two estimates of the same photos.
3. A survey date for that day created by something else while matching ran (an import): `ensureCapture` must find it, not add a second one.
4. Creating the date fails or the project is no longer the open one: the maps are still built, under no date; the run must never hang in "Working".
5. The person chose a date in Options, then chose other photos: their choice stays.

Each of these has a test in the task that owns the code (Tasks 2, 3, 5).

## Execution DAG

```
T1 schema ─┬─> T3 main: photo days ─────────┐
           ├─> T4 main: ensureCapture IPC ──┤
T2 project ┘   (T4 also needs T2)           ├─> T6 screens ─> T8 e2e
           └─> T5 renderer: pick and carry ─┘
                                 T7 guide (needs only the spec)
```

| Batch | Tasks (dispatched in one message) | Shared files |
| ----- | --------------------------------- | ------------ |
| B1    | T1, T2                            | none         |
| B2    | T3, T4, T5                        | none         |
| B3    | T6, T7                            | none         |
| B4    | T8                                | none         |

Critical path: T1, T5, T6, T8.

Package ownership: T1 `@aio/schema` and `docs/architecture`; T2 `@aio/project`; T3, T4 `apps/desktop` main and preload; T5, T6 `apps/desktop` renderer (`photogrammetry/` only); T7 `docs/guide`; T8 `apps/desktop/e2e`.

Contract change (T1 adds the row to `docs/architecture/contract-changes.md`): `PhotoEstimate.photoDays?` and the IPC channel `builder:ensureCapture`, both additive.

e2e specs changed: `apps/desktop/e2e/photo-process.spec.ts` (and its helper `photoPack.ts`). The other photo specs (`photo-align`, `photo-products`) share the helper and are run again in T8.

---

### Task 1: Contract (`@aio/schema`)

**Files:**

- Modify: `packages/schema/src/photogrammetry.ts` (`PhotoEstimate`, near line 160)
- Modify: `packages/schema/src/ipc.ts` (after `'builder:updateCapture'`, near line 1397)
- Modify: `docs/architecture/contract-changes.md` (new last row)
- Test: `packages/schema/src/builder.test.ts`

**Interfaces:**

- Produces: `PhotoEstimate['photoDays']?: { date: string; photos: number }[]`; IPC `'builder:ensureCapture'`: request `{ projectId: string; date: string }`, response `{ ok: true; manifest: ProjectManifest; captureId: string; created: boolean } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing tests** at the end of `packages/schema/src/builder.test.ts` (add `PhotoEstimate` to the import from `./index`):

```ts
describe('survey date of a photo run', () => {
  const estimate = { minutes: [1, 2], diskBytes: 0, memoryBytes: 0 };

  it('photoDays is optional and holds days with photo counts', () => {
    expect(PhotoEstimate.safeParse(estimate).success).toBe(true);
    const r = PhotoEstimate.safeParse({
      ...estimate,
      photoDays: [{ date: '2026-03-14', photos: 12 }],
    });
    expect(r.success && r.data.photoDays).toEqual([{ date: '2026-03-14', photos: 12 }]);
    expect(
      PhotoEstimate.safeParse({ ...estimate, photoDays: [{ date: '14/03/2026', photos: 12 }] })
        .success,
    ).toBe(false);
  });

  it('builder:ensureCapture takes a project and a day, nothing else', () => {
    const req = ipc['builder:ensureCapture'].request;
    expect(req.safeParse({ projectId: 'p', date: '2026-03-14' }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', date: 'tomorrow' }).success).toBe(false);
    expect(req.safeParse({ projectId: 'p', date: '2026-03-14', label: 'x' }).success).toBe(false);
    const res = ipc['builder:ensureCapture'].response;
    expect(res.safeParse({ ok: false, error: 'no' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm vitest run packages/schema/src/builder.test.ts --retry=0`
Expected: FAIL (`photoDays` is stripped so `r.data.photoDays` is undefined; `ipc['builder:ensureCapture']` is undefined).

- [ ] **Step 3: Implement.** In `photogrammetry.ts`, import `IsoDate` from `./common` beside `IsoTime`, and add to `PhotoEstimate` after `suggestedEpsg`:

```ts
  /**
   * The days the photos were taken (the local date in each photo), most photos first; counted on
   * the sample and scaled like the camera groups. Absent when no photo carries a date.
   */
  photoDays: z
    .array(z.object({ date: IsoDate, photos: z.number().int().nonnegative() }))
    .max(366)
    .optional(),
```

In `ipc.ts`, after the `'builder:updateCapture'` entry (import `IsoDate` and `Id` from `./common` if the file does not have them yet):

```ts
  /**
   * The survey date of a day: the project's capture with that date, or a new one (`capture-<date>`,
   * label "Survey") added in date order. Nothing is written when the date exists.
   */
  'builder:ensureCapture': {
    request: z.object({ projectId: z.string().min(1), date: IsoDate }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        captureId: Id,
        created: z.boolean(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

- [ ] **Step 4: Run the schema tests.** Run: `pnpm vitest run packages/schema --retry=0`. Expected: PASS. If a test that pins the list of channels fails (`m10.test.ts`, `m11.test.ts` or a compat test), read what it pins: add `builder:ensureCapture` only to a list of all current channels, never to a list that pins what an older release had.

- [ ] **Step 5: Add the contract row** as the last row of the table in `docs/architecture/contract-changes.md`, in the same four-column shape as the rows above it: date `2026-10-11`; change: "Additive: `PhotoEstimate` gains the optional `photoDays` (`{ date, photos }[]`, at most 366, most photos first: the days the photos were taken, counted on the estimate's sample). New IPC channel `builder:ensureCapture` (`{ projectId, date }` to `{ ok: true, manifest, captureId, created }` or `{ ok: false, error }`): finds the capture of that day or adds `capture-<date>` labelled "Survey" in date order; refused on a package; journaled like `builder:updateCapture`. The pack and `aio.photo-run/1` are unchanged"; why: "Founder, 11 Oct 2026: maps made from photos land under the survey date of the photos without a trip into Options; no channel could add a survey date to an existing project"; affected: "Photo wizard and run panel, main (photogrammetry, builder, journal), `@aio/project`"; approved by: "Founder (11 Oct 2026); integration lead". Then run `pnpm prettier --write docs/architecture/contract-changes.md`.

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/photogrammetry.ts packages/schema/src/ipc.ts packages/schema/src/builder.test.ts docs/architecture/contract-changes.md
git commit -m "feat(schema): photo days in the estimate and builder:ensureCapture"
```

---

### Task 2: Find or create a survey date (`@aio/project`)

**Files:**

- Modify: `packages/project/src/builder/create.ts` (after `updateCapture`)
- Modify: `packages/project/src/builder/raw.ts:197-206` (`addCapture` uses the shared helper)
- Modify: `packages/project/src/builder/index.ts` (export `ensureCapture`)
- Test: `packages/project/src/builder/raw.test.ts` (after `describe('updateCapture', ...)`)

**Interfaces:**

- Produces: `captureForDate(m: ProjectManifest, date: string): { manifest: ProjectManifest; captureId: string; created: boolean }` (pure) and `ensureCapture(root: string, date: string): Promise<{ manifest: ProjectManifest; captureId: string; created: boolean }>`.

- [ ] **Step 1: Write the failing tests** in `raw.test.ts` (add `ensureCapture` to the import from `./create`):

```ts
describe('ensureCapture', () => {
  const dated = async () => {
    const root = await project();
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      captures: [
        { id: 'c1', label: 'First survey', date: '2026-01-10' },
        { id: 'c2', label: 'Second survey', date: '2026-03-10' },
      ],
    });
    return root;
  };

  it('adds a survey date for a new day, in date order, named Survey', async () => {
    const root = await dated();
    const r = await ensureCapture(root, '2026-02-10');
    expect(r.created).toBe(true);
    expect(r.captureId).toBe('capture-2026-02-10');
    expect(r.manifest.captures.map((c) => c.date)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
    ]);
    expect(r.manifest.captures[1]).toEqual({
      id: 'capture-2026-02-10',
      label: 'Survey',
      date: '2026-02-10',
    });
    expect((await readManifest(root)).captures).toEqual(r.manifest.captures);
  });

  it('finds the date that is already there and writes nothing', async () => {
    const root = await dated();
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    const r = await ensureCapture(root, '2026-03-10');
    expect(r).toMatchObject({ captureId: 'c2', created: false });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('asked twice for the same new day, makes one date', async () => {
    const root = await dated();
    const a = await ensureCapture(root, '2026-05-01');
    const b = await ensureCapture(root, '2026-05-01');
    expect(b).toMatchObject({ captureId: a.captureId, created: false });
    expect(b.manifest.captures.filter((c) => c.date === '2026-05-01')).toHaveLength(1);
  });

  it('refuses a day that is not a date', async () => {
    const root = await dated();
    await expect(ensureCapture(root, '10 March')).rejects.toThrow('is not a date');
  });
});
```

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run packages/project/src/builder/raw.test.ts --retry=0 -t ensureCapture`. Expected: FAIL, `ensureCapture` is not exported.

- [ ] **Step 3: Implement** in `create.ts`, after `updateCapture` (import the `Capture` type from `@aio/schema` if it is not imported; `uniqueId` is defined in this file):

```ts
/**
 * The survey date of a day in a manifest: the capture with that date (the first in the list), or
 * a new one, `capture-<date>` named "Survey", added in date order. Pure: nothing is saved.
 */
export function captureForDate(
  m: ProjectManifest,
  date: string,
): { manifest: ProjectManifest; captureId: string; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date (YYYY-MM-DD).`);
  const found = m.captures.find((c) => c.date === date);
  if (found) return { manifest: m, captureId: found.id, created: false };
  const c: Capture = {
    id: uniqueId(`capture-${date}`, (x) => m.captures.some((k) => k.id === x)),
    label: 'Survey',
    date,
  };
  const captures = [...m.captures, c].sort((a, b) => a.date.localeCompare(b.date));
  return { manifest: { ...m, captures }, captureId: c.id, created: true };
}

/**
 * Find the survey date of a day or add it, and save. A date that exists writes nothing; a new one
 * backs up and validates the manifest first. No layer and no file changes.
 */
export async function ensureCapture(
  root: string,
  date: string,
): Promise<{ manifest: ProjectManifest; captureId: string; created: boolean }> {
  const r = captureForDate(await readManifestFile(root), date);
  if (r.created) await writeManifestFile(root, r.manifest);
  return r;
}
```

In `raw.ts`, replace the body of `addCapture` so both paths make the same date (import `captureForDate` from `./create`):

```ts
function addCapture(m: ProjectManifest, date: string | undefined): void {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  m.captures = captureForDate(m, date).manifest.captures;
}
```

Remove imports in `raw.ts` that this leaves unused (`Capture`, `uniqueId`) only if the lint says so. In `index.ts` add `captureForDate` and `ensureCapture` to the export list from `./create`.

- [ ] **Step 4: Run the package's tests.** Run: `pnpm vitest run packages/project --retry=0`. Expected: PASS, including the import tests that go through `addCapture`.

- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/create.ts packages/project/src/builder/raw.ts packages/project/src/builder/index.ts packages/project/src/builder/raw.test.ts
git commit -m "feat(project): ensureCapture finds or adds the survey date of a day"
```

---

### Task 3: Photo days in the estimate (main)

Depends on Task 1.

**Files:**

- Modify: `apps/desktop/src/main/photogrammetry.ts` (`PhotoSet` near line 244, `estimateRun` near line 371, `readPhotoSet` near line 430)
- Test: `apps/desktop/src/main/photogrammetry.test.ts` (beside "reads camera groups, the frame size and GPS from the photo heads", near line 345)

**Interfaces:**

- Consumes: `PhotoEstimate.photoDays` (Task 1).
- Produces: `PhotoSet.days: { date: string; photos: number }[]` (most photos first, ties by earlier date); `estimateRun(...)` returns `photoDays` when `days` is not empty.

- [ ] **Step 1: Write the failing tests.** `withExif` (from `@aio/project/builder/testing`) takes `dateTimeOriginal: 'YYYY:MM:DD HH:mm:ss'`.

```ts
it('counts the days the photos were taken, most photos first', async () => {
  const shot = (dateTimeOriginal?: string) =>
    withExif({
      make: 'Stratlas Synthetic',
      model: 'SYN-20',
      width: 1600,
      height: 1200,
      ...(dateTimeOriginal ? { dateTimeOriginal } : {}),
    });
  const files = ['a', 'b', 'c', 'd'].map((n) => join(dir, `${n}.jpg`));
  await writeFile(files[0] ?? '', shot('2026:03:13 23:58:00'));
  await writeFile(files[1] ?? '', shot('2026:03:14 00:02:00'));
  await writeFile(files[2] ?? '', shot('2026:03:14 00:03:00'));
  await writeFile(files[3] ?? '', shot());
  const set = await readPhotoSet(files);
  expect(set.days).toEqual([
    { date: '2026-03-14', photos: 2 },
    { date: '2026-03-13', photos: 1 },
  ]);
  const hw = { cpu: { model: '', cores: 8 }, memoryBytes: 0, freeDiskBytes: 0, cuda: false };
  expect(estimateRun(set, 'standard', ['ortho'], hw).photoDays).toEqual(set.days);
});

it('a tie between two days goes to the earlier one, and no dates means no days', async () => {
  const shot = (dateTimeOriginal?: string) =>
    withExif({ width: 64, height: 48, ...(dateTimeOriginal ? { dateTimeOriginal } : {}) });
  const tie = [join(dir, 't1.jpg'), join(dir, 't2.jpg')];
  await writeFile(tie[0] ?? '', shot('2026:03:15 10:00:00'));
  await writeFile(tie[1] ?? '', shot('2026:03:14 10:00:00'));
  expect((await readPhotoSet(tie)).days.map((d) => d.date)).toEqual(['2026-03-14', '2026-03-15']);
  const none = [join(dir, 'n1.jpg')];
  await writeFile(none[0] ?? '', shot());
  const set = await readPhotoSet(none);
  expect(set.days).toEqual([]);
  const hw = { cpu: { model: '', cores: 8 }, memoryBytes: 0, freeDiskBytes: 0, cuda: false };
  expect('photoDays' in estimateRun(set, 'standard', ['ortho'], hw)).toBe(false);
});
```

Add `estimateRun` to the test file's import from `./photogrammetry` if it is not there. Other tests in this file build a `PhotoSet` by hand: give each of them `days: []` so the type holds.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run apps/desktop/src/main/photogrammetry.test.ts --retry=0 -t "days"`. Expected: FAIL, `set.days` is undefined.

- [ ] **Step 3: Implement.** In `PhotoSet` add:

```ts
/** Days the photos were taken (local date in the photo), most photos first; scaled when sampled. */
days: {
  date: string;
  photos: number;
}
[];
```

In `readPhotoSet`, beside `const groups = new Map...` add `const days = new Map<string, number>();`, and inside the loop after `groups.set(key, g);`:

```ts
const day = meta.takenAt?.slice(0, 10);
if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) days.set(day, (days.get(day) ?? 0) + 1);
```

and in the returned object, after `sampled,`:

```ts
    days: [...days.entries()]
      .map(([date, n]) => ({ date, photos: sampled ? Math.round(n * factor) : n }))
      .sort((a, b) => b.photos - a.photos || a.date.localeCompare(b.date))
      .slice(0, 366),
```

In `estimateRun`, add to the returned object after the `cameras` line:

```ts
    ...(photos.days.length ? { photoDays: photos.days } : {}),
```

- [ ] **Step 4: Run the file's tests.** Run: `pnpm vitest run apps/desktop/src/main/photogrammetry.test.ts --retry=0`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/photogrammetry.ts apps/desktop/src/main/photogrammetry.test.ts
git commit -m "feat(photo): the estimate counts the days the photos were taken"
```

---

### Task 4: `builder:ensureCapture` in main

Depends on Tasks 1 and 2.

**Files:**

- Modify: `apps/desktop/src/main/builder.ts` (after `builderUpdateCapture`, line 282)
- Modify: `apps/desktop/src/main/index.ts` (import near line 52, handler after line 1219)
- Modify: `apps/desktop/src/preload/index.ts` (after line 95)
- Modify: `apps/desktop/src/main/journal.ts` (header comment line 12, condition line 846, cast line 849)
- Test: `apps/desktop/src/main/builder.test.ts` (beside the `builderUpdateCapture` test near line 82), `apps/desktop/src/main/journal.test.ts` (the `writers` list near line 655)

**Interfaces:**

- Consumes: `ensureCapture(root, date)` from `@aio/project` (Task 2), the channel from Task 1.
- Produces: `builderEnsureCapture(req, registry)`; the channel answers through `bridge.call('builder:ensureCapture', { projectId, date })`.

- [ ] **Step 1: Write the failing test** in `builder.test.ts`, inside the same `describe` as the `builderUpdateCapture` test and using the same `registry` and `projectId` it sets up (import `builderEnsureCapture`):

```ts
it('ensureCapture adds the survey date of a day once, and refuses a closed project', async () => {
  const closed = await builderEnsureCapture({ projectId: 'x', date: '2026-03-14' }, registry);
  expect(closed).toEqual({
    ok: false,
    error: 'Project "x" is not open. Open it, then try again.',
  });
  const first = await builderEnsureCapture({ projectId, date: '2026-03-14' }, registry);
  expect(first.ok && first.created).toBe(true);
  expect(first.ok && first.captureId).toBe('capture-2026-03-14');
  const again = await builderEnsureCapture({ projectId, date: '2026-03-14' }, registry);
  expect(again.ok && again.created).toBe(false);
  expect(again.ok && again.manifest.captures.filter((c) => c.date === '2026-03-14')).toHaveLength(
    1,
  );
});
```

In `journal.test.ts`, add `'builder:ensureCapture',` after `'builder:updateCapture',` in the `writers` list near line 655.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run apps/desktop/src/main/builder.test.ts apps/desktop/src/main/journal.test.ts --retry=0`. Expected: FAIL, `builderEnsureCapture` is not exported (and the journal test, if it checks that each writer is wrapped).

- [ ] **Step 3: Implement.** In `builder.ts`:

```ts
/** Find the survey date of a day or add it: only `manifest.captures` can change. */
export async function builderEnsureCapture(
  req: IpcRequest<'builder:ensureCapture'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:ensureCapture'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then try again.`,
    };
  try {
    const r = await (await lib()).ensureCapture(root, req.date);
    return { ok: true, manifest: r.manifest, captureId: r.captureId, created: r.created };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
```

In `index.ts`, import `builderEnsureCapture` beside `builderUpdateCapture` and add after the `'builder:updateCapture'` handler:

```ts
handle(
  'builder:ensureCapture',
  (req) => packageRefusal(req.projectId) ?? builderEnsureCapture(req, registry),
);
```

In `preload/index.ts`, add `'builder:ensureCapture': true,` after `'builder:updateCapture': true,`.

In `journal.ts`, widen the condition at line 846 to `channel === 'builder:updateLayers' || channel === 'builder:updateCapture' || channel === 'builder:ensureCapture'`, add `'builder:ensureCapture'` to the union in the cast on line 849, and name the channel in the header comment on line 12. Read the block that follows (to its closing brace) and confirm it diffs the manifest generically: it must record nothing when the manifest did not change (`created: false`).

- [ ] **Step 4: Run.** Run: `pnpm vitest run apps/desktop/src/main --retry=0` then `pnpm typecheck`. Expected: PASS. A type error in `handle(` means the channel map in main or preload has another list to extend: follow `builder:updateCapture` with a search and add the new channel beside every hit under `apps/desktop/src/main` and `apps/desktop/src/preload`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/builder.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/journal.ts apps/desktop/src/main/builder.test.ts apps/desktop/src/main/journal.test.ts
git commit -m "feat(desktop): builder:ensureCapture adds a survey date to an open project"
```

---

### Task 5: The pick, and carrying it to the maps (renderer logic)

Depends on Task 1 (types only).

**Files:**

- Create: `apps/desktop/src/renderer/photogrammetry/surveyDate.ts`
- Create: `apps/desktop/src/renderer/photogrammetry/surveyDate.test.ts`
- Modify: `apps/desktop/src/renderer/photogrammetry/store.ts` (`PendingProducts`, `PhotoUi`)
- Modify: `apps/desktop/src/renderer/photogrammetry/actions.ts` (`startProducts`)

**Interfaces:**

- Consumes: `PhotoEstimate.photoDays`, `bridge.call('builder:ensureCapture', ...)`.
- Produces (exact names, Task 6 uses them):

```ts
export type DatePick =
  | { kind: 'existing'; captureId: string; date: string; label: string }
  | { kind: 'new'; date: string }
  | { kind: 'none' };
export interface CaptureLike {
  id: string;
  label: string;
  date: string;
}
export function pickSurveyDate(
  days: readonly { date: string; photos: number }[] | undefined,
  captures: readonly CaptureLike[],
  layerCapture?: string,
): DatePick;
export function pickFromChoice(choice: string, captures: readonly CaptureLike[]): DatePick; // '' | capture id | 'new:<date>'
export function choiceOf(pick: DatePick): string;
export function dateSentence(pick: DatePick, show: (iso: string) => string): string;
export function daysNote(
  days: readonly { date: string; photos: number }[] | undefined,
  show: (iso: string) => string,
): string | null;
export function dateOptions(
  pick: DatePick,
  captures: readonly CaptureLike[],
  show: (iso: string) => string,
): { value: string; label: string }[];
export function pickParams(pick: DatePick): { capture?: string; captureDate?: string };
```

`PendingProducts` gains `captureDate?: string`; `photoUi` gains `dates: Record<string, { capture?: string; captureDate?: string }>` and `setDate(run, d | null)`.

- [ ] **Step 1: Write the failing tests**, `surveyDate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  choiceOf,
  dateOptions,
  dateSentence,
  daysNote,
  pickFromChoice,
  pickParams,
  pickSurveyDate,
} from './surveyDate';

const captures = [
  { id: 'c1', label: 'Survey', date: '2026-01-10' },
  { id: 'c2', label: 'After the rain', date: '2026-03-14' },
];
const show = (iso: string) => `<${iso}>`;

describe('pickSurveyDate', () => {
  it('a photos layer that belongs to a date keeps it', () => {
    expect(pickSurveyDate([{ date: '2026-03-14', photos: 9 }], captures, 'c1')).toEqual({
      kind: 'existing',
      captureId: 'c1',
      date: '2026-01-10',
      label: 'Survey',
    });
  });

  it('the day most photos were taken, when the project has a date for it', () => {
    const days = [
      { date: '2026-03-14', photos: 200 },
      { date: '2026-03-13', photos: 3 },
    ];
    expect(pickSurveyDate(days, captures)).toMatchObject({ kind: 'existing', captureId: 'c2' });
  });

  it('a new date when the project has none for that day', () => {
    expect(pickSurveyDate([{ date: '2026-04-02', photos: 12 }], captures)).toEqual({
      kind: 'new',
      date: '2026-04-02',
    });
  });

  it('none when no photo carries a date, and a layer date that is gone is ignored', () => {
    expect(pickSurveyDate(undefined, captures)).toEqual({ kind: 'none' });
    expect(pickSurveyDate([], captures, 'gone')).toEqual({ kind: 'none' });
  });

  it('two dates on one day: the first in the list', () => {
    const twice = [...captures, { id: 'c3', label: 'Second flight', date: '2026-03-14' }];
    expect(pickSurveyDate([{ date: '2026-03-14', photos: 1 }], twice)).toMatchObject({
      captureId: 'c2',
    });
  });
});

describe('the choice in Options', () => {
  it('round trips through the select value', () => {
    for (const pick of [
      pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures),
      pickSurveyDate([{ date: '2026-04-02', photos: 1 }], captures),
      pickSurveyDate(undefined, captures),
    ])
      expect(pickFromChoice(choiceOf(pick), captures)).toEqual(pick);
    expect(choiceOf({ kind: 'new', date: '2026-04-02' })).toBe('new:2026-04-02');
    expect(pickFromChoice('gone', captures)).toEqual({ kind: 'none' });
  });

  it('lists None, the dates in date order, and the new day when there is one', () => {
    expect(dateOptions({ kind: 'new', date: '2026-04-02' }, captures, show)).toEqual([
      { value: '', label: 'None' },
      { value: 'c1', label: '<2026-01-10>' },
      { value: 'c2', label: '<2026-03-14> · After the rain' },
      { value: 'new:2026-04-02', label: 'New: <2026-04-02>' },
    ]);
    expect(dateOptions({ kind: 'none' }, captures, show)).toHaveLength(3);
  });
});

describe('what the wizard says', () => {
  it('names the date, says when it is new, and says why there is none', () => {
    expect(dateSentence(pickSurveyDate([{ date: '2026-01-10', photos: 1 }], captures), show)).toBe(
      'Survey date: <2026-01-10>',
    );
    expect(dateSentence(pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures), show)).toBe(
      'Survey date: <2026-03-14> · After the rain',
    );
    expect(dateSentence({ kind: 'new', date: '2026-04-02' }, show)).toBe(
      'Survey date: <2026-04-02> (new)',
    );
    expect(dateSentence({ kind: 'none' }, show)).toBe('No survey date.');
  });

  it('says so when the photos are from more than one day', () => {
    expect(daysNote([{ date: '2026-03-14', photos: 9 }], show)).toBeNull();
    expect(daysNote(undefined, show)).toBeNull();
    expect(
      daysNote(
        [
          { date: '2026-03-14', photos: 200 },
          { date: '2026-03-13', photos: 3 },
          { date: '2026-03-12', photos: 1 },
        ],
        show,
      ),
    ).toBe('The photos are from 3 days. Most are from <2026-03-14>.');
  });
});

describe('pickParams', () => {
  it('an id for a date that exists, a day for a new one, nothing for none', () => {
    expect(
      pickParams({ kind: 'existing', captureId: 'c2', date: '2026-03-14', label: 'x' }),
    ).toEqual({ capture: 'c2' });
    expect(pickParams({ kind: 'new', date: '2026-04-02' })).toEqual({ captureDate: '2026-04-02' });
    expect(pickParams({ kind: 'none' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run apps/desktop/src/renderer/photogrammetry/surveyDate.test.ts --retry=0`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `surveyDate.ts`:**

```ts
/**
 * The survey date a photo run's layers go under, worked out from the days the photos were taken
 * (`PhotoEstimate.photoDays`) and the project's survey dates. Pure: the wizard shows the pick and
 * `startProducts` makes a new date real just before the maps are built.
 */

export type DatePick =
  | { kind: 'existing'; captureId: string; date: string; label: string }
  | { kind: 'new'; date: string }
  | { kind: 'none' };

export interface CaptureLike {
  id: string;
  label: string;
  date: string;
}

type Days = readonly { date: string; photos: number }[] | undefined;

const existing = (c: CaptureLike): DatePick => ({
  kind: 'existing',
  captureId: c.id,
  date: c.date,
  label: c.label,
});

/**
 * The automatic pick: the date a photos layer already belongs to, else the date of the day most
 * photos were taken (`days` comes most photos first), else a new date for that day, else none.
 */
export function pickSurveyDate(
  days: Days,
  captures: readonly CaptureLike[],
  layerCapture?: string,
): DatePick {
  const own = layerCapture ? captures.find((c) => c.id === layerCapture) : undefined;
  if (own) return existing(own);
  const day = days?.[0]?.date;
  if (!day) return { kind: 'none' };
  const found = captures.find((c) => c.date === day);
  return found ? existing(found) : { kind: 'new', date: day };
}

/** The value of the pick in the Options list: '', a capture id, or `new:<date>`. */
export function choiceOf(pick: DatePick): string {
  return pick.kind === 'existing' ? pick.captureId : pick.kind === 'new' ? `new:${pick.date}` : '';
}

/** The pick a value of the Options list stands for; a date that is gone reads as none. */
export function pickFromChoice(choice: string, captures: readonly CaptureLike[]): DatePick {
  if (choice.startsWith('new:')) return { kind: 'new', date: choice.slice(4) };
  const found = captures.find((c) => c.id === choice);
  return found ? existing(found) : { kind: 'none' };
}

/** A date with its name, when the name says more than the default "Survey". */
const named = (c: { date: string; label: string }, show: (iso: string) => string) =>
  c.label && c.label !== 'Survey' ? `${show(c.date)} · ${c.label}` : show(c.date);

/** The line under the photo summary. */
export function dateSentence(pick: DatePick, show: (iso: string) => string): string {
  if (pick.kind === 'existing') return `Survey date: ${named(pick, show)}`;
  if (pick.kind === 'new') return `Survey date: ${show(pick.date)} (new)`;
  return 'No survey date.';
}

/** Said once when the photos are from more than one day; null otherwise. */
export function daysNote(days: Days, show: (iso: string) => string): string | null {
  if (!days || days.length < 2 || !days[0]) return null;
  return `The photos are from ${String(days.length)} days. Most are from ${show(days[0].date)}.`;
}

/** The Options list: None, the project's dates in date order, and the new day when there is one. */
export function dateOptions(
  pick: DatePick,
  captures: readonly CaptureLike[],
  show: (iso: string) => string,
): { value: string; label: string }[] {
  const sorted = [...captures].sort((a, b) => a.date.localeCompare(b.date));
  return [
    { value: '', label: 'None' },
    ...sorted.map((c) => ({ value: c.id, label: named(c, show) })),
    ...(pick.kind === 'new' ? [{ value: choiceOf(pick), label: `New: ${show(pick.date)}` }] : []),
  ];
}

/** What `startProducts` is given: the id of a date that exists, or the day of a new one. */
export function pickParams(pick: DatePick): { capture?: string; captureDate?: string } {
  if (pick.kind === 'existing') return { capture: pick.captureId };
  if (pick.kind === 'new') return { captureDate: pick.date };
  return {};
}
```

- [ ] **Step 4: Run.** Run: `pnpm vitest run apps/desktop/src/renderer/photogrammetry/surveyDate.test.ts --retry=0`. Expected: PASS.

- [ ] **Step 5: Carry the pick.** In `store.ts`, add to `PendingProducts`:

```ts
  /** A survey date to add for this day just before the maps are built (never with `capture`). */
  captureDate?: string;
```

and to `PhotoUi` (interface and store):

```ts
  /** The wizard's survey date pick per run, for a run that builds its maps later (ground control first). */
  dates: Record<string, { capture?: string; captureDate?: string }>;
  setDate: (run: string, d: { capture?: string; captureDate?: string } | null) => void;
```

```ts
  dates: {},
  setDate: (run, d) => {
    set((s) => {
      const dates = Object.fromEntries(Object.entries(s.dates).filter(([k]) => k !== run));
      if (d && (d.capture || d.captureDate)) dates[run] = d;
      return { dates };
    });
  },
```

In `actions.ts`, replace `startProducts`:

```ts
const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The capture id the maps go under: the one chosen, or the survey date of `captureDate`, found or
 * added now. Null when there is none or it cannot be made: the maps are then built without a date
 * rather than not at all.
 */
async function captureOf(p: PendingProducts): Promise<string | null> {
  if (p.capture) return p.capture;
  if (!p.captureDate) return null;
  const project = workspace.getState().project;
  if (!project || folderKey(project.root) !== folderKey(p.root)) return null;
  const r = await bridge.call('builder:ensureCapture', {
    projectId: project.id,
    date: p.captureDate,
  });
  if (!r.ok || !r.value.ok) return null;
  const ws = workspace.getState();
  if (ws.project?.id === project.id) ws.replaceManifest(r.value.manifest);
  return r.value.captureId;
}

export async function startProducts(run: string, p: PendingProducts): Promise<string | null> {
  if (!p.products.length) return 'Choose at least one product.';
  const capture = await captureOf(p);
  const err = await start('photo.products', p.root, {
    run,
    products: p.products,
    preset: p.preset,
    ...(capture ? { capture } : {}),
  });
  if (!err) {
    photoUi.getState().setPending(run, null);
    photoUi.getState().setDate(run, null);
  }
  return err;
}
```

- [ ] **Step 6: Test the carrying.** Create `apps/desktop/src/renderer/photogrammetry/actions.test.ts`. If a neighbouring renderer test already replaces `bridge` another way (search `vi.mock('../shell'` under `apps/desktop/src/renderer`), keep these assertions and use its way of mocking:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const replaceManifest = vi.fn();
const open: { project: { id: string; root: string } | null } = {
  project: { id: 'p1', root: 'D:\\Projects\\site' },
};

vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', () => ({
  workspace: { getState: () => ({ project: open.project, replaceManifest }) },
}));

import { startProducts } from './actions';
import { photoUi } from './store';

const base = { root: 'D:/Projects/site/', preset: 'standard', products: ['ortho'] } as const;
const started = { ok: true, value: { ok: true } };
const paramsOfStart = () =>
  (call.mock.calls.find((c) => c[0] === 'jobs:start')?.[1] as { params: Record<string, unknown> })
    .params;

beforeEach(() => {
  call.mockReset();
  replaceManifest.mockReset();
  open.project = { id: 'p1', root: 'D:\\Projects\\site' };
});

describe('startProducts and the survey date', () => {
  it('adds the date of a new day first, then starts the maps under its id', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? {
              ok: true,
              value: { ok: true, manifest: { captures: [] }, captureId: 'capture-2026-04-02' },
            }
          : started,
      ),
    );
    photoUi.getState().setDate('r1', { captureDate: '2026-04-02' });
    const err = await startProducts('r1', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'jobs:start',
    ]);
    expect(call).toHaveBeenNthCalledWith(1, 'builder:ensureCapture', {
      projectId: 'p1',
      date: '2026-04-02',
    });
    expect(paramsOfStart()).toMatchObject({ run: 'r1', capture: 'capture-2026-04-02' });
    expect(paramsOfStart()).not.toHaveProperty('captureDate');
    expect(replaceManifest).toHaveBeenCalledTimes(1);
    expect(photoUi.getState().dates.r1).toBeUndefined();
  });

  it('a date that exists is used as it is', async () => {
    call.mockResolvedValue(started);
    await startProducts('r2', { ...base, products: ['ortho'], capture: 'c2' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).toMatchObject({ capture: 'c2' });
  });

  it('builds the maps without a date when the date cannot be added', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? { ok: true, value: { ok: false, error: 'no' } }
          : started,
      ),
    );
    const err = await startProducts('r3', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });

  it('adds no date to another project that happens to be open', async () => {
    open.project = { id: 'p2', root: 'D:\\Projects\\other' };
    call.mockResolvedValue(started);
    await startProducts('r4', { ...base, products: ['ortho'], captureDate: '2026-04-02' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });
});
```

Run: `pnpm vitest run apps/desktop/src/renderer/photogrammetry --retry=0`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/surveyDate.ts apps/desktop/src/renderer/photogrammetry/surveyDate.test.ts apps/desktop/src/renderer/photogrammetry/store.ts apps/desktop/src/renderer/photogrammetry/actions.ts apps/desktop/src/renderer/photogrammetry/actions.test.ts
git commit -m "feat(photo): work out the survey date of a run and add it before the maps are built"
```

---

### Task 6: The wizard and the run panel

Depends on Task 5. Load the `impeccable` skill before editing: this is UI copy and layout inside two existing dialogs; follow the classes already used there (`small`, `faint`, `ph-sum`, `b-foot`), add no new visual language.

**Files:**

- Modify: `apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx`
- Modify: `apps/desktop/src/renderer/photogrammetry/RunPanel.tsx`
- Modify: `apps/desktop/src/renderer/photogrammetry/photo.css` (only if a line needs spacing)

**Interfaces:**

- Consumes: everything Task 5 produces; `formatDate` from `@aio/ui` (already used by `change/SurveyDate.tsx`).
- Produces: test ids `photo-project`, `photo-date`, `photo-days`, `photo-destination` (wizard) and `photo-run-project`, `photo-results-where` (run panel), used by Task 8.

- [ ] **Step 1: The wizard's state.** In `ProcessWizard.tsx` replace `const [capture, setCapture] = useState('');` with:

```ts
/** The person's own choice in Options ('' is None); null while the pick is automatic. */
const [dateChoice, setDateChoice] = useState<string | null>(null);
```

After `const layer = layers.find((l) => l.id === layerId);` add:

```ts
const captures = project.manifest.captures;
const autoPick = pickSurveyDate(
  estimate?.photoDays,
  captures,
  kind === 'layer' ? layer?.capture : undefined,
);
const pick = dateChoice === null ? autoPick : pickFromChoice(dateChoice, captures);
const days = estimate && !noPhotos ? daysNote(estimate.photoDays, formatDate) : null;
```

(`noPhotos` is declared a few lines below today; move these lines under it.) In `go()`, replace the `ui.setPending` block with:

```ts
const ui = photoUi.getState();
const date = pickParams(pick);
if (!gcpFirst) ui.setPending(run, { root: project.root, preset, products, ...date });
else ui.setDate(run, date);
ui.openRun(run, 'progress');
```

- [ ] **Step 2: The wizard's lines.** In the header, under `<h2>{TITLE}</h2>` and above the existing hint:

```tsx
<p className="small" data-testid="photo-project">
  Project: <b>{project.manifest.name}</b>
</p>
```

In the summary section, after the `photo-needs` paragraph and inside the same `fresh &&` condition:

```tsx
{
  fresh && (
    <p className="small" data-testid="photo-date">
      {dateSentence(pick, formatDate)}
      {pick.kind === 'none' && dateChoice === null
        ? ' These photos carry no date. Choose one in Options.'
        : ''}
    </p>
  );
}
{
  fresh && days && (
    <p className="small faint" data-testid="photo-days">
      {days}
    </p>
  );
}
```

In Options, replace the body of the Survey date `<select>` (keep its `<label className="b-field">` and `<span>Survey date</span>`):

```tsx
<select
  className="input"
  value={choiceOf(pick)}
  onChange={(e) => {
    setDateChoice(e.target.value);
  }}
>
  {dateOptions(autoPick, captures, formatDate).map((o) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  ))}
</select>
```

In the footer, keep the `photo-missing` span exactly as it is (the e2e reads it) and add after it, before the Cancel button:

```tsx
{
  !error && missing === null && (
    <span className="hint faint small" data-testid="photo-destination">
      The maps are added to {project.manifest.name}.
    </span>
  );
}
```

If `photo-missing` has the class `grow` and the new span breaks the row, move `grow` to a wrapper `<span className="grow">` that holds both. Import `formatDate` from `@aio/ui` and the functions from `./surveyDate`.

- [ ] **Step 3: The run panel.** In `RunPanel.tsx`, header subtitle:

```tsx
<p className="small faint" data-testid="photo-run-project">
  {project.manifest.name}
  {' · '}
  {data
    ? `${RUN_STATUS[data.run.status]} · ${preset ? presetLabel(preset) : ''} · ${String(data.run.photos.count)} photos`
    : 'Starting'}
</p>
```

In `Progress`, before the `return`:

```ts
const dated = data?.capture
  ? project.manifest.captures.find((c) => c.id === data.capture)
  : undefined;
const where = dated
  ? `Added to ${project.manifest.name} under ${formatDate(dated.date)} as new layers:`
  : `Added to ${project.manifest.name} as new layers, under no survey date:`;
const kept = usePhotoUi((s) => s.dates[run]);
```

(`usePhotoUi` is a hook: put the `kept` line with the other hooks at the top of `Progress`, above `if (!project) return null;`.) Replace `<p className="small">Added to the project as new layers:</p>` with `<p className="small" data-testid="photo-results-where">{where}</p>`, and in the "Create maps" button of the "Next steps" section pass the kept pick:

```tsx
                  startProducts(run, {
                    root: project.root,
                    preset: data?.preset ?? 'standard',
                    products: defaultProducts(data?.preset ?? 'standard'),
                    ...(kept ?? {}),
                  }),
```

Import `formatDate` from `@aio/ui`.

- [ ] **Step 4: Check.** Run: `pnpm typecheck` then `pnpm vitest run apps/desktop/src/renderer/photogrammetry --retry=0` then `pnpm lint`. Expected: all PASS. `PhotoRuns.tsx` is not edited: "Create maps again" keeps the date the run's layers already have (the pack does that).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx apps/desktop/src/renderer/photogrammetry/RunPanel.tsx apps/desktop/src/renderer/photogrammetry/photo.css
git commit -m "feat(photo): the wizard and the run panel name the project and the survey date"
```

(Leave `photo.css` out of the `git add` if it was not changed.)

---

### Task 7: The guide

Needs only the spec. Runs beside Task 6.

**Files:**

- Modify: `docs/guide/28-processing-photos.md`

- [ ] **Step 1: Edit.** Step 3 of "Create maps" becomes:

```markdown
3. Read the summary, for example "248 photos, 1 camera, GPS on all", the time on this computer underneath, and the survey date the new layers will go under. The top of the screen names the project they are added to.
```

After the sentence "That is all. Everything else is chosen for you: ..." add a paragraph:

```markdown
The survey date is chosen for you too: the day the photos were taken. If the project has no survey date for that day, a new one is added when the maps are built, and the screen says "(new)" beside it. Photos from several days go under the day most of them were taken. Photos that carry no date go under no survey date; choose one in **Options**, or file the layers from the Datasets list afterwards.
```

In "Options", replace the Survey date bullet with:

```markdown
- **Survey date:** the date the new layers belong to. It starts on the day the photos were taken; choose another of the project's dates, or **None**.
```

In "Your maps are ready", change the first sentence to: `When the run is done it says **Your maps are ready**, names the project and the survey date, and lists the new layers. Layers you had before are not changed.`

- [ ] **Step 2: Check and commit.** Run: `pnpm prettier --check docs/guide/28-processing-photos.md` and `node tools/agent/check-public-text.mjs docs/guide/28-processing-photos.md`. Expected: both clean.

```bash
git add docs/guide/28-processing-photos.md
git commit -m "docs(guide): maps from photos go under the photos' survey date"
```

---

### Task 8: End to end

Depends on Tasks 3, 4, 6.

**Files:**

- Modify: `apps/desktop/e2e/photoPack.ts` (the synthetic photos' EXIF, near line 168)
- Modify: `apps/desktop/e2e/photo-process.spec.ts` (the first test, lines 72 to 227, and the `Probe` type near line 43)

- [ ] **Step 1: Give the synthetic photos a date.** In `photoPack.ts`, in the Python that writes each photo, after `exif[272] = "SYN-20"` add `exif[306] = "2026:03:14 10:00:00"` (tag 306 is DateTime; the app reads it when DateTimeOriginal is absent). Export `export const PHOTO_DAY = '2026-03-14';` near `PHOTO_PROJECT`. Read `writePhotoProject` in the same file: if the project it writes already has a capture dated `2026-03-14`, pick a day it does not have, so the run has to add the date.

- [ ] **Step 2: Extend the first test** of `photo-process.spec.ts`. Widen `Probe` so the manifest also has `captures: { id: string; date: string }[]` and each layer `capture?: string`. Then add, right after the `photo-needs` assertion:

```ts
// the project by name, and the survey date worked out from the photos
await expect(wizard.getByTestId('photo-project')).toHaveText(`Project: ${PHOTO_PROJECT.name}`);
await expect(wizard.getByTestId('photo-date')).toContainText('Survey date:');
await expect(wizard.getByTestId('photo-date')).toContainText('(new)');
await expect(wizard.getByTestId('photo-days')).toHaveCount(0);
await expect(wizard.getByTestId('photo-destination')).toHaveText(
  `The maps are added to ${PHOTO_PROJECT.name}.`,
);
```

after `const run = await runId(win);`:

```ts
await expect(panel.getByTestId('photo-run-project')).toContainText(PHOTO_PROJECT.name);
// the date is not added while the photos are still being matched
expect(
  await win.evaluate(
    (day) =>
      (window as unknown as Probe).__stratlas.workspace
        .getState()
        .project?.manifest.captures.some((c) => c.date === day),
    PHOTO_DAY,
  ),
).toBe(false);
```

and after the poll that waits for `photo-${run}-mesh`:

```ts
// the new layer is under the photos' survey date, which the run added
const filed = await win.evaluate(
  ([id, day]) => {
    const m = (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest;
    const capture = m?.layers.find((l) => l.id === id)?.capture;
    return { capture, date: m?.captures.find((c) => c.id === capture)?.date, day };
  },
  [`photo-${run}-mesh`, PHOTO_DAY] as const,
);
expect(filed.capture).toBe(`capture-${PHOTO_DAY}`);
expect(filed.date).toBe(PHOTO_DAY);
await expect(results.getByTestId('photo-results-where')).toContainText(
  `Added to ${PHOTO_PROJECT.name} under`,
);
```

Import `PHOTO_DAY` and `PHOTO_PROJECT` from `./photoPack`. Keep the existing assertion `await expect(wizard.locator('.notice')).toHaveCount(0);` passing: the new lines are plain paragraphs, not notices.

- [ ] **Step 3: Run the way CI runs it.** From the worktree root: `pnpm demo:build --quick` and `pnpm demo:change --quick`. Then from `apps/desktop`, with `QUADRION_WINDOW_SIZE=1100x700` and `QUADRION_E2E_SWGL=1` set:

```bash
pnpm exec electron-vite build
pnpm exec playwright test e2e/photo-process.spec.ts e2e/photo-align.spec.ts e2e/photo-products.spec.ts --workers=1
```

Expected: all pass (specs that need tools this machine lacks may skip; `photo-process` must run, not skip: it needs the development Python, `uv sync --frozen` in `python/`). A failure in `photo-align` or `photo-products` caused by the new date in the synthetic photos is a real finding: read the assertion, and fix the spec only when it pinned "no survey date" by accident.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/photoPack.ts apps/desktop/e2e/photo-process.spec.ts
git commit -m "test(e2e): a photo run names its project and files its layers under the photos' date"
```

---

## Amendments made during the build

The task text above is the plan as approved. The build changed four things:

1. **Photos layer days (Tasks 5 and 6).** For a photos layer the wizard takes the days from the layer items' `takenAt` (`daysOfItems(items)` in `surveyDate.ts`) and falls back to the estimate's `photoDays`. A layer's files can be copies without the date, and the items are exact.
2. **`dateOptions` (Tasks 5 and 6).** It takes the picks to offer, `dateOptions(picks, captures, show)`, and the wizard passes `[autoPick, pick]`. With only the automatic pick, a new day the person chose in Options dropped out of the list when they changed the photos, and the list then showed "None".
3. **The stand-in pipeline (Task 8).** `e2e/photo-fake/aio_photo_fake.py` now writes `capture` into `run.json` as the real pack does; the run panel reads it from there.
4. **The synthetic photos (Task 8).** They carry DateTimeOriginal as well as DateTime: the app reads a photo's date only when the photo has an Exif block, so DateTime alone counts as no date.

Commits in a parallel batch were made by the controller, one per task, once the batch was quiet.

## After the last task

1. `pnpm check` in the worktree: green.
2. The e2e run of Task 8, quoted in the hand-off.
3. `node tools/agent/finish-task.mjs`, then the hand-off message to the Orchestrator: this branch has a contract change (one row, additive) and should land before the Jobs redesign branch.

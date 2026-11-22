# The volumetric report's open points: implementation plan

Date: 22 Nov 2026. Branch `fix/report-open-points`, off `main` `35face58a`. Status: built on this branch (22 Nov 2026); the calls of section 3 are decided. It follows `2026-11-20-volumetric-report-layout.md` and the open threads of `../sessions/2026-11-20-1910-volumetric-report-layout.md`, `../sessions/2026-11-19-0105-volumetrics-finalize.md` and `../sessions/2026-11-20-1347-volumetrics-test-fixes.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to build this plan task by task, each task test first (superpowers:test-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking. Dispatch each batch of section 4 in one message.

**Goal:** close the six open points the rebuilt volumetric report shipped with in installer 0.32.0, as fixes only (a feature freeze is on).

**Architecture:** each point is fixed where its cause is, not where it shows. The flat pile's box is a rule of the pile look, the offline badges reuse the printed pages' spreading, the CSV is fixed in the CSV builder, the caption is a string, and a package says what it cannot do instead of doing it silently.

**Tech stack:** TypeScript, React, three.js, Vitest, Playwright with Electron. No Python, no pipeline pack change.

**Spec:** this file. Sections 1 to 3 are the design (causes, approaches, decisions); sections 4 to 6 are the plan.

## Global constraints

- Fixes only. No new capability, no change to a founder-approved layout beyond what a point names.
- No contract change: nothing in `packages/schema/src` changes except a test fixture string (T6). No row for `docs/architecture/contract-changes.md`.
- No em or en dashes and no emoji in user-facing text. No client, site, tester or person names in code, tests, docs or commit messages (`node tools/agent/check-public-text.mjs <files>`).
- Renderer code never imports `electron` or `node:*`. The offline view's script (`viewer/viewer.ts`) imports nothing outside its own folder.
- Out of scope: the pile panel's head height at 1100 x 720 (a founder design call), anything telecom, the site names in `apps/desktop/e2e/compare.spec.ts` (most of them are real-data project ids the spec needs; they belong to the engineering review's clean-up, not to the report).

## 1. Causes, read from the code

| #   | Point                                                             | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A nearly flat negative pile draws as a tall box in its 3D picture | `pileLift` in `apps/desktop/src/renderer/survey/pile/pileLook.ts:111-113` returns `Math.max(hmax * 1.6, span * 0.22)`. `buildPrism` (`:240-249`) starts `hmax` at 0.5 and only raises it where the surface is above the base, so a flat or negative pile keeps 0.5 and its box is 22 % of its span tall: an 11 m box around a 50 m pile with no relief. The rule was made for the opened pile in the app (well clear of the terrain around it); the report's pinned box (`pileLookScene.ts:360`) reuses it unchanged. The camera is not the cause: `pileShot` in `captureViews.ts:545-563` frames the footprint, and the box rises in it. |
| 2   | Badges of overlapping piles sit on each other in the offline view | `viewer/viewer.ts:274-286` places every badge at its pile's centre as a percentage, with no collision handling. The printed pages spread colliding badges with `spreadMarkers` (`reportPage/volumetric/chrome.tsx:220-294`) and draw a leader; the offline view never calls it. Two outlines drawn on the same ground give two centres at one point.                                                                                                                                                                                                                                                                                      |
| 3   | The offline CSV carries tonnes for piles at or under zero         | `html.ts:264` embeds `volumetricCsv(survey, compared)`, which is the app's `stockpileCsv` as it is (`packages/project/src/export/volumetric.ts:803-820`). `stockpileCsv` writes `volumeM3 * density` for every date (`surveyCsv.ts:674`) and `r.tonnes`, `r.changeTonnes` (`:678-690`) with no test of the volume's sign. The pages and the offline view's rows apply `pileTonnesShown` (`volumetric.ts:593`); the CSV does not. Commit 9632366c1 fixed the summary table with the same rule, read over the whole report.                                                                                                                 |
| 4   | The photo caption on a pile card wraps to two lines               | `vreport.card.photo` (`packages/ui/src/i18n/en/vreport.ts:135`) is "Photo with the outline and the profile line, {date}": 56 characters with a date such as "31 Mar 2026", in a 59 mm column at 7 pt (`piles.css:375-416`), which holds about 45. The other two captions ("3D view, {date}", "Before, {date}") fit.                                                                                                                                                                                                                                                                                                                       |
| 5   | Stale pictures go out when a package exports the report           | `exportRun.ts:162-164`: `const keep = pkg !== null && source.value.model.frame !== null;` skips the retake on purpose, because `report:saveViews` is refused for a package (`main/index.ts:2160-2165`). Nothing says so: the editor hides its stale line when read only (`VolumetricEditor.tsx:589-590`) and no later step compares fingerprints. A second defect on the same lines: a package with no pictures at all has `keep` false, takes every picture, is refused at the save and fails after the wait. Packing copies `report/views/volumetric` as it is (`packages/project/src/package/plan.ts`), stale or not.                  |
| 6   | Hygiene                                                           | `measuredShown` in `packages/volumetric/src/store.ts:163-167, 204, 255, 526-530` is written by `connectKitPilesShown` (`survey/pile/kitPileLink.ts:57-80`, mounted in `App.tsx:89`) and read by nothing; its own comment says so. `packages/volumetric/src/store.test.ts:107-117, 154, 207, 215-217` uses a site name as its fixture project id and name. `packages/schema/src/report.test.ts:105, 109, 113, 119` uses a project id that holds a flagged token.                                                                                                                                                                           |

## 2. Approaches

**Point 1.** (a) A lower lift floor for the report's pinned box only: `Math.max(hmax * 1.6, span * 0.06)`. Chosen: the box of a pile with relief stays as approved (its own height sets the lift once it is taller than 3.75 % of its span), a flat pile gets a low box, and the opened pile in the app is untouched. (b) The same lower floor for the opened pile too: changes a look the founder picked on 26 Oct 2026 (D1: not taken). (c) Frame the camera lower: does not change the box, so the picture still shows a tall empty box.

The pictures' fingerprint goes from `v2` to `v3` (`report/volumetric/editorView.ts:100`), as `v2` did for the pile pictures: a set taken before the fix counts as stale and is retaken whole at the next export. Without it a report keeps its old picture of the flat pile until something else changes (D2).

**Point 2.** (a) Move `spreadMarkers` to a pure file in the viewer's folder, import it from both sides, and lay the badges out in pixels of the map as it is drawn, again on resize. Chosen: one algorithm for print and screen, and the map is responsive, so the spreading has to follow its size. (b) Spread once in the exporter at a nominal width: wrong at every other window width. (c) A second algorithm in the viewer: two rules to keep equal.

**Point 3.** (a) An option on `stockpileCsv` that leaves a pile row's tonnes empty at or under zero, passed by `volumetricCsv` only. Chosen: the report's CSV follows the report's rule, the app's own inventory CSV stays byte for byte (D3). (b) Filter in the viewer: it would have to parse and rewrite CSV in the offline script. (c) Change `stockpileCsv` for every caller: changes the app's export, which nobody asked for.

Points 2 and 3 were expected to share `viewer/viewer.ts`. With (a) point 3 does not touch the viewer at all, so they can run at once.

**Point 4.** (a) A shorter string: "Outline and profile line, {date}" (37 characters with the longest date). Chosen: the profile's own caption already reads "Elevation profile, A to B", so the line is named twice either way. (b) A smaller font or a wider column: changes the approved card. (c) `white-space: nowrap` with an ellipsis: cuts text, which the report never does.

**Point 5.** (a) Say it and stop failing: a package with stale pictures exports with them and says so, in the editor and after the export; a package with no pictures is refused at once with the reason, before any picture is taken. Chosen: small, true for every package that already exists, no new storage. (b) Leave stale pictures out and print "No picture yet": a report with slightly old pictures is worth more to its reader than one with none, and every package made before `v3` would lose all of them. (c) Keep a package's new pictures in memory for the session, as the first design note of 25 Oct 2026 intended: a new read path through `aio://` and the report page; a feature, not a fix (D4). (d) Retake stale pictures before a package is made: a minute of capture inside the Export package dialog for a report the recipient may never open (D5).

**Point 6.** Remove the dead plumbing and rename the fixtures. Nothing to choose.

## 3. Decisions

The founder delegated these calls on 22 Nov 2026; they are decided as below, and the build follows them.

- **D1. The low box is for the report's pictures only.** The pile opened in the app keeps its lift (the look picked on 26 Oct 2026), also when it is flat.
- **D2. One retake of the pictures per project is accepted.** The fingerprint goes to `v3`, so the next export of every existing report retakes its pictures once (about half a minute on the proof project), and every package made before this fix says its pictures may not match.
- **D3. The app's own stockpile inventory CSV stays as it is** (Project, Volumes, Export): it still lists tonnes for a pile at or under zero. Only the report's CSV follows the report's rule.
- **D4. No retake of pictures inside an opened package during the freeze.** The notice covers the defect.
- **D5. Making a package does not refresh the report's pictures.** The person who makes the package exports the report once before packing; the guide says so.
- **D6. The caption's new wording is taken:** "Outline and profile line, 31 Mar 2026".
- **D7. The low box is 6 % of the pile's span** (3 m for a 50 m pile), built as planned. It is a look, so the founder looks at it on a real flat pile: How to test, step 3.

## 4. Execution DAG

```
Batch 1 (five agents, no shared files)     Batch 2 (two agents)        Batch 3 (one agent)
T1 flat pile box        ───────────────────────────────────────────┐
T2 offline badges       ──────────────┬──► T7 end to end spec ─────┤
T3 CSV tonnes           ──────────────│────────────────────────────┼──► T8 docs, checks, proof runs
T4 caption and strings  ──────────────┴──► T5 package ─────────────┤
T6 hygiene              ───────────────────────────────────────────┘
```

- **Dependencies.** T5 needs T4 (T4 adds T5's two strings, so `packages/ui/src/i18n/en/vreport.ts` has one owner). T7 needs T2 and T4 (it asserts both in the app). T8 needs all.
- **Critical path.** T4, T5, T8 (T2, T7, T8 is as long). Three steps deep.
- **Shared files, settled.** `vreport.ts`: T4 only. `docs/KNOWN-LIMITS.md` and `docs/guide/10-reports-and-exports.md` (points 2, 3 and 5 each change a sentence): T8 only. `viewer/viewer.ts`: T2 only. `chrome.tsx`: T2 only. `e2e/volumetric-report-layout.spec.ts`: T7 only.
- **Every agent is told:** the worktree path, its files and no others, stage by path, no `git add -A`, no `git stash`, Electron off-screen (the fixtures do it), one heavy run at a time.

| Task | Packages                                              | Unit tests                                                                     | End to end                          | Contract |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- | -------- |
| T1   | desktop                                               | `pileLook.test.ts`, `editorView.test.ts`                                       | none new; T8 reruns the layout spec | none     |
| T2   | desktop                                               | `viewer/viewer.test.ts`, `chrome.test.ts` (unchanged, must stay green)         | T7                                  | none     |
| T3   | `@aio/project`, desktop                               | `surveyCsv.test.ts`, `volumetric.test.ts`, `html.test.ts`                      | none                                | none     |
| T4   | `@aio/ui`, desktop                                    | `pileCard.test.tsx`, `i18n/vreport.test.ts`                                    | T7                                  | none     |
| T5   | desktop                                               | `exportRun.test.ts`, `VolumetricEditor.test.tsx`                               | none; T8 proof run                  | none     |
| T6   | `@aio/volumetric`, `@aio/schema` (test only), desktop | `store.test.ts`, `controller.test.ts`, `kitPileLink.test.ts`, `report.test.ts` | none                                | none     |
| T7   | desktop (e2e)                                         | none                                                                           | `volumetric-report-layout.spec.ts`  | none     |
| T8   | docs                                                  | `pnpm check`                                                                   | the three volumetric report specs   | none     |

## 5. Tasks

### T1: a flat pile's box is low in the report's picture

**Files:** modify `apps/desktop/src/renderer/survey/pile/pileLook.ts`, `pileLookScene.ts` (the `buildPrism` call at `:360`), `apps/desktop/src/renderer/report/volumetric/editorView.ts:100`; tests `pileLook.test.ts`, `report/volumetric/editorView.test.ts`.

**Interfaces produced:**

- `export type PileLookKind = 'opened' | 'picture'`
- `export function pileLift(hmax: number, span: number, look: PileLookKind = 'opened'): number`, which returns `Math.max(hmax * 1.6, span * (look === 'picture' ? 0.06 : 0.22))`
- `PrismInput.look?: PileLookKind` (absent is `'opened'`); `buildPrism` passes it to `pileLift`.

- [ ] **Step 1: failing tests** in `pileLook.test.ts`, beside "lifts the top well clear of the pile":

```ts
it('lifts a picture by the pile height alone once that is clear of a low floor', () => {
  expect(pileLift(6, 40, 'picture')).toBeCloseTo(9.6); // as the opened pile
  expect(pileLift(0.5, 50, 'picture')).toBeCloseTo(3); // flat: 6 % of the span, not 11 m
  expect(pileLift(0.5, 50)).toBeCloseTo(11); // the opened pile is unchanged
});

it('gives a flat pile under its base a low box in a picture', () => {
  // a 50 m square on level ground at 100 m, its base 0.4 m above the ground: a negative pile
  const flat = prismOf({ size: 50, ground: () => 100, base: () => 100.4, look: 'picture' });
  expect(flat.hmax).toBe(0.5);
  expect(flat.lift).toBeCloseTo(3);
  for (const [a, b] of flat.posts) expect(b[2] - a[2]).toBeCloseTo(3);
  const opened = prismOf({ size: 50, ground: () => 100, base: () => 100.4 });
  expect(opened.lift).toBeCloseTo(11);
});
```

`prismOf` is a helper of the test file: build it from the file's existing fixtures (`pileGrid`, `gridPoints`, `buildPrism`). In `editorView.test.ts` change the expected prefix at `:100` to `/^v3-1-/`.

- [ ] **Step 2:** run `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/pile/pileLook.test.ts src/renderer/report/volumetric/editorView.test.ts`; expect the new cases and the prefix to fail.
- [ ] **Step 3:** implement the signature above; in `pileLookScene.ts` pass `look: target.pinned ? 'picture' : 'opened'` to `buildPrism` (the draw key at `:349` already holds `target.pinned`); leave the estimate at `:464` as it is (it is the opened pile's fly); change the fingerprint prefix to `v3` and its comment ("`v3` is the set with the low box of a flat pile").
- [ ] **Step 4:** run the same command; expect green. Run `pileLookPinned.test.ts` and `captureViews.test.ts` too: unchanged and green.
- [ ] **Step 5:** commit `fix(desktop): a flat pile's box is low in the report's 3D picture`.

Not changed, on purpose: `pileShot`'s camera (`captureViews.ts:554` allows `0.6 x` the pile's height over its top, while the real lift is `1.6 x`). The approved pictures were taken with it and look right; T8 looks at the flat pile's picture and reports if its box is cut.

### T2: the offline view spreads badges that collide

**Files:** create `apps/desktop/src/renderer/reportPage/volumetric/viewer/spread.ts`; modify `chrome.tsx` (remove the body, import and re-export), `viewer/viewer.ts`, `viewer/viewer.css`; test `viewer/viewer.test.ts`.

**Interfaces produced:**

- `viewer/spread.ts` exports `spreadMarkers`, `SpreadMarker` and `KeepClear` exactly as `chrome.tsx:193-294` has them today (moved, not rewritten, with its two constants). It imports nothing.
- `chrome.tsx` keeps exporting the three names (`export { spreadMarkers, type SpreadMarker, type KeepClear } from './viewer/spread'`), so `chrome.test.ts` and `overview.tsx` are untouched.
- Each badge button gets `data-pile="<pile id>"` (T7 reads it).
- `export const MARKER_R_PX = 14` in `viewer.ts`: the 26 px badge's radius with a pixel of air.

- [ ] **Step 1: failing tests** in `viewer.test.ts`:

```ts
describe('badges that would sit on each other', () => {
  // jsdom lays nothing out: give the map a size, as a browser would
  const sized = (w: number, h: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h);
  };
  const centre = (id: string): [number, number] => {
    const b = q<HTMLElement>(`.vr-d-marker[data-pile="${id}"]`);
    return [(parseFloat(b.style.left) / 100) * 800, (parseFloat(b.style.top) / 100) * 400];
  };

  it('moves two badges at one place apart, each with a leader to its true place', () => {
    sized(800, 400);
    mount({ piles: [pile('a', [500, 250]), pile('b', [500, 250])] }); // frame 1000 x 500
    const [ax, ay] = centre('a');
    const [bx, by] = centre('b');
    expect(Math.hypot(bx - ax, by - ay)).toBeGreaterThanOrEqual(2 * 14 * 1.12 - 0.01);
    expect(document.querySelectorAll('.vr-d-leaders line.vr-d-leader')).toHaveLength(2);
    expect(document.querySelectorAll('.vr-d-leaders circle')).toHaveLength(2);
  });

  it('leaves badges that stand clear where they are, with no leader', () => {
    sized(800, 400);
    mount({ piles: [pile('a', [100, 100]), pile('b', [900, 400])] });
    expect(centre('a')).toEqual([80, 80]);
    expect(document.querySelector('.vr-d-leaders')).toBeNull();
  });

  it('keeps the true places while the map has no size yet', () => {
    mount({ piles: [pile('a', [500, 250]), pile('b', [500, 250])] });
    expect(q<HTMLElement>('.vr-d-marker[data-pile="a"]').style.left).toBe('50%');
  });
});
```

`mount` and `pile` follow the file's existing helpers (extend them to take piles and a marker). The existing "places the markers as named buttons" test stays as it is.

- [ ] **Step 2:** run `pnpm --filter @aio/desktop exec vitest run src/renderer/reportPage/volumetric/viewer`; expect the three to fail.
- [ ] **Step 3:** move `spreadMarkers` to `viewer/spread.ts`; re-export from `chrome.tsx`.
- [ ] **Step 4:** in `viewer.ts` add `function placeMarkers(): void`: read `map.clientWidth` and `clientHeight`; when either is 0 keep each badge at its true percentage and remove the leaders; else turn each `p.marker` into map pixels, call `spreadMarkers(points, MARKER_R_PX, { width, height })`, set `left` and `top` as percentages of the spread place (`round`), and rebuild one `<svg class="vr-d-leaders" viewBox="0 0 w h" preserveAspectRatio="none" aria-hidden="true">` inside `.vr-d-markers`, before the buttons, with a `line.vr-d-leader-halo`, a `line.vr-d-leader` and a `circle` (r 2.5) per moved badge; no svg when none moved. Call it at the end of `render()`, on the map image's `load`, and from a `ResizeObserver` on the map when the global exists.
- [ ] **Step 5:** `viewer.css`: `.vr-d-leaders` fills the layer (`position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none`); the halo `stroke: rgb(17 22 28 / 0.55); stroke-width: 3`, the leader `stroke: #f6f8f9; stroke-width: 1.25`, the dot `fill: #f6f8f9` with the halo colour as its stroke; both lines `vector-effect: non-scaling-stroke`.
- [ ] **Step 6:** run the viewer tests, `chrome.test.ts` and `html.test.ts` (the script's hash in the CSP is computed from the bundle, so it follows); expect green.
- [ ] **Step 7:** commit `fix(desktop): the offline report view moves colliding pile badges apart`.

### T3: the offline CSV leaves a pile's tonnes empty at or under zero

**Files:** modify `packages/project/src/export/surveyCsv.ts` (`stockpileCsv`, `:633-700`), `packages/project/src/export/volumetric.ts` (`volumetricCsv`, `:803-820`); tests `surveyCsv.test.ts`, `volumetric.test.ts`, `apps/desktop/src/renderer/reportPage/volumetric/html.test.ts`.

**Interfaces produced:** `stockpileCsv(data: SurveyReportData, opts: { pileTonnes?: 'all' | 'above-zero' } = {}): string`. With `'above-zero'`, in a `pile` row only: `<date>_tonnes` is empty where that date's volume is at or under zero; `current_tonnes` and `current_mass_<unit>` are empty where the current volume is; `change_tonnes` is empty where the current or the previous volume is. Material and total rows are untouched. `volumetricCsv` passes `{ pileTonnes: 'above-zero' }` on each of its three returns; its signature does not change.

- [ ] **Step 1: failing tests.** In `volumetric.test.ts`, in `describe('volumetricCsv')`, add a fourth pile to a copy of the fixture with volumes 120 on `c1` and -3.9 on `c2` (density 1.6), and:

```ts
it('leaves a pile at or under zero without tonnes, and keeps the totals', () => {
  const rows = parseCsv(volumetricCsv(withNegative));
  const head = rows[0] ?? [];
  const cell = (row: string[], name: string) => row[head.indexOf(name)];
  const pile = rows.find((r) => r[1] === 'm-4') ?? [];
  expect(cell(pile, '2026-09-03_volume_m3')).toBe('-3.9');
  expect(cell(pile, '2026-09-03_tonnes')).toBe('');
  expect(cell(pile, '2026-09-02_tonnes')).toBe('192');
  expect(cell(pile, 'current_tonnes')).toBe('');
  expect(cell(pile, 'change_tonnes')).toBe('');
  const total = rows.find((r) => r[0] === 'total') ?? [];
  const app = parseCsv(stockpileCsv(withNegative)).find((r) => r[0] === 'total') ?? [];
  expect(total).toEqual(app); // the site's tonnes still add the pile, as the app's total does
});

it("is the app's CSV while every pile is above zero", () => {
  expect(volumetricCsv(data)).toBe(stockpileCsv(data));
});
```

Use the CSV parser the package's tests already use, or split on lines and commas (the fixture has no quoted cell). In `surveyCsv.test.ts`: `stockpileCsv(d)` equals `stockpileCsv(d, { pileTonnes: 'all' })` for a fixture with a negative pile, and still carries that pile's tonnes. In `html.test.ts:420` the expectation stays `volumetricCsv(survey(), null)`.

- [ ] **Step 2:** run `pnpm --filter @aio/project exec vitest run src/export/volumetric.test.ts src/export/surveyCsv.test.ts`; expect the first new case to fail on `2026-09-03_tonnes`.
- [ ] **Step 3:** implement. Reuse `pileTonnesShown` for the rule if importing it into `surveyCsv.ts` makes no cycle; otherwise move it to `surveyCsv.ts` and re-export it from `volumetric.ts`.
- [ ] **Step 4:** run both files and `html.test.ts`; expect green.
- [ ] **Step 5:** commit `fix(project): the volumetric report's CSV has no tonnes for a pile at or under zero`.

### T4: a one-line photo caption, and the package's two strings

**Files:** modify `packages/ui/src/i18n/en/vreport.ts`, `packages/ui/src/i18n/vreport.test.ts`, `apps/desktop/src/renderer/reportPage/volumetric/pileCard.tsx`, `piles.css` (the comment at `:370` only); test `pileCard.test.tsx`.

**Interfaces produced (strings T5 reads):**

- `'vreport.card.photo': 'Outline and profile line, {date}'`
- `'vreport.pictures.stalePackage': 'The pictures in this package may not match its data. A package cannot take new ones: export the report from the project folder for new pictures.'`
- `'vreport.pictures.nonePackage': 'This package carries no report pictures, and a package cannot take them. Export the report once from the project folder, then make the package again.'`
- `export const CAPTION_LINE = 40` in `pileCard.tsx`, beside `NAME_LINE`: the characters one caption line holds (59 mm at 7 pt, with room).

- [ ] **Step 1: failing test** in `pileCard.test.tsx`:

```ts
it('keeps every picture caption to one line', () => {
  const date = '30 Sep 2026'; // the longest date the cards print
  for (const key of ['vreport.card.photo', 'vreport.card.3d', 'vreport.card.before'] as const)
    expect(t(key, { date }).length).toBeLessThanOrEqual(CAPTION_LINE);
});
```

Add the two new keys to `vreport.test.ts` with no placeholders.

- [ ] **Step 2:** run `pnpm --filter @aio/desktop exec vitest run src/renderer/reportPage/volumetric/pileCard.test.tsx`; expect 56 > 40.
- [ ] **Step 3:** change the string, add the two strings and the constant; reword the CSS comment to "a caption is one line; the second line's room stays in the card's budget". `min-height: 7.2mm` and `CARD_FIXED` stay: the chart's height must not move.
- [ ] **Step 4:** run the test, `pnpm --filter @aio/ui exec vitest run src/i18n` and `piles.test.tsx`; the existing assertion at `pileCard.test.tsx:188` reads the string through `t`, so it follows.
- [ ] **Step 5:** commit `fix(desktop): the pile card's photo caption fits one line`.

### T5: a package says what it does with its pictures

**Files:** modify `apps/desktop/src/renderer/report/volumetric/exportRun.ts` (`run`, `:145-184`), `VolumetricEditor.tsx` (`PicturesNote`, `:207-225`, and its use at `:586-592`); tests `exportRun.test.ts`, `VolumetricEditor.test.tsx`.

**Consumes:** the two strings of T4. **Produces:** `PicturesNote` takes `state: 'none' | 'stale'`, `busy`, `onTake` and a new `locked: boolean`: when locked it prints the package string for its state and no button.

Behaviour of `run(format, src)` in a package (`pkg !== null`), replacing the `keep` line:

| Pictures in the package | `format` is an export                                                                                                                                 | `format` is null ("Take them now") |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| current                 | export, as today                                                                                                                                      | not offered (as today)             |
| stale                   | export with them; when the file is written, a second toast under the same title, finished `'done'`, with `vreport.pictures.stalePackage`              | not offered                        |
| none                    | no capture, no export: `say(title, t('vreport.pictures.nonePackage'))`, the run ends `'failed'` with that error; `takeReportPictures` is never called | not offered                        |

A folder project behaves exactly as today.

- [ ] **Step 1: failing tests** in `exportRun.test.ts`, replacing "exports a package with the pictures it carries, stale or not" (`:224-230`):

```ts
describe('in a package', () => {
  beforeEach(() => {
    opened.pkg = { header: { exports: ['report-pdf'] } };
  });

  it('exports with stale pictures and says they may not match', async () => {
    const end = await exportVolumetric('volumetric-pdf', given(frameOf('v1-old')));
    expect(takeReportPictures).not.toHaveBeenCalled();
    expect(end).toBe('done');
    expect(finished()).toContainEqual(['done', t('vreport.pictures.stalePackage')]);
  });

  it('says nothing more when the pictures are current', async () => {
    await exportVolumetric('volumetric-pdf', given(frameOf(current)));
    expect(finished()).toEqual([]);
  });

  it('refuses at once without pictures, before any is taken', async () => {
    const end = await exportVolumetric('volumetric-pdf', given(null));
    expect(end).toBe('failed');
    expect(takeReportPictures).not.toHaveBeenCalled();
    expect(exportIssues).not.toHaveBeenCalled();
    expect(finished()).toContainEqual(['error', t('vreport.pictures.nonePackage')]);
  });

  it('says nothing about pictures when the export itself failed', async () => {
    exportIssues.mockResolvedValue('error');
    await exportVolumetric('volumetric-pdf', given(frameOf('v1-old')));
    expect(finished()).toEqual([]);
  });
});
```

`finished()` returns the `[state, message]` pairs the file's toast mock was finished with; add it beside the mock. In `VolumetricEditor.test.tsx`, beside the stale test at `:244`:

```ts
it('in a package says the pictures may not match, with no link', async () => {
  readOnly = true;
  model = { ...twoDates, frame: frameOf('v1-old') };
  await mount();
  expect(note()?.textContent).toContain('may not match its data');
  expect(button('Take them now')).toBeUndefined();
});

it('in a package without pictures says it carries none', async () => {
  readOnly = true;
  model = { ...twoDates, frame: null };
  await mount();
  expect(note()?.textContent).toContain('carries no report pictures');
});
```

Set `readOnly` the way the file's existing package tests do (`:336`, `:344`).

- [ ] **Step 2:** run `pnpm --filter @aio/desktop exec vitest run src/renderer/report/volumetric/exportRun.test.ts src/renderer/report/volumetric/VolumetricEditor.test.tsx`; expect the new cases to fail.
- [ ] **Step 3:** implement the table; update the file comment of `exportRun.ts` (its line "no route ends with the report has no pictures yet" gains "except a package, which says so at once").
- [ ] **Step 4:** run both files and `useVolumetric.test.tsx`; expect green.
- [ ] **Step 5:** commit `fix(desktop): a package says when its report pictures may not match, and no longer fails after taking them`.

### T6: hygiene

**Files:** modify `packages/volumetric/src/store.ts`, `packages/volumetric/src/store.test.ts`, `packages/volumetric/src/scene/controller.test.ts:525`, `apps/desktop/src/renderer/survey/pile/kitPileLink.ts`, `kitPileLink.test.ts`, `apps/desktop/src/renderer/App.tsx`, `packages/schema/src/report.test.ts`.

- [ ] **Step 1:** write the check that fails today: `node tools/agent/check-public-text.mjs packages/volumetric/src/store.test.ts packages/schema/src/report.test.ts` exits 1.
- [ ] **Step 2:** in `store.test.ts` rename the fixture's project id and name (every flagged line) to `quarry-demo` and `Quarry demo`; in `report.test.ts` rename the project id on the four lines to `yard-demo`. Run both test files; expect green and the checker to exit 0.
- [ ] **Step 3:** remove `measuredShown` and `setMeasuredShown` from `store.ts` (state type, action type, initial value, action); remove `connectKitPilesShown` and `shownKitPiles` from `kitPileLink.ts` with their tests, and the mount in `App.tsx`; delete the one call in `controller.test.ts:525` (the assertions after it stay). `grep -rn "measuredShown\|MeasuredShown\|KitPilesShown\|shownKitPiles" apps packages` must return nothing.
- [ ] **Step 4:** run `pnpm --filter @aio/volumetric exec vitest run`, `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/pile` and `pnpm typecheck`; expect green. If a public API listing of `@aio/volumetric` names the removed action, update it in the same commit.
- [ ] **Step 5:** two commits: `chore(volumetric): remove the unused measuredShown plumbing` and `test: neutral project names in two volumetric and report fixtures`.

### T7: the end to end spec proves the badges and the caption

**Files:** modify `apps/desktop/e2e/volumetric-report-layout.spec.ts` (the first test only).

- [ ] **Step 1:** in the preview block, after the card assertions (`:198-201`), add: for each `.vr-pile-pic figcaption` of the first pile page, a `Range` over its contents has exactly one client rect (`el => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; }`), and the photo's caption starts with "Outline and profile line, ".
- [ ] **Step 2:** in the offline block (`:321-335`), in the Photo view: `d.locator('.vr-d-marker')` has 6 badges; the boxes of `[data-pile="m-sp2"]` and `[data-pile="m-sp2b"]` (the outline drawn twice, so one centre) do not intersect; no two badge boxes intersect; `.vr-d-leaders line.vr-d-leader` has at least 2 lines. Then `await d.setViewportSize({ width: 700, height: 800 })` and assert again that no two boxes intersect.
- [ ] **Step 3:** update the PDF text assertion only if it names the old caption (it names "3D view" today, so nothing should change).
- [ ] **Step 4:** build the demos (`pnpm demo:build --quick`, Python from the main checkout's venv: `reference-e2e-in-a-worktree`), then from `apps/desktop`, the CI way: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/volumetric-report-layout.spec.ts --workers=1`. Expect both tests green and the line `[e2e] window 1100 x 720 px at display scale 1`. Note the logged `share of the picture the pile box's surface takes`: the two box shares must stay above 0.15 after T1.
- [ ] **Step 5:** commit `test(desktop): the report spec proves spread badges and one-line captions`.

### T8: docs, checks and proof runs

**Files:** modify `docs/guide/10-reports-and-exports.md`, `docs/KNOWN-LIMITS.md`; `/wrapup` writes the session note and the north star.

- [ ] **Step 1: guide.** In the paragraph on negative piles (`:61`) add the CSV to "prints no tonnes in its table row, on its card or in the HTML file's interactive view"; in the paragraph on the interactive view (`:63`) add "numbers that would sit on each other are moved apart there too"; add one paragraph on packages: a package exports the report with the pictures it carries, says when they may not match its data, cannot take new ones, and a package made from a project whose report was never exported carries none, so export the report once before making a package.
- [ ] **Step 2: known limits.** `:344`: remove the sentence that the interactive view's CSV keeps such a pile's tonnes. `:345`: reword to what is now true (stale pictures go out with a notice; no pictures, no export). Add: a report's first export after this update retakes its pictures once.
- [ ] **Step 3:** `pnpm check` in the worktree; quote the totals.
- [ ] **Step 4:** the CI way, one run at a time: `volumetric-report.spec.ts`, `volumetric-report-edit.spec.ts`, `volumetric-report-layout.spec.ts`, `dialogs-a11y.spec.ts`, `package.spec.ts`.
- [ ] **Step 5: proof runs**, off-screen through a throwaway Playwright script on a copy of the quarry demo (never committed), each looked at and recorded in the session note with what was seen:
  1. a pile outline added on level ground with a base above it: its `pile-3d` picture shows a low box, whole in the frame;
  2. a pile at or under zero with a material: the offline file's downloaded CSV has its tonnes cells empty and the total row unchanged;
  3. a package made from the demo after its report was exported, with one outline moved before packing: opened, the editor shows the "may not match" line, Export PDF saves a file with the pictures and the second toast;
  4. a package made from a demo copy whose report was never exported: Export PDF answers at once with the "carries no report pictures" message and takes no picture.
     A step that could not be driven is said so in the hand-over, by name.
- [ ] **Step 6:** `node tools/agent/check-public-text.mjs` on every changed file and doc; scan the added lines with the handover's pattern; look at any screenshot kept.
- [ ] **Step 7:** `/wrapup` on this branch, then `node tools/agent/finish-task.mjs` and the hand-over to the merge coordinator (branch, head SHA, contents, check and e2e results, How to test).

## Review focus

Inputs no task's happy path meets; each has its test in the task that owns the code.

1. **One pile, or badges at the picture's edge** (T2): `spreadMarkers` keeps badges inside the map; covered by the existing `chrome.test.ts` cases, which must stay green after the move.
2. **The map hidden or not laid out** (T2, print and first paint): a zero size keeps the true places (third test of T2).
3. **A pile with no density and a volume at or under zero** (T3): its tonnes cells were empty before and stay empty; add it to the T3 fixture as a fifth pile and assert no cell changes between the two options.
4. **A package whose export is not allowed** (T5): `actionAllowed` returns before anything else, as today; the existing test must stay green.
5. **A pile taller than 3.75 % of its span** (T1): its picture's lift equals the opened pile's (first test of T1), so approved pictures do not change.

## 6. How to test (draft, for the founder)

On your own two-date stockpile project, with `pnpm dev`. Every step is backed as named at the end.

1. Open the project, then Reports, Customer reports, Open volumetric report. The line above the preview reads "The data changed since the pictures were taken." (once, because of this update). Click Export PDF: the pictures are retaken under the progress card, then the save dialog. Save and open the PDF.
2. On a pile page, the first picture's caption reads "Outline and profile line," and the date, on one line. All three captions are one line.
3. Find a pile that is flat or under its base (a negative volume). If there is none: Tools, Measure, Volume, draw an outline on level ground, Save, Recompute, and export again. Its 3D picture shows a low box, about a sixteenth of the pile's width tall, not a tall empty one. A normal pile's picture looks as before.
4. Click Export HTML, save, and open the file in a browser. In the Photo view, piles whose outlines lie on each other have their numbers side by side, each with a thin line to its true place. Make the browser window narrow: they stay apart.
5. In that file click Download CSV and open it. A pile at or under zero has empty tonnes cells; its volume is there; the total row's tonnes are the app's.
6. Back in the app, move one pile's outline a little and do not export the report. Make a package (Export package), open the package, and open its volumetric report. The line above the preview reads "The pictures in this package may not match its data." with no button. Click Export PDF: the file saves at once, and a second message says the same.
7. Make a package from a project whose volumetric report was never exported, open it, open the report and click Export PDF: a message says at once "This package carries no report pictures", and no pictures are taken.

What backs each step: 1 by `e2e/volumetric-report.spec.ts` and the layout spec's stale case (there the saved fingerprint is rewritten); 2 and 4 by `e2e/volumetric-report-layout.spec.ts` (T7), step 4 also at a narrow window; 3, 5, 6 and 7 by unit tests and by the proof runs of T8 on the quarry demo, not by a committed spec. The hand-over says which proof runs were driven and what was seen.

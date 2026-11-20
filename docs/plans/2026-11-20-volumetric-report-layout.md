# Volumetric report: the rebuilt layout

Date: 20 Nov 2026. Branch `feat/volumetric-report-layout`, on local `main` `d17798ff0`. Status: the layout is approved by the founder (20 Nov 2026, on a mock-up made from real data); this plan is ready to build. Per the 24 Oct rule, an approved mock-up means build now: the decisions in section 2 are recorded as decided, and only section 9 holds questions.

## 1. Goal

The founder tested volumetrics and said the exported volumetric report has no pictures of the piles or their profiles, and that its structure must improve. A throwaway spike produced a mock-up, and the founder approved it. This plan rebuilds the report to that layout with production code.

The report after this work:

1. **Summary page.** The table lists every pile. A pile without a volume reads "Not computed". The title band says how many piles there are and how many have a volume ("8 piles, 3 measured").
2. **Site overview.** The site photo, the elevation map and the 3D site view, each with the pile numbers.
3. **Pile pages**, two piles per page, one full card per pile: the volume and the change since the compared survey; three pictures (the photo with the outline and the profile line, the 3D view of the pile, the earlier survey's photo); the elevation profile with both surveys and the base line; then footprint, base, base level, peak height, density and survey date.
4. **Change between surveys**, with the method note once, at the end of the report.

The pictures are taken by the export itself. There is no separate "Take pictures" step.

The spike (worktree `report-layout-spike`, WIP commit `32e4f0a54`) is the reference for the layout only. Its code is not merged; its `piles.test.tsx` is stale; its profile chart, its loose frame keys and its capture order are replaced as described below.

Paths starting with `R/` mean `apps/desktop/src/renderer/`.

## 2. Decisions (decided, not open)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                  | Source                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| D1  | A pile with no volume is listed and gets a card; its figures read "Not computed". It is never dropped.                                                                                                                                                                                                                                                                    | founder, 20 Nov                  |
| D2  | When two pile outlines substantially overlap, the report prints a plain warning that the site total may count the same material twice. Report text only; no new UI in the app.                                                                                                                                                                                            | founder, 20 Nov                  |
| D3  | "Substantially" is the engine's existing test for "the same pile drawn again": the two outlines share half or more of the smaller one (`overlapShare` at `SAME_PILE_SHARE`, `packages/survey/src/calc/kitPiles.ts`). No new threshold is invented. The warning is raised only for two piles that both have a volume on the latest date, on that date's outlines.          | this plan                        |
| D4  | Pictures are taken at export when there are none or they are stale. The editor has no required "Take pictures" step. A quiet "Take them now" link stays in the preview's picture placeholder so the preview can show pictures before the first export (see question Q1).                                                                                                  | founder, 20 Nov; link: this plan |
| D5  | Ground the survey does not cover prints as paper, never black (defect a).                                                                                                                                                                                                                                                                                                 | founder, 20 Nov                  |
| D6  | The 3D pile picture shows the latest survey for every pile (defect b). The engine change is in section 4.                                                                                                                                                                                                                                                                 | founder, 20 Nov                  |
| D7  | The profile on a card is the app's own chart and data path: `pileAxis`, the report page's `sampleProfiles`, the shared `ProfileChart` printed statically, as the survey report already prints line profiles (defect c). No stand-in SVG.                                                                                                                                  | founder, 20 Nov                  |
| D8  | The export shows progress and a Stop button while it takes pictures, and the capture scales to sites with many piles (defect d). Design in section 5.                                                                                                                                                                                                                     | founder, 20 Nov                  |
| D9  | Badges that would collide are spread apart with a leader to their true place; table and chart rows get room; no text is cut off, however long (defect e).                                                                                                                                                                                                                 | founder, 20 Nov                  |
| D10 | A negative volume (defect f): the volume prints as the engine gives it, with a short note on the card, "The surface is below the base here. Check the base." A percentage change is printed only when the earlier and the latest volume are both above zero; otherwise the change is given in cubic metres alone. A pile at or below zero takes no part of the share bar. | this plan                        |
| D11 | The site total and every figure stay exactly what Project > Volumes shows. A negative or overlapping pile is not removed from the total by the report (the report would then disagree with the app).                                                                                                                                                                      | this plan                        |
| D12 | The method note prints once, as the closing block of the last page. The footer keeps "Prepared by" and the page number only.                                                                                                                                                                                                                                              | approved mock-up, cleaned        |
| D13 | No new page id. The site overview and the pile pages are both switched by the existing "piles" page switch, relabelled "B. Site overview and pile pages". `ReportPageId` and the saved text file do not change.                                                                                                                                                           | this plan                        |
| D14 | Each pile's pictures are views of two new kinds in the pictures' frame (`pile-photo`, `pile-3d`), with typed keys. The spike's loose `pile` and `pileView` keys on a `photo` view are not used: an older build would have read such a view as the site photo.                                                                                                             | this plan                        |

## 3. Out of scope

Feature freeze (18 Nov 2026) is in force. Nothing below is built here.

- Anything in the app outside the report: no overlap warning in the Volumes panel, no change to how a pile is computed, no new base, no change to the inventory or the pile panel (the pile look gets one report-only input, section 4).
- The interactive view of the offline HTML file (view D) keeps its layout. It only has to cope with piles that have no volume.
- Retaking only the pictures of the piles that changed. Every capture retakes the whole set (question Q3).
- Volume uncertainty, repeat reports, tonnes from a weighbridge: deferred on 18 Nov, still deferred.
- The general survey report ("Project report") and its stockpile parts.
- A new report page switch for the site overview (D13).
- Any change to the pipeline pack or to Python.

## 4. The engine change for the 3D pile picture (defect b)

**What went wrong in the spike, read from the code:**

- The opened pile's glass box is drawn by `R/survey/pile/pileLookScene.ts`. Its `openedPile()` returns a pile only when it is the focused measurement **and** `measurementsOn(...)` lists it, which applies `scopeOnScreen(m.scope, dates, hidden)` (`packages/workspace/src/dateVisibility.ts`): a pile filed under a survey date counts as on screen only while that survey's layers are shown.
- The capture brings a date into view with `timeline.focusSurvey(capture)` (`R/report/volumetric/liveStage.ts`, `showDate`). With the latest date in view, a pile filed under the earlier date is not on screen, so no box is drawn.
- The spike worked around this by taking each pile's 3D picture on the pile's own date (`planShots`: "a pile filed under a survey date is pictured in 3D on that date"). Most piles of the test project are filed under the earlier date, so most 3D pictures showed the earlier survey.
- The box also reads its date and outline from the date in focus (`captureOf`, `ringOf`), and its colours from the person's own Solid or Height choice (`pileView`).

**The change:**

1. `R/survey/pile/pileLookState.ts` gains a report-only input and a fuller output:
   - `pinned: { id: string; capture: string } | null`: "draw this pile's box as it is on this survey date, whatever is focused, selected or on screen".
   - `shownOn: string | null` beside `shown`: the survey date the drawn box was sampled on, so a caller can tell the box of the wanted date from an earlier one still on screen.
2. `R/survey/pile/pileLookScene.ts`:
   - `openedPile()` returns the pinned pile first (it must still be a pile and not be under edit), without the focus test and without `measurementsOn`.
   - `captureOf(m)` returns `pinned.capture` for the pinned pile; `ringOf(m)` reads `editedOutline(m, pinned.capture)`.
   - A pinned box is always drawn Solid, never by height and never with cut and fill colours, and shows no legend.
   - The scene redraws when `pinned` changes (a subscription that compares `pinned` only, since the scene itself writes `shown` and `hits`).
   - `publish` also sets `shownOn`.
3. The sampling of a pile's base (`sample()` in `pileLookScene.ts`, `buildBase` with its `perimeter`, `interior` and `atPoints` callbacks) moves into a shared helper, `R/survey/pile/pileBase.ts`, so the report's profile (section 6, T5) builds the base line with the same code instead of a second copy (the spike copied it).
4. `CaptureStage` (`R/report/volumetric/captureViews.ts`) gains `openPile(id: string | null, capture?: string): Promise<boolean>`. `liveStage.ts` implements it by setting `pinned` and waiting until `shown === id && shownOn === capture` (or, for `null`, until `shown === null`), with a time limit. It does not touch `measureStore` focus or selection, so no panel opens and the person's selection needs no extra restore. `restore()` clears `pinned` as well.
5. `planShots` takes every pile's 3D picture on the latest date.

**Not verified by running:** that `focusSurvey` hides the other dates' layers in every project kind (survey projects and older kit projects take different paths in `R/workspace/timeline.ts`). The fix does not depend on it: the pinned box ignores what is on screen. Also not verified: a pile filed under a date whose survey is shifted (`captureShift`) pictured on another date. The box keeps the convention the figures already use (`drawnPoints` with the pile's own scope, as `volumesOverTime` in `R/reportPage/house/surveyData.ts`); T3 adds a unit test with a shifted date.

## 5. Capture at export: progress, Stop and scale (defect d)

What exists today: `captureViews` already counts shots into `pictureRun`, `R/report/volumetric/PictureProgress.tsx` already shows a modal card with a bar and a Stop button, and a stopped run saves nothing. The spike's export called that same path, yet the spike's author saw no feedback during the 28 seconds. Why is **not verified**; T8 starts by reproducing it (candidates: the card mounted under the Scene, or the card shown only after the Scene finished opening).

The design:

- **One flow.** `Export PDF` and `Export HTML` call one function (`exportVolumetric(format)`, new file `R/report/volumetric/exportRun.ts`): save pending text, take pictures when the frame is missing or its fingerprint is not current, then run the export. The Exports screen's two volumetric actions go through the same function, so they no longer fail with "The report has no pictures yet".
- **Progress.** The card says what is being pictured ("Site, 12 Mar 2026" or "Pile 4 of 31: Pile D") with "Picture 12 of 97", a bar, and Stop. Stop ends the run after the current picture, saves nothing, keeps the previous set and cancels the export. A second phase line, "Writing the PDF" or "Writing the HTML file", shows until the file is saved.
- **Order.** Shots are grouped by survey date so each date's layers load once: the compared date's site pictures and pile photos, then the latest date's site pictures, pile photos and 3D pile pictures, then cut and fill.
- **Waiting.** A site picture waits as today. A pile picture waits only until the layers report loaded and two frames have passed, with a short quiet time (the spike's 450 ms is the starting point; T4 measures and sets it).
- **Size.** A pile picture is 800 x 600 px (4:3), JPEG 0.80. Per pile: the photo on the latest date, the photo on the compared date (same framing: the union of both outlines plus a margin) and the 3D picture on the latest date.
- **The cap.** `REPORT_VIEWS_MAX` goes from 64 to 512. With two dates that is 7 site pictures and room for 168 piles. `planShots` gives pictures to the piles in report order (largest first) while they fit; a pile past the cap prints its card with the existing crop of the site photo for both photos and the line "No 3D picture: the report pictures the 168 largest piles" (the number is computed). The summary and overview are never affected.
- **Budget to measure.** The spike took about 0.9 s per picture. Target after the reordering: 0.6 s or less per pile picture on the founder's PC, so 30 piles take about one minute and the full cap about five. T4 records the measured figure in the session note.

## 6. Tasks

Rules for every task: tests are written first and seen to fail; no task edits a file another task of the same batch owns; a task that needs one more text key asks the build's coordinator, it does not edit the catalogue. No client, site or person name goes into code, tests, fixtures, screenshots or commit messages.

### T0. Words

- **What:** every new and changed text of the report and the editor.
- **Files:** `packages/ui/src/i18n/en/vreport.ts`.
- **Packages:** `@aio/ui`.
- **Keys (new or changed):** `vreport.band.pilesMeasured` ("{count} piles, {measured} measured", with a one-pile form), `vreport.notComputed`, `vreport.pile.baseNotSet`, `vreport.pile.belowBase`, `vreport.overlap.warning` (two piles) and `vreport.overlap.warningMany`, `vreport.overview.*` (title, three captions), `vreport.card.*` (photo, 3D, before captions; profile title; footprint, base, base level, peak height, density, surveyed; "No 3D picture" line), `vreport.pages.piles` relabelled, `vreport.pictures.progress*` (what is pictured, the writing phase), `vreport.pictures.takeNow`, `vreport.pictures.none` reworded for D4, `vreport.error.noPictures` reworded (no "press Take pictures").
- **Tests first:** `packages/ui/src/i18n/glossary.test.ts` stays green (pile, Volumetric report, "cut and fill" in sentences); a catalogue test that no `vreport.*` text holds an em or en dash.
- **Acceptance:** all keys exist; nothing in the catalogue says "Take pictures" as a required step.

### T1. The pictures' contract

- **What:** the frame learns the pile pictures and the larger cap.
- **Files:** `packages/schema/src/report.ts`, `packages/schema/src/report.test.ts`, `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md` (the report views section).
- **Packages:** `@aio/schema`, docs.
- **Change:** `ReportViewKind` gains `pile-photo` and `pile-3d`. `ReportView` gains optional `pile` (a measurement id) and `extent` (`[e0, n0, e1, n1]`, project CRS; the ground a `pile-photo` covers). A refinement: a pile kind needs `pile`, a `pile-photo` needs `extent`, a site kind has neither. `REPORT_VIEWS_MAX` becomes 512 (the `report:saveViews` request in `ipc.ts` follows it by reference). The schema name stays `aio.report-views/1`.
- **Tests first:** a frame with both pile kinds parses; a `pile-3d` without `pile` is refused; a `photo` with `pile` is refused; 512 views parse and 513 do not; a frame written before this change still parses.
- **Acceptance:** `pnpm --filter @aio/schema test` green; the contract row is written (section 8).

### T2. The report model

- **What:** every pile in the model, a card for every pile, the new page plan, overlaps, the percentage rule, the profile type.
- **Files:** `packages/project/src/export/volumetric.ts`, `packages/project/src/export/volumetric.test.ts`, `packages/project/src/export/index.ts` if a type is newly exported.
- **Packages:** `@aio/project`.
- **Change:**
  - `volumetricModel` keeps every input pile (today it filters out piles with no figure on any date). Piles with a volume rank first, largest first; the rest follow in natural name order.
  - `outline`, `previousOutline` and `areaM2` fall back to the date's own outline when the pile has no figure (as the spike did).
  - Two piles never share a tag: when `pileTag` gives a duplicate, every tag becomes the rank.
  - `kpis.piles` stays "piles counted on the latest date"; the model adds `kpis.listed` (all piles).
  - `changeShare` returns null unless the earlier and the latest volume are both above zero (D10). `share` leaves out piles at or below zero.
  - New `VolumetricPileProfile` type: `a`, `b`, `lengthM`, `series` (each `kind: 'current' | 'earlier' | 'base'`, `capture?`, `date?`, `chainage`, `z`), `baseLevel: [min, max] | null`, `baseKind: 'own' | 'boundary'`. `VolumetricPileInput.profile?` and `VolumetricPile.profile` (null when not sampled) carry it, so it rides on the model the editor's preview receives.
  - `VolumetricInput.overlaps?: { a: string; b: string }[]` (pile ids); the model resolves them to `overlaps: { a: tag-and-label, b: tag-and-label }[]`, keeping only pairs where both piles have a latest volume (D3).
  - `VolumetricPile.belowBase: boolean` (latest volume under zero).
  - `cards` holds every pile id; `compact` is removed with `VOLUMETRIC_CARDS`' use for cards (the share bar still names the 8 largest). `PILE_CARDS_PER_PAGE = 2`.
  - `PlannedPage` gains `part?: 'overview' | 'cards'`. `pagePlan`: cover pages; then, when "piles" is on, one overview page and `ceil(cards / 2)` card pages; then the change pages when there is a compared date. `PILES_ROWS` and `PILES_CONTINUED_ROWS` go.
  - `methodNote` unchanged in wording.
- **Tests first:** a pile with no figure is in `piles` and `cards` with `latestM3 === null`; "8 listed, 3 counted" gives `kpis.listed === 8`, `kpis.piles === 3`; duplicate tags fall back to ranks; `changeShare(-97, 93.1)` with a latest of -3.9 is null and with 100 to 50 is -50; a negative pile has no share segment and `belowBase`; an overlap pair with one uncomputed pile is dropped; `pagePlan` of 5 piles with a compared date is cover, overview, 3 card pages, change; with "piles" off there is no overview; with one date there is no change page.
- **Acceptance:** `pnpm --filter @aio/project test` green; no caller of the removed `compact` is left (typecheck).

### T3. The pile look pinned to a date (engine change, section 4)

- **Files:** `R/survey/pile/pileLookState.ts`, `R/survey/pile/pileLookScene.ts`, new `R/survey/pile/pileBase.ts` and `pileBase.test.ts`, new `R/survey/pile/pileLookPinned.test.ts` (the pure rule: which pile, which date, which outline), `R/survey/pile/pileLook.test.ts` if a helper moves.
- **Packages:** desktop renderer.
- **Change:** as section 4, items 1 to 3. To keep the rule testable without a WebGL scene, `openedPile`, `captureOf` and `ringOf` become one pure function in `pileLookState.ts` (or a small `pileLookTarget.ts`): `lookTarget(measureState, datesOnScreen, focus, manifest, pinned)` returning `{ m, capture, ring, mode } | null`; the scene calls it.
- **Tests first:** unpinned, the target is today's (focused pile on screen, date in focus, the person's mode); pinned to a pile filed under an earlier date with the latest date given, the target is that pile on the latest date with that date's outline, mode Solid, although the pile is not on screen and nothing is focused; a pile under edit is never the target; a pinned id that is not a pile gives null; `pileBase` returns the same base heights as the code it replaces for a Toe surface, a Lowest point and a Custom base (fixtures in the test), and the boundary's heights when no base can be built; a shifted survey date keeps the pile's own scope shift.
- **Acceptance:** the existing pile specs still pass unchanged (`pile-panel.spec.ts` is run in T11); `host.dataset.pileLook` is set for a pinned box as for an opened one.

### T4. Capture

- **Depends on:** T1, T3.
- **Files:** `R/report/volumetric/captureViews.ts`, `captureViews.test.ts`, `R/report/volumetric/framing.ts`, `framing.test.ts`, `R/report/volumetric/liveStage.ts`, `apps/desktop/src/main/reportViews.ts`, `apps/desktop/src/main/reportViews.test.ts`.
- **Packages:** desktop renderer, desktop main.
- **Change:**
  - `planShots(dates, pair, piles)`: the order and the cap of section 5; names `pile-<k>-photo-<n>.jpg` and `pile-<k>-3d.jpg` (inside `ReportViewFileName`). It returns, beside the shots, the ids of the piles left without pictures.
  - `pileFrame(rings, aspect, margin)` in `framing.ts`: the 4:3 extent around the union of a pile's outlines on the pictured dates, with a floor of 20 m.
  - `captureViews` takes the pile shots: a `pile-photo` straight down on that extent with the measurements' own outlines off (the report draws the outline itself, from `extent`); a `pile-3d` with `stage.openPile(id, latest)`, from the south-east, framed on the pile and the space above it. A pile whose box did not come within the time limit gets no `pile-3d` view; the run does not fail.
  - `CaptureStage` gains `openPile` (section 4) and `showOutlines(on)`; `pictureRun` gains `label` (what is pictured) for the card.
  - **Defect a.** `renderInto` (`liveStage.ts`) draws the shot over paper: for the length of the render it sets `scene.background` and the clear colour to the report's picture colour and puts both back in `finally` (the pattern of `packages/engine/src/stage/groundShading.ts`, lines 207 to 238). Cause as read from the code, **not reproduced here**: the renderer has no alpha channel (`packages/engine/src/stage/Stage.ts`, line 94), in sky mode `scene.background` is null (`environment.ts`, `applyMode`), and the straight-down orthographic camera does not see the sky mesh, so ground without data shows the black clear colour. T4 reproduces it first on the change demo; if imagery tiles themselves hold black texels where they have no data, the fix moves to the imagery material and the task reports back before going further.
  - `apps/desktop/src/main/reportViews.ts` needs no logic change (it reads `REPORT_VIEWS_MAX`); its refusal text and test follow the new number.
- **Tests first** (`captureViews.test.ts`, with the fake stage the file already has): every pile's `pile-3d` is planned on the latest date, also for a pile filed under the earlier date; each date's shots are contiguous; `openPile(id, latest)` is called before a pile's 3D shot and `openPile(null)` after, also when the shot throws; outlines are off during a `pile-photo` and back on after; with 200 piles and two dates 168 get pictures and 32 ids come back as unpictured, and the frame has at most 512 views; a pile whose box does not come is skipped without failing the run; Stop during a pile shot saves nothing and restores the view; the two `pile-photo` views of one pile share one extent. `framing.test.ts`: `pileFrame` is 4:3, holds every ring, has the margin, and has the floor. `reportViews.test.ts`: 512 files are saved, 513 refused.
- **Acceptance:** a run saves `3 x piles + 3 x dates + 1` pictures (three site pictures per date and cut and fill: 7 site pictures with two dates, 10 on the three-date Quarry demo, so 22 for its four piles); no top-down picture has a black region (T9 checks a pixel); the measured seconds per pile picture are in the session note.

### T5. Profiles and the model's input

- **Depends on:** T2, T3.
- **Files:** new `R/reportPage/volumetric/pileProfiles.ts` and `pileProfiles.test.ts`, `R/reportPage/house/surveyData.ts` (a `pileProfiles` build option and field), `R/reportPage/house/main.ts` (the volumetric run asks for it), `R/reportPage/volumetric/run.ts`, `run.test.ts`.
- **Packages:** desktop renderer.
- **Change:**
  - `pileProfiles.ts`: for each pile, the line is `pileAxis(ring)` on the latest date's outline (the pile panel's default line). The surfaces are sampled with the report page's existing `sampleProfiles(line, refs, engine.resolver(latest))` (`surveyData.ts`, line 866), latest as `current`, the compared date as `earlier`: the same function the survey report uses for a line's card. The base is sampled at the same stations with `pileBase.ts` (T3) and kept only inside the outline, as a `base` series. `baseLevel` is the lowest and highest base height under the pile.
  - A pile whose profile cannot be sampled (no prepared surface) has `profile: null`; nothing fails.
  - `volumetricInputOf` (`run.ts`): a pile with no rows still gets one entry per survey date with its outline and area, so it has a picture and a footprint (D1); `overlaps` from `overlapShare` on the latest date's outlines at `SAME_PILE_SHARE` (both from `@aio/survey`); each pile's `profile`.
  - The compared date for the profile's `earlier` series is the model's compared date, so the editor's "Compare with" choice changes the profile as it changes the figures. `run.ts` passes it to the build.
- **Tests first:** a two-date fixture gives a `current`, an `earlier` and a `base` series with equal chainage; a one-date fixture has no `earlier`; the base series is null outside the outline; a pile with no base spec uses the Toe surface, as the pile look does; an unsampled date gives `profile: null`; `volumetricInputOf` keeps a never-computed pile with `volumeM3: null` on each date and a real area; two outlines sharing 60 % give one overlap pair, 30 % none.
- **Acceptance:** the model the editor receives carries profiles (checked in `run.test.ts` on the `volumetric-model` kind).

### T6. The pages

- **Depends on:** T0, T2. (Uses T1's types.)
- **Files:** `R/reportPage/types/template.ts`, `template.test.ts`, `R/reportPage/volumetric/cover.tsx`, `cover.test.tsx`, `piles.tsx`, `piles.test.tsx` (rewritten), new `overview.tsx`, `overview.test.tsx`, new `pileCard.tsx`, `pileCard.test.tsx`, `change.tsx`, `change.test.tsx`, `chrome.tsx`, `chrome.test.ts`, `volumetric.css`, `piles.css`, `change.css`.
- **Packages:** desktop renderer.
- **Change:**
  - `template.ts`: `ReportViews.pilePicture(kind: 'photo' | '3d', pile, capture): { src: string; extent: Extent | null } | null`, read from the typed views. `picture()` never returns a pile view (kinds differ now, so no guard is needed).
  - `cover.tsx`: the band's "N piles, M measured" (only when they differ); the table lists every pile, "Not computed" spanning the figure columns, "Not set" for a missing base; the overlap warning as a plain notice under the table; the method note leaves the cover.
  - `overview.tsx` (a component, used by `piles.tsx`; `types/index.ts` keeps its three page modules): the share bar, the site photo, the elevation map and the 3D site view with numbers and captions.
  - `pileCard.tsx`: the header (number, name, change badge, "since" date, volume or "Not computed", the below-base note); three pictures at 4:3 with captions, the outline and the A to B line drawn as SVG over the photo from `extent`, the outline alone over the before photo; the profile as `ProfileChart` printed statically (`width`, `height`, `interactive={false}`, `exaggeration` from `autoExaggeration`, as `profileChart` in `R/reportPage/house/survey.tsx`), with the shade between the latest surface and the base; the six figures. A missing picture or profile leaves a quiet placeholder of the same size, so two cards always fit a page.
  - `piles.tsx`: the overview page when `page.part === 'overview'`, else two cards.
  - `change.tsx`: bars with real row height; the method block once, on the report's last page (D12).
  - `chrome.tsx`: `spreadMarkers(points, radius)`, a pure function that moves badges which would overlap apart and returns a leader to each true place; `SitePicture` uses it. `Page` and `Footer` drop the footer method.
  - CSS: nothing clips text. The "In short" block and every text block grow with their text; the page fit is kept by the table taking fewer rows on the first page (`COVER_ROWS` is already a count per page, T2 keeps it). **Not verified:** where the mock-up's summary was cut ("... since 3"). The printed CSS has no clamp on it, so the likely cause is a half-typed text saved as the person's own version; T6 reproduces it with a 600 character summary first and, if the print is innocent, hands the finding to T8 (the editor's save).
- **Tests first:** cover: 8 piles with 3 measured prints the band text and five "Not computed" rows, and no row is missing; the overlap notice names both piles and is absent without overlaps. Overview: three pictures with a badge per pile. Card: a measured pile prints volume, badge with m³ and %, three pictures, the chart's `svg.pc-svg` with three series and the six figures; an uncomputed pile prints "Not computed", no badge, still its pictures and profile; a below-base pile prints the note and a badge without a percentage; a pile past the cap prints the "No 3D picture" line; `pilePicture` null gives placeholders. Piles page: 5 piles make 3 card pages of 2, 2 and 1. Change: the method block is on the last page only and the footer has none. `spreadMarkers`: two badges at one point end at least a diameter apart with leaders to the same place; far badges do not move. A 600 character summary and a 280 character pile note render whole (no `overflow: hidden` or clamp on their boxes, asserted on the stylesheet text).
- **Acceptance:** the pages match the approved mock-up in structure; the look is judged by eye in T11 from an export of the Quarry demo (the design skills are loaded for this task).

### T7. The offline HTML file

- **Depends on:** T6.
- **Files:** `R/reportPage/volumetric/html.ts`, `html.test.ts`, `R/reportPage/volumetric/viewer/viewer.ts`, `viewer/types.ts`, `viewer/viewer.test.ts`.
- **Packages:** desktop renderer.
- **Change:** `printPages` supplies `pilePicture` (each pile picture encoded once, at most 640 px wide, with its own step down to 480 px before the file's budget refuses); `PICTURE_QUALITY` covers the two new kinds; the viewer lists piles without a volume as "Not computed" and never divides by a null. The 15 MB budget and its refusal text stay (question Q2).
- **Tests first:** the file holds each pile picture once; with 60 piles the file steps the pile pictures down before the site pictures; past the budget the existing refusal is returned; the viewer's data for an uncomputed pile has null figures and its row renders.
- **Acceptance:** `html.test.ts` green; the file opens with every request blocked (T9).

### T8. The editor and the export flow

- **Depends on:** T0, T4.
- **Files:** new `R/report/volumetric/exportRun.ts` and `exportRun.test.ts`, `R/report/volumetric/VolumetricEditor.tsx`, `VolumetricEditor.test.tsx`, `PictureProgress.tsx`, `PictureProgress.test.tsx`, `editorView.ts`, `editorView.test.ts`, `volumetricEditor.css`, `R/exports/exports.ts` (the two volumetric actions call `exportVolumetric`), `R/screens/Reports.tsx` only if `reportPiles` changes what is offered.
- **Packages:** desktop renderer.
- **Change:**
  - `reportPiles` returns every pile (`isPile`: a volume polygon), computed or not (today `editorView.ts` line 41 keeps only those with a stockpile item). The picture fingerprint's prefix becomes `v2`, so pictures taken before this change count as stale and are retaken by the next export.
  - `exportVolumetric(format)`: section 5, "One flow". The run state (pictures, writing, done, stopped, failed) lives in a small store the card reads.
  - `PicturesBar` goes. The preview's picture placeholders say "Pictures are taken when you export" with the "Take them now" link (D4); a stale set shows one quiet line with the same link.
  - `PictureProgress`: the label line, the writing phase; Stop is disabled in the writing phase. It still fits a 1100 x 700 window.
  - The first step is to reproduce the spike's "no feedback" (section 5) and fix its cause.
- **Tests first:** `exportRun.test.ts`: with current pictures no capture runs; with none or stale ones the capture runs before the export; a stopped or failed capture does not start the export and reports why; pending text is flushed first. `editorView.test.ts`: an uncomputed pile is a report pile; the fingerprint starts with `v2`. `VolumetricEditor.test.tsx`: no "Take pictures" button; Export PDF calls `exportVolumetric`; the placeholder link takes pictures. `PictureProgress.test.tsx`: the label and count show; Stop asks to stop; the writing phase disables Stop.
- **Acceptance:** from a project with no pictures, one click on Export PDF ends with a saved PDF that has pictures.

### T9. End to end

- **Depends on:** T4 to T8.
- **Files:** `apps/desktop/e2e/volumetric-report.spec.ts` (changed), `apps/desktop/e2e/volumetric-report-edit.spec.ts` (changed), new `apps/desktop/e2e/volumetric-report-layout.spec.ts`. The spike's `spike-report.spec.ts` is not brought over.
- **Packages:** desktop e2e.
- **Detail:** section 9.

### T10. Documents

- **Depends on:** T8 (the flow is final).
- **Files:** `docs/guide/10-reports-and-exports.md`, `docs/KNOWN-LIMITS.md` (line 339: no "Take pictures again"; add the 168 pile picture cap and the HTML size limit for many piles), `docs/TESTING.md` (the volumetric report steps), `docs/plans/2026-11-18-volumetrics-finalize.md` (steps 29 to 32 of its test list point here).
- **Tests:** `pnpm format:check`, `node tools/agent/check-public-text.mjs <files>`.

### T11. Proof

- **Depends on:** all.
- `pnpm check`; the three report specs and `pile-panel.spec.ts` the CI way (section 9); each "How to test" step of section 12 driven once on the Quarry demo by a spec and once by hand on a copy of a two-date project; an independent review; the added lines scanned for names; every screenshot looked at; `/wrapup`; hand-over to the merge coordinator. The session note carries the measured capture times.

## 7. Execution DAG

### Dependencies

```
T0 words ───────────────┬──────────────► T6 pages ──► T7 html ──┐
T1 contract ──► T4 capture ──► T8 editor and export ─────────────┤
T2 model ─────┬──► T5 profiles and input ────────────────────────┼──► T9 e2e ──► T11 proof
              └──► T6                                            │
T3 pile look ─┬──► T4                                            │
              └──► T5                              T10 docs ─────┘  (after T8)
```

### Batches

| Batch | Tasks (run at once, dispatched in one message) | Why they can run together                                                                                                                                                                                                             |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | T0, T1, T2, T3                                 | Four packages or folders, no shared file: `@aio/ui` text; `@aio/schema` and the contract docs; `@aio/project`; `R/survey/pile/`.                                                                                                      |
| 1     | T4, T5, T6                                     | T4 owns `R/report/volumetric/captureViews.ts`, `framing.ts`, `liveStage.ts` and `main/reportViews.ts`; T5 owns `R/reportPage/house/`, `pileProfiles.ts` and `run.ts`; T6 owns `types/template.ts`, the page components and their CSS. |
| 2     | T7, T8                                         | T7 owns `html.ts` and `viewer/`; T8 owns the editor files, `exportRun.ts` and `R/exports/exports.ts`.                                                                                                                                 |
| 3     | T9 and T10 at once, then T11                   | T9 owns `apps/desktop/e2e/`, T10 owns docs. One Playwright run at a time, `--workers=1`.                                                                                                                                              |

Files that look shared and who owns them: `R/report/volumetric/liveStage.ts` is T4's (T8 only calls `takeReportPictures`); `R/report/volumetric/editorView.ts` is T8's (T4's request takes the piles as an argument, so it does not need `reportPiles`); `R/reportPage/volumetric/run.ts` is T5's (T8 does not touch the "no pictures" refusal there, it prevents it); `R/reportPage/types/template.ts` is T6's (T7 reads it).

### Critical path

**T3 → T4 → T8 → T9 → T11.** T3 (the engine change) and T4 (capture, with defect a to reproduce) carry the most risk and sit first on the path. T6 is the largest task by lines but has slack of one batch.

### Rough effort

About 9 to 11 working days of agent work; in the four batches about 3 calendar days, plus one founder test of about 30 minutes.

## 8. Contract changes

Each needs its row in `docs/architecture/contract-changes.md` (T1 writes the first two, T2's and T5's types go in the same row as a note, since they are not `@aio/schema`).

| Change                                                                                                                                                                                           | Where                                                                       | Kind                                            | For an older build                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReportViewKind` gains `pile-photo`, `pile-3d`; `ReportView.pile?` and `ReportView.extent?`; a refinement ties them to the kinds                                                                 | `packages/schema/src/report.ts`                                             | additive to `aio.report-views/1`                | It refuses a frame holding the new kinds (its enum is closed), reads it as "no pictures" and offers Take pictures, which replaces the set with its own. Nothing else is lost. |
| `REPORT_VIEWS_MAX` 64 to 512 (the frame's `views` and the `report:saveViews` request's `files`)                                                                                                  | `packages/schema/src/report.ts`, used by `ipc.ts` and `main/reportViews.ts` | a limit raised                                  | A frame with more than 64 views is refused the same way.                                                                                                                      |
| Report model (`@aio/project`, not a frozen contract; recorded for readers of the model): `VolumetricPile.profile`, `belowBase`; `kpis.listed`; `overlaps`; `PlannedPage.part`; `compact` removed | `packages/project/src/export/volumetric.ts`                                 | internal to this build (window and report page) | None: the model is computed and read by the same build and never saved.                                                                                                       |
| Picture fingerprint prefix `v1` to `v2`                                                                                                                                                          | `R/report/volumetric/editorView.ts`                                         | not a schema change (a string inside the frame) | Pictures taken before count as stale and are retaken at the next export.                                                                                                      |

Not changed: `ReportPageId` and `ReportTextFile` (D13), the `report:volumetricModel` channel (its `model` is `unknown`), the pipeline pack, any Python.

## 9. End to end specs

Every spec uses the generated Quarry demo (four piles filed under survey dates, three dates) or a synthetic project the spec writes itself. None uses real data and none carries a real name.

| Spec                               | State   | What it drives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `volumetric-report.spec.ts`        | changed | No "Take pictures" click. Export PDF from a project with no pictures: the progress card shows a label and a count, the PDF is saved; `frame.json` holds `3 x piles + 3 x dates + 1` views; every `pile-3d` view's `capture` is the latest date (the demo's piles are filed under earlier dates, so this is defect b's regression test); the page count is cover, overview, `ceil(piles / 2)`, change; the figures still equal Project > Volumes. Export HTML: one file under the budget, opened with every request blocked, pile pictures present.                                                                                                                                                                      |
| `volumetric-report-edit.spec.ts`   | changed | The "take pictures first" precondition goes; the page switch is found by its new label; with "piles" off the PDF has neither overview nor cards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `volumetric-report-layout.spec.ts` | new     | (1) A copy of the demo with one pile's results removed and one pile's outline copied onto another: the summary reads "5 piles, 4 measured" (as the fixture makes it), the uncomputed pile's row and card read "Not computed" and its card still has pictures; the overlap warning is printed once and names the two piles. (2) Stop during the capture: no file is saved, the previous `frame.json` is untouched, the editor is back, the view is where it was. (3) The site photo's top-left region outside the survey is the paper colour, not black (a pixel read from the saved JPEG; skipped with a stated reason if the demo covers its whole frame). (4) The card fits a 1100 x 700 window (`test.use` sets it). |

Changed specs that only need to keep passing: `pile-panel.spec.ts` (T3 touched the pile look).

**Run the CI way**, from `apps/desktop`, one run at a time:

```powershell
pnpm demo:build --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'
$env:QUADRION_E2E_SCALE = '1'
$env:QUADRION_E2E_SWGL = 'warp'
npx playwright test e2e/volumetric-report.spec.ts e2e/volumetric-report-edit.spec.ts e2e/volumetric-report-layout.spec.ts e2e/pile-panel.spec.ts --workers=1
```

The run must print `[e2e] window 1100 x 720 px at display scale 1`. In a worktree the Python for the pipeline comes from the main checkout's venv (`QUADRION_E2E_PYTHON`, and `--python` for `demo:build`). On WARP the capture is slower than on a GPU: the specs wait on the progress card's state, never on a fixed time, and `--repeat-each=3` is run once on the new spec.

## 10. Risks

| Risk                                                                                                                                        | What is done about it                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The black ground has another cause than the clear colour (imagery tiles with black texels).                                                 | T4 reproduces first and reports before changing the imagery material, which every view shares.                                                                                         |
| The pinned box needs the pile's surface prepared; on a date still preparing the box falls back to a coarse ray cast of the stage's terrain. | The export waits for nothing new: a box that does not come in time is skipped and the card prints a placeholder. T9 runs on prepared demo dates.                                       |
| Capture time grows with the number of piles (three pictures each).                                                                          | The order, the short wait, the measured budget, the cap and Stop (section 5). Question Q3 if it is still too slow.                                                                     |
| 512 pictures in one `report:saveViews` message (about 40 MB at 800 x 600).                                                                  | T4 measures it on a synthetic 168 pile project in a unit-level main test; if it is too heavy the cap drops, not the message design (a chunked save would be a second contract change). |
| The offline HTML file passes 15 MB at roughly 70 piles or more.                                                                             | Pile pictures step down first; then the existing refusal points to Export PDF. Named in the known limits. Question Q2.                                                                 |
| `ProfileChart` printed at card width: labels may crowd at about 180 mm x 40 mm.                                                             | It already prints statically in the survey report; T6 checks the card's size in `pileCard.test.tsx` and by eye, and may pass a smaller `height` only.                                  |
| WARP on CI is far slower than the founder's PC for 19 pictures on the demo.                                                                 | Specs wait on state with a generous limit; the demo has four piles.                                                                                                                    |
| The report lists piles the Volumes inventory leaves under "Not counted", so the two lists differ in length.                                 | Intended (D1). The totals still match (D11); the e2e compares totals and the measured rows, not the row count.                                                                         |
| Two sessions edit the report at once (the volumetrics test fixes landed on `main` on 20 Nov).                                               | Rebase onto local `main` before T9; `finish-task.mjs` does it again before hand-over.                                                                                                  |

## 11. Open questions for the founder

These could not be settled from the code. Each has a recommendation, and the build proceeds on it unless the founder says otherwise.

- **Q1. A "Take them now" link in the editor.** Pictures are taken at export. Until the first export the editor's preview has no pictures. Recommendation: keep one quiet link in the preview's empty picture, so the preview can be checked before exporting. The alternative is a preview without pictures until the first export.
- **Q2. Very large sites in the HTML file.** Past roughly 70 piles the single offline file exceeds 15 MB and the app says to export a PDF. Recommendation: keep the limit for now. The alternative is a larger limit (a 30 MB file is slow to mail and to open on a phone).
- **Q3. Capture time on very large sites.** At the measured rate 100 piles take about three minutes with progress and Stop. Recommendation: accept it now; retaking only the piles that changed is new capability for after the freeze.
- **Q4. Overlap threshold.** The warning uses the engine's "same pile" test (half of the smaller outline). Two piles that share less than that, such as neighbours with touching toes, get no warning. Recommendation: keep it, so the report adds no number of its own.
- **Q5. A negative pile in the site total.** The report keeps the total equal to the app's (D11), so a pile at -3.9 m³ lowers it by 3.9. Leaving such piles out of the total would have to change in the app first. Recommendation: no change now.

## 12. How to test (draft, for the founder)

On your own two-date stockpile project, in the dev app (`pnpm dev` on the local `main` after the coordinator lands the branch). The generated demo projects are not on the dev app's Projects screen, so every step uses your project. Nothing is written into the project except the report's own pictures folder and text file.

1. Open the project. Go to **Reports** > **Customer reports** > **Open volumetric report**.
   - Expect: the editor opens. There is no "Take pictures" button. The preview's empty pictures say that pictures are taken when you export.
2. Click **Export PDF** and choose where to save.
   - Expect: the 3D view opens and a card shows what is being pictured ("Site, ..." then "Pile 1 of N: ...") with a count, a bar and **Stop taking pictures**. Then "Writing the PDF". The view comes back to the report editor as you left it, and a message says where the file was saved.
3. Open the PDF. Page 1:
   - Expect: under the title, "N piles, M measured". The table lists every pile of the project; piles without a volume read "Not computed". If two of your piles lie on top of each other, a line under the table says the site total may count the same material twice and names them.
   - Expect: the site photo has no black area; ground the survey does not cover is light grey. Numbers on the photo do not sit on top of each other.
   - Expect: the "In short" text is whole, also if you typed a long one.
4. Page 2, the site overview:
   - Expect: the site photo, the elevation map and the 3D view, each with the pile numbers.
5. The pile pages, two piles per page:
   - Expect per pile: the volume and the change since the earlier survey; the photo with the outline and the A to B line; a 3D picture of the pile captioned with the **latest** survey date, for every pile; the earlier survey's photo; the elevation profile with both surveys and the dashed base line; footprint, base, base level, peak height, density and survey date.
   - Expect for a pile with a negative volume: the volume as computed, the note "The surface is below the base here. Check the base.", and a change in m³ without a percentage.
6. The last page, change between surveys:
   - Expect: the before and after photos, the cut and fill picture, a bar per pile with room between the rows, and the method note once, at the end.
7. Back in the editor, click **Export PDF** again without changing anything.
   - Expect: no pictures are taken this time; the file is written at once.
8. Click **Export HTML**, open the file in a browser.
   - Expect: the same report; the pile list shows the piles without a volume as "Not computed".
9. In the project, move one corner of one pile's boundary and save. Open the report again and click **Export PDF**. While the card shows, click **Stop taking pictures**.
   - Expect: no file is saved, a message says taking them was stopped, and the editor is back. Export again and let it finish: the pictures are new.
10. In the editor, switch **B. Site overview and pile pages** off and export.
    - Expect: the PDF has the summary and the change page only.

Each step is driven by `volumetric-report.spec.ts`, `volumetric-report-edit.spec.ts` or `volumetric-report-layout.spec.ts` on the Quarry demo before hand-over (T11). Step 5's negative pile and step 3's long text are covered by unit tests of the pages; say if your project shows them differently.

# RF coverage, simplified: the Coverage chip, the Coverage panel and Auto-plan (design)

Draft, 18 Oct 2026, for the founder's review. It builds on `2026-10-17-rf-coverage-design.md` (Phase 1, on main). Mockups were made over real screenshots of the app from the RF e2e fixture. They are in `.superpowers/brainstorm/` on the author's machine and are not committed.

## Why

RF coverage works, but people can't find it, and using it means filling in a long form:

- **There is no visible way in.** The only entry is "Coverage..." in the project right-click menu (`shell/actions/rfActions.tsx`). It is the third of 14 items, it isn't in Ctrl+K and there is no island tile.
- **There are about 12 required clicks before Run unlocks.** Accept each antenna in the Measure bench, right-click, Coverage..., Group by bearing. Then, for every sector: the sector chip, the unit chip, the catalogue picker, the band and the bandwidth.
- **The RF tab is an unpinned panel**, so it closes as soon as another panel opens.

The founder wants coverage easy to find, a simpler panel, and **one button that has AI assign every antenna to a sector, choose its equipment and band, and run coverage**.

What planners usually have is **only the drone data**, and sometimes the operator's cell export. Auto-plan has to work from the drone data alone, and use a cell export when there is one.

## Goals

1. Coverage can be found from the stage without any menus once a project has antennas.
2. A single action goes from "antennas detected" to "coverage on the map". The only stop on the way is a review.
3. The panel shows what was decided, in three short steps. Detail is still there on demand.
4. Every value the AI chose is visibly marked, and the person can change it.

## Non-goals

- Changing the propagation engine, the job, the run format or the results UI (class table, views, export, legend, live preview). These stay as they are on main.
- New catalogue entries or verifying the existing ones. This is a known gap, see Risks.
- A sector-subset run, which has already been ruled out on main.
- Changes to `telecom/antennas.json` or to antenna review. Those belong to the antenna inventory work.

## Anti-goals (a failure even if it technically works)

- The AI changes **measured** azimuth, downtilt or height. Never. It only fills fields that RF owns (equipment, band, technology, bandwidth, and optionally power and e-tilt), following D5 of the Phase 1 design.
- The AI writes something without the person seeing it first.
- Auto-plan fails or blocks when there's no AI provider, no network, or the project policy forbids cloud AI.
- Low-confidence guesses look the same as confident ones.

## Decisions (founder)

- **F1. The way in is a Coverage chip on the stage** (option A of three; the left-nav item and the island tile were not chosen). It is a pill at the top of the stage, next to the date chip. It shows once `telecom/antennas.json` exists and has at least one unit.
- **F2. Auto-plan shows a review table first.** Applying and running happen only after the person presses **Apply & run coverage** (there is also **Apply only**).
- **F3. When the AI isn't sure, it still gives its best guess**, marked low confidence, so that a run can go ahead.
- **F4. The usual input is drone data only. A cell export is sometimes available**, and Auto-plan uses it when it is.
- **F5. The new panel replaces the current RF tab layout:** an AI card on top, then three steps, with the detail folded away (section "The Coverage panel").
- **F6. Auto-plan does not plan draft antennas.**
  - If no antenna is accepted yet, Auto-plan stops with "Review antennas first" and a button that opens the antenna inventory. It doesn't turn on "include drafts" and it doesn't accept antennas on the person's behalf.
  - **My reading:** when some antennas are accepted and some are drafts, it plans the accepted ones. The drafts are listed in the review dialog as "left out, not reviewed", with the same inventory link. This matches the mockup the founder approved.
  - The manual "include drafts" switch in step 1 stays for anyone who wants it.

## The Coverage chip

The chip sits on the stage, at the top beside the dates chip. It is a new stage slot (`at('rfChip', ...)`) inside the `Stage.tsx` RF marked block, next to `rfLegend`. It has three states:

| State                                                   | Text                                           | Actions                                                                      |
| ------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Antennas, none accepted (F6)                            | `Coverage · 4 antennas · review first`         | **Review antennas** (opens the inventory); clicking the chip opens the panel |
| Accepted antennas, nothing planned                      | `Coverage · 3 antennas · not planned`          | **✦ Auto-plan** button; clicking the chip opens the panel                    |
| Planned, no run, or the plan changed since the last run | `Coverage · 3 sectors · ready`                 | **▶ Run**; clicking the chip opens the panel                                 |
| Running                                                 | `Coverage · running…` with progress            | clicking the chip opens the panel                                            |
| Has a run                                               | `Coverage · RSRP · 17% fair or better · 08:17` | layer toggle (the same state as the Display bench Coverage eye), **Re-plan** |

- "Fair or better" is the share of area at the fair class or better, read from the selected run's class stats. If the view is best server or overlap, the chip says which view is showing instead.
- The chip respects the stage's narrow layout. At small widths it drops the descriptive text and keeps the dot, the word "Coverage" and the buttons.
- **Also (my call):** two Ctrl+K entries, "Auto-plan coverage" and "Open Coverage panel". The project menu "Coverage..." stays.
- The chip opens the Coverage tab **pinned**, so another panel doesn't replace it.

## The Coverage panel

This is the current RF workbench tab (`workbench/benches/RfBench.tsx`). The tab label changes from "RF" to "Coverage" (`wb.tab.rf`). The component and data stay the same; only the layout changes:

1. **AI card.** It explains what Auto-plan does in one sentence and has **✦ Auto-plan & run**, plus a "set up by hand" link that expands step 2. If a cell export has already been imported, or the person drops one on the card, the card offers **Use cell export** as well.
2. **Step 1, Antennas.**
   - It shows `N accepted · M draft`, with a "Review in inventory" link that opens the Measure bench antenna inventory.
   - The "include drafts" switch moves here from Study.
   - The step is done when at least one unit takes part.
3. **Step 2, Sectors & equipment.**
   - There is one row per sector, with its best-server colour swatch, the name and bearing, a summary of the equipment and band, and a state tag: `needs setup` (amber), `AI` (accent), `AI · low` (amber), `edited` or `from export`.
   - Expanding a row shows today's `SectorSection` / `UnitFields` for that sector, unchanged.
   - Group by bearing, Add sector, rename and delete stay in a small toolbar above the rows.
   - Units in no sector and orphan settings stay listed, as they are today.
4. **Step 3, Coverage.** Run, the run picker, the views, the class table, Export and the "Indicative" note, exactly as in today's Results section. When Run is disabled, the reason is the same `checkRun` text as today.
5. **Advanced (folded).** Study settings (model, environment, where people are, radius, grid) and the CSV import. Its one-line summary shows the current study, for example `TR 38.901 · urban macro · 3 km · 10 m`.

The unsaved-changes banner and the save flow don't change.

## Auto-plan

### Flow

1. Clicking the chip or the card first checks F6: if no antenna is accepted, it stops with "Review antennas first". Otherwise it gathers the inputs below. With cloud AI there is a send preview, following the antenna AI labels pattern: provider, an estimate of what is sent, consent.
2. A **proposal** is built and shown in the **review dialog**, with one row per antenna showing:
   - the sector,
   - the equipment,
   - the band, technology and bandwidth,
   - a one-line reason,
   - the confidence (high, medium or low).

   Excluded units, such as drafts and non-panels, are listed with the reason they are excluded.

3. The dialog has three buttons:
   - **Apply & run coverage** writes the proposal through the store actions: sectors as in C1, then `setEquipment` and `patchSettings`, plus the origin fields. It then calls `startRfRun`, which saves (C6).
   - **Apply only** writes without running.
   - **Cancel** writes nothing.
4. Applied values carry an origin of `ai` or `export`, so the panel can tag them (see Data). Editing a value by hand changes its origin to `user`.
5. **Re-plan** works the same way, but it keeps the sectors (C1) and every field group with the origin `user` or `export` (C3). The dialog shows those as "kept".

### Sources, in order of preference

1. **A cell export, if one is given.** Rows are matched to antennas leniently: an exact unit name or id first, then the sector name plus the nearest bearing, then height as a tie-break.
   - A matched row supplies the band, technology, bandwidth, power, e-tilt and model.
   - The AI only resolves the model text to a catalogue entry when the existing exact match (`cellCsv.findEntry`) fails.
   - Unmatched rows and unmatched antennas are listed in the dialog.
2. **Drone data and AI.** The sectors come from the measured bearings (`proposeSectors`, as today). For each antenna the AI receives:
   - the measured face width, height and depth;
   - the downtilt;
   - the height above ground;
   - the user fields (model, frequencies);
   - the photo crops, only when the project's photo consent allows;
   - the list of catalogue entries.

   It returns a catalogue entry id, the band, technology and bandwidth, a reason and a confidence. **The response is validated against the catalogue and band table.** An unknown id or an impossible band combination is dropped and replaced by the rules result, and its confidence is marked low.

3. **Rules only (no AI).** This is the same proposal made without a model: sectors as in C1, and equipment and band from the face-size rule in C2. It is always available.
   - The review dialog has a `<provider> | Rules only` switch.
   - Rules only is preselected when no provider is set up, when the project AI policy forbids it, or when the app is offline.

### The AI call

- **My call:** it goes through the existing AI routing, using the provider the project allows, including a local model, with the same gates as antenna labels (`main/aiGates.ts`, project policy and consent).
- It is a single request for the whole site, not one per antenna, so the sectors stay consistent with each other. For example, the AI can see that S1, S2 and S3 are the same model.
- The prompt states the lead market's technologies (LTE and NR only) and the band table from the catalogue. It must not contain the project or site name.
- **The schema forbids numbers for geometry.** The AI cannot return azimuth, tilt or height, matching the rule in the antenna labelling schema.
- A new main IPC pair follows `ai:antennaLabelPreview` / `ai:labelAntennas`: a preview that estimates cost and what is sent, and a call that returns the proposal. The renderer never talks to a provider directly.

### Author's calls from the builder review

The founder hasn't ruled on these. Each is written so it can be reversed.

- **C1. Sectors on first plan and on Re-plan.**
  - If the plan has no sectors yet, Auto-plan calls `applyProposal`, which groups by bearing.
  - If sectors already exist, Auto-plan and Re-plan **keep the sectors**: their ids, names, membership and any sectors the person added. Only units that are in no sector are added, each to the sector with the nearest bearing, or to a new sector when none is within the 30° rule.
  - Regrouping from scratch stays the explicit "Group by bearing" button.
  - The AI never changes sector membership. A cell export may only **rename** a sector it matches; it never moves units.
  - So sectors don't need an origin.
- **C2. Rules-only defaults (deterministic).** The rule uses the measured face:
  - **AAU-like** (depth ≥ 0.15 m and width ≥ 0.40 m): `generic-aau-64t64r-n78`, n78, NR, 100 MHz.
  - **Otherwise** (a passive panel): `generic-panel-65-17` plus `generic-rru-4t4r-4x40w`, B3 (1800 MHz), LTE, 20 MHz. These are the lead market's main 5G and LTE layers.
  - The rule's numbers are constants in `rfDefaults.ts`, not settings, and there is no band control in the dialog. The person changes the band per row after applying.
  - **Builder check:** confirm the generic panel and RRU cover B3. If not, fall back to the AAU rule and flag low confidence.
- **C3. How fine-grained the origin is.** One origin, plus a confidence, per **field group**:
  - `equipment`;
  - `etiltDeg`;
  - each carrier as a whole: band, technology, bandwidth and power together.

  Editing any field in a group marks that whole group `user`. Re-plan keeps every `user` and `export` group and replaces only the `ai` and `rules` groups.

- **C4. Carriers.** The AI and the rules propose **one carrier per antenna** in v1. A cell export may give several carriers when it has several rows for the same antenna. The review table shows one row per antenna, with extra carriers as sub-lines.
- **C5. The cell export is not stored.**
  - "Use cell export" works on a file picked or dropped during that session.
  - Values that came from it keep the origin `export`, so Re-plan keeps them without needing the file again.
  - "A cell export has already been imported" in the AI card means "at least one value has the origin `export`".
- **C6. Saving.**
  - **Apply & run** saves, through the existing `startCoverage` auto-save. The person has just reviewed the plan, so this doesn't break the anti-goal.
  - **Apply only** leaves the changes unsaved behind the existing banner, the same as any hand edit.

## Data

- **Origin of each field group (C3):** in `rf/sectors.json`, `RfAntennaSettings` gains an optional `origins?: { equipment?, etiltDeg? }` and each `RfCarrier` gains an optional `origin?`. Each value is `{ by: 'ai' | 'export' | 'rules' | 'user', confidence?: 'high' | 'medium' | 'low' }`.
  - When absent, the value counts as `user`, so old files are unchanged.
  - The schemas are `.strict()`, so the zod definitions in `packages/schema/src/rf.ts` gain these optional keys. The version `aio.rf-sectors/1` stays.
  - The Python `rf` inputs must ignore the keys. Check that `inputs.py` doesn't reject unknown keys, because the run snapshot embeds this shape.
- **Nothing is written to `antennas.json`.**

## Coordination with other sessions

| Area                                                                                                            | Owner                                             | What this work does                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `telecom/*`, `antennaStore`                                                                                     | Antenna inventory session (`feat/antenna-review`) | Read only. It uses the store's existing and new filter/solo fields for "Review in inventory". No edits. |
| `shell/Sidebar.tsx`, the Datasets tree, `MeasureBench.tsx`, `survey/measure*`                                   | Measurements session (`feat/measurement-layers`)  | Not touched. That is why the left-nav option was not chosen.                                            |
| `Stage.tsx`                                                                                                     | Stage-island session, which merges to main        | One new slot line inside the existing RF marked block. Tell the merger before landing.                  |
| `shell/Palette.tsx`                                                                                             | none active                                       | Add two entries.                                                                                        |
| `rf/*`, `RfBench.tsx`, `packages/rf`, `packages/schema/src/rf.ts`, `packages/ai` (new route), `main/` (new IPC) | this work                                         | Main changes.                                                                                           |

## Testing

- **Unit tests:**
  - the proposal builder: rules only, export matching (exact, bearing and height tie-break, unmatched);
  - AI response validation: unknown id, impossible band, a geometry field present;
  - keeping `user` origins on Re-plan;
  - the chip's state selection.
- **e2e:** extend the RF fixture spec, or add one, to cover two flows. The flows can't use the real provider; use the existing `e2e/fake-llm.ts`.
  - Auto-plan from the chip with Rules only: the review dialog, Apply & run, coverage on the map, and the chip status line.
  - Auto-plan with the fake LLM: AI tags appear, and a low-confidence row is amber.
- **Run it the way CI does** (1100 × 720, WARP), because the chip has to fit at that width.
- Screenshots of the chip, the panel and the dialog go in the hand-off.

## Risks

- **The catalogue is thin.** Only the generic AAU covers n78, and every vendor entry is unverified. Until the catalogue grows, AI picks will often land on generic entries. The dialog says "generic · unverified" on those rows, and that is accepted for v1.
- **Guessing from the drone alone is genuinely uncertain.** For example, a passive panel and a radio behind it versus an AAU. The confidence and the reason are the safeguard. Results stay labelled "indicative".
- **Space on the stage.** The top centre already has the dates chip, and a compare notice can appear there too. The chip has to collapse cleanly at 1100 px.

## Left to the builder

- The exact chip styling, within the existing `ss-chip` and stage-status look.
- Whether the AI card's cell-export drop target reuses `CsvImport` as is.
- Prompt wording, and how many photo crops to send for each antenna.
- How the review dialog is built: reuse `SendDialog` from `@aio/ai` for the send step, and a new table dialog for the review.

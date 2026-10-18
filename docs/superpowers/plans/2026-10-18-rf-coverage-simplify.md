# RF Coverage Simplify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RF coverage findable from a stage chip, restructure the RF tab into a pinned three-step Coverage panel, and add an Auto-plan that proposes sectors, equipment and bands (from AI, from rules, or from a cell export), shows a review, then applies them and runs coverage.

**Architecture:**

- The planning logic is pure TypeScript under `apps/desktop/src/renderer/rf/autoplan/`: rules, sector merging, export matching, building the proposal and validating the AI's picks. It works on `RfSectorsFile`, the catalogue and the antenna units, and is unit-tested without React.
- The AI call is a new main-process IPC pair modelled exactly on `ai:antennaLabelPreview` / `ai:labelAntennas` (`packages/ai/src/main.ts`). Main only checks the shape of the reply; the renderer checks it against the catalogue.
- The UI pieces are the chip, the review dialog, the AI card and the three steps. They are new files under `rf/` that read `rfStore` and a small `autoplanStore`.
- `RfBench.tsx` keeps its existing field components and only rearranges its top-level render.

**Tech Stack:** Electron, React 19, TypeScript, zustand-style `createStore`, zod (`@aio/schema`), Vitest, Playwright for Electron, Python 3 (pytest) for the `rf.coverage` job.

**Spec:** `docs/superpowers/specs/2026-10-18-rf-coverage-simplify-design.md`, which builds on `docs/superpowers/specs/2026-10-17-rf-coverage-design.md`.

## Global Constraints

- The repo is public. Never put operator, country or site names in code, tests, fixtures, i18n or commit text. Say "lead market". `check-public-text` misses operator and country names, so grep by hand before every commit.
- The AI never returns or changes azimuth, downtilt or height. The AI reply schema has no numeric geometry fields, and any such key is dropped with a warning.
- Nothing is written without a review. Auto-plan always goes through the review dialog (F2).
- Auto-plan does not plan drafts (F6). If no antenna is accepted, it stops with "Review antennas first".
- Rules only must work with no provider, offline, or under the `forbid` AI policy.
- `aio.rf-sectors/1` stays version 1. The new keys are optional, and a missing origin means `user`.
- Rules-only constants (C2):
  - **AAU-like** when `depthM ≥ 0.15` and `widthM ≥ 0.40`: `generic-aau-64t64r-n78`, `n78`, `nr`, `100` MHz.
  - **Otherwise:** `generic-panel-65-17` plus `generic-rru-4t4r-4x40w`, `B3`, `lte`, `20` MHz.
- One carrier per antenna from the AI and the rules (C4). A cell export may give more than one.
- Sectors (C1):
  - With no sectors yet, use `applyProposal` (by bearing).
  - Otherwise keep every existing sector and add each unsectored unit to the sector with the nearest bearing within `SECTOR_GAP_DEG` (30°), else to a new sector.
  - The AI never moves units. An export may only rename a matched sector.
- Re-plan keeps every field group whose origin is `user` or `export` (C3).
- Apply & run saves, through the existing `startCoverage` auto-save. Apply only leaves the changes unsaved (C6).
- i18n keys go only under `rf.*` in `packages/ui/src/i18n/en.ts`. The antenna inventory session edits `telecom.antennas.*` in the same file, so keep additions in one contiguous `rf.autoplan.*` / `rf.chip.*` / `rf.steps.*` block.
- Do not edit these files, which other sessions own:
  - `telecom/*` and `antennaStore.ts`;
  - `shell/Sidebar.tsx`, `shell/actions/*`;
  - `MeasureBench.tsx`, `survey/measure*`.
- `Stage.tsx` gets one slot line inside the existing `// --- RF coverage legend (rf-ui) ---` marked block. Tell the stage-island session (d-ba) before landing.
- Run the e2e specs the way CI does: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`.

## Review Focus

1. **The AI reply names a catalogue id that doesn't exist, or a band the equipment can't do** (for example an n78 AAU on B3). That row should fall back to the rules pick with confidence `low` and say why, never write invalid settings. Tested in Task 5.
2. **Re-plan after the person edited one carrier's bandwidth.** The whole carrier group is kept as `user`, and equipment still marked `ai` may be replaced. Tested in Task 5 and Task 6.
3. **A project whose detected units have no CRS (`convergenceDeg: null`).** Its units have no bearing, so Auto-plan must list them as left out (`no-azimuth`), not crash or put them all in S1. Tested in Task 3.
4. **A cell export whose rows match no antenna, or where two rows name the same antenna with different bands.** Unmatched rows are listed and both carriers are kept, without throwing. Tested in Task 4.
5. **The provider fails, times out, or the person cancels the send preview.** The dialog offers Rules only, the store has no stale `pending` state, and the chip doesn't stay on "planning…". Tested in Task 8.

---

### Task 1: Origin fields in the RF sectors schema

**Files:**

- Modify: `packages/schema/src/rf.ts` (around `RfCarrier` and `RfAntennaSettings`, ~lines 228–276)
- Test: `packages/schema/src/rf.test.ts` (create it, or add to the existing rf schema test next to it)
- Test: `python/tests/test_rf_coverage.py`

**Interfaces:**

- Produces:
  - `RfOrigin = z.object({ by: z.enum(['ai','export','rules','user']), confidence: z.enum(['high','medium','low']).optional() }).strict()` and `type RfOrigin`.
  - `RfCarrier.origin?: RfOrigin`.
  - `RfAntennaSettings.origins?: { equipment?: RfOrigin; etiltDeg?: RfOrigin }`, as a strict object.
  - `originOf(o: RfOrigin | undefined): RfOrigin['by']`, which returns `'user'` when `o` is undefined.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts origins and keeps old files valid', () => {
  const old = RfSectorsFile.parse(fixtureWithoutOrigins);
  expect(old.antennas[0]?.origins).toBeUndefined();
  const f = RfSectorsFile.parse(
    withOrigins({ equipment: { by: 'ai', confidence: 'low' } }, { by: 'rules' }),
  );
  expect(f.antennas[0]?.origins?.equipment).toEqual({ by: 'ai', confidence: 'low' });
  expect(f.antennas[0]?.carriers[0]?.origin).toEqual({ by: 'rules' });
});
it('rejects an unknown origin', () => {
  expect(RfSectorsFile.safeParse(withOrigins({ equipment: { by: 'guess' } })).success).toBe(false);
});
it('originOf defaults to user', () => {
  expect(originOf(undefined)).toBe('user');
});
```

```python
def test_origin_keys_are_ignored(tmp_path):
    # rf_synth project; add "origins" to the first antenna and "origin" to its first carrier
    # then resolve inputs: the source list is identical to the run without them
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/schema test rf` and `cd python && uv run pytest tests/test_rf_coverage.py -k origin -q`
Expected: the TS tests FAIL (unknown keys are rejected by `.strict()`). The Python test passes already, because `inputs.py` reads with `.get`. Keep it as the guard.

- [ ] **Step 3: Add `RfOrigin`, `originOf`, and the optional `origin` / `origins` keys to `packages/schema/src/rf.ts`**

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/schema test rf && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/rf.ts packages/schema/src/rf.test.ts python/tests/test_rf_coverage.py
git commit -m "feat(schema): optional origin and confidence on RF settings"
```

---

### Task 2: Rules-only equipment pick

**Files:**

- Modify: `apps/desktop/src/renderer/rf/rfDefaults.ts` (add the constants)
- Create: `apps/desktop/src/renderer/rf/autoplan/types.ts`
- Create: `apps/desktop/src/renderer/rf/autoplan/rules.ts`
- Test: `apps/desktop/src/renderer/rf/autoplan/rules.test.ts`

**Interfaces:**

- Consumes: `RfCatalogueEntry`, `RfEquipment`, `RfCarrier`, `RfOrigin` (Task 1); `AntennaUnit` from `@aio/schema`.
- Produces (in `types.ts`):
  - `interface PlanPick { equipment: RfEquipment; carrier: Omit<RfCarrier,'id'|'feederLossDb'|'origin'>; by: 'ai'|'rules'|'export'; confidence: 'high'|'medium'|'low'; reason: string }`.
- Produces (in `rfDefaults.ts`):
  - `AUTOPLAN_AAU = { aau: 'generic-aau-64t64r-n78', band: 'n78', tech: 'nr', bandwidthMhz: 100 } as const`;
  - `AUTOPLAN_PANEL = { antenna: 'generic-panel-65-17', radio: 'generic-rru-4t4r-4x40w', band: 'B3', tech: 'lte', bandwidthMhz: 20 } as const`;
  - `AAU_MIN_DEPTH_M = 0.15`, `AAU_MIN_WIDTH_M = 0.4`.
- Produces (in `rules.ts`):
  - `rulesPick(unit: AntennaUnit, catalogue: readonly RfCatalogueEntry[]): PlanPick`.

- [ ] **Step 1: Write the failing tests**

```ts
it('picks the n78 AAU for a deep wide face', () => {
  const p = rulesPick(unit({ widthM: 0.5, depthM: 0.2 }), CATALOGUE);
  expect(p.equipment).toEqual({ kind: 'aau', aau: 'generic-aau-64t64r-n78' });
  expect(p.carrier).toMatchObject({ band: 'n78', tech: 'nr', bandwidthMhz: 100 });
  expect(p).toMatchObject({ by: 'rules', confidence: 'medium' });
});
it('picks panel plus RRU on B3 for a thin face', () => {
  const p = rulesPick(unit({ widthM: 0.3, depthM: 0.1 }), CATALOGUE);
  expect(p.equipment).toEqual({
    kind: 'separate',
    antenna: 'generic-panel-65-17',
    radio: 'generic-rru-4t4r-4x40w',
  });
  expect(p.carrier).toMatchObject({ band: 'B3', tech: 'lte', bandwidthMhz: 20 });
});
it('falls back to the AAU rule with low confidence when the panel or radio cannot do B3', () => {
  const p = rulesPick(unit({ widthM: 0.3, depthM: 0.1 }), catalogueWithoutB3Radio());
  expect(p.equipment.kind).toBe('aau');
  expect(p.confidence).toBe('low');
});
it('treats missing measurements as a thin face with low confidence', () => {
  expect(rulesPick(unit({}), CATALOGUE).confidence).toBe('low');
});
```

Build `CATALOGUE` from the real `packages/rf/catalogue/generic.json` entries, so that the B3 coverage check runs against the shipped data.

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/autoplan/rules`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement `rulesPick`**

Use `bandRangeMhz` on the radio or AAU, and the antenna port ranges, together with `@aio/rf` `bands`, to check that B3 is covered. The reason text is a code-like English string built from the measured sizes, for example `"0.50 m × 0.20 m deep face: AAU"`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/autoplan/rules`
Expected: PASS. If the shipped generic panel or RRU really can't do B3, the second test fails. In that case change `AUTOPLAN_PANEL` to entries that can and note it in the commit message. Don't weaken the test.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/rfDefaults.ts apps/desktop/src/renderer/rf/autoplan/
git commit -m "feat(rf): rules-only equipment pick for Auto-plan"
```

---

### Task 3: Sector planning that keeps the person's sectors (C1)

**Files:**

- Create: `apps/desktop/src/renderer/rf/autoplan/sectors.ts`
- Test: `apps/desktop/src/renderer/rf/autoplan/sectors.test.ts`

**Interfaces:**

- Consumes: `proposeSectors`, `unitTrueAzimuthDeg`, `meanBearingDeg`, `SECTOR_GAP_DEG`, `RfUnit` from `@aio/rf`; `rfUnit` from `rf/rfModel.ts` (export it if it is not exported yet).
- Produces:
  - `type LeftOut = { unitId: string; reason: 'draft' | 'not-panel' | 'no-azimuth' | 'inactive' | 'rejected' }`.
  - `planSectors(units: readonly AntennaUnit[], current: readonly RfSector[]): { sectors: RfSector[]; leftOut: LeftOut[]; regrouped: boolean }`.
  - Only `accepted` panels take part. `regrouped` is true when `current` was empty and the result is the bearing proposal.

- [ ] **Step 1: Write the failing tests**

```ts
it('groups by bearing when there are no sectors', () => {
  const r = planSectors(units([0, 120, 240]), []);
  expect(r.regrouped).toBe(true);
  expect(r.sectors.map((s) => s.name)).toEqual(['S1', 'S2', 'S3']);
});
it('keeps existing sectors, names and membership', () => {
  const cur = [{ id: 'sec-a', name: 'North', antennaIds: ['u0'] }];
  const r = planSectors(units([0, 120]), cur);
  expect(r.sectors[0]).toEqual({ id: 'sec-a', name: 'North', antennaIds: ['u0'] });
  expect(r.regrouped).toBe(false);
});
it('adds an unsectored unit to the nearest sector within 30°, else a new one', () => {
  const cur = [{ id: 'sec-a', name: 'North', antennaIds: ['u0'] }];
  const r = planSectors(units([0, 20, 180]), cur);
  expect(r.sectors.find((s) => s.id === 'sec-a')?.antennaIds).toEqual(['u0', 'u1']);
  expect(r.sectors.some((s) => s.antennaIds.includes('u2') && s.id !== 'sec-a')).toBe(true);
});
it('lists drafts and units without a bearing as left out', () => {
  const r = planSectors([...units([0]), draft('d1', 90), noCrs('n1')], []);
  expect(r.leftOut).toEqual(
    expect.arrayContaining([
      { unitId: 'd1', reason: 'draft' },
      { unitId: 'n1', reason: 'no-azimuth' },
    ]),
  );
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/autoplan/sectors`
Expected: FAIL.

- [ ] **Step 3: Implement `planSectors`**

- A sector's bearing is `meanBearingDeg` of its members' true azimuths.
- New sector ids use the `sec-s<n>` pattern, with the next free `n`.
- Map the left-out reasons from `unitEligibility(...).reason`: `short`, `dish` and `other` become `not-panel`, `no-crs` becomes `no-azimuth`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/autoplan/sectors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/autoplan/sectors.ts apps/desktop/src/renderer/rf/autoplan/sectors.test.ts apps/desktop/src/renderer/rf/rfModel.ts
git commit -m "feat(rf): Auto-plan sector planning that keeps existing sectors"
```

---

### Task 4: Forgiving cell-export matching

**Files:**

- Create: `apps/desktop/src/renderer/rf/autoplan/exportMatch.ts`
- Test: `apps/desktop/src/renderer/rf/autoplan/exportMatch.test.ts`

**Interfaces:**

- Consumes: `splitCsv`, `findEntry` and the column detection used by `parseCellCsv` in `rf/cellCsv.ts` (export `columnsOf` if it is private); `PlanPick` (Task 2); the sectors from Task 3.
- Produces:
  - `matchCellExport(text: string, units: readonly AntennaUnit[], sectors: readonly RfSector[], catalogue: readonly RfCatalogueEntry[]): ExportMatch | { error: 'empty' | 'no-antenna-column' }`.
  - `interface ExportMatch { picks: Map<string, PlanPick[]>; renames: { sectorId: string; name: string }[]; unmatchedRows: number[]; unmatchedUnits: string[] }`.
  - One unit can get several `PlanPick` entries, one per row (that is, one per carrier).
  - Each pick has `by: 'export'` and `confidence: 'high'` for an exact match, `'medium'` for a bearing match, and `'low'` when the model text didn't resolve to a catalogue entry.

- [ ] **Step 1: Write the failing tests**

```ts
it('matches by exact unit name first', () => {
  /* row antenna "Panel A" → unit named Panel A, confidence high */
});
it('matches by sector name plus nearest bearing when the name does not match', () => {
  // row sector "S2", antenna "X-17"; S2 holds units at 118° and 125°; row has azimuth 120 → the 118° unit, medium
});
it('breaks a bearing tie by height', () => {
  /* two units at 120°, heights 25 and 30; row height 30 → the 30 m unit */
});
it('keeps two rows for one antenna as two carriers', () => {
  expect(m.picks.get('u1')?.map((p) => p.carrier.band)).toEqual(['B3', 'n78']);
});
it('lists rows and units that do not match', () => {
  expect(m.unmatchedRows).toEqual([4]);
  expect(m.unmatchedUnits).toEqual(['u3']);
});
it('renames a matched sector but never moves a unit', () => {
  expect(m.renames).toEqual([{ sectorId: 'sec-s1', name: 'Alpha' }]);
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/autoplan/exportMatch`
Expected: FAIL.

- [ ] **Step 3: Implement `matchCellExport`**

- Accept optional `azimuth` and `height` columns, using the same header aliasing as `cellCsv.ts`.
- Use `findEntry` for the model text. When it fails, set the pick's `confidence: 'low'` and leave the equipment for Task 5 to resolve (the AI or rules).

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/autoplan/exportMatch rf/CsvImport`
Expected: PASS, with the existing CSV tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/autoplan/exportMatch.* apps/desktop/src/renderer/rf/cellCsv.ts
git commit -m "feat(rf): forgiving cell-export matching for Auto-plan"
```

---

### Task 5: Proposal builder, validating AI picks, and keeping the person's values

**Files:**

- Create: `apps/desktop/src/renderer/rf/autoplan/proposal.ts`
- Test: `apps/desktop/src/renderer/rf/autoplan/proposal.test.ts`

**Interfaces:**

- Consumes: Tasks 2–4; `withEquipment` from `rf/rfFields.ts`; `originOf` (Task 1).
- Produces:
  - `interface AiPickRaw { unitId: string; entryId: string; radioId?: string; band: string; tech: 'lte'|'nr'; bandwidthMhz: number; reason: string; confidence: 'high'|'medium'|'low' }`, which mirrors the IPC reply in Task 7.
  - `validateAiPick(raw: AiPickRaw, unit: AntennaUnit, catalogue: readonly RfCatalogueEntry[]): PlanPick`. On an unknown id, a band outside the equipment's range, or an AAU paired with a radio, it returns `rulesPick(unit)` with `confidence: 'low'` and a reason that starts `"AI pick not usable: "`.
  - `interface ProposalRow { unitId: string; sectorId: string; picks: PlanPick[]; kept: { equipment: boolean; carriers: boolean[] } }`.
  - `interface Proposal { sectors: RfSector[]; regrouped: boolean; rows: ProposalRow[]; leftOut: LeftOut[]; renames: ExportMatch['renames']; unmatchedRows: number[] }`.
  - `buildProposal(i: { units: readonly AntennaUnit[]; file: RfSectorsFile; catalogue: readonly RfCatalogueEntry[]; picks: ReadonlyMap<string, PlanPick[]>; renames?: ExportMatch['renames'] }): Proposal`.
  - Units without a pick get `rulesPick`. `kept` marks the groups whose current origin is `user` or `export`; those are not replaced.
  - `applyToFile(file: RfSectorsFile, p: Proposal, catalogue: readonly RfCatalogueEntry[]): RfSectorsFile`. This pure function writes the sectors, the renames, the equipment via `withEquipment`, and the carriers (`id: 'c1'`, `'c2'`… for non-kept groups, `feederLossDb: 0`), with `origin` / `origins.equipment` set to `{ by, confidence }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces an unknown AI entry id with the rules pick at low confidence', () => {
  const p = validateAiPick({ ...raw, entryId: 'nope' }, unitDeep, CATALOGUE);
  expect(p).toMatchObject({ by: 'rules', confidence: 'low' });
  expect(p.reason).toMatch(/^AI pick not usable: /);
});
it('rejects a band the equipment cannot do', () => {
  expect(
    validateAiPick({ ...raw, entryId: 'generic-aau-64t64r-n78', band: 'B3' }, unitDeep, CATALOGUE)
      .confidence,
  ).toBe('low');
});
it('keeps user and export groups on re-plan', () => {
  const file = fileWith({ u1: { equipment: { by: 'ai' }, carriers: [{ by: 'user' }] } });
  const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
  expect(p.rows.find((r) => r.unitId === 'u1')?.kept).toEqual({
    equipment: false,
    carriers: [true],
  });
  const out = applyToFile(file, p, CATALOGUE);
  expect(out.antennas.find((a) => a.antennaId === 'u1')?.carriers[0]?.bandwidthMhz).toBe(
    file.antennas[0]?.carriers[0]?.bandwidthMhz,
  );
});
it('writes origins on applied groups', () => {
  const out = applyToFile(
    emptyFile,
    buildProposal({ units, file: emptyFile, catalogue: CATALOGUE, picks: new Map() }),
    CATALOGUE,
  );
  expect(out.antennas[0]?.origins?.equipment).toEqual({ by: 'rules', confidence: 'medium' });
  expect(out.antennas[0]?.carriers[0]?.origin?.by).toBe('rules');
});
it('the result passes RfSectorsFile.parse', () => {
  expect(RfSectorsFile.safeParse(out).success).toBe(true);
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/autoplan/proposal`
Expected: FAIL.

- [ ] **Step 3: Implement `validateAiPick`, `buildProposal` and `applyToFile`**

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/autoplan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/autoplan/proposal.*
git commit -m "feat(rf): Auto-plan proposal, AI pick validation and keep rules"
```

---

### Task 6: Store wiring: applying a plan and marking hand edits as `user`

**Files:**

- Modify: `apps/desktop/src/renderer/rf/rfStore.ts` (`patchSettings` ~373, `setEquipment` ~391, `clearSetting` ~408, plus a new `applyPlan`)
- Modify: `apps/desktop/src/renderer/workspace/workbench/benches/RfBench.tsx`, only where `patchCarrier` (~635) builds a carrier
- Test: `apps/desktop/src/renderer/rf/rfStore.test.ts`

**Interfaces:**

- Consumes: `applyToFile`, `Proposal` (Task 5).
- Produces:
  - `applyPlan(p: Proposal): void`. It edits the working copy (marking it dirty) through `edit((f) => applyToFile(f, p, catalogue))`, and does nothing when the project is read-only.
  - Every hand edit marks its group `{ by: 'user' }`:
    - `setEquipment` and `clearSetting('equipment')` mark `origins.equipment`;
    - `clearSetting('etiltDeg')` and a `patchSettings` that includes `etiltDeg` mark `origins.etiltDeg`;
    - a `patchSettings` that includes `carriers`, or `patchCarrier`, marks the changed carrier's `origin`.
  - `applyCellImport` marks the groups it writes `{ by: 'export', confidence: 'high' }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('applyPlan writes the proposal and marks the copy dirty', () => {
  applyPlan(proposal);
  expect(rfStore.getState().dirty).toBe(true);
  expect(rfStore.getState().sectors.sectors).toHaveLength(3);
});
it('a hand edit turns an ai group into user', () => {
  applyPlan(proposal);
  setEquipment('u1', aauEntry);
  expect(settings('u1').origins?.equipment).toEqual({ by: 'user' });
});
it('editing one carrier field marks only that carrier user', () => {
  applyPlan(proposal);
  patchSettings('u1', { carriers: [{ ...settings('u1').carriers[0]!, bandwidthMhz: 80 }] });
  expect(settings('u1').carriers[0]?.origin).toEqual({ by: 'user' });
  expect(settings('u1').origins?.equipment?.by).toBe('rules');
});
it('applyCellImport marks export', () => {
  /* … origin.by === 'export' */
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/rfStore`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement `applyPlan` and the origin marking**

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/ && pnpm typecheck`
Expected: PASS. The `RfBench` tests that compare whole settings objects may need the `origin` keys added. Update those expectations; don't strip the origins.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/rfStore.* apps/desktop/src/renderer/workspace/workbench/benches/RfBench.tsx
git commit -m "feat(rf): applyPlan and origin marking on hand edits"
```

---

### Task 7: The AI route for Auto-plan (main and IPC)

**Files:**

- Create: `packages/ai/src/rfPlan.ts`
- Test: `packages/ai/src/rfPlan.test.ts`
- Modify: `packages/schema/src/ipc.ts` (next to `ai:labelAntennas`, ~2359)
- Modify: `packages/ai/src/main.ts`: add `rfPlanPreview` and `rfPlan` beside `antennaLabelPreview` / `labelAntennas` (~1220–1300), reusing `labelProject`, `check`, the consent-token map pattern and `recordUsage`
- Modify: the preload/IPC registration wherever `ai:labelAntennas` is registered (grep for `'ai:labelAntennas'` under `apps/desktop/src/main` and `preload`)
- Test: `packages/ai/src/rfPlanRuntime.test.ts`, modelled on `antennaLabelRuntime.test.ts`

**Interfaces:**

- Produces:
  - **IPC `ai:rfPlanPreview`.**
    - Request: `{ projectId, unitIds: string[1..200] }`.
    - Response: `{ ok: true, provider, model, cloud, photosAllowed, crops: {unitId,path}[], estimate: { inputTokens, costUsd? }, token } | { ok: false, error }`.
  - **IPC `ai:rfPlan`.**
    - Request: `{ runId, projectId, units: RfPlanUnitInput[1..200], catalogue: { id, kind, vendor, model, bands: string[] }[1..400], token?, photos?: boolean }`, where `RfPlanUnitInput = { unitId, widthM?, heightM?, depthM?, downtiltDeg?, heightAboveGroundM?, userModel?, userFrequencies? }`.
    - Response: `{ ok: true, provider, model, promptVersion, picks: AiPickRaw[], inputTokens, outputTokens, costUsd?, warnings: string[] } | Failure`.
  - **In `rfPlan.ts`:**
    - `RF_PLAN_PROMPT_VERSION = 'rf-plan-v1'`;
    - `rfPlanInstructions(): string`;
    - `rfPlanUserText(units, catalogue): string`;
    - `parseRfPlan(text: string, unitIds: readonly string[]): { picks: AiPickRaw[]; warnings: string[] }`;
    - `estimateRfPlan(units: number, images: number): { inputTokens: number }`.
  - Use the route `check('vision', …)` when photos are allowed and crops exist, else `check('chat', …)`. The request is one call for the whole site, not batched.

- [ ] **Step 1: Write the failing tests**

```ts
it('instructions forbid geometry and name LTE and NR only', () => {
  const s = rfPlanInstructions();
  expect(s).toMatch(/LTE and NR only/);
  expect(s).toMatch(/Do not report azimuth, tilt or height/);
});
it('parseRfPlan drops geometry keys and unknown units with warnings', () => {
  const r = parseRfPlan(
    JSON.stringify({
      picks: [
        {
          unitId: 'u1',
          entryId: 'x',
          band: 'n78',
          tech: 'nr',
          bandwidthMhz: 100,
          azimuthDeg: 10,
          reason: 'r',
          confidence: 'high',
        },
        {
          unitId: 'zz',
          entryId: 'x',
          band: 'B3',
          tech: 'lte',
          bandwidthMhz: 20,
          reason: 'r',
          confidence: 'low',
        },
      ],
    }),
    ['u1'],
  );
  expect(r.picks).toHaveLength(1);
  expect(r.picks[0]).not.toHaveProperty('azimuthDeg');
  expect(r.warnings.join(' ')).toMatch(/azimuth/);
  expect(r.warnings.join(' ')).toMatch(/zz/);
});
it('the prompt never contains the project name', () => {
  expect(rfPlanUserText(units, catalogue)).not.toMatch(/E2E tiny project/);
});
// runtime: a cloud request without a fresh preview token answers the "preview first" error;
// a forbid policy refuses cloud; a local provider costs 0
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/ai test rfPlan`
Expected: FAIL.

- [ ] **Step 3: Implement `rfPlan.ts`, the two IPC contracts, the runtime functions and the registration**

Reuse `extractJson` from `./detect`, as `antennaLabel.ts` does. Keep the same message constants style (`*_PREVIEW_FIRST`, etc.).

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/ai test && pnpm -F @aio/schema test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/rfPlan* packages/ai/src/main.ts packages/schema/src/ipc.ts apps/desktop/src/main apps/desktop/src/preload
git commit -m "feat(ai): ai:rfPlanPreview and ai:rfPlan for Auto-plan"
```

---

### Task 8: The Auto-plan controller store

**Files:**

- Create: `apps/desktop/src/renderer/rf/autoplan/autoplanStore.ts`
- Test: `apps/desktop/src/renderer/rf/autoplan/autoplanStore.test.ts`

**Interfaces:**

- Consumes: Tasks 3–7; `rfStore`, `antennaStore` (read only: `file.units`), `startRfRun` from `rf/rfTab.ts`, `window.aio.invoke` (or the project's IPC helper, as `antennaStore` uses it).
- Produces:
  - `type AutoplanSource = 'ai' | 'rules' | { csvText: string }`.
  - `type AutoplanPhase = 'idle' | 'blocked-review' | 'preview' | 'thinking' | 'review' | 'error'`.
  - `interface AutoplanState { phase: AutoplanPhase; source: AutoplanSource; preview: IpcResponse<'ai:rfPlanPreview'> | null; proposal: Proposal | null; warnings: string[]; error: string | null; aiAvailable: boolean }`.
  - `useAutoplan<T>(sel: (s: AutoplanState) => T): T`.
  - `startAutoplan(source?: AutoplanSource): Promise<void>`. With no accepted panels it goes to `'blocked-review'` (F6). The default source is `'ai'` when a provider is set up and the project policy allows it, else `'rules'`.
  - `confirmSend(photos: boolean): Promise<void>`.
  - `switchSource(source: AutoplanSource): Promise<void>`.
  - `applyAutoplan(run: boolean): Promise<StartResult | null>`, which calls `applyPlan` and then, when `run` is true, `startRfRun(root)`.
  - `cancelAutoplan(): void`.
  - `openAntennaReviewOrFallback(): void`. It calls `openAntennaReview()` when `antennaStore` exports it, else `revealAntenna(firstDraftId)` (on main), else opens the Measure bench.
  - `selectChipState(rf: RfState, antennaUnits: readonly AntennaUnit[] | null, autoplan: AutoplanState): ChipState`, where `type ChipState = { kind: 'hidden' } | { kind: 'review-first'; total: number } | { kind: 'not-planned'; accepted: number } | { kind: 'ready'; sectors: number } | { kind: 'planning' } | { kind: 'running' } | { kind: 'result'; view: RfView; fairOrBetterPct: number | null; at: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('blocks with review-first when nothing is accepted', async () => {
  seedAntennas([draft('d1', 0)]);
  await startAutoplan('rules');
  expect(autoplan().phase).toBe('blocked-review');
});
it('rules source goes straight to review', async () => {
  await startAutoplan('rules');
  expect(autoplan().phase).toBe('review');
  expect(autoplan().proposal?.rows).toHaveLength(3);
});
it('ai source asks for a preview, then thinks, then reviews', async () => {
  /* mock invoke: preview → confirmSend → rfPlan reply */
});
it('a failed AI call ends in error with rules offered, never stuck in thinking', async () => {
  mockInvoke('ai:rfPlan', { ok: false, error: 'timeout' });
  await startAutoplan('ai');
  await confirmSend(false);
  expect(autoplan().phase).toBe('error');
  await switchSource('rules');
  expect(autoplan().phase).toBe('review');
});
it('cancel at the preview leaves idle and writes nothing', async () => {
  /* rfStore dirty stays false */
});
it('applyAutoplan(true) applies and starts a run', async () => {
  /* startRfRun mocked, called once */
});
it('chip state follows the store', () => {
  expect(selectChipState(rf({ runs: [], sectorsN: 0 }), units3, idle).kind).toBe('not-planned');
  expect(selectChipState(rf({ classStats: STATS }), units3, idle)).toMatchObject({
    kind: 'result',
    fairOrBetterPct: 17,
  });
});
```

Use the e2e class stats from the RF spec, which give 17%: Excellent 0, Good 4, Fair 13.

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/autoplan/autoplanStore`
Expected: FAIL.

- [ ] **Step 3: Implement `autoplanStore.ts`**

Follow the module-level `createStore` plus exported actions style of `rfStore.ts`. The share counted is the sum of the area shares of the classes Excellent, Good and Fair from `rfStore.classStats`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/autoplan/autoplanStore.*
git commit -m "feat(rf): Auto-plan controller and chip state"
```

---

### Task 9: The review dialog

**Files:**

- Create: `apps/desktop/src/renderer/rf/AutoplanDialog.tsx`
- Modify: `apps/desktop/src/renderer/rf/rf.css`
- Modify: `packages/ui/src/i18n/en.ts` (`rf.autoplan.*`)
- Test: `apps/desktop/src/renderer/rf/AutoplanDialog.test.tsx`

**Interfaces:**

- Consumes: `useAutoplan`, `confirmSend`, `switchSource`, `applyAutoplan`, `cancelAutoplan`, `openAntennaReviewOrFallback` (Task 8); `SendDialog` from `@aio/ai` for the `'preview'` phase, as `telecom/AntennaSendPreview.tsx` uses it.
- Produces:
  - `<AutoplanDialog />`, mounted once in `RfBench` and rendered into a portal under `<body>`.
  - The test ids are `rf-autoplan`, `rf-autoplan-row-<unitId>`, `rf-autoplan-source`, `rf-autoplan-apply-run`, `rf-autoplan-apply` and `rf-autoplan-cancel`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows one row per planned unit with sector, equipment, band, reason and confidence', () => {
  renderWith(reviewState);
  const row = screen.getByTestId('rf-autoplan-row-u1');
  expect(row).toHaveTextContent('S1');
  expect(row).toHaveTextContent('AAU 64T64R 3.5 GHz 200 W');
  expect(row).toHaveTextContent('n78 · NR · 100 MHz');
  expect(row).toHaveTextContent(/generic · unverified/);
});
it('marks low confidence rows amber and kept rows as kept', () => {
  /* data-confidence="low", text "kept" */
});
it('lists drafts as left out with a review link', () => {
  /* "Not reviewed yet", button calls openAntennaReviewOrFallback */
});
it('blocked-review shows "Review antennas first" and no apply buttons', () => {});
it('Apply & run calls applyAutoplan(true); Apply only calls applyAutoplan(false)', () => {});
it('the source switch offers Rules only and disables the provider when unavailable', () => {});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/AutoplanDialog`
Expected: FAIL.

- [ ] **Step 3: Implement the dialog**

The layout follows the approved mockup (section 4): the columns Sector, Antenna, Equipment, Band · tech · BW, Why and Confidence; in the footer, the source switch, the cost line, Cancel, Apply only and Apply & run coverage. The copy is plain English and never names the project.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/AutoplanDialog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/AutoplanDialog.* apps/desktop/src/renderer/rf/rf.css packages/ui/src/i18n/en.ts
git commit -m "feat(rf): Auto-plan review dialog"
```

---

### Task 10: The Coverage chip on the stage, and Ctrl+K

**Files:**

- Create: `apps/desktop/src/renderer/rf/CoverageChip.tsx`
- Modify: `apps/desktop/src/renderer/rf/rfTab.ts`: add `openCoverage(): void`, which calls `bench.getState().open('rf', { pinned: true })`, and make `openRfTab` and `startRfRun` open pinned as well
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx`: one line inside the RF marked block, rendering `<CoverageChip />` in a top-centre `stage-status` row beside the date pill
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx`: two entries, `rf:autoplan` and `rf:open`, shown only when the chip isn't hidden
- Modify: `packages/ui/src/i18n/en.ts` (`rf.chip.*`)
- Test: `apps/desktop/src/renderer/rf/CoverageChip.test.tsx`; `apps/desktop/src/renderer/workspace/Stage.overlays.test.tsx` (one case: the chip doesn't overlap the legend or the dates at 1100 px)

**Interfaces:**

- Consumes: `selectChipState`, `startAutoplan`, `openAntennaReviewOrFallback` (Task 8); `coverageDisplay` (the visible toggle, the same state as the Display bench eye).
- Produces:
  - `<CoverageChip />`, with test id `rf-chip` and `data-state={ChipState['kind']}`, plus the buttons `rf-chip-autoplan`, `rf-chip-review`, `rf-chip-run`, `rf-chip-layer` and `rf-chip-replan`.
  - `openCoverage()`.

- [ ] **Step 1: Write the failing tests**

```ts
it('is hidden without antennas', () => {
  expect(screen.queryByTestId('rf-chip')).toBeNull();
});
it('not-planned shows the count and Auto-plan', () => {
  expect(screen.getByTestId('rf-chip')).toHaveTextContent('Coverage · 3 antennas · not planned');
  fireEvent.click(screen.getByTestId('rf-chip-autoplan'));
  expect(startAutoplan).toHaveBeenCalled();
});
it('review-first shows Review antennas', () => {
  /* text "review first", button calls openAntennaReviewOrFallback */
});
it('result shows the RSRP share and toggles the layer', () => {
  expect(chip).toHaveTextContent('Coverage · RSRP · 17% fair or better');
});
it('clicking the chip body opens the Coverage tab pinned', () => {
  expect(workbench.getState().tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
});
it('narrow layout keeps the dot, Coverage and the buttons only', () => {
  /* container width 1100 → no .rf-chip-desc */
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/CoverageChip workspace/Stage.overlays`
Expected: FAIL.

- [ ] **Step 3: Implement the chip, `openCoverage`, the Stage line and the Palette entries**

Style it with the existing `ss-chip` classes plus an `rf-chip` modifier in `rf.css`. Before landing the Stage line, message d-ba with the one-line diff.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm -F @aio/desktop test rf/ workspace/ shell/Palette && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/CoverageChip.* apps/desktop/src/renderer/rf/rfTab.ts apps/desktop/src/renderer/rf/rf.css apps/desktop/src/renderer/workspace/Stage.tsx apps/desktop/src/renderer/workspace/Stage.overlays.test.tsx apps/desktop/src/renderer/shell/Palette.tsx packages/ui/src/i18n/en.ts
git commit -m "feat(rf): Coverage chip on the stage and Ctrl+K entries"
```

---

### Task 11: The Coverage panel layout

**Files:**

- Create: `apps/desktop/src/renderer/rf/panel/AiCard.tsx`, `StepAntennas.tsx`, `StepSectors.tsx`, `AdvancedFold.tsx`
- Modify: `apps/desktop/src/renderer/workspace/workbench/benches/RfBench.tsx`
  - The top-level `RfBench` render (~1534–1607) becomes: AiCard, StepAntennas, StepSectors (wrapping the existing `SectorList` toolbar and `SectorSection` / `UnitFields` as an expandable row body), the Results section renamed to step 3, then AdvancedFold (wrapping `StudySettings` and the CSV import).
  - Move the "include drafts" switch from `StudySettings` (~497) into StepAntennas.
  - Mount `<AutoplanDialog />`.
- Modify: `packages/ui/src/i18n/en.ts`: `wb.tab.rf` becomes "Coverage", plus the `rf.steps.*` keys
- Test: `apps/desktop/src/renderer/rf/panel/*.test.tsx`; update the existing `RfBench` tests and e2e selectors that relied on the old section titles

**Interfaces:**

- Consumes: `useRf`, `useAutoplan`, `startAutoplan`, `openAntennaReviewOrFallback`; the existing `SectorList`, `SectorSection`, `UnitFields`, `StudySettings`, `ResultsSection` and `Orphans` (export them from `RfBench.tsx` if the new files need them, or keep the composition inside `RfBench.tsx`; the files under `panel/` take children).
- Produces:
  - `<StepSectors />` rows with test id `rf-step-sector-<sectorId>` and `data-tag` set to one of `needs-setup`, `ai`, `ai-low`, `rules`, `edited`, `from-export`.
  - The tag is derived from the origins of the sector's units. The weakest wins, in the order `needs-setup` > `ai-low` > `rules` > `ai` > `from-export` > `edited`.
  - `<AiCard />` (test id `rf-ai-card`) has **✦ Auto-plan & run** (`startAutoplan()`), a "set up by hand" link that expands step 2, and **Use cell export**. That button is a file pick, and dropping a `.csv` onto the card does the same: `startAutoplan({ csvText })`. The card also shows **Use cell export** as the main action when any group has the origin `export`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the AI card, three steps and a folded Advanced', () => {
  render(<RfBench />);
  expect(screen.getByTestId('rf-ai-card')).toBeVisible();
  expect(screen.getByText('Antennas')).toBeVisible();
  expect(screen.getByText('Sectors & equipment')).toBeVisible();
  expect(screen.getByText('Coverage')).toBeVisible();
  expect(screen.getByTestId('rf-advanced')).toHaveAttribute('aria-expanded', 'false');
});
it('step 1 counts accepted and draft units', () => { expect(screen.getByTestId('rf-step-antennas')).toHaveTextContent('3 accepted · 1 draft'); });
it('a sector row tag follows the weakest origin', () => { /* one unit ai-low → data-tag="ai-low" */ });
it('expanding a sector row shows the existing unit fields', () => { /* rf-pick-aau visible after click */ });
it('the tab is labelled Coverage', () => {});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm -F @aio/desktop test rf/panel workspace/workbench/benches/RfBench`
Expected: FAIL.

- [ ] **Step 3: Restructure the render and add the panel pieces**

- [ ] **Step 4: Run the full unit suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. Fix the old tests by updating their selectors, never by deleting assertions about behaviour.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/rf/panel apps/desktop/src/renderer/workspace/workbench/benches/RfBench.tsx packages/ui/src/i18n/en.ts
git commit -m "feat(rf): Coverage panel with AI card, three steps and Advanced"
```

---

### Task 12: End to end, CI conditions, and visual evidence

**Files:**

- Modify: `apps/desktop/e2e/rf-coverage.spec.ts`. Keep the existing flow, but it now opens the panel via the chip and the old selectors are updated.
- Create: `apps/desktop/e2e/rf-autoplan.spec.ts`
- Modify: `apps/desktop/e2e/rfFixtures.ts`, only if a units-with-sizes variant is needed (add `widthM` / `depthM` to the 3 panels so the AAU rule fires)

**Interfaces:**

- Consumes: everything above; `startFakeLlm` from `e2e/fake-llm.ts` (the `openai-compatible` kind, as `offline-cloud-ai.spec.ts` uses it).

- [ ] **Step 1: Write the e2e specs**

```ts
test('chip → Auto-plan (rules) → review → Apply & run → coverage and chip status', async ({
  win,
  dataRoot,
}) => {
  await writeRfProject(dataRoot.projectDir);
  // chip shows "3 antennas · not planned"; click rf-chip-autoplan; rf-autoplan visible
  // source switch reads "Rules only" (no provider configured); three rows S1/S2/S3, draft listed as left out
  // click rf-autoplan-apply-run; wait for a done run on disk (doneRuns helper)
  // chip data-state="result" and text matches /RSRP · \d+% fair or better/
  // the Coverage tab is pinned; step 2 rows have data-tag="rules" (not needs-setup)
});
test('Auto-plan with the fake local model tags AI picks and marks a low-confidence row', async () => {
  // fake LLM answers ai:rfPlan with two valid picks and one unknown entry id
  // review shows two rows confidence high and one row data-confidence="low" with "AI pick not usable"
  // Apply only → banner "RF settings changed and not saved yet"; step 2 tags ai / ai-low
});
test('no accepted antennas → chip review-first → Review antennas opens the inventory', async () => {});
```

- [ ] **Step 2: Build and run them under CI conditions**

Run (from `apps/desktop`):

```bash
pnpm demo:build --quick
npx electron-vite build
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/rf-autoplan.spec.ts e2e/rf-coverage.spec.ts e2e/telecom-antennas.spec.ts --workers=1 --repeat-each=3
```

Expected: all pass, three times each, and the log prints `[e2e] window 1100 x 720 px at display scale 1`.

- [ ] **Step 3: Capture the visual evidence**

Run the two RF specs again with `AIO_EVIDENCE_DIR=<scratch>/shots` at 1440x900 and at 1100x720. Hand the founder these screenshots:

- the chip in each state;
- the panel before and after the plan;
- the review dialog (rules and AI);
- coverage on the map with the chip status.

- [ ] **Step 4: Run the full checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && cd python && uv run pytest tests/test_rf_coverage.py -q`
Expected: PASS.

- [ ] **Step 5: Grep for public text, then commit**

```bash
git grep -niE "<operator and country names from the private notes>" -- apps packages docs || true   # must print nothing new
git add apps/desktop/e2e
git commit -m "test(e2e): Auto-plan from the Coverage chip, rules and fake model"
```

After this task, run `/wrapup` on this branch so the session note travels with the feature PR. Then hand d-ba the PR number, the branch and the head SHA once CI is green.

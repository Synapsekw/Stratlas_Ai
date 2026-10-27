# Antenna box handles: plan

Spec: `docs/superpowers/specs/2026-10-27-antenna-box-handles-design.md`. Branch
`feat/antenna-box-handles`. Package touched: `apps/desktop` (renderer and e2e) and
`packages/ui` (English strings only). No `@aio/schema` change, no Python change, no pipeline pack
bump, no contract-changes row (the `telecom.flag` input is reused as it is).

## Tasks

| Id  | Task                                                                                                                                                        | Files                                                                                                    | Tests                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| T1  | Pure box edit math: faces, `resizeBox`, `extentFromRay`, `boxCropSelection`, `settleBoxEdit`; `wasMeasured` and a no-box typed helper out of `antennaTyped` | `telecom/antennaBoxEdit.ts`, `telecom/antennaTyped.ts`                                                   | `antennaBoxEdit.test.ts` (one face moves, opposite fixed, clamp, rotated frame, crop keeps inside points only, settle cases) |
| T2  | Value labels off the face centres                                                                                                                           | `telecom/antennaMeasure.ts`                                                                              | `antennaMeasure.test.ts` updated                                                                                             |
| T3  | Store: `boxEdit`, begin, drag, cancel, commit (starts `telecom.flag` redraw), settle in `afterFlag`, toasts; strings                                        | `telecom/antennaStore.ts`, `packages/ui/src/i18n/en.ts`                                                  | `antennaStore.test.ts` (refusals, job params, settle write, failure restores, not-measured toast)                            |
| T4  | Handles overlay (look A from the spike), Escape, chip                                                                                                       | `telecom/antennaHandles.ts`, `survey/telecom.css`                                                        | `antennaHandles.test.ts` (shows for a selected panel, none for a dish or read only, Escape cancels)                          |
| T5  | Runner wiring: dragged box drawn, labels hidden while dragging, handles mounted, spike removed                                                              | `telecom/AntennaRunner.tsx`, delete `telecom/antennaHandleSpike.ts`, `e2e/spike-antenna-handles.spec.ts` | `AntennaRunner.test.ts` still green                                                                                          |
| T6  | E2E: select in 3D, drag top face up, box grows on one side, re-measure, survives a re-detect                                                                | `e2e/antenna-box-handles.spec.ts`                                                                        | the spec itself, CI way                                                                                                      |
| T7  | User guide and known limits                                                                                                                                 | `docs/guide/45-antenna-inventory.md`, `docs/KNOWN-LIMITS.md`                                             | `check-public-text`, format                                                                                                  |
| T8  | Verify and review: `pnpm check`, changed e2e specs CI way, screenshots, independent review                                                                  | none                                                                                                     |                                                                                                                              |

## Execution DAG

```
T1 ──► T3 ──► T4 ──► T5 ──► T6 ──► T8
T2 ─────────────────────────┘ (T5)
T7 (independent) ───────────────────► T8
```

- Batch 1 (parallel, no shared files): T1, T2, T7.
- Batch 2: T3 (needs T1's helpers).
- Batch 3: T4 then T5 (the runner imports the handles; both read the store API from T3).
- Batch 4: T6 (needs the built feature).
- Batch 5: T8.

Critical path: T1, T3, T4, T5, T6, T8.

## E2E specs

- Added: `apps/desktop/e2e/antenna-box-handles.spec.ts` (needs the pipeline Python, like
  `telecom-antenna-flag.spec.ts`).
- Removed: `apps/desktop/e2e/spike-antenna-handles.spec.ts`.
- Run the CI way as well: `telecom-antenna-flag.spec.ts`, `project-list-antennas.spec.ts`,
  `telecom-antennas.spec.ts` (labels moved, runner changed).

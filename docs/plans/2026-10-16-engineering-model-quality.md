# Engineering model quality repair

> **For agentic workers:** Use superpowers:subagent-driven-development with regression tests before implementation. Work only in this task's worktree.

**Goal:** Build a correctly proportioned, recognisable engineering model from a tall asset in a cluttered compound, preserving the AI's distinct component proposals and allowing visual review of the generated geometry.

**Architecture:** Repair the existing Python evidence pipeline, deterministic component assembler and bounded vision request path. Keep current file formats and source consent checks. Resolve known dimensions explicitly, reject unreliable fits instead of treating them as authoritative, and preserve component groups through assembly.

**Tech stack:** Python/numpy/pytest; TypeScript/zod/three.js/Vitest; existing Electron end-to-end fixtures.

**Spec:** The diagnosed failures and user's instruction to fix them on 16 October; existing engineering design in `docs/plans/2026-10-15-engineering-model-design.md` supplies the surrounding contracts.

## Scope and decisions

- Repair the observed failure classes using synthetic regression fixtures, then replay private saved inputs outside the repository without modifying the source project.
- A person's reference height wins over an automated height. Preserve its provenance as a reference. A stale measured profile that contradicts the asset extent must not continue to dictate the radius.
- Select coherent shaft sections by their vertical span rather than locking onto the first low circles. Preserve valid taper and avoid promoting unrelated tall objects.
- Preserve antenna groups, their sizes, types, levels and bearings. A whip uses the existing slender omni geometry rather than silently becoming a panel; no new on-disk assembly kind is needed.
- Ground-level light candidates require visual confirmation, and rejected or implausibly large candidates cannot become measured aviation lights.
- Every critique request reserves room for generated model views and representative source views. Selection, preview, consent, cache and actual request must agree. No extra cloud requests are introduced automatically.
- Improve photo coverage with available position/view information and perceptual diversity; retain deterministic fallbacks when metadata is missing.
- The existing region-editor proposal on another branch is separate. Do not edit that worktree or introduce its new UI here.
- No model-provider change, installer build, live API call or project overwrite is required for this repair.

## Global constraints

- Own worktree: `.claude/worktrees/engineering-model-quality`, branch `fix/engineering-model-quality`, based on `c8d122f1`.
- Follow `CONTRIBUTING.md`; no client/site names or private data in tracked files.
- Strict TypeScript, no `any` or non-null assertions; no em/en dashes in product copy.
- Preserve schema compatibility; record any unavoidable semantic contract change in `docs/architecture/contract-changes.md`.
- All source data remains read-only. Private replay outputs go under a system temporary directory outside the repository.
- Every regression must fail before the corresponding fix and pass afterwards. Run `pnpm check`, relevant Python checks and affected end-to-end specs before delivery.

## Review focus

1. Connected clutter at the base, stepped/tapered shafts and partial scans must not select the wrong radius or invent height (Task 1).
2. A reference height must not silently relabel AI estimates as measurements or stretch a contaminated radius profile (Task 2).
3. Several antenna groups, zero counts, user overrides and accepted component IDs must remain distinct and stable (Task 2).
4. Image budget saturation, repeated passes, tiny model limits and sharing exclusions must still permit honest visual critique (Task 3).
5. A syntactically valid GLB is insufficient: verify dimensions, component inventory and rendered appearance against inputs (Task 4).

## Execution DAG

Tasks 1, 2 and 3 run in parallel with exclusive file ownership. Task 4 depends on all three; independent review and final checks follow Task 4. Critical path: measurement regression, private replay, integration review, complete checks.

### Task 1: Evidence from the actual shaft and diverse photos

**Owns:** `python/src/aio_pipelines/engineer/`, associated `python/tests/test_engineer_*.py`, `python/tests/test_model_evidence.py` and synthetic asset helpers. Coordinate before editing packaging or shared schema.

**Interfaces:** Existing `EvidencePack` remains readable. Output `height`, `slices`, `taper`, `familyHints` and `warnings` must describe the coherent tall asset. Existing photo image records and budget are retained.

- [x] Add and run a failing synthetic regression: a roughly 30 m slender pole above dense 2 to 4 m compound clutter yields full pole height and sub-metre radii, with no compound fit labelled as the shaft.
- [x] Cover taper, stepped shapes, absent base and unrelated neighbours using existing fixtures plus focused additions.
- [x] Implement coherent section selection and height plausibility, with explanatory warnings for incomplete or ambiguous fits.
- [x] Add photo selection regression for redundant sharp views versus available coverage; implement deterministic diversity within the existing cap.
- [x] Run affected Python tests and report exact red/green results. Prepare instructions for replaying saved asset points without a live provider.

### Task 2: Preserve reference dimensions and component distinctions

**Owns:** `packages/modelling/src/engineer/assemble/`, associated builders only where needed, fixtures and regression/acceptance tests in `packages/modelling`. No schema or AI package edits without coordination.

**Interfaces:** `assemble(AssembleInput)` remains the public API. Existing proposal components retain their role/type/size/level identity. Existing quality and scale records remain truthful.

- [x] Failing regression: reference height 31 over stale 2.4 m evidence gives 31 m, with reference provenance; a compound-only profile must not become a 7.5 m-wide pole when the source extent and proposal contradict it.
- [x] Failing regression: 12 large panels, four small panels and a whip remain distinct sizes/types/levels rather than becoming 17 identical panels.
- [x] Failing regression: unconfirmed low candidates and multi-metre canopy-sized candidates do not become aviation lights; valid confirmed lights and user overrides survive.
- [x] Implement the smallest corresponding fixes, preserving IDs and accepted edits across rebuilds, and using existing omni geometry for whip proposals.
- [x] Run assembly, builder and model acceptance suites. Report representation limits honestly.

### Task 3: Make visual critique see the result

**Owns:** `packages/ai/src/engineer.ts`, `engineerPrompt.ts`, corresponding tests; `apps/desktop/src/renderer/engineer/runStore.ts`, related pure selection helpers/tests and existing `engineering-flow.spec.ts` only if necessary.

**Interfaces:** The preview and actual payload use one deterministic image-selection policy; provider cap and consent remain enforced; cache includes actual selection and updated prompt version.

- [x] Failing regression: 24 evidence images plus five generated views with cap 20 includes generated geometry and representative scan/photo evidence; repeats can cover omitted sources.
- [x] Cover low-cap models, first pass, exclusions, consent checks, preview agreement and cache invalidation.
- [x] Implement bounded selection with explicit review priority and an instruction to compare the generated model with source observations and flag measurement conflicts.
- [x] Run AI engineer, run-store, preview and affected end-to-end tests; report exact red/green evidence. Unit coverage and all 7 engineering workflow tests are green.

### Task 4: Integrate, replay, review and finish

**Owns:** Integration acceptance tests, guide/known-limit updates, contract-change entry if required, session note and this plan's execution record.

- [x] Verify all three task reports and independently review their diffs for correctness and scope.
- [x] Replay private saved point samples and proposals into a temporary output directory using repaired code; compare height, radius, antenna grouping and lights with the previous output.
- [x] Render the replayed GLB and visually inspect it against source views. No private data enters git.
- [x] Run `pnpm check`, Python checks/tests, demo preparation and affected end-to-end tests under CI window/scale/renderer settings.
- [x] Independent whole-change review; address material findings and repeat covering checks.
- [ ] Record validation, outstanding limits and concrete app test steps. Commit on this branch and follow repository integration process once checks permit.

## Execution record

- Worktree created from latest remote main; dependencies installed. Main checkout's pre-existing untracked landing studies left untouched.
- Investigation already established the reproduction using saved models, proposals, evidence and rendered GLBs. Repair scope approved by the user's instruction to fix it.
- No contract expansion is planned. The changes are corrections to interpretation and assembly of existing inputs.
- Task 2: 18 regression tests now cover the diagnosed errors and independent-review findings. Modelling suite: 368 passed; TypeScript and targeted lint passed. Review caught candidate reassignment from disabled groups and accepted-component duplication; both reproduced, fixed and approved on re-review.
- Task 3: saturated requests retain generated feedback, rotate omitted photos and use one selection for consent, preview, cache and request. AI suite: 628 passed, plus renderer coverage and type/lint checks. Independent review approved, including the additional omitted-kind consent regression and distinct-group prompt.
- Private assembly replay: a supplied 31 m height yields 31 m, twelve large panels, four small panels and one slender omni/whip; six false low lights are absent and the remaining uncertain crown light stays inferred. The replay uses saved inputs and writes outside the repository.
- Integration choice: pipeline pack 0.13.1, with the engineering minimum raised to that version, so installed clients cannot claim the repaired measurement behavior while using older processing code. No file format changes.

- Task 2 and 3 implementation committed as `9e6b65b3`. Desktop build passed; fresh evidence replay and full checks remain pending.

- Desktop validation: all four quick demos passed, followed by 7/7 engineering workflow tests without skips or retries at 1100 x 720, scale 1 and WARP. No real project writes or live provider calls.
- Integration committed as `6114ddf5`; independent review also closed the resumed-job minimum-version bypass.

- Fresh evidence replay recovers a narrow observed shaft through the equipment clutter and correctly suggests a telecom monopole. The supplied height remains a reference. A merged crown candidate exposed a further antenna assignment error; two regressions now reject oversized aggregate measurements and retain missing proposal sectors. The combined GLB renders successfully with distinct large/small/whip groups and a compact crown.

- Final Python verification: 67 engineering/model-evidence tests passed; two PDAL-dependent tests skipped because that executable was not configured in this test invocation. Runtime/checkpoint coverage: 32 passed. Python-wide Ruff lint and format checks passed (318 files). The invalid standing-axis case is rejected before base calculation or evidence publication.
- Final desktop rebuild and a repeat of all 7 engineering workflow tests passed after antenna and checkpoint fixes; no skips or retries. Independent whole-change review approved all code deltas.

- Repository finish check passed on `ddb64a94` after rebase onto current remote main: lint, formatting, TypeScript, 965 test files passed (4 skipped), 9,838 tests passed (14 skipped). The final verification record is a documentation-only follow-up.

- The two previously skipped compressed-cloud checks were then run with the installed PDAL executable configured explicitly: both passed. Total final engineering/model-evidence coverage is 69 passed across the main run and this follow-up, with no remaining skipped cases in that scope.

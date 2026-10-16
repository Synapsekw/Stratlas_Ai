---
type: session
date: 2026-10-16-1700
branch: fix/engineering-model-quality
status: verified
related:
  - docs/plans/2026-10-16-engineering-model-quality.md
  - docs/guide/44-engineering-models.md
---

# Engineering model quality

## What changed

- Shaft fitting selects sustained sections, recovers observed wall points through equipment clutter and rejects degenerate standing-axis fits before they produce displaced geometry. Photo selection balances sharpness with camera and perceptual coverage.
- Reference heights take precedence with reference provenance, and short compound-only profiles cannot dictate the shape of a much taller asset.
- Antenna proposal groups retain their individual sizes, types, levels and bearings. A whip uses the existing slender omni representation. Group overrides and accepted identities survive rebuilds.
- Low unconfirmed and oversized warning-light candidates do not become measured aviation fixtures.
- Visual review requests retain generated model views with representative source evidence and rotate omitted photos into later passes. Preview, consent, cost and cache use the same selection.
- The prompt preserves distinct groups and asks for an explicit source-to-draft comparison. Processing pack 0.13.1 is required for repaired evidence generation.

## Why

A low equipment compound could dominate the section fit of a tall pole, producing a short, broad cylinder. The AI could recognise the mistake, but the assembler overrode that observation and discarded distinctions between antenna groups. Saturated image requests also dropped every generated review view.

## Verification

- Assembly regressions reproduced the diagnosed failures before fixes. Independent review found two further group/identity defects; both have covering regressions and an approved re-review.
- Modelling package: 368 tests passed. AI package: 628 tests passed. Focused renderer tests, TypeScript and lint checks passed.
- A local replay of fresh measurements and a private saved proposal produces the entered reference height, a narrow measured shaft, distinct large/small/whip antenna groups and no oversized low lights. The combined GLB renders successfully; full and crown views were inspected. Inputs remain read-only and artifacts stay outside the repository.
- Desktop build and all four synthetic demos passed. The engineering end-to-end workflow passed all 7 tests with no skips or retries at 1100 x 720, display scale 1, WARP and an off-screen window.
- Resumed evidence jobs enforce the new pack minimum and invalidate pre-repair checkpoints before recording the new version, so old measurements cannot be silently reused. The actual IPC-handler and interrupted-checkpoint regressions pass.
- Independent review caught shaft truncation across short interruptions and a downstream fallback that resurrected explicitly withheld heights. Fresh evidence replay also exposed a merged crown being used as one large antenna; regressions cover all three repairs. Independent review approved all final changes.

- Final engineering Python run: 67 passed, two PDAL-dependent tests skipped because the executable was not configured for that invocation. Runtime/checkpoint suite: 32 passed. Python-wide Ruff lint and formatting passed (318 files).
- Final desktop rebuild and repeat of all 7 engineering workflow tests passed after the last antenna/checkpoint changes. `finish-task.mjs` passed after rebasing onto the latest remote main: lint, formatting, TypeScript and 9,838 unit tests passed, with 14 skipped. Integration remains subject to the repository merge lock and remote CI.

## How to test

1. Use a build containing this branch and processing tools 0.13.1 or later.
2. Open a project with a slender tower in a compound. Choose **Create engineering model** with its cloud and photos, and enter a known height when available.
3. Check the estimated height and fitted pole against the scan. The compound must not become the shaft.
4. At the second send preview, confirm that generated model views appear alongside source evidence.
5. In Model Builder, verify that large panels, small panels and slender antennas remain distinct and that ground signs/canopies are not warning lights.
6. Accept a component, change another group's count and rebuild. The accepted component must remain unchanged without a duplicate.

## Open threads

- Integrate the verified branch after remote CI. All local checks, private replay and independent reviews are complete.
- Geometry remains an editable approximation: the existing circular headframe, step bolts, grated platforms, foundations and fences have representation limits.
- No installer or live provider evaluation is part of this repair. The next packaged build must carry the repaired processing pack.

## Next session entry point

Use the test walkthrough in the next build with processing tools 0.13.1. The repair was developed and verified in its isolated worktree; remote integration status is recorded by the pull request.

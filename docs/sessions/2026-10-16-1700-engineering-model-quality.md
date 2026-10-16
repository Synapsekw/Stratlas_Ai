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

- Shaft fitting selects sustained sections and recovers observed wall points through equipment clutter. Invalid standing-axis fits stop before producing displaced bases or fabricated heights; an unreliable height stays unknown downstream.
- Reference heights take precedence with reference provenance. Short compound-only profiles cannot dictate the shape of a much taller asset.
- Antenna groups retain individual sizes, types, levels and bearings. Aggregate crown detections cannot dictate a single panel's dimensions, and partial measurements do not collapse every proposed sector into one. Overrides and accepted identities survive rebuilds.
- Low unconfirmed and oversized warning-light candidates do not become measured aviation fixtures.
- Photo selection balances sharpness with camera and perceptual coverage. AI review requests retain generated model views alongside source evidence; preview, consent, cost and cache share that selection.
- Processing tools 0.13.1 are required for new and resumed evidence jobs. Upgraded jobs invalidate pre-repair checkpoints before recording the new version, so old measurements are recomputed.
- Immediate Retry waits for the previous job's cancellation to finish before resuming it. Cancelling again during that wait remains effective.
- The Globe street renderer distinguishes delayed watchdog callbacks and continuing draw progress from genuine inactivity, with a finite draw limit and cleanup on disposal.

## Why

Low equipment could dominate the section fit of a tall pole, producing a short, broad cylinder. The AI could recognise the mistake, but assembly overrode that observation and discarded distinctions between antenna groups. Saturated image requests also dropped every generated review view.

## Verification

- Repository finish check passed after rebase onto remote main: lint, formatting, TypeScript, 965 test files passed (four skipped), and 9,838 unit tests passed (14 skipped). The verification record is a documentation-only follow-up.
- Modelling package: 368 passed. AI package: 628 passed, with focused renderer coverage. These suites include regressions reproduced before fixes and independent-review follow-ups.
- Engineering/model-evidence Python: 69 passed across the main run and an explicit PDAL follow-up. Both initially skipped compressed-cloud cases passed with the executable configured. Runtime/checkpoint suite: 32 passed. Python-wide Ruff lint and formatting passed (318 files).
- Desktop build and all four synthetic demos passed. The final engineering workflow passed all seven tests without skips or retries at 1100 x 720, display scale 1, WARP and one off-screen worker.
- Local UI tests use the shared development interpreter, whose isolated job process resolves the main checkout's editable Python package. The direct Python suites and remote CI use the repaired source; local UI results establish the renderer and workflow behavior, not a separate installed-pack validation.
- Fresh measurements and a private saved proposal replayed into a coherent narrow shaft, distinct large/small/whip antenna groups and no oversized low lights. The GLB built without failures; full and crown renders were inspected. Inputs stayed read-only and artifacts remain outside the repository.
- Independent whole-change review approved all final deltas, including shaft continuity, height provenance, group identity, aggregate candidates, checkpoint upgrades and invalid standing-axis rejection.
- Remote CI passed sixteen checks, but the remaining desktop shard failed a documented street-tile timeout. Its single permitted rerun repeated that failure and exposed the immediate engineering Retry race. Both were reproduced with deterministic regressions and fixed; independent review approved both follow-ups. Focused renderer coverage passed 47 tests, and maps/Globe coverage passed 302 tests. Final integration remains gated on CI for the updated commit.
- The follow-up desktop build passed, followed serially by all seven engineering tests and all nineteen Globe tests at the CI window/scale/renderer settings. Cancel/retry and street-pack drawing each passed two additional repetitions, three successful runs of each case in total.

## How to test

1. Use a build containing this branch and processing tools 0.13.1 or later.
2. Open a project with a slender tower in a compound. Choose **Create engineering model** with its cloud and photos, and enter a known height when available.
3. Check the estimated height and fitted pole against the scan. The compound must not become the shaft.
4. At the second send preview, confirm that generated model views appear alongside source evidence.
5. In Model Builder, verify that large panels, small panels and slender antennas remain distinct and that ground signs/canopies are not warning lights.
6. Accept a component, change another group's count and rebuild. The accepted component must remain unchanged without a duplicate.

## Limits and integration

Geometry remains an editable approximation. Circular headframes, step bolts, grated platforms, foundations and fences still have the existing component-library limits. A new live-provider evaluation remains useful; this validation used scripted providers and a saved proposal. No installer was built. The next packaged build must include the repaired processing tools, and existing saved models need regeneration to benefit.

The repair was implemented and verified in its isolated worktree. Remote CI and the repository merge lock govern integration; the pull request records that status.

## Next session entry point

Use the walkthrough in the next build with processing tools 0.13.1, then assess the remaining component-library limits against representative source images.

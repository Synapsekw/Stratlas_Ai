# UI review, October 2026

Evidence for the UI revision project (design `docs/plans/2026-10-30-ui-revision-design.md`, plan and tracker `docs/plans/2026-10-30-ui-revision.md`). Taken on 30 Oct 2026 from `main` at `d13e6a6b9`, with the four synthetic demo projects from `apps/desktop/demo`, at 1280 x 800 and at the 1100 x 720 CI size.

| File | What it holds |
| --- | --- |
| [critique.md](critique.md) | Visual critique: verdict, Nielsen scores, cognitive load, ten priority issues, personas, the proposed layout |
| [code-audit.md](code-audit.md) | Read-only renderer audit: shell map, placement, tokens, component consistency, accessibility, anti-patterns and copy, with `file:line` references |
| [index.md](index.md) | Index of all 83 screenshots taken (name, what it shows, how it was reached, what is visibly broken) |
| [annotations.json](annotations.json) | Numbered callouts per screenshot: box in percent of the image, severity, note |
| [img/](img/) | The 24 screenshots used in the merged report, as WebP |

The merged report (top fixes, placement map, the twelve-item polish checklist, system debt and the three waves) was published as a private artifact; its content is folded into the design and the plan. Only the 24 screenshots in `img/` are kept in the repository; the other names in `index.md` refer to the full capture set, which was not committed.

Measurements in pixels are read from screenshots and are approximate. Every project, customer and site name in the images is synthetic demo data.

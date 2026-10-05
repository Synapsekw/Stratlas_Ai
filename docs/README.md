# Documentation

The order below follows the product process: requirements, then brand and UI direction, then architecture, then plans. Nothing under `apps/` or `packages/` is written until the spec is approved.

| Document                                                           | Purpose                                                                                                                      | Status        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [PRD.md](PRD.md)                                                   | Product requirements for Release A (Player and Workspace) and Release B (Builder)                                            | Approved v1.1 |
| [design/DIRECTION.md](design/DIRECTION.md)                         | Chosen UI direction (Mission), tokens, fixed layout elements                                                                 | Decided       |
| [design/BRIEF.md](design/BRIEF.md)                                 | Brief used for the UI and brand rounds                                                                                       | Final         |
| `design/ui-options/round2/`                                        | Live mockups: Mission (chosen), Flight, Studio. View via the `design-preview` server, `http://localhost:8765/ui-review.html` | Reference     |
| `design/assets/`                                                   | Real client assets used by the mockups (internal only, see MANIFEST.md)                                                      | Reference     |
| `brand/`                                                           | Name and logo rounds. Working name **Stratlas** (temporary), R5 placeholder mark                                             | Temporary     |
| [architecture/tech-evaluation.md](architecture/tech-evaluation.md) | Options and recommendation for every major technology choice                                                                 | Final         |
| [architecture/SPEC.md](architecture/SPEC.md)                       | System architecture for Releases A and B, parallel delivery model                                                            | Approved v1.0 |
| [architecture/adr/](architecture/adr/)                             | Architecture decision records: 0001 Electron, 0002 Mission UI                                                                | Accepted      |
| [plans/ROADMAP.md](plans/ROADMAP.md)                               | Milestones M1 to M10 in build order (licensing last), one plan per milestone in `plans/`                                     | Living        |
| [TESTING.md](TESTING.md)                                           | Founder test checklist, only what still needs testing                                                                        | Living        |

## Reference material

- Six existing review artifacts (claude.ai): HCl Tank 710-D-130335, EBSM Flare Inspection, DAMAC Hills residential tower Review, Masafi Stockpile Review, 1st Ring Road Survey, Al-Zour LNG Plant Model.
- Build kits in the DRA vault: `outputs/templates/Asset Inspection Kit/`, `outputs/templates/Volumetric Survey Kit/`.
- Offline packages on `\\DanNas\Work Data\`: see the project memory or the SPEC for exact paths.
- Kestrel (`E:\Dev\Yolo\app`), a separate app; modules may be copied: point-cloud viewer, GLB pins and frustums, image annotation canvas, agent risk-tier patterns.

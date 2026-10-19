# Documentation

The product is **Quadrion AI**. It was called Stratlas until 7 Oct 2026; older plans, ADRs and records keep that name ([rename record](plans/2026-10-07-rename-quadrion.md)).

The order below follows the product process: requirements, then brand and UI direction, then architecture, then plans.

| Document                                                           | Purpose                                                                                                                      | Status        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [PRD.md](PRD.md)                                                   | Product requirements for Release A (Player and Workspace) and Release B (Builder)                                            | Approved v1.1 |
| [design/DIRECTION.md](design/DIRECTION.md)                         | Chosen UI direction (Mission), tokens, fixed layout elements                                                                 | Decided       |
| [design/BRIEF.md](design/BRIEF.md)                                 | Brief used for the UI and brand rounds                                                                                       | Final         |
| `design/ui-options/round2/`                                        | Live mockups: Mission (chosen), Flight, Studio. View via the `design-preview` server, `http://localhost:8765/ui-review.html` | Reference     |
| `design/assets/`                                                   | Real client assets used by the mockups (internal only, see MANIFEST.md)                                                      | Reference     |
| `brand/`                                                           | Name and logo rounds; the final identity kit for **Quadrion AI** is `brand/quadrion/kit/`                                    | Final         |
| [architecture/tech-evaluation.md](architecture/tech-evaluation.md) | Options and recommendation for every major technology choice                                                                 | Final         |
| [architecture/SPEC.md](architecture/SPEC.md)                       | System architecture for Releases A and B, parallel delivery model                                                            | Approved v1.0 |
| [architecture/adr/](architecture/adr/)                             | Architecture decision records 0001 to 0012, from Electron and the Mission UI to the OpenDroneMap engine                      | Accepted      |
| [plans/ROADMAP.md](plans/ROADMAP.md)                               | Milestones M1 to M12 in build order (licensing last), plus timeline, walks 360 and drone panoramas                           | Living        |
| [TESTING.md](TESTING.md)                                           | Founder test checklist, only what still needs testing                                                                        | Living        |

## Reference material

- Six existing review artifacts (claude.ai): a tank inspection, a flare inspection, a residential tower review, a stockpile review, a road survey and an LNG plant model.
- Build kits in the DRA vault: `outputs/templates/Asset Inspection Kit/`, `outputs/templates/Volumetric Survey Kit/`.
- Offline packages on the founder's network share: see the project memory or the SPEC for exact paths.
- Kestrel (`E:\Dev\Yolo\app`), a separate app; modules may be copied: point-cloud viewer, GLB pins and frustums, image annotation canvas, agent risk-tier patterns.

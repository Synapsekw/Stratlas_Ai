---
type: session
date: 2026-10-19-0101
branch: feat/rf-coverage-simplify
status: complete
related:
  [
    superpowers/specs/2026-10-18-rf-coverage-simplify-design.md,
    superpowers/plans/2026-10-18-rf-coverage-simplify.md,
  ]
---

# RF coverage simplified: Coverage card, Coverage panel and Auto-plan

## What changed

- The RF tab is now the pinned **Coverage** panel: a status line, an AI card, three steps (Antennas, Sectors and equipment, Coverage) and the study settings and CSV import folded under Advanced.
- A **Coverage card** heads the stage's legend corner once a project has antennas ("3 antennas, not planned" with Auto-plan; after a run "RSRP, N% fair or better" with the layer eye and Re-plan). Before a run it yields so the dates pill and the readout keep their corners (stage-island ruling); Ctrl+K has Auto-plan coverage and Open Coverage panel.
- **Auto-plan**: sectors by bearing (existing sectors kept), equipment and band per antenna from the AI (`ai:rfPlanPreview` / `ai:rfPlan`, same gates as antenna labels), from rules (face size: n78 AAU or B3 panel plus radio) or from a cell export matched by name, sector bearing and height. A review dialog shows each pick with its reason and confidence before anything is written; Apply and run saves and starts the job.
- Values carry an origin (`ai`, `rules`, `export`, `user`) in `rf/sectors.json` (optional keys, schema version unchanged); Re-plan keeps the person's and the export's values; low confidence is amber.
- Drafts are never planned; with no accepted antenna Auto-plan says "Review antennas first". The AI never sets azimuth, tilt or height.

## Why

The founder found RF coverage too hard to find and too long to fill in, and asked for one button that assigns antennas to sectors and runs coverage. Usually only drone data exists, sometimes a cell export.

## How to test

1. Open a project with detected antennas and accept them in the antenna inventory.
2. The Coverage card in the stage's bottom corner reads "Coverage, N antennas, not planned". Click Auto-plan.
3. The review dialog lists one row per antenna. Without an AI provider it shows Rules only. Click Apply and run coverage.
4. Coverage draws on the map; the card shows the RSRP share; the Coverage panel's step 2 shows each sector tagged rules, AI or AI low.
5. With drafts only, Auto-plan shows "Review antennas first" and its button opens the inventory.

## Open threads

- The catalogue is thin (only the generic AAU covers n78; vendor entries unverified), so picks often land on generic entries.
- Parked: the AI does not resolve unmatched cell-export model text (rules equipment at low confidence instead); the plan-changed-since-run flag is in memory only; the card's before-run rule is conservative because the stage gives RF no overlay information.
- The antenna inventory's `openAntennaReview()` lands with `feat/antenna-review`; until then Review antennas reveals the first draft and opens the Measure bench.

## Next session entry point

Founder tries the steps above in the next build; follow-ups are the parked items and catalogue verification.

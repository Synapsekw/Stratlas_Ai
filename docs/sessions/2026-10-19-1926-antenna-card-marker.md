---
type: session
date: 2026-10-19-1926
branch: fix/ui-batch-oct18
status: complete
related: [sessions/2026-10-18-2215-antenna-review.md]
---

# Stable marker on the antenna card

## What changed

- The floating antenna card carries `data-antenna-card`, and `telecom/AntennaCard.tsx` exports `ANTENNA_CARD_SELECTOR`, with a test. Its `data-testid` is unchanged.

## Why

The RF coverage card keeps clear of the antenna card. It found the card by test id, and a test id rename would have broken that without any error. The RF session asked for a stable marker like the Labels control's `data-antenna-labels-control`.

## How to test

No user-facing behaviour to test; covered by the test suite.

## Open threads

- The RF session can switch its lookup to `ANTENNA_CARD_SELECTOR` once this lands.
- The antenna review follow-ups stay as listed in the 2026-10-18 note.

## Next session entry point

Nothing pending from this branch once it lands.

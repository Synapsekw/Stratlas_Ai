---
type: session
date: 2026-10-23-0057
branch: feat/vlm-detectors-m2
status: complete
related:
  [
    ../superpowers/specs/2026-10-17-local-vlm-detectors-design.md,
    ../superpowers/plans/2026-10-22-local-vlm-detectors-merge2.md,
    2026-10-21-2326-local-vlm-detectors-merge1.md,
  ]
---

# Local vision-model detectors merge 2: install, run and review in the app

## What changed

- This PR adds an **Analytics pack** section in Settings, Processing tools. It covers install, progress and Remove, and shows whether this computer's graphics card can run detectors (RTX 20 series or newer, driver 580 or later), with Check again. If an installed pack can't be used, the section says why. An unsigned Analytics pack now asks before installing, as the processing tools do, and the pack build signs with the publisher key when one is set.
- A **Detector library** sits below it, grouped into Shipped, My library and This project. Each detector shows its hit rate, misses and suggested threshold. Import offers update or keep both. Export can leave out sample photos and warns when it doesn't. Clear review history asks first.
- The Detect dialog gets a third mode, **Detectors (on this computer)**:
  - choose the detectors, with a threshold for each and the time estimate
  - a visible reason whenever Start is off
  - a loading line while the model loads, and the dialog can be closed then
  - a run waits for a busy graphics card in a strip with Cancel; photo processing waits while a detector run uses the card
- The review gets a score badge, a bar per run that really hides and shows boxes (header, tiles and photo), and reject reasons with an optional note. Accept, reject and misses go into the detector's review history on this computer, with a cropped thumbnail.
- Main and the pipeline get hardening: GPU age and driver checks, the model server's own output kept in `analytics-server.log`, shorter model timeouts, and a "Create class" suggestion when the project lacks a detector's class. Detectors need processing tools 0.23.0 (pyproject bumped in this PR).
- New e2e: `detectors-local.spec.ts` (UI flow) and `analytics-settings.spec.ts`.

## Why

Merge 1 shipped the engine with no screens. The founder asked for a place to install and update the Analytics pack, like the processing tools, and for evidence that it works.

## How to test

1. Use a build with processing tools 0.23.0 or later. Go to **Settings**, **Processing tools**, **Analytics pack**. The graphics card line shows your card and its free memory. Choose the `analytics-pack-<version>-win-x64.tar.gz` file. Because it is unsigned, confirm Install; progress runs, then the version shows.
2. Open a plant project, go to **Detections**, **All photos**, select a few photos, then **Detect** and **Detectors (on this computer)**. Pick **Corrosion on metal** and press **Start**. The dialog closes within seconds once the model is in the disk cache, or up to two minutes the first time.
3. When the job ends, the review shows a strip "Corrosion on metal · Show boxes scored 0.80 · N shown, M hidden". Drag the bar up: boxes leave the photo and the header count drops. Drag it down and they return.
4. On a draft, press **Reject** and choose **Not a defect**. Accept another. Then go to **Settings**, **Processing tools**, **Detector library**: Corrosion on metal shows a hit rate and the number reviewed.

## Open threads

- Real-hardware acceptance (RTX 5070 Ti, 8 spike photos) passed. It took 45 s for 8 photos and the model loaded in about 4 s warm. It found the same 7 drafts at or above 0.8 as merge 1, and the ledger lines and crops were correct.
- These follow-ups are in KNOWN-LIMITS:
  - a renderer-supplied import and export path (security follow-up)
  - UTC run dates in the strip
  - no retry for only the refused layers
  - a possible double start when reopening the dialog during the model load
  - the slug id of a class created from a suggestion, so later misses are not counted
- `feat/antenna-flagging` (#218) moves to processing tools 0.24.0 after this PR (agreed between the sessions).
- Founder: review the corrosion detector's flare false alarms so it can be marked verified, and create the pack signing key.

## Next session entry point

Merge 3: the detector builder, `.aiodet` sharing, learning suggestions and dataset export.

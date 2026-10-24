---
type: session
date: 2026-10-24-2223
branch: feat/inspect
status: complete
related:
  [../superpowers/specs/2026-10-24-inspect-design.md, ../superpowers/plans/2026-10-24-inspect.md]
---

# Inspect: one screen for photos, findings and AI

## What changed

- This PR replaces the Media and Detections screens with one Inspect screen: a photo column (sets, 360s, clips, filter chips To review / With findings / All, an orange AI badge and a teal confirmed badge per tile, Media's tile right-click actions), the photo viewer with dashed AI suggestions and solid confirmed findings, one findings list per photo with Accept, Change and Dismiss, and the keyboard (J/K, Shift+J/K, A, D).
- One Ask AI button with a scope (This photo, Selected, All). The backend comes from a Settings default (Automatic tries the project's detectors, then the local model, then the cloud). A cloud run always shows a one-line confirm first, and Try again re-checks the provider and refuses if it changed since the confirm. A run strip shows progress, the waiting runs with Cancel and why a run failed.
- A review queue (crop, one confidence slider, Accept / Fix / Not a fault). The slider is the only confidence bar in Inspect and starts at 50 % (founder), from the moment Inspect opens.
- Ask AI settings in Settings, with the local model class maps moved out of the run dialog. The old screens and their dialogs are deleted, and the agent, palette, navigation and every e2e spec use Inspect. Contract row: `@aio/ai` `AppScreen` gains `inspect`. No pipeline pack change.
- Final review fixes: keys pressed in a right-click menu or dialog no longer act on suggestions, and user-facing text no longer points to Media.

## Why

The founder: users cannot find the AI features and they take too many steps. AI on one photo took 8 to 10 actions across two screens; the founder picked option A with option B's review queue from three options rendered in the real app.

## How to test

1. Open a project with photos. The left navigation shows Inspect, and Media and Detections are gone.
2. Pick a photo and draw a box: class and severity are asked once, with your last choice filled in. The finding is solid teal.
3. Press Ask AI with This photo. The suggestions appear dashed orange with their confidence. Press A on one: it turns into a confirmed finding. Press D on another: it goes away.
4. Choose All and Ask AI with the cloud as the backend: a one-line confirm says what is sent and where. Nothing is sent until you press Send.
5. Open the review queue. The slider starts at 50 %. Lower it: weaker suggestions show, and the "Review n suggestions" count follows. Step with J/K and decide with Accept, Fix or Not a fault.
6. Right-click a photo tile and press the arrow keys and letters in the menu: only the menu reacts, and no suggestion is accepted.

## Open threads

- Follow-ups from the final review: "Don't ask again" for the cloud has no undo; Reopen, the detection note, "Unreviewed photos" scope and the post-run cloud usage lines are gone; an agent-set filter does not show while the Filter panel is closed; accepted sizes on small EXIF-rotated photos with legacy passes can swap, and mask assist ignores EXIF orientation (older than this branch); the agent's place_on_model can save normalized coordinates (older than this branch).
- People who had saved any Ask AI setting before keep a 0 slider start.

## Next session entry point

Founder testing of Inspect on local main once the coordinator lands it; the review follow-ups above are the next small batch.

# Inspect: one place for photos, drawing and AI

Date: 24 Oct 2026. Status: draft for founder approval.

## Why

The app can already draw findings on photos, run three kinds of AI (cloud vision, local ONNX models, local vision-model detectors) and review the results. Users can't find most of it, and the parts they do find take too many steps. The founder's words: "what is the point of having all of these capabilities when users can't find them and it's complicated to use."

Today the work is split across screens:

- **Media** (`apps/desktop/src/renderer/screens/Media.tsx`) shows the photos and lets you draw. It has no way to start AI and only shows finding counts.
- **Detections** (`screens/Detections.tsx`) is a second photo grid (the contact sheet) where AI runs start ("Detect with AI" → `AiDetectDialog` → choose backend → choose scope → settings → Run) and where results are accepted or rejected.
- **Issues** is where accepted results end up.
- **Settings** holds model setup.

The same mark means different things depending on where you draw it. In Media's `PhotoViewer` a box becomes an Issue with a Sighting. In the Detections `ReviewEditor` it becomes a human-sourced Detection that then has to be accepted. Class and severity are asked in the composer, the inspector, the local-model class mapping and "Create class".

Running AI on one photo is 8 to 10 actions across two screens. Running it on everything and reviewing the results is 10 or more actions across three screens.

## Decided

The founder reviewed three options rendered in the real app (canvas: https://claude.ai/artifact/FA7arnG3tfbhthi7p9DFqj; throwaway spike on branch `feat/inspect-spike`, commit `885d75026`, file `apps/desktop/src/renderer/screens/InspectSpike.tsx`) and picked **option A as the everyday screen, with option B's review queue for working through AI results**.

## Goals

1. **One screen, Inspect**, where you see the photos, draw findings, run AI on one photo, on a selection or on everything, and confirm the AI's suggestions. You never switch screens to do this.
2. **One kind of finding on screen.** Your findings and the AI's appear in one list and on the photo in one visual language:
   - AI suggestions: dashed orange, with the confidence shown, until a person accepts them.
   - Confirmed findings: solid, in the app's confirmed accent (teal).
3. **One Ask AI button.** Scope is This photo, Selected (n) or All (n). There is no backend or model picker in the flow.
4. **Class and severity are asked once**, when you draw or accept, with your last choice filled in.
5. **Fewer steps.** These targets come from estimates made with the founder's mock-ups:
   - Draw a finding on one photo: about 4 actions.
   - AI on one photo, then confirm it: about 3.
   - AI on all photos: 3 actions, then one key per result.

## Non-goals

- New AI capability, new models or new detectors. This is a re-arrangement of what exists.
- Changing how the AI backends work inside, or the Analytics pack.
- Thermal measurement tools. The Thermal bench stays where it is (see Open points).
- The Scene's Annotate bench (`workspace/workbench/benches/AnnotateBench.tsx`) and findings on meshes and clouds.
- Reports.

## Anti-goals (a failure even if it works)

- **A fourth place to do the same thing.** Media and Detections must go away as separate screens, not live on beside Inspect.
- **AI results counting as findings before a person accepts them.** Drafts never reach the Issues register or a report unaccepted. This keeps today's rule.
- **Losing what Media does besides findings.** Flights, clips and 360 panoramas stay, and so do the photo-set grouping and the tile right-click actions: place, move, direction, as 360, as photo, remove and Edit position (`useTileMenu`, `MediaPins.tsx`, the shared action registry in `shell/actions/`).
- **A model or backend question every time someone wants AI.**

## The screen

Layout, matching option A in the canvas:

- **Left: photo column.**
  - The project's photos, grouped by set as in Media today, plus 360s and clips.
  - Filter chips: To review (n), With findings (n), All.
  - Each tile has two badges: an orange count of AI suggestions waiting, and a teal count of confirmed findings.
  - Selection follows Media's rules: click picks one, Ctrl toggles, Shift picks a range (`mediaSelect.ts`).
  - A colour key sits at the bottom.
- **Centre: the real `PhotoViewer`.**
  - Its draw tools: Select, Box, Rotated box, Polygon, Point.
  - Ask AI, followed by the scope buttons This photo, Selected (n) and All (n).
  - The photo name and its position ("14 of 312").
  - Confirmed findings are drawn solid. AI suggestions are drawn dashed orange with a small label: class, confidence, ✓ and ✕.
  - Hint line: "Draw on the photo, or accept a dashed AI box · J / K next photo".
- **Right: "Findings on this photo".**
  - One list with a YOU / AI n% chip, class and severity on each item.
  - AI items have Accept (A), Change and Dismiss (D). Change opens the class and severity picker, then accepts.
  - "+ Draw a finding (B)".
  - At the bottom: "n photos still have AI suggestions to check" and "Next photo to review →".
- **Top strip while an AI run is going.** "AI is checking n photos for … · k done · suggestions appear as they arrive", a progress bar and Stop. Suggestions stream into the tiles and the list as each photo finishes.

**Review queue (from option B).** After a bulk run, or from "To review", the right panel switches to the queue:

- progress ("14 of 86") and class chips with counts;
- a zoomed crop of one suggestion, with its class and severity pickers;
- big Accept (A), Fix (F: redraw or relabel, then accept) and Not a fault (D) buttons;
- "Accept all <class> above <threshold>% (n)".

The centre viewer follows the queue, so the photo for the current suggestion is always open. Esc or finishing the queue returns to the photo list.

**Ask AI.**

- The scope comes from the buttons. This photo is the default when nothing is selected.
- What to look for is a short list of checks, the project's classes or installed detectors, opened from the Ask AI button. The last choice is remembered per project, so a repeat run is one click.
- The backend is picked by a default set in Settings. The order is: an installed local detector for the chosen check, then the local ONNX model, then cloud vision if the project's AI policy allows it.
- Thresholds, tiles and class mapping move to Settings, with today's values as the defaults.
- If no backend can run, the button says so and links to Settings.

## Data

- **Human-drawn findings** become an Issue with a Sighting, as Media does today. The human-sourced Detection path (drawing in the `ReviewEditor`) is no longer offered.
- **AI results** stay Detections with status `draft` in the pass files under `detections/`, as today.
  - Accept sets them `accepted` and creates or links the Issue, which is today's accept path.
  - Dismiss sets them `rejected` with a reason.
- The single list on screen is a view over both (`findingsIndex` already joins them for Media's badges).
- **Intended result: no schema or contract change.** If the builder finds one is needed, it gets a row in `docs/architecture/contract-changes.md`.
- Existing projects open unchanged: their issues and detection pass files show up in Inspect as they are.

## Navigation

- The sidebar replaces **Media** and **Detections** with one item, **Inspect**.
- **Issues** stays as the project-wide register and export list. Opening an issue's photo takes you to Inspect with that photo and finding selected.
- Links that open Media or Detections today (scene markers, map photo markers, "Open in Issues" and the like) open Inspect instead.
- Model setup stays in Settings under the Analytics area.

## Constraints

- Windows first. Must work in CI's 1100 x 720 window at display scale 1. At that width the right panel may collapse to a drawer.
- Reuse the existing pieces rather than rebuild them: `PhotoViewer`, `DrawLayer`, `ClassComposer`, `PhotoTile`, `findingsIndex`, `AiDetectDialog`'s run code, `LocalDetect`, the detector run code, `DetectorQueue`, and the tile action registry.
- e2e specs that use Media or Detections are moved to Inspect, not deleted. Their coverage must not drop.
- i18n keys for every new string. Run the public-text check on docs.

## Left to the builder

- Component structure, file split and state shape.
- How the right panel collapses at narrow widths.
- Keyboard map details beyond A, D, F, J, K, B, Esc.
- Whether the old screens' code is deleted in the same branch or in a follow-up, as long as they are gone from the UI.

## Settled after the builder check (the session's calls, not the founder's)

- **Colours of confirmed findings.** They keep today's severity colours, drawn solid (`PhotoViewer.tsx:213`, `mediaFindings.ts:52-58`). "Solid" against "dashed orange" is what separates confirmed from AI, so worst-severity stays visible at a glance. Tile badges: orange for AI waiting, and the worst severity colour for confirmed. The teal in the mock-ups is dropped, so no new token is needed.
- **Video frames and 360 frames.**
  - The review queue must handle existing frame drafts. It reuses the frame rendering in `renderer/detections/Editor.tsx` when the current suggestion's source is a video, so no draft is left without a place to review it.
  - Video and 360 frames as a new Ask AI scope stay as today's run code allows. Anything missing becomes a follow-up.
- **Threshold.**
  - The review queue header carries a confidence slider, which replaces the per-pass bar in `DetectorPasses`.
  - Candidates below the slider are hidden and not counted in To review.
  - "Accept all above n%" uses the slider's value.
  - The default thresholds live in Settings.
- **Link to an existing issue stays.** Key L, and "Same as an existing finding…" inside Change, so the same defect is not logged twice.
- **Other Detections and Media tools that stay:**
  - In the queue: undo and redo, Reject all for the current class, and the Accepted / Rejected filters.
  - Under a Filter menu next to the chips: Media's severity filter and its sort.
  - In the Change picker: "Create class" for a suggested new class.
- **Backend choice.**
  - Settings gets "AI for Ask AI": Automatic (local first: detector, then ONNX model, then cloud if allowed), Local only, or Cloud.
  - The local model's class mappings move from localStorage into that Settings area, keeping their stored values.
- **One-key accept.** When a draft lacks a class or a valid severity, Accept fills in the last class and severity used in this project. If there is none, Accept opens the picker instead. The accept logic is in `packages/annotate/src/detections/accept.ts:51-67`.
- **Contract change.** The AI agent's `show` tool and the `AppScreen` type list the screens (`packages/ai/src/show-tool-specs.ts:64`, `packages/ai/src/tool-kit.ts:49`).
  - Inspect is added. `media` and `detections` stay accepted as aliases that open Inspect, so older agent prompts keep working.
  - This needs a row in `docs/architecture/contract-changes.md`.
  - The hard-coded screen lists move with it: `renderer/agent/hooks.ts:41`, `renderer/agent/dockScreens.ts:8`, `renderer/shell/Palette.tsx:76-77`, `renderer/shell/autoFold.ts:13`. Inspect gets the agent dock.
- **Where the shared pieces live.** `PhotoViewer`, `DrawLayer` and `ClassComposer` are in `packages/annotate/src/components/`. Changes there must not alter the Lightbox, which uses the same `PhotoViewer`.

## Open points

- **Thermal:** for now Inspect only links to the Thermal bench ("Analyse thermal" on thermal photos). Folding thermal spot findings into the one list is a follow-up.
- **Cloud confirmation (founder, 24 Oct):** a cloud run asks first. Local runs start straight away. When Ask AI resolves to cloud vision, a one-line confirm shows before anything is sent: "Send n photos to <provider>, about <cost>?" with Send, Cancel and "Don't ask again for this project". It reuses the provider, cost estimate and image preview from `AiDetectDialog.tsx:273-309`, with the preview one click away. The project's AI policy still decides whether cloud is allowed at all. This adds one action to the step targets, for cloud runs only.

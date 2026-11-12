---
type: session
date: 2026-11-12-0938
branch: docs/wrapup-wave-3
status: complete
related: [plans/2026-10-30-intelligence-review.md, sessions/2026-10-31-2259-intelligence-wave-2.md]
---

# Intelligence review Wave 3 done

## What changed

- All six Wave 3 items of `plans/2026-10-30-intelligence-review.md` are on local `main` (founder go 11 Nov, built autonomously, each branch with an independent review and narrow re-reviews): M2 `feat/site-tracks` `aa88f9096` (tracks across dates for antennas, change regions and thermal hot spots; a per-date antenna record in `telecom/history/<captureId>.json`; three digest rules; carries pipeline pack 0.35.0), V4 `feat/walk-detections` `fcbf991e3` (`walk.track` tracks and places 360 detections, `detect.vlm` on walk frames, Label with AI on change regions behind the cloud confirm), M1 `feat/fact-index` `9c7485050` (`packages/facts`, an SQLite FTS5 fact index in userData built in a worker, `query_facts` and `history_of`, "Search this project" on the Project tab).
- N1 `feat/model-addons` `ec3096467`: add-ons downloaded on demand with hash checks or Choose file; Road defects (integration only, untrained), Segmentation (real MobileSAM verified), Ground classifier (PDAL SMRF) and `segment.lift`; `chore/addons-serve` `92d0d92a6` adds `pnpm addons:serve` and an Add-on address field.
- X1 `feat/local-mcp` `aef9260a2`: a local read-only MCP server with 24 audited pure read tools, served only for projects the user allows; Offline only refuses every call. A3 `feat/offline-agent` `79f524929`: the bundled Qwen3.5 offline agent behind a tool-calling check (real run on an RTX 5070 Ti: 11/12, 12/12, 12/12 at 16384 context), batch approvals, project notes and view-capture consent per project and per route.
- Calls made on the founder's behalf: carried-over accepted antennas measured again count as confirmed; the fact index lives in userData and is kept for unplugged drives, deleted antennas excluded; add-on catalogue redirects are followed hop by hop against the allowed address; MCP needs an explicit per-project allow, keeps drawings consent and leaves out any tool with side effects or route-dependent sharing; the agent gets 7650 MB at 16384 context (detector and photo keep 7400), releases the model while an approval waits, and its notes are data, never packaged and hidden from MCP.
- This PR carries only this note and the north-star refresh.

## Why

Wave 3 closes the review's learning and memory gaps: the app remembers across dates, answers from its own facts, works without a cloud model and opens its read tools to local agents.

## How to test

Follow the How to test of each branch note (`2026-11-11-2200-site-tracks.md`, `2026-11-12-0041-walk-detections.md`, `2026-11-11-2222-fact-index.md`, `2026-11-12-0228-model-addons.md`, `2026-11-12-0600-local-mcp.md`, `2026-11-12-0730-offline-agent.md`); every step there is backed by an e2e or a real run. For add-ons, run `pnpm addons:serve` first.

## Open threads

- No full agent loop on the real bundled model yet (the E1 local profile run is next) and no real-model agent eval with an API key.
- Road YOLO is untrained and the SAM 3 ONNX export needs a PC with PyTorch; no add-on catalogue is published.
- Hot spot and region tracks have unit tests only (no multi-date demo); V4 can keep a rare duplicate when a same-class neighbour sits on exactly the reviewed frame.
- MCP engineering and change tools wait for a drawing-consent check; the native stdio MCP launcher is not built.

## Next session entry point

The intelligence review's three waves are complete; pick from the follow-ups above. The corrosion model waits for the asset inspection focus (founder, 30 Oct).

---
type: session
date: 2026-10-29-1807
branch: feat/custom-analytics
status: complete
related:
  [
    ../superpowers/specs/2026-10-26-analysis-structure-design.md,
    ../superpowers/specs/2026-10-27-custom-analytics-design.md,
    ../superpowers/plans/2026-10-28-custom-analytics.md,
  ]
---

# Custom analytics: ask the AI for anything on your photos

## What changed

- This PR adds two approved specs: the analysis frame (start from the map or cloud, one photo viewer with a thermal mode, project types, one findings list, one report; built later) and custom analytics (built here). The founder delegated the open decisions on 27 Oct and asked for an overnight build.
- Custom requests in Inspect (Ask AI > Custom request...): a plain-words request, optional typed values per item (number with unit, text, yes or no, choice), Find / Compare dates / Ask, scope This photo / Selected / All, saved requests per project or in this computer's library (`.aioreq` export and import), follow-up threads. Answers are dashed drafts with their values; Accept turns them into issues whose values print as tables in both reports.
- Routing: find and count on this PC, changes and text on Claude Sonnet 5.5, bulk on Haiku 5.5, OpenAI when only its key exists; the inspector can override (Opus as best quality). Guards drop whole-frame and tiny boxes, merge repeats, cap at 30, repair broken replies.
- Analytics pack 0.2.0 switches to Qwen3.5-9B (smoke OK on the build PC, 6.89 GB archive); pipeline pack 0.27.0 reads both box frames, so pack 0.1.0 keeps working. The local model stays warm 90 s after an ask; GPU photo jobs stop it first.
- Cloud AI is on by default for new installs (founder); Settings, Privacy and cloud gains "Keep this project's images on this PC" (the existing `aiPolicy: forbid`). Contract rows added; lint heap raised to 6 GB.

## Why

A 27 Oct bench showed the new local model reads gauges far better than the shipped one, and the cloud models are needed for date comparisons and report text.

## How to test

1. Install pipeline pack 0.27.0 and Analytics pack 0.2.0 (Settings > Processing tools > Choose file).
2. Inspect, open a photo with gauges, Ask AI menu > Custom request... Type "read all gauges", add values Reading (Number, unit bar) and Status (Choice: ok, worn, broken), Run on This photo: dashed boxes appear with the values; Accept one, open the issue, the values are there.
3. Save the request, press New, pick it again from Saved requests.
4. Compare dates on a photo with another survey date: pick the other date, Run, a cloud confirm shows first; changes land on the newer photo.
5. Ask kind: ask a question, then a follow-up; "Make a finding" turns an answer into a draft.
6. Settings > Privacy and cloud > This project: switch on "Keep this project's images on this PC"; cloud choices go grey in the panel.
7. Export the house report: accepted values print as "Recorded values" tables.

## Open threads

- The analysis frame (project types, spot-to-photos, findings list) is not built yet; Thermal and point cloud segmentation follow.
- Corrosion on Qwen3.5: no go on thin truth, detector stays experimental; rerun the bench with a higher `--limit`.
- Deferred minors are listed in the plan's follow-ups and this PR's review: `.aioreq` newer-version message, the Qwen3-VL-4B fallback, Word templates, ortho date pairs, batch APIs, editing values after accept.
- A `@realdata` package video seek test failed locally (209 s off); this PR touches no video code.

## Next session entry point

Founder testing of custom analytics on local `main` with both new packs; then the analysis frame plan from its spec.

---
type: session
date: 2026-10-22-2122
branch: feat/model-typed-corrections
status: complete
related:
  [
    ../superpowers/specs/2026-10-22-engineering-model-typed-corrections-design.md,
    ../superpowers/plans/2026-10-22-engineering-model-typed-corrections.md,
    2026-10-22-0703-ai-corrections-design.md,
  ]
---

# Engineering model typed corrections: type what is wrong, Send

## What changed

- This PR turns the Corrections tab into one box, "Tell the AI what's wrong", with Send beside it. Part and pin are optional; with neither, the request is model-wide (new `CorrectionTarget` kind `model`, contract row of 22 Oct). A pin on a model with provisional scale or no placement is kept as a view hint and the request goes model-wide.
- Every disabled Send shows its reason on screen (checking the AI, route not ready with Open AI settings, a conversation or send preview open, project cloud permission with Allow for this project, read only, nothing typed).
- Model-wide proposals: at most 20 operations, additions inside the model's built box grown by 10%. Proposals on provisional models carry a note that sizes are model units.
- Send again resends a rejected, proposed or stale request on the same record; history keeps the 8 most recent rounds and drops the oldest (founder, 22 Oct). Older builds 0.21 to 0.24 refuse a run file with a model-wide request (accepted by the founder).
- Fixes: the stuck busy lock (each send step has a 30 s limit, a lock is released only by its own action), a saved request whose send fails stays open with the error shown, a send that did not start no longer says "Sent", and the AI tools still work after the first of several requests is proposed. The correction prompt moved into `@aio/ai`; the scripted test model answers it.
- New e2e `engineering-corrections.spec.ts` drives the loop on a pipeline-built, provisional-scale model; the flow spec's helpers moved to `e2e/engineeringFlow.ts`.

## Why

The founder could never press Send: a request needed a target, and pins are refused on fresh (provisional-scale) models.

## How to test

1. Open a project with one photo or a cloud and run **Create engineering model** through to the review. A fresh model has a provisional scale.
2. In **Model review**, open **Corrections**. The box "Tell the AI what's wrong" is at the top with **Send** and **Save without sending**.
3. With the box empty, Send is off and the line under it says "Type a correction to send." Type "remove the ladder, there isn't one". Send turns on. If it stays off, the line says why, with a button to fix it where there is one.
4. Press **Send**. If the send preview opens in the AI pane, confirm it. The proposal appears with Before and After and a note that the scale is provisional.
5. Switch to **After**: the ladder is gone. Press **Accept**. The model updates and the box is empty for the next correction.
6. Type "the top section is 3 m, not 4", Send, then **Reject**. The request stays selected: type a reply and press **Send again**. A new proposal comes back; the earlier one stays in the request's history.

## Open threads

- Live AI correction quality is unproven until a founder run with a real provider.
- Product call: the permission blocker's Allow for this project grants the project cloud flag without showing the images first (the send preview still runs).
- While the Corrections tab is open the AI pane uses the model-building route; it is restored when the tab closes.
- Model-wide replace is not checked against the box (the spec names additions only); the Before/After shows it.

## Next session entry point

Merge this PR after antenna flagging or before it (independent code); then the founder's live evaluation.

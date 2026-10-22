# Engineering model typed corrections — design

Date: 2026-10-22. Branch: `docs/ai-corrections-design`. Status: approved by the founder in a brainstorming session for write-up; ready for a plan.

## Intent

After the app generates an engineering model, the founder wants to tell the AI what it got wrong and have it fixed: "for the engineering model we need to type and ai should fix". A correction loop already exists (Model review, **Corrections** tab: target a part or a pin, comment, save, **Send to AI**, review a Before/After proposal, accept or reject; `docs/sessions/2026-10-17-model-correction-review.md`). In use the founder could never send: "no matter what i did i couldnt not click send it was always greyed out".

Typical corrections (our assumption; the founder was shown these and did not object):

- "You missed the second platform, add it."
- "Remove the ladder, there isn't one."
- "The top section is 3 m, not 4."

This piece is independent of antenna manual flagging (`2026-10-22-antenna-manual-flagging-design.md`). They touch different code and can be built in parallel.

## Why Send stays greyed out (root cause)

Read-only investigation on `main` at `4a8c2ad60`:

- Send is `disabled={locked || queued.length === 0}` (`apps/desktop/src/renderer/engineer/CorrectionPanel.tsx:442-449`), with `locked = !!p.busy || !!p.readOnly || pending` (`:108`) and `queued` the saved requests with status `open` or `failed` (`:125-127`). The Send button only appears once a request is saved (`:419`).
- **Most likely cause: the request never saves.** Save request (`:370`) needs a target and a comment. "Add something" can only target a pin, and a pin is refused when the model's scale is provisional (`packages/modelling/src/engineer/corrections.ts:59-88`, "A location pin needs a known model scale."). A freshly generated model is provisional whenever no measured or reference height exists (`packages/modelling/src/engineer/assemble/assemble.ts:203-223`), which is the normal case. So the comment can be typed but never saved, and there is never anything to send.
- **Answered requests can't be resent.** Once a request is `proposed`, `accepted` or `rejected` it leaves the queue and the button reads "No requests waiting to send". The only way back to `open` is Save reply, and nothing says so.
- **A stuck busy flag locks the whole panel.** `busy` is the run store's `busy` or the draft's `working` (`CorrectionWorkbench.tsx:235`); when it sticks the only message is "Saving or preparing the correction…".
- **Failed requests enable Send, then fail.** `failed` counts as queued, but `correctionSession.ts:65` accepts only `open` or `proposed`.
- **No reason is shown before the click.** The AI route, a running conversation and the cloud permissions are checked only inside `onSend` (`CorrectionWorkbench.tsx:307-324`) and appear as an error afterwards. There is no tooltip.
- **No test catches it.** No e2e spec drives the Corrections workbench; the only test that clicks Send is `CorrectionPanel.test.tsx`, on a hand-built model with a known scale.

## Goals

1. **One plain box.** "Tell the AI what's wrong": a text field on the model review, with Send next to it. Send turns on as soon as there is text.
2. **Target optional.** Picking a part or dropping a pin narrows the request but is never required. A request with no target is model-wide.
3. **Keep the safety loop.** The AI still only proposes (`propose_model_correction`); the person still compares Before and After and accepts or rejects. Nothing changes the model without that.
4. **Say why before the click.** Any blocker (no AI route ready, a conversation already running, cloud permission missing for attached evidence) shows as a line next to Send, with a link to fix it where there is one (Settings, AI providers). Send is disabled only for a reason that is on screen.
5. **Fix the found bugs.** Requests save on provisional-scale models; an answered request can be sent again (a follow-up or "try again" without the Save reply detour); a busy flag cannot outlive its work; failed requests are resendable or not counted, consistently between panel and session.

## Non-goals

- Changing the generation pipeline or the prompt beyond what model-wide requests need.
- Free direct edits by the AI. It proposes; a person approves.
- Correcting arbitrary imported GLBs. The flow still needs the parametric model and component records.
- Proving live AI correction quality. That needs a paid run and a founder evaluation, after this lands.

## Anti-goals (a failure even if it technically works)

- **A greyed-out button with no reason on screen.**
- **The model changed without a Before/After review.**
- **A typed correction lost** because a save step failed silently.
- **Sending photos, scans or drawings without the existing consent path** (offline-only switch, project cloud flags, send preview).

## Constraints

- Repo rules in `CLAUDE.md` and `CONTRIBUTING.md`. Public repo: no client or site names.
- Reuse the existing session, tools and review: `correctionSession.ts`, `correctionTools.ts`, `packages/ai/src/correction-tool-specs.ts`, `@aio/modelling` transactions, `CorrectionWorkbench.tsx`.

## How it works

- The Corrections tab opens on the text box. Part and pin pickers sit under it as optional "point at something".
- Typing and pressing Send saves the request and sends it in one step. Requests already saved and waiting go with it, as today.
- **Model-wide target (contract change).** `CorrectionTarget` (`packages/schema/src/modelCorrections.ts`) gains a model-wide kind, our call: `{ kind: 'model' }`. `validateTarget` accepts it, and the prompt and `list_model_corrections` show it. Needs a row in `docs/architecture/contract-changes.md` at build time.
- **Pins on provisional models.** Builder's choice: either allow pins in the model's local frame when scale is provisional (marked provisional), or save the request without the pin and keep the pin only as a view hint. Either way the request saves.
- After a proposal is accepted or rejected, the box is ready for the next correction, and a rejected request can be resent with a reply in one step.

## Testing

- **Unit:** the panel enables Send with text and no target; shows each blocker reason; model-wide and provisional-pin requests validate and save; a rejected request can be resent; the busy flag clears on error.
- **E2E (new):** drive the Corrections panel on a model produced by the normal pipeline fixture (provisional scale; see `apps/desktop/e2e/engineering-flow.spec.ts` and `engineering-fixture.py`), with scripted AI tool replies: type "remove the ladder", send, see the Before/After, accept, and check the model changed. Run it the way CI does.
- Live AI quality stays unproven until a founder evaluation with a real provider.

## Left to the builder

- The pin approach on provisional models (above).
- Exact copy and placement of blocker lines, within the existing panel look.
- Whether failed requests are resent automatically or need a click.

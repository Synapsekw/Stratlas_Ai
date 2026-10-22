# Engineering model typed corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Model review's Corrections tab, the person types what is wrong, presses Send, and the AI proposes a fix for Before/After review. This works on a freshly generated (provisional-scale) model, and every disabled Send shows its reason on screen.

**Architecture:** The schema gains a model-wide correction target, `{ kind: 'model' }`. `@aio/modelling` checks model-wide proposals: at most 20 operations, and additions must sit inside the model's bounding box grown by 10%. It also gains a one-step resend that adds a round to the request's history. The renderer panel becomes one text box with Send. The part and pin pickers become optional. The workbench works out the blockers (AI route, a running conversation, cloud permissions) from the live agent session before the click, so `working` covers only local work and cannot outlive it. `@aio/ai` owns the correction prompt, and its scripted test model answers it, which lets an e2e drive the whole loop on a model built by the real pipeline.

**Tech Stack:** TypeScript, zod (`@aio/schema`), React + zustand (renderer), Vitest + Testing Library, Playwright Electron e2e, scripted provider (`packages/ai/src/scripted.ts`).

**Spec:** `docs/superpowers/specs/2026-10-22-engineering-model-typed-corrections-design.md` (founder-approved 22 Oct, including "Decisions after review").

## Global Constraints

- Repo rules: `CLAUDE.md`, `CONTRIBUTING.md`. Public repo: no client, site, tester or person names in code, copy, commits or notes (`node tools/agent/check-public-text.mjs <files>`).
- The AI only proposes (`propose_model_correction`). The model changes only on a person's Accept after Before/After. No AI acceptance path.
- Model-wide proposal: add, remove or replace any components, **at most 20 operations**. **Additions must lie inside the model's bounding box expanded by 10%.**
- Provisional scale: metres in a request apply **in model units only**. The review shows a note that the scale is provisional and points to setting a reference height. No scale change from a correction.
- Resend **reopens the same request record**, re-based on the current model fingerprint. **History appends a new round and keeps the earlier rounds.** No parent link between requests.
- Send is disabled **only for a reason that is on screen**.
- Never send photos, scans or drawings around the existing consent path (offline-only switch, project cloud flags `aiCloudPhotos` / `aiCloudScans` / `aiCloudDrawings`, send preview).
- A typed correction is never lost silently. If the save works and the send fails, the request stays `open`, the comment is kept in the request, and the error is shown.
- Contract change gets a row in `docs/architecture/contract-changes.md` (Task 1).
- `QUADRION_AI_TEST_PROVIDER` and `QUADRION_AI_TEST_SCRIPT` stay dev/test only. Verified on `main` 25e0115a8: both fall under `scrubPackagedEnv`'s `QUADRION_*` drop (`apps/desktop/src/main/packagedEnv.ts`, neither is in `KEPT`; the test asserts the first). `index.ts:743` also requires `!app.isPackaged` and `QUADRION_USER_DATA`. This plan adds no new environment switch.
- Light local test load: e2e with `--workers=1`, one Playwright run at a time, windows off-screen (isolated profile from the fixtures).

## Code facts (verified on 25e0115a8)

- Send: `disabled={locked || queued.length === 0}` (`CorrectionPanel.tsx:442-449`); `locked = busy || readOnly || pending` (`:108`); `queued` = status `open` or `failed` (`:125-127`); the Send button only renders when `requests.length > 0` (`:419`). Save request needs a target (`:370`).
- `validateTarget` (`packages/modelling/src/engineer/corrections.ts:59-88`) refuses a pin when the model is unplaced or its scale is provisional. `assemble.ts:203-223` makes every model provisional unless there is a measured or reference height. **There is no `validateProposal`**: scope rules live in `applyPatch` (`:245-304`) and in `checkPinnedGeometry` (`:161-243`), which `checkBase` (`:110-119`) and `proposeModelCorrection` (`:306-333`) call.
- `ModelCorrection.status` is `open | proposed | accepted | rejected` (`packages/schema/src/modelCorrections.ts:67`). **`failed` exists only in the panel's view type** (`CorrectionPanel.types.ts:18`); the workbench never produces it (`CorrectionWorkbench.tsx:334`). `correctionSession.submission` accepts `open | proposed` (`correctionSession.ts:65`), but `proposeModelCorrection` accepts only `open` (`corrections.ts:313`), so a sent `proposed` request can never be answered.
- `CorrectionPatch` is `.max(32)`; `history` is `.max(8)`; `replies` is `.max(32)`; a record is at most 256,000 characters.
- `rebaseModelCorrection` (`:398-425`) already moves `proposal` into `history` (`rejected` or `superseded`) and refuses `accepted`. Only `onReply` → `session.reply` reaches it.
- `busy` = run store `busy || draft.working` (`CorrectionWorkbench.tsx:318`). `onSend`'s `act` holds `working` across `session.refresh()` (`ai:status` + `ai:project`, no timeout), `prepareCorrectionSubmission` and `session.send`. `AgentSession.send` itself returns quickly: main's `ai:send` starts the run and returns (`packages/ai/src/main.ts:1666-1678`). A hang in `refresh()` or in the cloud-route check therefore keeps the whole panel locked behind "Saving or preparing the correction…", the only text shown.
- The correction prompt is an inline string in `CorrectionWorkbench.tsx:322`. Tool descriptions are in `packages/ai/src/correction-tool-specs.ts` and `packages/ai/src/tools.ts:666-671`.
- The scripted provider answers keywords (`SCRIPT`) and `#tool` directives in the last user text. The scripted `chimney` has a `ladder` part (`scripted.ts:229-234`). The `C:` case of `engineering-flow.spec.ts` (one photo, no PDAL) gives `scale.status === 'provisional'` and `georef.horizontal.status === 'unplaced'`.
- The project schema stays `aio.project/1`, the run file `aio.engineer-run/1`. The last pinned compat snapshot with corrections is `tools/compat/schema-0.21`.

## Decisions this plan makes (left to the builder by the spec)

1. **Pins on provisional or unplaced models:** the pin is kept only as a view hint. When `pinTargetRefusal(model)` is not null, the request is saved with target `{ kind: 'model' }` and the saved `camera` (the view the person picked from). The panel says so under the pin picker before saving. No new field.
2. **Failed sends need a click.** A request whose send failed stays `open`, so it is in the queue and Send takes it next time. `failed` is removed from the view status union. Panel and session share one rule: only `open` is sendable.
3. **Resend at the history cap:** when `history` already holds 8 rounds, or `replies` holds 32, resend is refused with "This request has had 8 answers. Start a new request for the next try." Nothing is trimmed (the spec keeps earlier rounds).
4. **Bounding box rule:** use the base model's built vertices (non-rejected assemblies, `standard` detail). Each half-extent grows by 10% about the box centre. Each half-extent is floored at 5% of the longest half-extent, so a flat model still leaves room. The vertices of every added assembly must lie inside. A model with no geometry refuses model-wide additions.
5. **Save without sending** stays as a quiet button next to Send (enabled whenever there is text and the panel is not locked). A person with no AI route can keep their correction in the run.

## Review Focus

1. **Send pressed with text while the AI route is still `checking`** (app just opened). Expect Send disabled with "Checking the AI connection…" on screen, then enabled, never silently doing nothing. Test: Task 4 `correctionSendBlocker` case `checking`, Task 5 panel case.
2. **Save succeeds, send fails** (route drops between the check and the click, or the cloud flag is off). Expect the request listed as Open with the error, the text box empty, and Send counting it. Test: Task 6 `sendCorrections` "keeps the saved request open when the send fails".
3. **The agent's send preview is dismissed** (the first cloud send in a project stops at the preview). Expect the panel unlocked, the requests still open, and the blocker "Finish or cancel the current AI conversation first." while the preview is open. Test: Task 4 blocker case `preview`, Task 6 "working is false after send returns at a preview".
4. **The model changes between Send and the AI's proposal** (the person accepts another proposal). Expect `propose_model_correction` to fail with the stale message and the request to stay resendable with Send again. Test: Task 2 "a model-wide proposal on a changed model is stale" and Task 4 resend after stale.
5. **A model-wide proposal that adds a duplicate of an existing id, or an addition just outside the grown box.** Expect a clear refusal the AI can read, and no candidate. Test: Task 2 bbox boundary cases.

---

## File structure

| File                                                                          | Responsibility                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/schema/src/modelCorrections.ts`                                     | `CorrectionTarget` model kind, `MODEL_WIDE_PATCH_LIMIT`, stored-record cap |
| `tools/compat/model-corrections-model-target.test.mjs` (new)                  | pins what 0.21 does with a model-wide request                              |
| `packages/modelling/src/engineer/corrections.ts`                              | target checks, model-wide patch rules, bounds, resend                      |
| `packages/ai/src/correctionPrompt.ts` (new)                                   | the correction send text and its lead marker                               |
| `packages/ai/src/correction-tool-specs.ts`, `tools.ts`                        | tool descriptions that mention model-wide requests                         |
| `packages/ai/src/scripted.ts`                                                 | scripted answer to the correction prompt (test model only)                 |
| `apps/desktop/src/renderer/engineer/correctionSession.ts`                     | sendable rule, model-wide submission data, `resend`, `requiredKinds`       |
| `apps/desktop/src/renderer/engineer/correctionBlockers.ts` (new)              | pure `correctionSendBlocker`                                               |
| `apps/desktop/src/renderer/engineer/CorrectionPanel.tsx`, `.types.ts`, `.css` | one box, optional target, blocker line, resend, provisional notes          |
| `apps/desktop/src/renderer/engineer/correctionSend.ts` (new)                  | `sendCorrections`, the bounded send sequence the workbench calls           |
| `apps/desktop/src/renderer/engineer/CorrectionWorkbench.tsx`                  | wiring: live session state, blockers, submit, resend                       |
| `packages/ui/src/i18n/en.ts`                                                  | copy                                                                       |
| `apps/desktop/e2e/engineeringFlow.ts` (new)                                   | helpers moved out of `engineering-flow.spec.ts`                            |
| `apps/desktop/e2e/engineering-corrections.spec.ts` (new)                      | the Corrections panel end to end                                           |

## Execution DAG

```
T1 schema ─────┐
               ├─> T2 modelling ─> T4 session+blockers ─┐
T3 ai prompt ──┼─────────────────────────────────────────┼─> T6 workbench ─> T7 e2e ─> T8 verify
T5 panel ──────┘ (T5 needs nothing; joins at T6) ────────┘
```

| Batch | Tasks (one message, in parallel) | Shared files                  |
| ----- | -------------------------------- | ----------------------------- |
| 1     | T1, T3, T5                       | none (T5 alone edits `en.ts`) |
| 2     | T2                               | —                             |
| 3     | T4                               | —                             |
| 4     | T6                               | —                             |
| 5     | T7                               | —                             |
| 6     | T8                               | —                             |

Dependencies: T2 ← T1. T4 ← T2. T6 ← T3, T4, T5. T7 ← T6. T8 ← T7.

**Critical path:** T1 → T2 → T4 → T6 → T7 → T8.

Packages per task: T1 `@aio/schema` + `tools/compat` + docs; T2 `@aio/modelling`; T3 `@aio/ai`; T4 `@aio/desktop` (renderer/engineer); T5 `@aio/desktop` + `@aio/ui` (i18n); T6 `@aio/desktop` + `@aio/ui` (i18n); T7 `@aio/desktop` e2e; T8 all.

Unit tests run per package: `pnpm vitest run <path> --retry=0` from the worktree root.

---

### Task 1: Model-wide target in the schema (contract change)

**Files:**

- Modify: `packages/schema/src/modelCorrections.ts`
- Test: `packages/schema/src/modelCorrections.test.ts`
- Create: `tools/compat/model-corrections-model-target.test.mjs`
- Modify: `docs/architecture/contract-changes.md` (append row)

**Interfaces:**

- Produces: `CorrectionTarget` union adds `z.object({ kind: z.literal('model') }).strict()`; `export const MODEL_WIDE_PATCH_LIMIT = 20`; `ModelCorrection` superRefine refuses `target.kind === 'model'` with `proposal.patch.length > 20` (path `['proposal','patch']`), and the same for each `history[i].proposal`.

- [ ] **Step 1: Write the failing tests** in `modelCorrections.test.ts`:

```ts
it('accepts a model-wide target and refuses extra keys on it', () => {
  expect(CorrectionTarget.safeParse({ kind: 'model' }).success).toBe(true);
  expect(CorrectionTarget.safeParse({ kind: 'model', partId: 'x' }).success).toBe(false);
});
it('caps a model-wide proposal at 20 operations, a part proposal stays at 32', () => {
  const ops = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'remove', id: `p${i}` }));
  expect(ModelCorrection.safeParse(record({ kind: 'model' }, ops(20))).success).toBe(true);
  expect(ModelCorrection.safeParse(record({ kind: 'model' }, ops(21))).success).toBe(false);
  expect(ModelCorrection.safeParse(record({ kind: 'part', partId: 'p0' }, ops(21))).success).toBe(
    true,
  );
});
```

`record(target, patch)` is a local helper building a valid `proposed` record (copy the existing fixture in this file).

- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/modelCorrections.test.ts --retry=0`. Expected: FAIL.
- [ ] **Step 3: Implement** the union member, the constant and the superRefine checks in `modelCorrections.ts`. Export `MODEL_WIDE_PATCH_LIMIT` from the package index (`packages/schema/src/index.ts`, next to the other model correction exports).
- [ ] **Step 4: Compat test** `tools/compat/model-corrections-model-target.test.mjs`, in the style of `pinned-media-additive.test.mjs`, against `./schema-0.21/index.mjs`:
  - `it('0.21 refuses a run holding a model-wide request (documented)')`: `current.EngineerRun.safeParse(run).success === true` and `v021.EngineerRun.safeParse(run).success === false`.
  - `it('runs without model-wide requests read the same in 0.21')`: the same run with a part target parses in both.
- [ ] **Step 5: Run** `pnpm vitest run packages/schema/src/modelCorrections.test.ts tools/compat/model-corrections-model-target.test.mjs --retry=0`. Expected: PASS.
- [ ] **Step 6: Contract row.** Append to `docs/architecture/contract-changes.md`:

```markdown
| 2026-10-22 | Engineering model typed corrections: `CorrectionTarget` gains `{ kind: 'model' }` (a model-wide request; no part or pin). New `MODEL_WIDE_PATCH_LIMIT` (20): a stored `ModelCorrection` with a model-wide target refuses a proposal, current or in `history`, of more than 20 operations (part and pin targets keep the 32 of `CorrectionPatch`). Modelling rule, not a stored shape: a model-wide addition must lie inside the model's built bounding box grown by 10%. Resend reopens the same record: `history` gains a round (`rejected` or `superseded`), earlier rounds kept, at most 8 as before. No shape change to history, replies or status. No schema version bump (`aio.project/1`, `aio.engineer-run/1` unchanged: the change is additive for this version). Compatibility: 0.21 to 0.24 refuse a run file holding a model-wide request (`tools/compat/model-corrections-model-target.test.mjs`); runs without one read as before. |
```

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/modelCorrections.ts packages/schema/src/modelCorrections.test.ts packages/schema/src/index.ts tools/compat/model-corrections-model-target.test.mjs docs/architecture/contract-changes.md
git commit -m "feat(schema): add a model-wide correction target with a 20-operation cap"
```

### Task 2: Model-wide rules, pin refusal and resend in `@aio/modelling`

**Files:**

- Modify: `packages/modelling/src/engineer/corrections.ts`, `packages/modelling/src/index.ts` (exports near `:150`)
- Test: `packages/modelling/src/engineer/corrections.test.ts`

**Interfaces:**

- Consumes: `CorrectionTarget` model kind and `MODEL_WIDE_PATCH_LIMIT` (Task 1).
- Produces:
  - `pinTargetRefusal(model: ProcModel): string | null`. It returns the existing pin messages (unplaced, provisional scale, transform). `validateTarget` calls it for pins.
  - `modelCorrectionBounds(model: ProcModel): { min: [number, number, number]; max: [number, number, number] } | null`. It returns the grown box (Decision 4), or null with no geometry.
  - `resendModelCorrection(model: ProcModel, request: ModelCorrection, reply: string | undefined, now: string): Promise<ModelCorrection>`. It appends the reply when one is given, then rebases (as `rebaseModelCorrection`). It refuses `accepted`, and refuses with `RESEND_LIMIT_MESSAGE` when history has 8 rounds and a proposal would be added, or replies has 32 and a reply is given.
  - `export const RESEND_LIMIT_MESSAGE = 'This request has had 8 answers. Start a new request for the next try.'`

- [ ] **Step 1: Failing tests** (use the existing `model()` and `radio()` fixtures; add `modelRequest(m)` = `createModelCorrection(m, { id: 'fix-m', target: { kind: 'model' }, comment: 'remove the radio' }, NOW)`):
  - `it('saves a model-wide request on a provisional, unplaced model')`: set `m.scale = { status: 'provisional' }` and georef unplaced. `createModelCorrection` resolves with `status: 'open'`. A pin request on the same model rejects with `'A location pin needs a known model placement and coordinate frame.'`. `pinTargetRefusal(m)` returns that same string.
  - `it('lets a model-wide proposal remove, replace and add anywhere inside the grown box')`: a single patch `[{op:'remove',id:'radio-1'}, {op:'replace', assembly: changed()}, {op:'add', assembly: inside}]` proposes. `candidate` holds the edits.
  - `it('refuses more than 20 model-wide operations')`: 21 ops reject. The message contains `'at most 20'`.
  - `it('refuses a model-wide addition outside the bounding box grown by 10%')`: let `b = modelCorrectionBounds(m)`. An addition centred at `b.max[0] + 0.01` rejects with `'Added geometry lies outside the model bounds.'`. One fully inside proposes.
  - `it('grows each half-extent by 10% with a 5% floor of the longest')`: for a known fixture box `min [-1,0,-1] max [1,10,1]` (half-extents 1, 5, 1), expect x half `1.1`, y half `5.5`, z half `1.1`. For a flat box with y half-extent 0, expect y half `0.25` (5% of 5).
  - `it('a model-wide proposal on a changed model is stale')`: change the model after `createModelCorrection`. `proposeModelCorrection` rejects with the stale message.
  - `it('resend reopens a rejected request with a reply and keeps every round')`: propose, reject, `resendModelCorrection(m, r, 'try the other ladder', LATER)` → `status 'open'`, `history.length === 1`, `history[0].disposition === 'rejected'`, `replies.at(-1).comment === 'try the other ladder'`, `baseFingerprint === await modelCorrectionFingerprint(m)`. A second propose, then resend without a reply, gives `history.length === 2`, `history[1].disposition === 'superseded'`.
  - `it('refuses resend past eight rounds and on accepted requests')`: 8 rounds of history, then a proposal, then resend rejects with `RESEND_LIMIT_MESSAGE`. Accepted rejects with `'Create a new request to change an accepted correction.'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/modelling/src/engineer/corrections.test.ts --retry=0`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** `validateTarget`: `kind: 'model'` returns. Move the pin checks into `pinTargetRefusal`. `applyPatch`: a `model` target allows every op. More than `MODEL_WIDE_PATCH_LIMIT` ops throws `'A model-wide correction may change at most 20 components.'`. After `ProcModel.parse`, each added assembly is checked by `checkWithinBounds(candidate, a, bounds)`. That function builds the assembly with `MeshSink(SEGMENTS.standard)` and `buildAssembly(sink, a, ctxFor(model))`, as `checkPinnedGeometry` does. It throws `'Added geometry lies outside the model bounds.'` for any vertex outside (tolerance 1e-6), and `'The correction must produce visible geometry.'` for zero vertices. Bounds come from the **base** model (`model`, not `candidate`), built the same way over `a.status !== 'rejected'`. Null bounds with an addition throws `'A model-wide addition needs a model with visible geometry.'`. `resendModelCorrection` composes `replyToModelCorrection` and `rebaseModelCorrection` after the limit checks. Export the three new names and the message from `packages/modelling/src/index.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS, existing cases included.
- [ ] **Step 5: Commit** `feat(modelling): check model-wide corrections and resend a request in one step`.

### Task 3: Correction prompt, tool descriptions and the scripted answer in `@aio/ai`

**Files:**

- Create: `packages/ai/src/correctionPrompt.ts`, `packages/ai/src/correctionPrompt.test.ts`
- Modify: `packages/ai/src/correction-tool-specs.ts`, `packages/ai/src/correction-tool-specs.test.ts`, `packages/ai/src/tools.ts:666-671`, `packages/ai/src/scripted.ts`, `packages/ai/src/scripted.test.ts`, `packages/ai/src/index.ts`, `packages/ai/README.md` (the `scripted.ts` row: mention the correction answer)

**Interfaces:**

- Produces:
  - `export const CORRECTION_PROMPT_LEAD = 'Review these submitted engineering correction requests.'`
  - `export function correctionPrompt(submitted: string): string`: the lead, the current text (from `CorrectionWorkbench.tsx:322`), then these rules: "A request with target kind model applies to the whole model: you may add, remove or replace any components, at most 20 operations in one proposal, and additions must lie inside the model bounds given in the data. When scale is provisional, dimensions in a comment are model units, not measured metres: say so in the explanation." It ends with `\nSubmitted review data:\n${submitted}`.
  - Scripted, test model only: `export function scriptedCorrectionTurn(prompt: LanguageModelV4Prompt): { kind: 'tool'; tool: string; input: Record<string, unknown> } | null`. When the last user text starts with `CORRECTION_PROMPT_LEAD`, it parses the JSON after `Submitted review data:\n`. Turn 0: `list_model_corrections {}`. Turn 1: for the first request whose comment contains `remove the ladder` and the first `components` entry with `kind === 'ladder'`, `propose_model_correction { requestId, proposal: { explanation: 'Scripted: the ladder is removed as the reviewer asked.', patch: [{ op: 'remove', id }] } }`. Otherwise null, and the text reply follows. `scriptedTurn` calls it first.

- [ ] **Step 1: Failing tests:**
  - `correctionPrompt.test.ts`: `correctionPrompt('{}')` starts with `CORRECTION_PROMPT_LEAD`, contains `'at most 20 operations'`, `'model units'`, `'propose_model_correction'`, and ends with `'Submitted review data:\n{}'`.
  - `scripted.test.ts` `describe('scripted model corrections')`: a prompt built from `correctionPrompt(JSON.stringify({ requests: [{ id: 'fix-1', target: { kind: 'model' }, comment: 'remove the ladder' }], components: [{ id: 'ladder-1', kind: 'ladder' }] }))` gives `list_model_corrections` first. After one tool result it gives `propose_model_correction` with `input.requestId === 'fix-1'` and `input.proposal.patch` equal to `[{ op: 'remove', id: 'ladder-1' }]`. The input passes `CorrectionProposalInput.parse`. A prompt without the lead gives `null`.
  - `correction-tool-specs.test.ts`: the `propose_model_correction` description contains `'whole model'` and `'20'`. The `list_model_corrections` description contains `'model-wide'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/ai/src/correctionPrompt.test.ts packages/ai/src/scripted.test.ts packages/ai/src/correction-tool-specs.test.ts --retry=0`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the prompt file. Export `CORRECTION_PROMPT_LEAD` and `correctionPrompt` from `index.ts`. Descriptions: propose becomes "Replace/remove only the selected component, add near a model-local pin, or, for a model-wide request, add, remove or replace any components of the whole model (at most 20 operations, additions inside the model bounds)…" (keep the rest). Update the short `tools.ts` lines to match. Add the scripted branch.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): move the correction prompt into @aio/ai and let the scripted model answer it`.

### Task 4: Session sendable rule, model-wide data, resend and blockers

**Files:**

- Modify: `apps/desktop/src/renderer/engineer/correctionSession.ts`, `correctionSession.test.ts`
- Create: `apps/desktop/src/renderer/engineer/correctionBlockers.ts`, `correctionBlockers.test.ts`

**Interfaces:**

- Consumes: `resendModelCorrection`, `modelCorrectionBounds` (Task 2).
- Produces:
  - `export const isSendable = (status: ModelCorrection['status']): boolean => status === 'open'`. `submission` refuses any non-open request with `'Only open correction requests can be sent.'`.
  - `submission(ids).data` gains `scale: model.scale?.status ?? 'provisional'` and, when any request has `target.kind === 'model'`, `components` = all assemblies plus `bounds: modelCorrectionBounds(model)`.
  - `export function requiredKinds(run: EngineerRun, model: ProcModel, requests: Pick<ModelCorrection, 'target' | 'evidence'>[]): { drawings: boolean; scans: boolean; photos: boolean }`. It is the current `required` logic, moved out; `submission` uses it.
  - Session method `resend(id: string, reply?: string): Promise<void>`: `current(true)`, `resendModelCorrection(ctx.model, find(ctx,id), reply, now())`, then `save`.
  - `correctionBlockers.ts`:

```ts
export type CorrectionBlocker =
  | { kind: 'checking' }
  | { kind: 'route'; message: string } // availability disabled; fix = open Settings > AI
  | { kind: 'conversation' } // agent busy or preview open
  | { kind: 'permission'; missing: ('photos' | 'scans' | 'drawings')[] } // fix = project settings
  | { kind: 'readOnly' };
export function correctionSendBlocker(input: {
  readOnly: boolean;
  availability: Availability; // from @aio/ai SessionState
  agentBusy: boolean;
  preview: boolean;
  required: { photos: boolean; scans: boolean; drawings: boolean };
  allowed: { photos: boolean; scans: boolean; drawings: boolean };
}): CorrectionBlocker | null;
```

The order is readOnly, checking, route, conversation, permission. Permission applies only when `availability.status === 'ready' && availability.cloud`, which mirrors `permitted` in `correctionTools.ts`.

- [ ] **Step 1: Failing tests:**
  - `correctionSession.test.ts`: `it('sends only open requests')`: `submission([proposedId])` throws `'Only open correction requests can be sent.'`. `it('sends the whole model and its bounds for a model-wide request')`: `data.components.length === model.assemblies.length`, `data.bounds` not null, `data.scale === 'provisional'`. `it('resend reopens a rejected request with a reply')`: status open, a history round, the reply saved through `ctx.save`. `it('resend after a stale proposal rebases on the current model')`.
  - `correctionBlockers.test.ts`: one `it` per kind with exact expected objects. `null` when ready and local (`cloud: false`) even if photos are not allowed. `permission` lists `['photos']` when cloud, `required.photos` and not allowed. `checking` wins over `conversation`. `readOnly` wins over all.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/engineer/correctionSession.test.ts apps/desktop/src/renderer/engineer/correctionBlockers.test.ts --retry=0`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** again. Expected: PASS. Also `pnpm vitest run apps/desktop/src/renderer/engineer/correctionTools.test.ts --retry=0` stays green.
- [ ] **Step 5: Commit** `fix(desktop): send only open corrections, add model-wide data, resend and blockers`.

### Task 5: The panel: one box, optional target, reasons on screen

**Files:**

- Modify: `apps/desktop/src/renderer/engineer/CorrectionPanel.tsx`, `CorrectionPanel.types.ts`, `CorrectionPanel.css`, `CorrectionPanel.test.tsx`
- Modify: `packages/ui/src/i18n/en.ts` (the `eng.correction.*` block, near `:3874-3960`)

**Interfaces (panel-local; Task 6 wires them):**

- `CorrectionTargetView` adds `| { kind: 'model' }`. `CorrectionRequestView.status` drops `'failed'`.
- New props: `blocker?: { message: string; fix?: { label: string; onClick: () => void } }`; `busyReason?: 'saving' | 'modelling' | 'sending'`; `pinNote?: string` (shown under the pin picker when a pin will only be a view hint); `scaleProvisional?: boolean`; `onSubmit: (r: { target?: CorrectionTargetView; comment: string; evidenceIds: string[]; send: boolean }) => Action` (replaces `onCreate`; `send: false` is Save without sending); `onResend: (requestId: string, reply?: string) => Action`.
- Behaviour:
  - The composer is open by default and shows the text box first ("Tell the AI what's wrong"). Part and pin pickers sit in a collapsed "Point at something (optional)" group. With no part and no pin, the target is omitted (model-wide).
  - Send is always rendered. It is enabled when `!locked && !blocker && (comment.trim() || queued.length) && comment.length <= 4000`, with `queued = requests.filter(r => r.status === 'open')`. Its label is "Send" when only the typed text goes, otherwise `eng.correction.send` with the count (typed text + queued).
  - Every disabled state has a visible line, which Send references through `aria-describedby`. Reasons: busy (`eng.correction.busy.saving|modelling|sending`), readOnly, blocker message (with its fix button), and empty (`eng.correction.typeFirst`).
  - Selected `rejected` or `proposed` request: the reply box and **Send again** (`onResend(id, reply || undefined)`), enabled under the same blocker rule. Save reply stays as a quiet button.
  - With `scaleProvisional`, the review section shows `eng.correction.scaleProvisional` next to Before/After.
  - After a successful submit, the text box clears and the notice reads `eng.correction.sent` (send) or `eng.correction.saved` (save).
- Copy (en.ts, new or changed keys): `eng.correction.request`: "Tell the AI what's wrong"; `eng.correction.commentPlaceholder`: "For example: remove the ladder, there isn't one"; `eng.correction.pointAt`: "Point at something (optional)"; `eng.correction.wholeModel`: "Whole model"; `eng.correction.sendNow`: "Send"; `eng.correction.saveOnly`: "Save without sending"; `eng.correction.typeFirst`: "Type a correction to send."; `eng.correction.busy.saving`: "Saving the correction…"; `eng.correction.busy.modelling`: "The model is being built or saved. Send is available when it finishes."; `eng.correction.busy.sending`: "Handing the request to the AI…"; `eng.correction.blocker.checking`: "Checking the AI connection…"; `eng.correction.blocker.conversation`: "Finish or cancel the current AI conversation first."; `eng.correction.blocker.permission`: "This project keeps {kinds} on this computer. Allow cloud AI for them in project settings, or choose a local model."; `eng.correction.blocker.openSettings`: "Open AI settings"; `eng.correction.blocker.openProject`: "Open project settings"; `eng.correction.pinHintOnly`: "This model has no known scale or placement yet: the pin is kept as a view hint and the request goes to the whole model."; `eng.correction.scaleProvisional`: "The scale is provisional: sizes in this proposal are model units, not measured metres. Set a reference height to fix the scale."; `eng.correction.resend`: "Send again"; `eng.correction.sent`: "Sent. The proposal appears here for Before and After review."; `eng.correction.resendLimit`: (message text = `RESEND_LIMIT_MESSAGE`). Remove `eng.correction.status.failed`.

- [ ] **Step 1: Failing tests** in `CorrectionPanel.test.tsx` (existing render helper, model with no target selected):
  - `it('enables Send with text and no target, and submits a model-wide request that is sent')`: type "remove the ladder", click Send, expect `onSubmit` called with `{ comment: 'remove the ladder', evidenceIds: [], send: true }` and `target` undefined.
  - `it.each(['busy', 'readOnly', 'blocker', 'empty'])('a disabled Send names its reason on screen: %s')`: Send is disabled, and `getByRole('button', { name: 'Send' })` has an accessible description equal to the expected visible text, for example `'Checking the AI connection…'` for blocker `checking`.
  - `it('shows the blocker fix and calls it')`: blocker with fix "Open AI settings"; clicking it calls `fix.onClick`.
  - `it('does not count rejected or proposed requests as waiting')`: requests open+rejected, typed text empty → label `'Send 1 request to AI'`.
  - `it('resends a rejected request with its reply in one step')`: select it, type a reply, click Send again → `onResend('fix-1', 'try the other ladder')`. With an empty reply → `onResend('fix-1', undefined)`.
  - `it('says a pin is only a view hint when pinNote is set')` and `it('notes a provisional scale in the review')`.
  - `it('keeps the text when submit fails')`: `onSubmit` rejects; the textarea still holds the text and the error shows (`role=alert`).
  - Update the existing tests that used `onCreate` and "Save request" to `onSubmit` / "Save without sending".
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/engineer/CorrectionPanel.test.tsx --retry=0`. Expected: FAIL.
- [ ] **Step 3: Implement** in the panel and types. Keep the existing look (`eng-correction-*` classes). Load `impeccable` and `frontend-design` before touching the layout. Follow `CorrectionPanel.css` for the blocker line (reuse `.eng-correction-hint`; add `.eng-correction-blocker` only for the fix button row).
- [ ] **Step 4: Run** again plus `pnpm vitest run packages/ui/src/i18n --retry=0`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): one correction box with Send and the reason when it is off`.

### Task 6: Workbench wiring and the stuck-busy fix

**Files:**

- Create: `apps/desktop/src/renderer/engineer/correctionSend.ts`, `correctionSend.test.ts`
- Modify: `apps/desktop/src/renderer/engineer/CorrectionWorkbench.tsx`, `correctionDraft.ts`, `correctionDraft.test.tsx`
- Modify: `packages/ui/src/i18n/en.ts` only if a key from Task 5 needs a variant (avoid when possible)

**Interfaces:**

- Consumes: `correctionPrompt` (T3); `isSendable`, `requiredKinds`, `session.resend` (T4); `correctionSendBlocker` (T4); `pinTargetRefusal` (T2); panel props (T5).
- Produces: `sendCorrections(deps: { ids: string[]; prepare: (ids: string[]) => Promise<string>; send: (text: string) => Promise<void>; timeoutMs?: number }): Promise<void>`. It runs `prepare`, then `send(correctionPrompt(submitted))`. Each await is bounded by `timeoutMs` (default 30,000), and a timeout throws `'The AI did not answer in time. Your request is saved; press Send to try again.'`.
- `correctionDraft`: `begin()` returns a token `number | false`; `end(token)` clears `working` only for its own token. A workbench mount resets a `working` flag whose token's action has settled (module-level `inFlight` set). This keeps a remount from inheriting a stale flag.

- [ ] **Step 1: Reproduce first** (superpowers:systematic-debugging). In `correctionDraft.test.tsx` / `correctionSend.test.ts`, show the lock with today's code: a `refresh` that never resolves leaves `working === true`. Record the finding in the commit body. If a different root cause turns up, fix that one too and add its test.
- [ ] **Step 2: Failing tests:**
  - `correctionSend.test.ts`: `it('times out a hung prepare and rejects with the saved-request message')` (fake timers, advance 30,000 ms). `it('sends the correction prompt with the submitted data')` (`send` is called with a string starting with `CORRECTION_PROMPT_LEAD` and ending with the prepared JSON). `it('keeps the saved request open when the send fails')`: drive the workbench-level submit through a small harness with a fake session whose `send` rejects. Expect `create` called once, no reject or resend, and the error rethrown.
  - `correctionDraft.test.tsx`: `it('working clears after an action that throws')`, `it('a stale token cannot clear a newer action')`, `it('a remount clears working left by a settled action')`, `it('working is false after send returns at a preview')`.
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/renderer/engineer/correctionSend.test.ts apps/desktop/src/renderer/engineer/correctionDraft.test.tsx --retry=0`. Expected: FAIL.
- [ ] **Step 4: Implement the workbench.**
  - Subscribe to the agent session with `useSyncExternalStore(session.subscribe, session.getState)` (as `AgentPane.tsx:60`). Call `setAgentTask('build')` and `void session.refresh()` on mount and on window focus, **outside** `working`.
  - Compute `blocker = correctionSendBlocker({ readOnly, availability, agentBusy: state.busy, preview: !!state.preview, required: requiredKinds(run, model, [...queuedRequests, draftEvidenceAsRefs]), allowed: manifest flags })`. Map it to copy and fixes: route → `shell.getState().openSettingsPage('ai')`; permission → the project settings page that holds `aiCloud*` (find the existing opener used by `EvidencePreview`'s "Allow for this project" and reuse it).
  - `busyReason`: `'saving'` while `draft.working` holds for a save, `'sending'` while for a send, `'modelling'` when only the run store is busy.
  - `onSubmit`: build the target from the given view: none → `{ kind: 'model' }`; part → as today; pin → as today unless `pinTargetRefusal(model)`, then `{ kind: 'model' }` with the camera. Pass `pinNote` = the hint key when `targetMode === 'pin' && pinTargetRefusal(model)`. Run `modelCorrections.create(...)` under `act`. When `send`, call `sendCorrections({ ids: [created.id, ...open ids], prepare: prepareCorrectionSubmission, send: (text) => session.send(text) })` under its own `act`, then `showBench('review')` as today.
  - `onResend(id, reply)`: `act(() => modelCorrections.resend(id, reply))`, then send `[id]` as above.
  - `scaleProvisional = !model.scale || model.scale.status === 'provisional'` (the enum is `measured | reference | provisional`, `packages/schema/src/assemblies.ts:402`), the same test `validateTarget` uses.
  - Drop the inline prompt string and the `refresh()` / `availability` checks inside `onSend`. The blocker covers them before the click. The tools still re-check permissions at call time (`correctionTools.ts` `permitted`), so the consent path keeps its own guard.
- [ ] **Step 5: Run** the Step 3 command plus `pnpm vitest run apps/desktop/src/renderer/engineer --retry=0`. Expected: PASS.
- [ ] **Step 6: Typecheck** `pnpm -F @aio/desktop typecheck`. Expected: no errors.
- [ ] **Step 7: Commit** `fix(desktop): send typed corrections in one step and never leave the panel locked`.

### Task 7: E2E on a pipeline-generated, provisional-scale model

**Files:**

- Create: `apps/desktop/e2e/engineeringFlow.ts`. Move `writeProject`, `openProject`, `setupStep`, `startSetup`, `confirmSends`, `runToReview`, `openReview`, `readModel`, `readRun`, `agent`, `approveAgent`, `nextOpenDialog`, `PROJECT`, `FIXTURE` and `ENV` out of `engineering-flow.spec.ts` unchanged, with `writeProject` taking the project id.
- Modify: `apps/desktop/e2e/engineering-flow.spec.ts` (import the helpers; no behaviour change)
- Create: `apps/desktop/e2e/engineering-corrections.spec.ts`

**Spec:** `engineering-corrections.spec.ts`, `engTest.use({ appEnv: { ...PIPELINE_ENV, QUADRION_AI_TEST_PROVIDER: '1' } })`, skip without pipeline Python (same guard as the flow spec), **no PDAL needed** (photo-only path, as case `C:`), network guard on.

```ts
engTest(
  'typed correction on a provisional model: send, compare, accept',
  async ({ app, eng, win }) => {
    test.setTimeout(300_000);
    // C path: one photo, fast detail → provisional scale, unplaced
    // ... openProject, palette "Create engineering model", add the photo, setupStep 1, fast, startSetup, runToReview
    const before = await readModel(eng.dir);
    expect(before.scale?.status).toBe('provisional');
    const ladder = before.assemblies.find((a) => a.kind === 'ladder');
    expect(ladder).toBeDefined();
    await openReview(win);
    await win.getByRole('button', { name: 'Corrections' }).click();
    const box = win.getByRole('textbox', { name: "Tell the AI what's wrong" });
    await box.fill('remove the ladder, there is not one');
    const send = win.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await approveAgent(win, 'propose_model_correction'); // confirms the send preview first
    await expect(
      win.getByText('Scripted: the ladder is removed as the reviewer asked.'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(win.getByText(/scale is provisional/)).toBeVisible();
    await win.getByRole('button', { name: 'After' }).click();
    await win.getByRole('button', { name: 'Accept' }).click();
    await expect
      .poll(async () => (await readModel(eng.dir)).assemblies.some((a) => a.id === ladder!.id), {
        timeout: 60_000,
      })
      .toBe(false);
    const run = await readRun(eng.dir);
    expect(run.corrections?.[0]).toMatchObject({ status: 'accepted', target: { kind: 'model' } });
    // the box is ready for the next one
    await expect(box).toHaveValue('');
  },
);

engTest(
  'Send names its reason while a conversation is running, and a rejected request resends',
  async (/* … */) => {
    // after runToReview: type text; open the agent's send preview with ask(win, 'hello') (first cloud send stops at preview)
    // expect Send disabled and 'Finish or cancel the current AI conversation first.' visible; cancel the preview; Send enabled
    // send, approve propose, Reject → select the request → reply 'try again' → 'Send again' → approve → a proposal shows again
    // run file: corrections[0].history.length === 1, history[0].disposition === 'rejected', replies.at(-1).comment === 'try again'
  },
);
```

`readRun`'s `RunFile` type gains `corrections?: { status: string; target: { kind: string }; history: { disposition: string }[]; replies: { comment: string }[] }[]`.

- [ ] **Step 1: Extract the helpers** and run the flow spec's `C:` case only, the CI way: `npx playwright test e2e/engineering-flow.spec.ts -g "C:" --workers=1` (with the env below). Expected: PASS. A and D skip locally without PDAL; CI runs them.
- [ ] **Step 2: Write the new spec** and run it the CI way, expecting FAIL before Task 6 is in the branch, or PASS on top of it. Name the step that fails.
- [ ] **Step 3: Run the CI way**, from `apps/desktop`, PowerShell. The worktree has no `python/.venv`, so point at the main checkout's venv (memory: e2e in a worktree):

```powershell
pnpm demo:change --quick
pnpm demo:build --quick
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
npx playwright test e2e/engineering-corrections.spec.ts e2e/engineering-flow.spec.ts --workers=1
```

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`, and both new cases PASS. Then `--repeat-each=3` on the new spec to surface timing problems. After the run, check that the shared editable `aio-pipelines` import path still points at the main checkout (memory: never junction the main venv).

- [ ] **Step 4: Commit** `test(desktop): drive typed corrections end to end on a pipeline-built model`.

### Task 8: Whole-branch verification

- [ ] **Step 1:** `pnpm check` from the worktree root. Expected: lint, format, typecheck and unit tests green.
- [ ] **Step 2:** Independent review (superpowers:requesting-code-review, strongest model) of the branch diff against the spec's anti-goals: no greyed Send without a reason; no model change without Before/After; no lost text; consent path intact (`correctionTools.ts` `permitted` unchanged or stricter).
- [ ] **Step 3:** `node tools/agent/check-public-text.mjs` on every added doc and on the new spec file.
- [ ] **Step 4:** Commit fixes from the review, if any (`fix(desktop): …`).

## How to test (for the founder, after merge)

1. Open a project with a cloud or one photo and run **Create engineering model** to the review. A fresh model has a provisional scale.
2. In **Model review**, open **Corrections**. The box "Tell the AI what's wrong" is at the top, with **Send** beside it.
3. With the box empty, Send is off and says "Type a correction to send." Type "remove the ladder, there isn't one". Send turns on. If it stays off, the line under it says why (for example "Open AI settings").
4. Press **Send**. Confirm the send preview if the agent asks. The AI's proposal appears with Before and After and a note that the scale is provisional.
5. Switch to **After**: the ladder is gone and highlighted in the list. Press **Accept**. The model updates, and the box is empty for the next correction.
6. Try "the top section is 3 m, not 4", then **Reject**. Select the request, type a reply, press **Send again**. A new proposal comes back. The earlier one is kept in the request's history.

# Classes on the fly and Accept all Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution is decided: subagent-driven, one parallel batch at a time per the Execution DAG below.

**Goal:** Let an inspector or the AI add a class while working, edit and delete classes in a Classes panel (with a class library on this computer), and accept or reject every detection on screen in one undoable action.

**Architecture:** Pure catalogue operations live in `@aio/annotate` (`catalogueOps.ts`, `palette.ts`, `severityMap.ts`), the issue editor gains two one-step bulk commands (`createMany`, `reassignClass`), and the detection review reducer gains three batch actions. Every catalogue change is one `builder:updateClasses` write in main (validated, backed up, journaled like `builder:updateCapture`); the renderer keeps a small class-edit history and a notice with Undo. The class library is a userData JSON store behind three IPC channels. UI pieces (shared `NewClassRow`, Classes settings page, Inspector create-class, Accept all, wizard checklist, `propose_class` tool) call one renderer module, `renderer/classes/store.ts`.

**Tech Stack:** TypeScript, React 19 (`createRoot` + `act` component tests, no testing-library), zustand, zod (`@aio/schema`), Vitest, Electron main with `handle()` IPC, Playwright e2e.

**Spec:** `docs/plans/2026-10-15-class-editing-design.md` (approved by the founder on 15 Oct 2026). Executors read both documents.

## Global Constraints

- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\class-editing` on branch `feat/class-editing`. Never edit the main checkout, never run a bare `git stash`, stage by path (never `git add -A`), never `--no-verify`.
- No schema change to `IssueClass` or `ClassCatalogue`; new contracts are additive only (four IPC channels, `LibraryClass`, optional detection field `suggestedNew`).
- New classes live in the project; the class library is `userData/class-library.json` with `{ classes: { label, color, hotkey?, severityLevels? }[] }` (plus a `schema` tag `aio.classLibrary/1`).
- Nothing is created silently: the AI proposes, a person confirms (Create class button, or Approve on the agent card).
- Creating a class mid-work asks only for the name.
- Deleting a used class asks which class takes over its issues and detections.
- Accept all and Reject all act on the filtered list on screen, and each is one undo step.
- Hotkey: one character, not `a` or `u` (reserved in the sighting picker), not used by another class (case-insensitive).
- Class id: slug of the label, unique across all catalogues (`-2`, `-3` suffixes). A label matching an existing class (case-insensitive) returns that class.
- Target catalogue for a new class: the first catalogue with `assetType: 'road'`, else the first catalogue, else a new `{ id: 'classes', name: 'Classes', assetType: 'asset' }`.
- Default severity model for a new class: the one most classes use, else `severityModels[0]`.
- Write failure: the notice shows the error and the renderer keeps the previous manifest.
- Read-only project (package or the annotate read-only flag): "+ New class" and the panel are disabled with the reason.
- User-facing text: no emoji, no em or en dashes (`i18n.test.ts` and `tools.test.ts` check some of it). Session notes and docs carry no client, site or person names.
- Team sync stays whole-catalogue last-writer-wins (`project` record, lww-field); recorded in `docs/KNOWN-LIMITS.md`.
- `pnpm check` green on the branch before hand-off. E2E: `--workers=1`, windows off-screen (the fixtures do this), CI-like environment (see Task 14).

## Review Focus

1. **A class is deleted right after its issues were moved, before the issue saver has written `issues.json`** (600 ms debounce): main checks `issues.json` and would refuse. Expected: the delete succeeds because the renderer flushes the saver first. Test: Task 6, "flushes the issue saver before writing the catalogue".
2. **Undo of "create class" after issues already use that class**: expected the write is refused with a clear sentence, the class stays, the notice shows the error. Test: Task 4, "refuses to remove a class that issues.json still uses"; Task 6, "keeps the manifest and reports when the write is refused".
3. **Accept all on a mixed list** (drafts with and without class or severity, accepted and rejected ones in an "all" filter): expected only drafts that pass are accepted, the rest are counted as skipped, and one Ctrl+Z removes exactly those issues and returns exactly those detections to waiting. Tests: Task 3, "acceptMany takes drafts only and reports why the rest are skipped" and "acceptedMany is one undoable step"; Task 7, "undo step needs the issue editor's matching command".
4. **Issue codes in one Accept all batch**: expected codes continue the sequence without repeats (F03, F04, F05). Test: Task 3, "createMany numbers the issues in sequence as one command".
5. **A damaged `class-library.json`**: expected list returns nothing and save refuses rather than overwriting the person's file. Test: Task 4, "does not overwrite a damaged library file".

Also covered: labels made only of symbols (slug `class`), hotkey `C` versus `c`, a deleted class's waiting detections (moved with `reclass`), a proposal named `new:` with no name (skipped with a warning).

---

## File Structure

| File                                                                                                                                                                                     | Responsibility                                          | Task  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----- |
| `packages/schema/src/severity.ts`                                                                                                                                                        | add `LibraryClass`                                      | 1     |
| `packages/schema/src/ipc.ts`                                                                                                                                                             | four channels                                           | 1     |
| `packages/schema/src/detections.ts`                                                                                                                                                      | optional `suggestedNew` on a pass entry                 | 1     |
| `packages/schema/src/classes.test.ts` (new)                                                                                                                                              | contract tests                                          | 1     |
| `packages/annotate/src/detections/model.ts`                                                                                                                                              | read and write `suggestedNew`; resolve by `label` too   | 1     |
| `packages/annotate/src/detections/suggestedNew.test.ts` (new)                                                                                                                            | bridge tests                                            | 1     |
| `apps/desktop/src/preload/index.ts`                                                                                                                                                      | whitelist                                               | 1     |
| `packages/ui/src/i18n/en.ts`                                                                                                                                                             | every new string                                        | 1     |
| `apps/desktop/src/renderer/store.ts`                                                                                                                                                     | `SettingsPage` gains `classes`                          | 1     |
| `apps/desktop/src/renderer/help/store.ts`                                                                                                                                                | `SETTINGS_HELP.classes`                                 | 1     |
| `apps/desktop/src/renderer/screens/Settings.tsx`                                                                                                                                         | PAGES, HEAD, render the page                            | 1     |
| `apps/desktop/src/renderer/screens/settings/Classes.tsx` (new, minimal; replaced in Task 11)                                                                                             | page component                                          | 1, 11 |
| `packages/annotate/src/model/palette.ts` (new)                                                                                                                                           | class colours                                           | 2     |
| `packages/annotate/src/model/catalogueOps.ts` (new)                                                                                                                                      | add, update, remove, usage                              | 2     |
| `packages/annotate/src/index.ts`                                                                                                                                                         | export the two                                          | 2     |
| `packages/annotate/src/model/severityMap.ts` (new)                                                                                                                                       | map a severity onto another model                       | 3     |
| `packages/annotate/src/model/editor.ts`                                                                                                                                                  | `createMany`, `reassignClass`                           | 3     |
| `packages/annotate/src/detections/accept.ts`                                                                                                                                             | `acceptMany`                                            | 3     |
| `packages/annotate/src/detections/review.ts`                                                                                                                                             | `acceptedMany`, `rejectMany`, `reclass`, `ReviewChange` | 3     |
| `packages/project/src/builder/classes.ts` (new)                                                                                                                                          | `updateClasses`, `cataloguesProblem`                    | 4     |
| `packages/project/src/builder/index.ts`                                                                                                                                                  | export                                                  | 4     |
| `apps/desktop/src/main/builder.ts`                                                                                                                                                       | `builderUpdateClasses`                                  | 4     |
| `apps/desktop/src/main/classLibrary.ts` (new)                                                                                                                                            | userData store                                          | 4     |
| `apps/desktop/src/main/index.ts`                                                                                                                                                         | handlers                                                | 4     |
| `apps/desktop/src/main/journal.ts`, `journal.test.ts`                                                                                                                                    | journal the new writer                                  | 4     |
| `packages/annotate/src/components/NewClassRow.tsx` (new)                                                                                                                                 | shared row, creator registry                            | 5     |
| `packages/annotate/src/components.tsx`                                                                                                                                                   | re-export                                               | 5     |
| `packages/annotate/src/components/SightingPicker.tsx`, `IssueRegister.tsx`                                                                                                               | wire the row                                            | 5     |
| `apps/desktop/src/renderer/classes/store.ts` (new)                                                                                                                                       | create, edit, delete, undo, library client              | 6     |
| `apps/desktop/src/renderer/classes/ClassNotice.tsx` (new)                                                                                                                                | notice with Undo                                        | 6     |
| `apps/desktop/src/renderer/App.tsx`                                                                                                                                                      | mount notice, register creator                          | 6     |
| `apps/desktop/src/renderer/detections/batch.ts` (new)                                                                                                                                    | pure batch planning, undo decision                      | 7     |
| `apps/desktop/src/renderer/detections/BatchConfirm.tsx` (new)                                                                                                                            | confirm popover                                         | 7     |
| `apps/desktop/src/renderer/detections/store.ts`                                                                                                                                          | `acceptAll`, `rejectAll`, `undoReview`, `redoReview`    | 7     |
| `apps/desktop/src/renderer/screens/Detections.tsx`                                                                                                                                       | header buttons, undo wiring                             | 7     |
| `apps/desktop/src/renderer/detections/createFromLabel.ts` (new)                                                                                                                          | Create class 'X'                                        | 8     |
| `apps/desktop/src/renderer/detections/Inspector.tsx`                                                                                                                                     | new class row, Create class, Suggested class            | 8     |
| `apps/desktop/src/renderer/detections/LocalDetect.tsx`                                                                                                                                   | row in mapping, `mapModelClass`                         | 8     |
| `packages/ai/src/detect.ts`                                                                                                                                                              | `new:<name>` prompt and parse, `detect-v2`              | 9     |
| `apps/desktop/src/renderer/detections/convert.ts`, `AiDetectDialog.tsx`                                                                                                                  | carry `suggestedNew`; send without classes              | 9     |
| `apps/desktop/e2e/detections.spec.ts`                                                                                                                                                    | prompt version strings                                  | 9     |
| `packages/ai/src/tools.ts`, `tool-kit.ts`, `class-tools.ts` (new), `renderer-tools.ts`, `AgentPanel.tsx`                                                                                 | `propose_class`                                         | 10    |
| `apps/desktop/src/renderer/agent/hooks.ts`                                                                                                                                               | `createClass` hook                                      | 10    |
| `apps/desktop/src/renderer/screens/settings/classesView.ts` (new), `Classes.tsx`, `classes.css` (new)                                                                                    | Classes panel                                           | 11    |
| `apps/desktop/src/renderer/builder/libraryPick.ts` (new), `NewProjectWizard.tsx`                                                                                                         | wizard checklist                                        | 12    |
| `docs/guide/05-annotation-and-issues.md`, `docs/guide/08-building-projects.md`, `docs/KNOWN-LIMITS.md`, `docs/architecture/data-conventions.md`, `docs/architecture/contract-changes.md` | docs                                                    | 13    |
| `apps/desktop/e2e/classes.spec.ts` (new)                                                                                                                                                 | end to end                                              | 14    |

## Execution DAG

Dependencies (an arrow means "needs"):

- T1 Foundation: none
- T2 catalogueOps + palette: none
- T3 editor bulk + review batch: none
- T5 NewClassRow + annotate pickers: none
- T13 Docs: none
- T4 Main handler + class library: T1
- T6 Renderer class store + notice: T1, T2, T3, T5
- T7 Accept all / Reject all: T1, T3
- T9 AI Detect `new:`: T1
- T8 Create class from detections: T1, T5, T6
- T10 `propose_class` tool: T6
- T11 Classes panel: T1, T2, T6
- T12 Wizard library checklist: T1, T2, T6
- T14 e2e + affected spec reruns + `pnpm check`: T4, T6, T7, T8, T9, T11 (and T10, T12 for the final `pnpm check`)

Parallel batches (each batch dispatched in one message; no two tasks in a batch share a file):

| Batch | Tasks               | Shared-file check                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | T1, T2, T3, T5, T13 | T1 owns schema, preload, `en.ts`, `store.ts`, `help/store.ts`, `Settings.tsx`, `detections/model.ts`; T2 owns `model/palette.ts`, `model/catalogueOps.ts`, `annotate/src/index.ts`; T3 owns `editor.ts`, `severityMap.ts`, `accept.ts`, `review.ts`; T5 owns `components/NewClassRow.tsx`, `components.tsx`, `SightingPicker.tsx`, `IssueRegister.tsx`; T13 owns docs only |
| B2    | T4, T6, T7, T9      | T4: `packages/project/src/builder/classes.ts`, builder `index.ts`, main `builder.ts`, `classLibrary.ts`, main `index.ts`, `journal.ts`; T6: `renderer/classes/*`, `App.tsx`; T7: `detections/batch.ts`, `BatchConfirm.tsx`, `detections/store.ts`, `Detections.tsx`; T9: `packages/ai/src/detect.ts`, `convert.ts`, `AiDetectDialog.tsx`, `e2e/detections.spec.ts`         |
| B3    | T8, T10, T11, T12   | T8: `createFromLabel.ts`, `Inspector.tsx`, `LocalDetect.tsx`; T10: `packages/ai` tool files, `agent/hooks.ts`; T11: `settings/Classes.tsx`, `classesView.ts`, `classes.css`; T12: `libraryPick.ts`, `NewProjectWizard.tsx`                                                                                                                                                 |
| B4    | T14                 | `e2e/classes.spec.ts`                                                                                                                                                                                                                                                                                                                                                      |

Critical path: **T3 → T6 → T8 → T14** (T3 is the largest B1 task, T6 waits for it, T8 is the heaviest B3 task, T14 needs it). T11 runs beside T8 and is the same length.

Run one heavy check at a time (founder rule): batch agents run their own package's Vitest files; the full `pnpm check` and e2e runs happen once per batch, by the coordinator, after the batch's commits are in.

---

### Task 1: Foundation: contracts, preload, strings, Settings page slot

**Packages:** `@aio/schema`, `@aio/annotate` (detections bridge only), `@aio/ui`, desktop preload, desktop renderer (Settings, store, help).
**Contract change:** yes (row text in Task 13). **E2E:** none here.

**Files:**

- Modify: `packages/schema/src/severity.ts` (append after `ClassCatalogue`)
- Modify: `packages/schema/src/ipc.ts` (imports at top; `builder:updateClasses` after `builder:updateCapture` ~line 1553; `classLibrary:*` after `library:add` ~line 625)
- Modify: `packages/schema/src/detections.ts:94` (after `label`)
- Create: `packages/schema/src/classes.test.ts`
- Modify: `packages/annotate/src/detections/model.ts` (interface ~line 56, read ~line 165-180, write ~line 291-292)
- Create: `packages/annotate/src/detections/suggestedNew.test.ts`
- Modify: `apps/desktop/src/preload/index.ts` (~line 98 and ~line 16)
- Modify: `packages/ui/src/i18n/en.ts`
- Modify: `apps/desktop/src/renderer/store.ts:51-66`
- Modify: `apps/desktop/src/renderer/help/store.ts:37-50`
- Modify: `apps/desktop/src/renderer/screens/Settings.tsx` (imports ~line 43, PAGES ~line 71, HEAD ~line 801, render ~line 880)
- Create: `apps/desktop/src/renderer/screens/settings/Classes.tsx`

**Interfaces:**

- Produces: `LibraryClass` (zod + type) from `@aio/schema`; `IpcRequest<'builder:updateClasses'> = { projectId: string; catalogues: ClassCatalogue[] }`, response `{ ok: true; manifest: ProjectManifest; backup: string } | { ok: false; error: string }`; `classLibrary:list` request `{}` response `LibraryClass[]`; `classLibrary:save` request `{ cls: LibraryClass }`, `classLibrary:remove` request `{ label: string }`, both responding `{ ok: true; classes: LibraryClass[] } | { ok: false; error: string }`; pass `Detection.suggestedNew?: boolean`; annotate `Detection.suggestedNew?: boolean`; `SettingsPage` member `'classes'`; component `Classes()` in `screens/settings/Classes.tsx`; the i18n keys listed in Step 9.

- [ ] **Step 1: Write the failing schema test**

Create `packages/schema/src/classes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Detection } from './detections';
import { ipc } from './ipc';
import { LibraryClass } from './severity';

describe('class editing contracts (ANN-7)', () => {
  it('has the four new channels', () => {
    for (const c of [
      'builder:updateClasses',
      'classLibrary:list',
      'classLibrary:save',
      'classLibrary:remove',
    ]) {
      expect(Object.keys(ipc)).toContain(c);
    }
  });

  it('builder:updateClasses takes a project and its catalogues, nothing else', () => {
    const req = ipc['builder:updateClasses'].request;
    const catalogues = [
      {
        id: 'c',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'm' }],
      },
    ];
    expect(req.safeParse({ projectId: 'p', catalogues }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', catalogues: [] }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', catalogues: [], extra: 1 }).success).toBe(false);
    expect(req.safeParse({ projectId: '', catalogues: [] }).success).toBe(false);
  });

  it('a library class has a label and a colour; a hotkey is one character', () => {
    expect(LibraryClass.safeParse({ label: 'Spalling', color: '#aabbcc' }).success).toBe(true);
    expect(LibraryClass.safeParse({ label: '   ', color: '#aabbcc' }).success).toBe(false);
    expect(LibraryClass.safeParse({ label: 'X', color: 'red' }).success).toBe(false);
    expect(LibraryClass.safeParse({ label: 'X', color: '#aabbcc', hotkey: 'ab' }).success).toBe(
      false,
    );
    expect(
      LibraryClass.parse({ label: 'X', color: '#aabbcc', severityLevels: ['Minor', 'Severe'] })
        .severityLevels,
    ).toEqual(['Minor', 'Severe']);
  });

  it('library save and remove answer with the whole library', () => {
    const ok = ipc['classLibrary:save'].response.parse({ ok: true, classes: [] });
    expect(ok.ok).toBe(true);
    expect(ipc['classLibrary:remove'].request.safeParse({ label: '' }).success).toBe(false);
  });

  it('a detection may say it suggests a new class', () => {
    const d = Detection.parse({
      photo: 'p1',
      class: 'Spalling',
      label: 'Spalling',
      suggestedNew: true,
      bbox: [0, 0, 10, 10],
    });
    expect(d.suggestedNew).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/schema/src/classes.test.ts`
Expected: FAIL (`LibraryClass` is not exported; `ipc['builder:updateClasses']` is undefined).

- [ ] **Step 3: Add the schema pieces**

Append to `packages/schema/src/severity.ts`:

```ts
/**
 * A class kept in the class library on this computer (`userData/class-library.json`,
 * `aio.classLibrary/1`). New projects offer these; `severityLevels` are the level names of the
 * model it was saved from, shown for orientation only (a class takes the new project's model).
 */
export const LibraryClass = z.object({
  label: z.string().trim().min(1).max(80),
  color: HexColor,
  hotkey: z.string().length(1).optional(),
  severityLevels: z.array(z.string().min(1)).optional(),
});

export type LibraryClass = z.infer<typeof LibraryClass>;
```

In `packages/schema/src/ipc.ts`, add to the imports near line 28:

```ts
import { ClassCatalogue, LibraryClass } from './severity';
```

After the `'builder:updateCapture'` entry:

```ts
  /**
   * Replace the project's class catalogues: add, rename, recolour, set a hotkey or a severity
   * model, delete (ANN-7). Validated in main (unique catalogue and class ids, unique hotkeys,
   * `a` and `u` reserved, known severity models, no class removed while `issues.json` uses it),
   * backed up and journaled like `builder:updateCapture`.
   */
  'builder:updateClasses': {
    request: z
      .object({
        projectId: z.string().min(1),
        catalogues: z.array(ClassCatalogue),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

After the `'library:add'` entry:

```ts
  /** Classes saved to the class library on this computer (`userData/class-library.json`). */
  'classLibrary:list': { request: Empty, response: z.array(LibraryClass) },
  /** Save a class to the library; one with the same label (any case) is replaced. */
  'classLibrary:save': {
    request: z.object({ cls: LibraryClass }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), classes: z.array(LibraryClass) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Remove a class from the library by label (any case). */
  'classLibrary:remove': {
    request: z.object({ label: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), classes: z.array(LibraryClass) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

In `packages/schema/src/detections.ts`, after the `label` field (line 94):

```ts
    /**
     * The proposer suggests a new class named `label` (AI Detect answered `new:<name>`). Nothing
     * is created until a person clicks Create class.
     */
    suggestedNew: z.boolean().optional(),
```

- [ ] **Step 4: Run the schema test**

Run: `pnpm vitest run packages/schema/src/classes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing detections bridge test**

Create `packages/annotate/src/detections/suggestedNew.test.ts`:

```ts
import type { DetectionsFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readPasses, toPassDetection, type PassContext } from './model';

const ctx: PassContext = {
  photoLayer: () => 'photos',
  photoSize: () => [100, 100],
  classId: (raw) => (raw === 'crack' || raw.toLowerCase() === 'hairline crack' ? 'crack' : null),
  pipelineIssue: () => null,
};

const file = (detections: DetectionsFile['detections']): DetectionsFile => ({
  schema: 'aio.detections/1',
  source: 'ai',
  detections,
});

describe('suggested new classes in pass files', () => {
  it('reads suggestedNew for a detection whose class matched none', () => {
    const r = readPasses(
      [
        {
          name: 'ai-r1.json',
          file: file([
            {
              id: 'a',
              photo: 'p1',
              class: 'Spalling',
              label: 'Spalling',
              suggestedNew: true,
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    expect(r.detections[0]).toMatchObject({ classId: '', label: 'Spalling', suggestedNew: true });
  });

  it('drops the flag once the class exists, and writes it only while the class is missing', () => {
    const r = readPasses(
      [
        {
          name: 'ai-r1.json',
          file: file([
            {
              id: 'a',
              photo: 'p1',
              class: 'crack',
              suggestedNew: true,
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    const d = r.detections[0];
    if (!d) throw new Error('no detection');
    expect(d.suggestedNew).toBeUndefined();
    const out = toPassDetection(
      { ...d, classId: '', label: 'Spalling', suggestedNew: true },
      {
        fileSource: 'ai',
      },
    );
    expect(out.suggestedNew).toBe(true);
    expect(toPassDetection(d, { fileSource: 'ai' }).suggestedNew).toBeUndefined();
  });

  it('resolves a class by the proposer word when the class field does not match', () => {
    const r = readPasses(
      [
        {
          name: 'model-r1.json',
          file: file([
            {
              id: 'm',
              photo: 'p1',
              class: 'crack_hairline',
              label: 'Hairline crack',
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    expect(r.detections[0]?.classId).toBe('crack');
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm vitest run packages/annotate/src/detections/suggestedNew.test.ts`
Expected: FAIL (`suggestedNew` undefined on read; `crack_hairline` not resolved).

- [ ] **Step 7: Carry the flag through the bridge**

In `packages/annotate/src/detections/model.ts`, in `interface Detection` after `label?: string;`:

```ts
  /** The proposer suggests a new class named `label` (AI Detect `new:<name>`). */
  suggestedNew?: boolean;
```

In the reader (the line `const classId = ctx.classId(raw.class) ?? '';`), replace it with:

```ts
const classId = ctx.classId(raw.class) ?? (raw.label ? ctx.classId(raw.label) : null) ?? '';
```

and after `if (label) d.label = label;` add:

```ts
if (raw.suggestedNew && classId === '') d.suggestedNew = true;
```

In `toPassDetection`, after `if (d.label) out.label = d.label;` add:

```ts
if (d.suggestedNew && d.classId === '') out.suggestedNew = true;
```

- [ ] **Step 8: Run the bridge tests**

Run: `pnpm vitest run packages/annotate/src/detections`
Expected: PASS (the new file and the existing `detections.test.ts`).

- [ ] **Step 9: Preload whitelist, strings, Settings page slot**

`apps/desktop/src/preload/index.ts`, in `CHANNELS` after `'builder:updateCapture': true,`:

```ts
  'builder:updateClasses': true,
```

and after the `'library:*'` entries (~line 16):

```ts
  'classLibrary:list': true,
  'classLibrary:save': true,
  'classLibrary:remove': true,
```

`packages/ui/src/i18n/en.ts`: add after `'settings.page.severity': 'Severity models',`:

```ts
  'settings.page.classes': 'Classes',
```

after `'settings.severity.text': ...` (the two-line entry):

```ts
  'settings.classes.text':
    'The classes this project sorts findings into: name, colour, hotkey and severity scale. Changes are saved in the project; Ctrl+Z undoes them.',

  // Classes (ANN-7)
  'classes.noProject': 'Open a project to edit its classes.',
  'classes.readOnly': 'This project is read-only, so its classes cannot be changed.',
  'classes.notSaved': 'Classes not saved: {error}',
  'classes.created': 'Class {label} created.',
  'classes.deleted': 'Class {label} deleted.',
  'classes.savedToLibrary': '{label} saved to your class library.',
  'classes.undo': 'Undo',
  'classes.dismiss': 'Dismiss',
  'classes.empty': 'This project has no classes yet. Create one below.',
  'classes.col.colour': 'Colour',
  'classes.col.name': 'Name',
  'classes.col.hotkey': 'Hotkey',
  'classes.col.severity': 'Severity scale',
  'classes.col.issues': 'Issues',
  'classes.name': 'Name of {label}',
  'classes.hotkey': 'Hotkey of {label}',
  'classes.severity': 'Severity scale of {label}',
  'classes.colour': 'Colour of {label}',
  'classes.severityLocked':
    'Issues use this class. Move them to another class to change its severity scale.',
  'classes.saveToLibrary': 'Save to my class library',
  'classes.delete': 'Delete {label}',
  'classes.delete.title': 'Delete {label}',
  'classes.delete.used': '{issues} issues and {detections} detections use {label}. Move them to:',
  'classes.delete.move': 'Move and delete',
  'classes.delete.cancel': 'Cancel',
  'classes.delete.pickTarget': 'Pick the class that takes over its issues.',
```

after `'det.accept.tip': ...`:

```ts
  'det.class.new': '+ New class...',
  'det.createClass': "Create class '{label}'",
  'det.suggestedClass': 'Suggested class: {label}',
  'det.acceptAll': 'Accept all ({count})',
  'det.rejectAll': 'Reject all ({count})',
  'det.acceptAll.confirm_one': 'Accept 1 detection as an issue?',
  'det.acceptAll.confirm_other': 'Accept {count} detections as issues?',
  'det.acceptAll.skip_one': '1 has no class or severity and will be skipped.',
  'det.acceptAll.skip_other': '{count} have no class or severity and will be skipped.',
  'det.rejectAll.confirm_one': 'Reject 1 detection?',
  'det.rejectAll.confirm_other': 'Reject {count} detections?',
  'det.batch.cancel': 'Cancel',
  'det.error.batchUndoMoved':
    'The issues of this Accept all were changed since. Undo those changes in the issue register first.',
```

and in the builder section (next to other `builder.*` keys):

```ts
  'builder.library.title': 'From your class library',
  'builder.library.lead': 'Ticked classes are added with this severity model.',
  'builder.library.inTemplate': 'in the template',
  'builder.library.notAdded':
    'The project was created, but the library classes were not added: {error}',
```

`apps/desktop/src/renderer/store.ts`, in the `SettingsPage` union after `| 'severity'`:

```ts
  | 'classes'
```

`apps/desktop/src/renderer/help/store.ts`, in `SETTINGS_HELP` after `severity`:

```ts
  classes: { chapter: 'annotation-and-issues', anchor: 'classes' },
```

Create `apps/desktop/src/renderer/screens/settings/Classes.tsx` (Task 11 replaces the body):

```tsx
import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';

/** Settings, Classes: the open project's classes (ANN-7). */
export function Classes() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  if (!project) return <p className="help">{t('classes.noProject')}</p>;
  return <div data-testid="classes-panel" />;
}
```

`apps/desktop/src/renderer/screens/Settings.tsx`: import after `About`:

```ts
import { Classes } from './settings/Classes';
```

In `PAGES` after the `severity` entry:

```ts
  {
    page: 'classes',
    label: 'settings.page.classes',
    icon: 'issues',
    group: 'settings.group.data',
  },
```

In `HEAD` after `severity`:

```ts
  classes: { title: 'settings.page.classes', text: 'settings.classes.text' },
```

In the render list after `{page === 'severity' && <Severity />}`:

```tsx
{
  page === 'classes' && <Classes />;
}
```

- [ ] **Step 10: Check strings and types**

Run: `pnpm vitest run packages/ui/src/i18n packages/schema/src/classes.test.ts` then `pnpm typecheck`
Expected: PASS; typecheck clean (the preload `satisfies Record<IpcChannel, true>` and `HEAD: Record<Page, ...>` now match).

- [ ] **Step 11: Commit**

```bash
git add packages/schema/src/severity.ts packages/schema/src/ipc.ts packages/schema/src/detections.ts packages/schema/src/classes.test.ts packages/annotate/src/detections/model.ts packages/annotate/src/detections/suggestedNew.test.ts apps/desktop/src/preload/index.ts packages/ui/src/i18n/en.ts apps/desktop/src/renderer/store.ts apps/desktop/src/renderer/help/store.ts apps/desktop/src/renderer/screens/Settings.tsx apps/desktop/src/renderer/screens/settings/Classes.tsx
git commit -m "feat(schema): class editing contracts, strings and the Classes settings page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: catalogueOps and palette

**Packages:** `@aio/annotate` (model). **Contract change:** none. **E2E:** none here.

**Files:**

- Create: `packages/annotate/src/model/palette.ts`, `packages/annotate/src/model/palette.test.ts`
- Create: `packages/annotate/src/model/catalogueOps.ts`, `packages/annotate/src/model/catalogueOps.test.ts`
- Modify: `packages/annotate/src/index.ts` (after line 8, the `./model/view` export)

**Interfaces:**

- Produces (all exported from `@aio/annotate`):
  - `CLASS_PALETTE: readonly string[]`, `nextClassColour(used: readonly string[]): string`
  - `RESERVED_HOTKEYS: readonly string[]` (`['a', 'u']`), `DEFAULT_CATALOGUE`
  - `interface NewClass { label: string; color?: string; hotkey?: string; severityModel?: string }`
  - `interface ClassPatch { label?: string; color?: string; hotkey?: string | null; severityModel?: string }`
  - `allClasses(catalogues: readonly ClassCatalogue[]): IssueClass[]`
  - `classSlug(label: string): string`
  - `defaultSeverityModel(catalogues, models): string | null`
  - `hotkeyProblem(catalogues, hotkey: string, exceptId?: string): string | null`
  - `addClass(catalogues, models, input: NewClass): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass; created: boolean }>`
  - `updateClass(catalogues, models, id: string, patch: ClassPatch): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass }>`
  - `removeClass(catalogues, id: string): Result<ClassCatalogue[]>`
  - `classUsage(issues: readonly { classId: string }[], detections: readonly { classId: string; status: string }[], id: string): { issues: number; detections: number }`

- [ ] **Step 1: Write the failing tests**

`packages/annotate/src/model/palette.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CLASS_PALETTE, nextClassColour } from './palette';

describe('class palette', () => {
  it('has distinct #rrggbb colours', () => {
    expect(new Set(CLASS_PALETTE.map((c) => c.toLowerCase())).size).toBe(CLASS_PALETTE.length);
    for (const c of CLASS_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns the first colour no class uses yet (any case)', () => {
    expect(nextClassColour([])).toBe(CLASS_PALETTE[0]);
    expect(nextClassColour([String(CLASS_PALETTE[0]).toUpperCase()])).toBe(CLASS_PALETTE[1]);
  });

  it('cycles once every colour is used', () => {
    const all = [...CLASS_PALETTE];
    expect(nextClassColour(all)).toBe(CLASS_PALETTE[all.length % CLASS_PALETTE.length]);
    expect(nextClassColour([...all, '#000000'])).toBe(CLASS_PALETTE[1]);
  });
});
```

`packages/annotate/src/model/catalogueOps.test.ts`:

```ts
import type { ClassCatalogue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { catalogue, strictModel, tankModel } from '../testing';
import {
  addClass,
  allClasses,
  classSlug,
  classUsage,
  defaultSeverityModel,
  hotkeyProblem,
  removeClass,
  updateClass,
} from './catalogueOps';
import { CLASS_PALETTE } from './palette';

const models = [tankModel, strictModel];
const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('classSlug', () => {
  it('makes a lowercase id from the label', () => {
    expect(classSlug('Hairline crack')).toBe('hairline-crack');
    expect(classSlug('  Rost / Korrosion  ')).toBe('rost-korrosion');
    expect(classSlug('Écaillage')).toBe('ecaillage');
  });
  it('falls back to "class" for a label of symbols', () => {
    expect(classSlug('+++')).toBe('class');
  });
});

describe('addClass', () => {
  it('adds to the first catalogue with an id from the label and the next free colour', () => {
    const r = value(addClass([catalogue], models, { label: '  Spalling  ' }));
    expect(r.created).toBe(true);
    expect(r.cls).toEqual({
      id: 'spalling',
      label: 'Spalling',
      color: CLASS_PALETTE[1], // #e5484d (crack) is taken; #e8c547 and #5b9bd5 are not first
      severityModel: 'tank-1-5',
    });
    expect(r.catalogues[0]?.classes.at(-1)).toEqual(r.cls);
  });

  it('keeps ids unique across catalogues with -2, -3', () => {
    const other: ClassCatalogue = {
      id: 'other',
      name: 'Other',
      assetType: 'pipe',
      classes: [{ id: 'dent', label: 'Old dent', color: '#000000', severityModel: 'road-3' }],
    };
    const r = value(addClass([catalogue, other], models, { label: 'Dent' }));
    expect(r.cls.id).toBe('dent-2');
    const r2 = value(
      addClass(
        [{ ...catalogue, classes: [...catalogue.classes, { ...r.cls, label: 'Dent B' }] }, other],
        models,
        { label: 'Dent' },
      ),
    );
    expect(r2.cls.id).toBe('dent-3');
  });

  it('returns the existing class for a label it has (any case), creating nothing', () => {
    const r = value(addClass([catalogue], models, { label: 'coating BLISTER' }));
    expect(r.created).toBe(false);
    expect(r.cls.id).toBe('blister');
    expect(r.catalogues).toEqual([catalogue]);
  });

  it('prefers a road catalogue, else the first, else a new Classes catalogue', () => {
    const road: ClassCatalogue = { id: 'road', name: 'Road', assetType: 'road', classes: [] };
    expect(
      value(addClass([catalogue, road], models, { label: 'Rut' })).catalogues[1]?.classes,
    ).toHaveLength(1);
    const fresh = value(addClass([], models, { label: 'Rut' }));
    expect(fresh.catalogues).toEqual([
      {
        id: 'classes',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'rut', label: 'Rut', color: CLASS_PALETTE[0], severityModel: 'tank-1-5' }],
      },
    ]);
  });

  it('uses the model most classes use, else the first model', () => {
    expect(defaultSeverityModel([catalogue], models)).toBe('tank-1-5');
    expect(defaultSeverityModel([], models)).toBe('tank-1-5');
    expect(defaultSeverityModel([], [])).toBeNull();
  });

  it('refuses an empty name and a project without a severity model', () => {
    expect(addClass([catalogue], models, { label: '   ' })).toEqual({
      ok: false,
      error: 'A class needs a name.',
    });
    expect(addClass([], [], { label: 'Rut' }).ok).toBe(false);
  });

  it('keeps a library colour and hotkey, and drops a hotkey that is taken or reserved', () => {
    const kept = value(
      addClass([catalogue], models, { label: 'Rut', color: '#123456', hotkey: 'R' }),
    );
    expect(kept.cls).toMatchObject({ color: '#123456', hotkey: 'r' });
    expect(value(addClass([catalogue], models, { label: 'Rut', hotkey: 'c' })).cls.hotkey).toBe(
      undefined,
    );
    expect(value(addClass([catalogue], models, { label: 'Rut', hotkey: 'a' })).cls.hotkey).toBe(
      undefined,
    );
  });
});

describe('hotkeys', () => {
  it('allows one free letter or digit, case-insensitive', () => {
    expect(hotkeyProblem([catalogue], 'x')).toBeNull();
    expect(hotkeyProblem([catalogue], '7')).toBeNull();
    expect(hotkeyProblem([catalogue], 'C')).toMatch(/Crack/);
    expect(hotkeyProblem([catalogue], 'c', 'crack')).toBeNull();
    expect(hotkeyProblem([catalogue], 'a')).toMatch(/reserved/);
    expect(hotkeyProblem([catalogue], 'U')).toMatch(/reserved/);
    expect(hotkeyProblem([catalogue], ' ')).toMatch(/one letter or digit/);
    expect(hotkeyProblem([catalogue], 'xy')).toMatch(/one letter or digit/);
  });
});

describe('updateClass', () => {
  it('renames, recolours, sets and clears a hotkey, changes the model', () => {
    let cats = [catalogue];
    cats = value(updateClass(cats, models, 'crack', { label: ' Wide crack ' })).catalogues;
    cats = value(updateClass(cats, models, 'crack', { color: '#010203' })).catalogues;
    cats = value(updateClass(cats, models, 'crack', { hotkey: 'W' })).catalogues;
    const cls = value(updateClass(cats, models, 'crack', { severityModel: 'road-3' })).cls;
    expect(cls).toEqual({
      id: 'crack',
      label: 'Wide crack',
      color: '#010203',
      hotkey: 'w',
      severityModel: 'road-3',
    });
    expect(value(updateClass(cats, models, 'crack', { hotkey: null })).cls.hotkey).toBeUndefined();
  });

  it('refuses a taken label, a bad colour, a taken hotkey, an unknown model or class', () => {
    expect(updateClass([catalogue], models, 'crack', { label: 'pothole' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { label: '' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { color: 'red' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { hotkey: 'b' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { severityModel: 'nope' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'nope', { label: 'X' }).ok).toBe(false);
  });
});

describe('removeClass and classUsage', () => {
  it('removes a class and keeps its catalogue', () => {
    const cats = value(removeClass([catalogue], 'pothole'));
    expect(allClasses(cats).map((c) => c.id)).toEqual(['crack', 'blister']);
    expect(cats[0]?.id).toBe('tank');
    expect(removeClass([catalogue], 'nope').ok).toBe(false);
  });

  it('counts issues and the detections not accepted yet', () => {
    expect(
      classUsage(
        [{ classId: 'crack' }, { classId: 'crack' }, { classId: 'blister' }],
        [
          { classId: 'crack', status: 'draft' },
          { classId: 'crack', status: 'rejected' },
          { classId: 'crack', status: 'accepted' },
        ],
        'crack',
      ),
    ).toEqual({ issues: 2, detections: 2 });
  });
});
```

Note on the first `addClass` test: the testing catalogue uses `#e5484d`, `#e8c547`, `#5b9bd5`. With the palette in Step 3 (`#e5484d` first, `#f08a3e` second) the first free colour is `CLASS_PALETTE[1]`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/annotate/src/model/palette.test.ts packages/annotate/src/model/catalogueOps.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/annotate/src/model/palette.ts`:

```ts
/**
 * Colours for new classes (ANN-7): distinct, legible on the dark and the light theme and on
 * photos. The kit importer's colours come first, so imported and new classes look alike.
 */
export const CLASS_PALETTE: readonly string[] = [
  '#e5484d',
  '#f08a3e',
  '#e8c547',
  '#7cc46b',
  '#34a6d9',
  '#5b9bd5',
  '#b68ef8',
  '#e879b9',
  '#2fb8a6',
  '#c9a26b',
  '#8fd14f',
  '#f2a1a1',
];

/** The first palette colour no class uses yet (any case); once all are used, it cycles. */
export function nextClassColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  const free = CLASS_PALETTE.find((c) => !taken.has(c));
  if (free) return free;
  return CLASS_PALETTE[used.length % CLASS_PALETTE.length] ?? '#e5484d';
}
```

`packages/annotate/src/model/catalogueOps.ts`:

```ts
import {
  err,
  ok,
  type ClassCatalogue,
  type IssueClass,
  type Result,
  type SeverityModel,
} from '@aio/schema';
import { nextClassColour } from './palette';

/*
 * Editing a project's class catalogues (ANN-7). Pure: the app writes the result with
 * `builder:updateClasses`. Ids are slugs of the label, unique across all catalogues.
 */

/** Keys the sighting picker keeps for itself: `a` adds to the selected issue, `u` is uncertain. */
export const RESERVED_HOTKEYS: readonly string[] = ['a', 'u'];

/** The catalogue a project without any gets for its first class. */
export const DEFAULT_CATALOGUE = { id: 'classes', name: 'Classes', assetType: 'asset' } as const;

const MAX_LABEL = 80;

export interface NewClass {
  label: string;
  color?: string;
  hotkey?: string;
  severityModel?: string;
}

export interface ClassPatch {
  label?: string;
  color?: string;
  /** null or empty clears the hotkey. */
  hotkey?: string | null;
  severityModel?: string;
}

export function allClasses(catalogues: readonly ClassCatalogue[]): IssueClass[] {
  return catalogues.flatMap((c) => c.classes);
}

const cleanLabel = (label: string) => label.trim().replace(/\s+/g, ' ');
const sameLabel = (a: string, b: string) =>
  cleanLabel(a).toLowerCase() === cleanLabel(b).toLowerCase();

/** A lowercase id from a label: letters and digits, words joined by `-`; `class` when empty. */
export function classSlug(label: string): string {
  const s = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'class';
}

function uniqueClassId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

/** The severity model most classes use, else the project's first model; null without models. */
export function defaultSeverityModel(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
): string | null {
  const known = new Set(models.map((m) => m.id));
  const uses = new Map<string, number>();
  for (const c of allClasses(catalogues)) {
    if (known.has(c.severityModel)) uses.set(c.severityModel, (uses.get(c.severityModel) ?? 0) + 1);
  }
  const top = [...uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ?? models[0]?.id ?? null;
}

/** Why `hotkey` cannot be a class hotkey (ignoring class `exceptId`), or null. */
export function hotkeyProblem(
  catalogues: readonly ClassCatalogue[],
  hotkey: string,
  exceptId?: string,
): string | null {
  const k = hotkey.toLowerCase();
  if (!/^[a-z0-9]$/.test(k)) return 'A hotkey is one letter or digit.';
  if (RESERVED_HOTKEYS.includes(k)) {
    return `"${k}" is reserved in the class picker (a adds to the selected issue, u marks uncertain).`;
  }
  const other = allClasses(catalogues).find(
    (c) => c.id !== exceptId && c.hotkey?.toLowerCase() === k,
  );
  return other ? `"${k}" is the hotkey of ${other.label}.` : null;
}

function labelProblem(label: string): string | null {
  if (!label) return 'A class needs a name.';
  if (label.length > MAX_LABEL) return `A class name is at most ${String(MAX_LABEL)} characters.`;
  return null;
}

/**
 * A new class from a name (and, from the class library, a colour and hotkey). A label the project
 * has already (any case) returns that class with `created: false` and the catalogues unchanged.
 * A library hotkey that is taken or reserved is dropped, not refused.
 */
export function addClass(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  input: NewClass,
): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass; created: boolean }> {
  const label = cleanLabel(input.label);
  const bad = labelProblem(label);
  if (bad) return err(bad);
  const all = allClasses(catalogues);
  const same = all.find((c) => sameLabel(c.label, label));
  if (same) return ok({ catalogues: [...catalogues], cls: same, created: false });
  const severityModel = input.severityModel ?? defaultSeverityModel(catalogues, models);
  if (!severityModel) return err('The project has no severity model, so it cannot take a class.');
  if (!models.some((m) => m.id === severityModel)) {
    return err(`Severity model "${severityModel}" is not in the project.`);
  }
  const hotkey =
    input.hotkey && hotkeyProblem(catalogues, input.hotkey) === null
      ? input.hotkey.toLowerCase()
      : undefined;
  const cls: IssueClass = {
    id: uniqueClassId(classSlug(label), new Set(all.map((c) => c.id))),
    label,
    color: input.color ?? nextClassColour(all.map((c) => c.color)),
    severityModel,
    ...(hotkey ? { hotkey } : {}),
  };
  const target = catalogues.find((c) => c.assetType === 'road') ?? catalogues[0];
  if (!target) {
    return ok({ catalogues: [{ ...DEFAULT_CATALOGUE, classes: [cls] }], cls, created: true });
  }
  return ok({
    catalogues: catalogues.map((c) => (c === target ? { ...c, classes: [...c.classes, cls] } : c)),
    cls,
    created: true,
  });
}

/** Rename, recolour, set or clear the hotkey, change the severity model of one class. */
export function updateClass(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  id: string,
  patch: ClassPatch,
): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass }> {
  const all = allClasses(catalogues);
  const cur = all.find((c) => c.id === id);
  if (!cur) return err(`Class "${id}" is not in the project.`);
  const next: IssueClass = { ...cur };
  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label);
    const bad = labelProblem(label);
    if (bad) return err(bad);
    const clash = all.find((c) => c.id !== id && sameLabel(c.label, label));
    if (clash) return err(`There is a class named ${clash.label} already.`);
    next.label = label;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) return err('Colour must be #rrggbb');
    next.color = patch.color;
  }
  if (patch.hotkey === null || patch.hotkey === '') {
    delete next.hotkey;
  } else if (patch.hotkey !== undefined) {
    const p = hotkeyProblem(catalogues, patch.hotkey, id);
    if (p) return err(p);
    next.hotkey = patch.hotkey.toLowerCase();
  }
  if (patch.severityModel !== undefined) {
    if (!models.some((m) => m.id === patch.severityModel)) {
      return err(`Severity model "${patch.severityModel}" is not in the project.`);
    }
    next.severityModel = patch.severityModel;
  }
  return ok({
    catalogues: catalogues.map((c) => ({
      ...c,
      classes: c.classes.map((k) => (k.id === id ? next : k)),
    })),
    cls: next,
  });
}

/** The catalogues without class `id` (its catalogue stays, even when empty). */
export function removeClass(
  catalogues: readonly ClassCatalogue[],
  id: string,
): Result<ClassCatalogue[]> {
  if (!allClasses(catalogues).some((c) => c.id === id)) {
    return err(`Class "${id}" is not in the project.`);
  }
  return ok(catalogues.map((c) => ({ ...c, classes: c.classes.filter((k) => k.id !== id) })));
}

/** How many issues and not-yet-accepted detections use class `id`. */
export function classUsage(
  issues: readonly { classId: string }[],
  detections: readonly { classId: string; status: string }[],
  id: string,
): { issues: number; detections: number } {
  return {
    issues: issues.filter((i) => i.classId === id).length,
    detections: detections.filter((d) => d.classId === id && d.status !== 'accepted').length,
  };
}
```

`packages/annotate/src/index.ts`, after `export * from './model/view';`:

```ts
export * from './model/catalogueOps';
export * from './model/palette';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/annotate/src/model/palette.test.ts packages/annotate/src/model/catalogueOps.test.ts`
Expected: PASS. If the first `addClass` colour assertion differs, the palette order changed: keep the palette above as written.

- [ ] **Step 5: Commit**

```bash
git add packages/annotate/src/model/palette.ts packages/annotate/src/model/palette.test.ts packages/annotate/src/model/catalogueOps.ts packages/annotate/src/model/catalogueOps.test.ts packages/annotate/src/index.ts
git commit -m "feat(annotate): class catalogue operations and class colour palette" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Issue editor bulk commands and detection review batches

**Packages:** `@aio/annotate` (model, detections). **Contract change:** none. **E2E:** none here.

**Files:**

- Create: `packages/annotate/src/model/severityMap.ts`
- Modify: `packages/annotate/src/model/editor.ts` (interface ~line 55-78; methods in the returned object after `mergeMany`)
- Create: `packages/annotate/src/model/editor.bulk.test.ts`
- Modify: `packages/annotate/src/detections/accept.ts` (append)
- Modify: `packages/annotate/src/detections/review.ts` (`Change` ~line 22, `ReviewAction` ~line 44, reducer before `case 'undo'`)
- Create: `packages/annotate/src/detections/batch.test.ts`

**Interfaces:**

- Consumes: `createIssue`, `findClass`, `findModel` from `./ops`; existing internals `bulk`, `commit`, `withDerived`, `plural` in `editor.ts`.
- Produces:
  - `mapSeverity(sev: Issue['severity'], to: SeverityModel): Issue['severity']` (not exported from the package index; used by the editor)
  - `IssueEditor.createMany(inputs: readonly CreateInput[], label: string): Result<Issue[]>`
  - `IssueEditor.reassignClass(fromId: string, toId: string): BulkResult`
  - `acceptMany(list: readonly Detection[], ctx: IssueContext, sizeOf?: (d: Detection) => readonly [number, number] | undefined): AcceptManyResult` with `AcceptManyResult = { accepted: { detection: Detection; input: AcceptAsNew }[]; skipped: { detection: Detection; problem: AcceptProblem }[] }`
  - `ReviewAction` gains `{ type: 'acceptedMany'; items: readonly { id: string; issueId: string }[]; label: string; by: string; now: string }`, `{ type: 'rejectMany'; ids: readonly string[]; label: string; by: string; now: string }`, `{ type: 'reclass'; from: string; to: string; now: string }`
  - `export interface ReviewChange { label; before; after; final?: boolean; issues?: true }` (the old `Change`, renamed and exported; `issues: true` marks an Accept all whose undo also undoes the issue editor command of the same label)

- [ ] **Step 1: Write the failing editor test**

`packages/annotate/src/model/editor.bulk.test.ts`:

```ts
import type { ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, strictModel, tankModel } from '../testing';
import { createIssueEditor } from './editor';
import { mapSeverity } from './severityMap';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel, strictModel],
  classCatalogues: [catalogue],
};

function setup(
  issues = [makeIssue({ id: 'i1', code: 'F01' }), makeIssue({ id: 'i2', code: 'F02' })],
) {
  const store = createWorkspace();
  store.setState({ project: { id: 'p', root: '/p', manifest }, issues });
  let n = 0;
  const editor = createIssueEditor({ store, newId: () => `n${String(++n)}` });
  return { store, editor };
}

describe('mapSeverity', () => {
  it('keeps a level the new model has, else takes the nearest (ties go up)', () => {
    expect(mapSeverity(2, strictModel)).toBe(2);
    expect(mapSeverity(5, strictModel)).toBe(3);
    expect(mapSeverity(0, strictModel)).toBe(1);
    const gappy = {
      ...strictModel,
      levels: [1, 3].map((v) => ({ value: v, label: String(v), color: '#000000', criteria: '' })),
    };
    expect(mapSeverity(2, gappy)).toBe(3);
  });
  it('keeps uncertain where the model has it, else the highest level', () => {
    expect(mapSeverity('uncertain', tankModel)).toBe('uncertain');
    expect(mapSeverity('uncertain', strictModel)).toBe(3);
  });
});

describe('createMany', () => {
  it('createMany numbers the issues in sequence as one command', () => {
    const { store, editor } = setup();
    const r = editor.createMany(
      [
        { sighting: photoSighting, classId: 'crack', severity: 3 },
        { sighting: photoSighting, classId: 'blister', severity: 2 },
        { sighting: photoSighting, classId: 'pothole', severity: 1 },
      ],
      'Accept 3 detections',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.map((i) => i.code)).toEqual(['F03', 'F04', 'F05']);
    expect(store.getState().issues).toHaveLength(5);
    expect(editor.state.undoLabel).toBe('Accept 3 detections');
    expect(editor.undo()).toBe(true);
    expect(store.getState().issues.map((i) => i.code)).toEqual(['F01', 'F02']);
    expect(editor.redo()).toBe(true);
    expect(store.getState().issues).toHaveLength(5);
  });

  it('creates nothing when one input is refused', () => {
    const { store, editor } = setup();
    const r = editor.createMany(
      [
        { sighting: photoSighting, classId: 'crack', severity: 3 },
        { sighting: photoSighting, classId: 'nope', severity: 2 },
      ],
      'Accept 2 detections',
    );
    expect(r.ok).toBe(false);
    expect(store.getState().issues).toHaveLength(2);
    expect(editor.state.canUndo).toBe(false);
  });

  it('is a no-op for an empty list', () => {
    const { editor } = setup();
    expect(editor.createMany([], 'Accept 0 detections')).toEqual({ ok: true, value: [] });
    expect(editor.state.canUndo).toBe(false);
  });
});

describe('reassignClass', () => {
  it('moves every issue of a class in one step, mapping severities to the new model', () => {
    const { store, editor } = setup([
      makeIssue({ id: 'i1', code: 'F01', classId: 'crack', severity: 5 }),
      makeIssue({ id: 'i2', code: 'F02', classId: 'crack', severity: 'uncertain' }),
      makeIssue({ id: 'i3', code: 'F03', classId: 'blister', severity: 2 }),
    ]);
    const r = editor.reassignClass('crack', 'pothole');
    expect(r).toEqual({ changed: 2, skipped: [] });
    const [a, b, c] = store.getState().issues;
    expect(a).toMatchObject({ classId: 'pothole', severityModelId: 'road-3', severity: 3 });
    expect(b).toMatchObject({ classId: 'pothole', severityModelId: 'road-3', severity: 3 });
    expect(c).toMatchObject({ classId: 'blister' });
    expect(editor.state.undoLabel).toBe('Move 2 issues from Crack to Pothole');
    editor.undo();
    expect(store.getState().issues.map((i) => i.classId)).toEqual(['crack', 'crack', 'blister']);
  });

  it('skips every issue when the target class does not exist', () => {
    const { editor } = setup([makeIssue({ id: 'i1', code: 'F01', classId: 'crack' })]);
    const r = editor.reassignClass('crack', 'nope');
    expect(r.changed).toBe(0);
    expect(r.skipped).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/annotate/src/model/editor.bulk.test.ts`
Expected: FAIL (`./severityMap` not found; `createMany` is not a function).

- [ ] **Step 3: Implement severityMap and the editor commands**

`packages/annotate/src/model/severityMap.ts`:

```ts
import type { Issue, SeverityModel } from '@aio/schema';

/**
 * A severity on another model (a class's issues move to a class with another scale): the same
 * level when the model has it, else the nearest (a tie takes the higher, the safe side);
 * uncertain stays uncertain where the model has it, else the highest level, for a person to grade.
 */
export function mapSeverity(sev: Issue['severity'], to: SeverityModel): Issue['severity'] {
  const values = to.levels.map((l) => l.value);
  const top = Math.max(...values);
  if (sev === 'uncertain') return to.uncertain ? 'uncertain' : top;
  if (values.includes(sev)) return sev;
  let best = top;
  let gap = Infinity;
  for (const v of values) {
    const g = Math.abs(v - sev);
    if (g < gap || (g === gap && v > best)) {
      best = v;
      gap = g;
    }
  }
  return best;
}
```

In `packages/annotate/src/model/editor.ts`:

- add `findModel` to the import list from `./ops`, and `import { mapSeverity } from './severityMap';`
- in `interface IssueEditor`, after `mergeMany`:

```ts
  /** Create many issues as one undo step (Accept all); nothing is created when one is refused. */
  createMany(inputs: readonly CreateInput[], label: string): Result<Issue[]>;
  /**
   * Move every issue of class `fromId` to class `toId` in one undo step (a class is deleted),
   * mapping each severity onto the new class's model (`mapSeverity`).
   */
  reassignClass(fromId: string, toId: string): BulkResult;
```

- in the returned object, after `mergeMany(ids) { ... },`:

```ts
    createMany(inputs, label) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      if (inputs.length === 0) return ok([]);
      const now = clock();
      const ctx = context();
      const list: Issue[] = [...store.getState().issues];
      const after: Record<string, Issue> = {};
      const out: Issue[] = [];
      for (const input of inputs) {
        const r = createIssue(
          list,
          { ...input, id: input.id ?? makeId(), author: input.author ?? author(), now },
          ctx,
        );
        if (!r.ok) return fail(r.error);
        const issue = withDerived(r.value, input.sighting);
        list.push(issue);
        after[issue.id] = issue;
        out.push(issue);
      }
      const c = commit(label, after);
      return c.ok ? ok(out) : err(c.error);
    },
    reassignClass(fromId, toId) {
      const ctx = context();
      const to = findClass(ctx, toId);
      const ids = store
        .getState()
        .issues.filter((i) => i.classId === fromId)
        .map((i) => i.id);
      if (!to) {
        const error = `Class "${toId}" is not in any class catalogue`;
        return {
          changed: 0,
          skipped: ids.map((id) => ({ id, code: get(id)?.code ?? id, error })),
        };
      }
      const toModel = findModel(ctx, to.severityModel);
      const fromName = findClass(ctx, fromId)?.label ?? fromId;
      return bulk(
        ids,
        (n) => `Move ${plural(n)} from ${fromName} to ${to.label}`,
        (i, now) =>
          toModel
            ? ok({
                ...i,
                classId: to.id,
                severityModelId: to.severityModel,
                severity: mapSeverity(i.severity, toModel),
                updatedAt: now,
              })
            : err(`Class ${to.label} has no severity model in this project`),
      );
    },
```

- [ ] **Step 4: Run the editor tests**

Run: `pnpm vitest run packages/annotate/src/model`
Expected: PASS (new file and the existing `editor.test.ts`).

- [ ] **Step 5: Write the failing batch tests for detections**

`packages/annotate/src/detections/batch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ctx } from '../testing';
import { acceptMany } from './accept';
import type { Detection } from './model';
import { canUndo, initialReview, reviewReducer, type ReviewState } from './review';

const NOW = '2026-10-15T10:00:00.000Z';

function det(id: string, over: Partial<Detection> = {}): Detection {
  return {
    id,
    pass: 'model-r1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p1' },
    size: [100, 100],
    geom: { type: 'box', x: 10, y: 10, w: 20, h: 20 },
    classId: 'crack',
    severity: 3,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'model', producer: 'detector' },
    ...over,
  };
}

const loaded = (ds: Detection[]): ReviewState =>
  reviewReducer(initialReview(), { type: 'load', detections: ds });

describe('acceptMany', () => {
  it('acceptMany takes drafts only and reports why the rest are skipped', () => {
    const r = acceptMany(
      [
        det('ok'),
        det('noclass', { classId: '', label: 'spalling' }),
        det('nosev', { severity: null }),
        det('done', { status: 'accepted', issueId: 'x' }),
        det('rej', { status: 'rejected' }),
      ],
      ctx,
    );
    expect(r.accepted.map((a) => a.detection.id)).toEqual(['ok']);
    expect(r.accepted[0]?.input).toMatchObject({ classId: 'crack', severity: 3, source: 'agent' });
    expect(r.skipped.map((s) => [s.detection.id, s.problem])).toEqual([
      ['noclass', 'no-class'],
      ['nosev', 'no-severity'],
    ]);
  });
});

describe('review batches', () => {
  it('acceptedMany is one undoable step marked as issues', () => {
    const s0 = loaded([det('a'), det('b'), det('c')]);
    const s1 = reviewReducer(s0, {
      type: 'acceptedMany',
      items: [
        { id: 'a', issueId: 'i1' },
        { id: 'b', issueId: 'i2' },
      ],
      label: 'Accept 2 detections',
      by: 'DR',
      now: NOW,
    });
    expect(s1.detections.filter((d) => d.status === 'accepted').map((d) => d.issueId)).toEqual([
      'i1',
      'i2',
    ]);
    expect(s1.past.at(-1)).toMatchObject({ label: 'Accept 2 detections', issues: true });
    expect(canUndo(s1)).toBe(true);
    const s2 = reviewReducer(s1, { type: 'undo' });
    expect(s2.detections.every((d) => d.status === 'draft' && !d.issueId)).toBe(true);
    const s3 = reviewReducer(s2, { type: 'redo' });
    expect(s3.detections.filter((d) => d.status === 'accepted')).toHaveLength(2);
  });

  it('acceptedMany leaves accepted detections alone and is a no-op with nothing to do', () => {
    const s0 = loaded([det('a', { status: 'accepted', issueId: 'old' })]);
    const s1 = reviewReducer(s0, {
      type: 'acceptedMany',
      items: [{ id: 'a', issueId: 'new' }],
      label: 'Accept 1 detection',
      by: 'DR',
      now: NOW,
    });
    expect(s1).toBe(s0);
  });

  it('rejectMany rejects the drafts as one step and undo brings them back', () => {
    const s0 = loaded([det('a'), det('b'), det('c', { status: 'accepted', issueId: 'x' })]);
    const s1 = reviewReducer(s0, {
      type: 'rejectMany',
      ids: ['a', 'b', 'c'],
      label: 'Reject 2 detections',
      by: 'DR',
      now: NOW,
    });
    expect(s1.detections.map((d) => d.status)).toEqual(['rejected', 'rejected', 'accepted']);
    expect(s1.past).toHaveLength(1);
    const s2 = reviewReducer(s1, { type: 'undo' });
    expect(s2.detections.map((d) => d.status)).toEqual(['draft', 'draft', 'accepted']);
  });

  it('reclass moves waiting and rejected detections of a class, not accepted ones', () => {
    const s0 = loaded([
      det('a'),
      det('b', { status: 'rejected' }),
      det('c', { status: 'accepted', issueId: 'x' }),
      det('d', { classId: 'blister' }),
    ]);
    const s1 = reviewReducer(s0, { type: 'reclass', from: 'crack', to: 'pothole', now: NOW });
    expect(s1.detections.map((d) => d.classId)).toEqual(['pothole', 'pothole', 'crack', 'blister']);
    expect(reviewReducer(s0, { type: 'reclass', from: 'nope', to: 'pothole', now: NOW })).toBe(s0);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm vitest run packages/annotate/src/detections/batch.test.ts`
Expected: FAIL (`acceptMany` not exported; unknown action types are a type error and fall through).

- [ ] **Step 7: Implement acceptMany and the reducer actions**

Append to `packages/annotate/src/detections/accept.ts`:

```ts
export interface AcceptManyResult {
  accepted: { detection: Detection; input: AcceptAsNew }[];
  skipped: { detection: Detection; problem: AcceptProblem }[];
}

/**
 * Accept all (ANN-7): the waiting detections of a list as new-issue inputs, in list order; the
 * waiting ones that cannot be accepted yet are skipped with the reason. Accepted and rejected
 * detections are left out. Pure: the app runs `inputs` through `issueEditor.createMany`.
 */
export function acceptMany(
  list: readonly Detection[],
  ctx: IssueContext,
  sizeOf: (d: Detection) => readonly [number, number] | undefined = () => undefined,
): AcceptManyResult {
  const out: AcceptManyResult = { accepted: [], skipped: [] };
  for (const d of list) {
    if (d.status !== 'draft') continue;
    const r = newIssueInput(d, ctx, sizeOf(d));
    if (r.ok) out.accepted.push({ detection: d, input: r.value });
    else out.skipped.push({ detection: d, problem: r.error });
  }
  return out;
}
```

In `packages/annotate/src/detections/review.ts`:

- rename `interface Change` to `export interface ReviewChange` and replace every other use of `Change` in the file with `ReviewChange`; add the field:

```ts
  /**
   * An Accept all: the issue editor holds a command of the same label that made the issues.
   * The app undoes and redoes both together (`undoReview` in the desktop store).
   */
  issues?: true;
```

- in `ReviewAction`, after `accepted`:

```ts
  /** Accept all: many detections accepted at once, one undoable step (see `ReviewChange.issues`). */
  | {
      type: 'acceptedMany';
      items: readonly { id: string; issueId: string }[];
      label: string;
      by: string;
      now: string;
    }
  /** Reject all: the waiting detections among `ids` rejected as one step. */
  | { type: 'rejectMany'; ids: readonly string[]; label: string; by: string; now: string }
  /** A class was deleted: its waiting and rejected detections move to class `to`, one step. */
  | { type: 'reclass'; from: string; to: string; now: string }
```

- in `reviewReducer`, before `case 'undo':`:

```ts
    case 'acceptedMany': {
      const byId = new Map(state.detections.map((d) => [d.id, d]));
      const before: Record<string, Detection> = {};
      const after: Record<string, Detection> = {};
      for (const it of action.items) {
        const d = byId.get(it.id);
        if (!d || d.status === 'accepted') continue;
        before[d.id] = d;
        after[d.id] = {
          ...d,
          status: 'accepted',
          issueId: it.issueId,
          reviewedBy: action.by,
          reviewedAt: action.now,
          updatedAt: action.now,
        };
      }
      if (Object.keys(after).length === 0) return state;
      return commit(state, { label: action.label, before, after, issues: true });
    }
    case 'rejectMany': {
      const wanted = new Set(action.ids);
      const before: Record<string, Detection> = {};
      const after: Record<string, Detection> = {};
      for (const d of state.detections) {
        if (!wanted.has(d.id) || d.status !== 'draft') continue;
        before[d.id] = d;
        after[d.id] = {
          ...d,
          status: 'rejected',
          reviewedBy: action.by,
          reviewedAt: action.now,
          updatedAt: action.now,
        };
      }
      if (Object.keys(after).length === 0) return state;
      return commit(state, { label: action.label, before, after });
    }
    case 'reclass': {
      const before: Record<string, Detection> = {};
      const after: Record<string, Detection> = {};
      for (const d of state.detections) {
        if (d.classId !== action.from || d.status === 'accepted') continue;
        before[d.id] = d;
        after[d.id] = { ...d, classId: action.to, updatedAt: action.now };
      }
      if (Object.keys(after).length === 0) return state;
      return commit(
        state,
        { label: 'Move detections to another class', before, after },
        state.currentId,
      );
    }
```

- [ ] **Step 8: Run the detections tests**

Run: `pnpm vitest run packages/annotate/src/detections`
Expected: PASS (new file, `detections.test.ts`, `review.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add packages/annotate/src/model/severityMap.ts packages/annotate/src/model/editor.ts packages/annotate/src/model/editor.bulk.test.ts packages/annotate/src/detections/accept.ts packages/annotate/src/detections/review.ts packages/annotate/src/detections/batch.test.ts
git commit -m "feat(annotate): one-step createMany and reassignClass; accept, reject and reclass detections in batches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Main: builder:updateClasses and the class library

**Packages:** `@aio/project` (builder), desktop main. **Contract change:** implements Task 1's channels. **E2E:** exercised by Task 14.

**Files:**

- Create: `packages/project/src/builder/classes.ts`, `packages/project/src/builder/classes.test.ts`
- Modify: `packages/project/src/builder/index.ts` (add an export line after the `./create` block)
- Modify: `apps/desktop/src/main/builder.ts` (after `builderUpdateCapture`, ~line 517)
- Create: `apps/desktop/src/main/builderClasses.test.ts`
- Create: `apps/desktop/src/main/classLibrary.ts`, `apps/desktop/src/main/classLibrary.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (import ~line 49-60; store ~line 324; handlers ~line 835 and ~line 1462)
- Modify: `apps/desktop/src/main/journal.ts` (header comment ~line 16; channel list ~line 1014-1031), `apps/desktop/src/main/journal.test.ts` (~line 1034 `writers`)

**Interfaces:**

- Consumes: Task 1 `IpcRequest<'builder:updateClasses'>`, `LibraryClass`.
- Produces: `updateClasses(root: string, catalogues: readonly ClassCatalogue[]): Promise<{ manifest: ProjectManifest; backup: string }>` and `cataloguesProblem(m: ProjectManifest, catalogues: readonly ClassCatalogue[], usedClassIds: ReadonlySet<string>): string | null` from `@aio/project/builder`; `builderUpdateClasses(req, registry)`; `createClassLibraryStore(file: string): ClassLibraryStore` with `list(): Promise<LibraryClass[]>`, `save(cls: LibraryClass): Promise<LibraryClass[]>`, `remove(label: string): Promise<LibraryClass[]>`.

- [ ] **Step 1: Write the failing project test**

`packages/project/src/builder/classes.test.ts`:

```ts
import type { ClassCatalogue, ProjectManifest } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cataloguesProblem, updateClasses } from './classes';

const manifest = (): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [
        { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
        { value: 3, label: 'Severe', color: '#f05653', criteria: 'Act' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
});

const withClasses = (classes: ClassCatalogue['classes']): ClassCatalogue[] => [
  { id: 'cat', name: 'Classes', assetType: 'asset', classes },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-classes-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest()));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [{ id: 'i1', classId: 'rust' }] }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cataloguesProblem', () => {
  const m = manifest();
  const none = new Set<string>();
  it('accepts a valid set', () => {
    expect(cataloguesProblem(m, m.classCatalogues, none)).toBeNull();
  });
  it('refuses duplicate ids, unknown models, reserved and shared hotkeys', () => {
    const crack = { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' };
    expect(cataloguesProblem(m, withClasses([crack, { ...crack, label: 'Other' }]), none)).toMatch(
      /Two classes have the id "crack"/,
    );
    expect(cataloguesProblem(m, withClasses([{ ...crack, severityModel: 'x' }]), none)).toMatch(
      /severity model "x"/,
    );
    expect(cataloguesProblem(m, withClasses([{ ...crack, hotkey: 'u' }]), none)).toMatch(
      /reserved/,
    );
    expect(
      cataloguesProblem(
        m,
        withClasses([
          { ...crack, hotkey: 'k' },
          { id: 'b', label: 'B', color: '#000000', severityModel: 'sev', hotkey: 'K' },
        ]),
        none,
      ),
    ).toMatch(/share the hotkey "k"/);
    expect(cataloguesProblem(m, [...withClasses([]), ...withClasses([])], none)).toMatch(
      /Two class catalogues/,
    );
  });
  it('refuses to remove a class that issues use; an unknown class in issues does not matter', () => {
    expect(cataloguesProblem(m, withClasses([]), new Set(['rust']))).toMatch(
      /Class "rust" still has issues/,
    );
    expect(cataloguesProblem(m, m.classCatalogues, new Set(['imported-x']))).toBeNull();
  });
});

describe('updateClasses', () => {
  it('writes the catalogues with a backup and leaves the rest of the manifest alone', async () => {
    const next = withClasses([
      ...(manifest().classCatalogues[0]?.classes ?? []),
      { id: 'spalling', label: 'Spalling', color: '#7cc46b', severityModel: 'sev' },
    ]);
    const r = await updateClasses(dir, next);
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    ) as ProjectManifest;
    expect(onDisk.classCatalogues).toEqual(next);
    expect(onDisk.severityModels).toEqual(manifest().severityModels);
  });

  it('refuses to remove a class that issues.json still uses', async () => {
    await expect(updateClasses(dir, withClasses([]))).rejects.toThrow(
      /Class "rust" still has issues/,
    );
    const onDisk = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    ) as ProjectManifest;
    expect(onDisk.classCatalogues).toEqual(manifest().classCatalogues);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/project/src/builder/classes.test.ts`
Expected: FAIL (`./classes` not found).

- [ ] **Step 3: Implement**

`packages/project/src/builder/classes.ts`:

```ts
import { ClassCatalogue, type ProjectManifest } from '@aio/schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { updateManifestFile } from './manifestFile';

/*
 * Class catalogues edited after the project was created (ANN-7, `builder:updateClasses`). Only
 * `manifest.classCatalogues` changes; saved in turn with a backup like `updateCapture`.
 */

const RESERVED = new Set(['a', 'u']);

/** Why `catalogues` cannot replace the manifest's, or null. `usedClassIds`: classes issues use. */
export function cataloguesProblem(
  m: ProjectManifest,
  catalogues: readonly ClassCatalogue[],
  usedClassIds: ReadonlySet<string>,
): string | null {
  const parsed = z.array(ClassCatalogue).safeParse(catalogues);
  if (!parsed.success) {
    return `The classes are invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`;
  }
  const models = new Set(m.severityModels.map((s) => s.id));
  const catalogueIds = new Set<string>();
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const c of catalogues) {
    if (catalogueIds.has(c.id)) return `Two class catalogues have the id "${c.id}".`;
    catalogueIds.add(c.id);
    for (const k of c.classes) {
      if (ids.has(k.id)) return `Two classes have the id "${k.id}".`;
      ids.add(k.id);
      if (!models.has(k.severityModel)) {
        return `Class ${k.label} names severity model "${k.severityModel}", which the project does not have.`;
      }
      if (k.hotkey) {
        const key = k.hotkey.toLowerCase();
        if (RESERVED.has(key)) return `Class ${k.label}: "${key}" is reserved in the class picker.`;
        const other = keys.get(key);
        if (other) return `Classes ${other} and ${k.label} share the hotkey "${key}".`;
        keys.set(key, k.label);
      }
    }
  }
  const had = new Set(m.classCatalogues.flatMap((c) => c.classes.map((k) => k.id)));
  for (const id of usedClassIds) {
    if (had.has(id) && !ids.has(id)) {
      return `Class "${id}" still has issues. Move them to another class first.`;
    }
  }
  return null;
}

/** Class ids the saved issues use (an absent `issues.json` uses none). */
async function usedClasses(root: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(join(root, 'issues.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw e;
  }
  const raw = JSON.parse(text) as { issues?: { classId?: unknown }[] };
  return new Set(
    (raw.issues ?? []).flatMap((i) => (typeof i.classId === 'string' ? [i.classId] : [])),
  );
}

/** Replace the project's class catalogues (validated against the manifest and the saved issues). */
export async function updateClasses(
  root: string,
  catalogues: readonly ClassCatalogue[],
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const used = await usedClasses(root);
  const r = await updateManifestFile(root, (m) => {
    const problem = cataloguesProblem(m, catalogues, used);
    if (problem) throw new Error(problem);
    return {
      manifest: {
        ...m,
        classCatalogues: catalogues.map((c) => ({
          ...c,
          classes: c.classes.map((k) => ({ ...k })),
        })),
      },
    };
  });
  return { manifest: r.manifest, backup: r.backup };
}
```

`packages/project/src/builder/index.ts`, after the `} from './create';` block:

```ts
export { cataloguesProblem, updateClasses } from './classes';
```

- [ ] **Step 4: Run the project tests**

Run: `pnpm vitest run packages/project/src/builder/classes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing main tests**

`apps/desktop/src/main/builderClasses.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builderUpdateClasses } from './builder';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-builder-classes-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('builder:updateClasses', () => {
  it('writes the catalogues of an open project and returns the new manifest', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const catalogues = [
      {
        id: 'classes',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'spalling', label: 'Spalling', color: '#7cc46b', severityModel: 'sev' }],
      },
    ];
    const r = await builderUpdateClasses({ projectId, catalogues }, registry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.classCatalogues).toEqual(catalogues);
    const disk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      classCatalogues: unknown;
    };
    expect(disk.classCatalogues).toEqual(catalogues);
  });

  it('refuses a closed project and an invalid set, with the reason', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    expect(await builderUpdateClasses({ projectId: 'x', catalogues: [] }, registry)).toEqual({
      ok: false,
      error: 'Project "x" is not open. Open it, then save again.',
    });
    const bad = await builderUpdateClasses(
      {
        projectId,
        catalogues: [
          {
            id: 'c',
            name: 'C',
            assetType: 'asset',
            classes: [{ id: 'k', label: 'K', color: '#000000', severityModel: 'nope' }],
          },
        ],
      },
      registry,
    );
    expect(bad).toEqual({
      ok: false,
      error: expect.stringMatching(/severity model "nope"/) as string,
    });
  });
});
```

`apps/desktop/src/main/classLibrary.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASS_LIBRARY_SCHEMA, createClassLibraryStore } from './classLibrary';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-class-library-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('class library store', () => {
  it('starts empty, saves sorted by label, replaces a label of any case, removes', async () => {
    const file = join(base, 'class-library.json');
    const store = createClassLibraryStore(file);
    expect(await store.list()).toEqual([]);
    await store.save({ label: 'Spalling', color: '#7cc46b' });
    await store.save({ label: 'Efflorescence', color: '#34a6d9', hotkey: 'e' });
    const after = await store.save({ label: 'spalling', color: '#000000' });
    expect(after.map((c) => [c.label, c.color])).toEqual([
      ['Efflorescence', '#34a6d9'],
      ['spalling', '#000000'],
    ]);
    const disk = JSON.parse(await readFile(file, 'utf8')) as { schema: string; classes: unknown[] };
    expect(disk.schema).toBe(CLASS_LIBRARY_SCHEMA);
    expect(disk.classes).toHaveLength(2);
    expect((await store.remove('EFFLORESCENCE')).map((c) => c.label)).toEqual(['spalling']);
  });

  it('skips entries it cannot read and keeps the good ones', async () => {
    const file = join(base, 'class-library.json');
    await writeFile(
      file,
      JSON.stringify({
        classes: [
          { label: 'Rust', color: '#f08a3e' },
          { label: '', color: 'x' },
        ],
      }),
    );
    expect((await createClassLibraryStore(file).list()).map((c) => c.label)).toEqual(['Rust']);
  });

  it('does not overwrite a damaged library file', async () => {
    const file = join(base, 'class-library.json');
    await writeFile(file, '{ not json');
    const store = createClassLibraryStore(file);
    expect(await store.list()).toEqual([]);
    await expect(store.save({ label: 'Rust', color: '#f08a3e' })).rejects.toThrow(/damaged/);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/builderClasses.test.ts apps/desktop/src/main/classLibrary.test.ts`
Expected: FAIL (exports not found).

- [ ] **Step 7: Implement main**

`apps/desktop/src/main/builder.ts`, after `builderUpdateCapture`:

```ts
/** Replace the project's class catalogues (ANN-7): only `manifest.classCatalogues` changes. */
export async function builderUpdateClasses(
  req: IpcRequest<'builder:updateClasses'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:updateClasses'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then save again.`,
    };
  try {
    const r = await (await lib()).updateClasses(root, req.catalogues);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
```

`apps/desktop/src/main/classLibrary.ts`:

```ts
import { LibraryClass } from '@aio/schema';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';

/** Classes saved on this computer for new projects (ANN-7), `userData/class-library.json`. */
export const CLASS_LIBRARY_SCHEMA = 'aio.classLibrary/1';

const LibraryFile = z.object({
  schema: z.string().optional(),
  classes: z.array(z.unknown()),
});

export interface ClassLibraryStore {
  list(): Promise<LibraryClass[]>;
  /** Add or replace (same label, any case); answers with the whole library. */
  save(cls: LibraryClass): Promise<LibraryClass[]>;
  remove(label: string): Promise<LibraryClass[]>;
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createClassLibraryStore(file: string): ClassLibraryStore {
  /** The classes, and whether the file exists but cannot be read (then it is never overwritten). */
  async function load(): Promise<{ classes: LibraryClass[]; damaged: boolean }> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (e) {
      console.warn(`Class library ${file} is unreadable, ignoring it: ${String(e)}`);
      return { classes: [], damaged: true };
    }
    if (raw === undefined) return { classes: [], damaged: false };
    const f = LibraryFile.safeParse(raw);
    if (!f.success) {
      console.warn(`Class library ${file} is not a class library, ignoring it.`);
      return { classes: [], damaged: true };
    }
    const classes = f.data.classes.flatMap((c) => {
      const r = LibraryClass.safeParse(c);
      return r.success ? [r.data] : [];
    });
    return { classes, damaged: false };
  }

  async function write(classes: LibraryClass[]): Promise<LibraryClass[]> {
    const sorted = [...classes].sort((a, b) => a.label.localeCompare(b.label));
    await writeJsonAtomic(file, { schema: CLASS_LIBRARY_SCHEMA, classes: sorted });
    return sorted;
  }

  async function loadForWrite(): Promise<LibraryClass[]> {
    const cur = await load();
    if (cur.damaged) {
      throw new Error(`The class library file is damaged and was left as it is: ${file}`);
    }
    return cur.classes;
  }

  return {
    list: async () => (await load()).classes,
    async save(cls) {
      const parsed = LibraryClass.parse(cls);
      const cur = await loadForWrite();
      return write([...cur.filter((c) => !sameLabel(c.label, parsed.label)), parsed]);
    },
    async remove(label) {
      const cur = await loadForWrite();
      const next = cur.filter((c) => !sameLabel(c.label, label));
      return next.length === cur.length ? cur : write(next);
    },
  };
}
```

Note: `readJson` returns `undefined` for a missing file and throws on bad JSON (`apps/desktop/src/main/fsutil.ts:6`).

`apps/desktop/src/main/index.ts`:

- add `builderUpdateClasses,` to the `./builder` import list (~line 58);
- add `import { createClassLibraryStore } from './classLibrary';` with the other local imports;
- after `const library = createLibraryStore(...)` (~line 324):

```ts
const classLibrary = createClassLibraryStore(join(app.getPath('userData'), 'class-library.json'));
```

- after `handle('library:add', ...)` (~line 835):

```ts
handle('classLibrary:list', () => classLibrary.list());
handle('classLibrary:save', async ({ cls }) => {
  try {
    return { ok: true as const, classes: await classLibrary.save(cls) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});
handle('classLibrary:remove', async ({ label }) => {
  try {
    return { ok: true as const, classes: await classLibrary.remove(label) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});
```

- after the `builder:updateCapture` handler (~line 1463):

```ts
handle(
  'builder:updateClasses',
  (req) => packageRefusal(req.projectId) ?? builderUpdateClasses(req, registry),
);
```

`apps/desktop/src/main/journal.ts`: add `channel === 'builder:updateClasses' ||` after `channel === 'builder:updateCapture' ||` in the condition, add `| 'builder:updateClasses'` to the `IpcRequest<...>` union just below it, and add `builder:updateClasses` to the list of manifest writers in the header comment (~line 16).

`apps/desktop/src/main/journal.test.ts`: in the `writers: IpcChannel[]` list (~line 1034) add `'builder:updateClasses',` after `'builder:updateCapture',`.

- [ ] **Step 8: Run the main tests**

Run: `pnpm vitest run apps/desktop/src/main/builderClasses.test.ts apps/desktop/src/main/classLibrary.test.ts apps/desktop/src/main/journal.test.ts packages/project/src/builder/classes.test.ts`
Expected: PASS. Then `pnpm typecheck` clean.

- [ ] **Step 9: Commit**

```bash
git add packages/project/src/builder/classes.ts packages/project/src/builder/classes.test.ts packages/project/src/builder/index.ts apps/desktop/src/main/builder.ts apps/desktop/src/main/builderClasses.test.ts apps/desktop/src/main/classLibrary.ts apps/desktop/src/main/classLibrary.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/journal.ts apps/desktop/src/main/journal.test.ts
git commit -m "feat(desktop): builder:updateClasses and the class library in main, journaled" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: NewClassRow and the annotate pickers

**Packages:** `@aio/annotate` (components). **Contract change:** none. **E2E:** the Issues register path is covered by `issue-card.spec.ts` rerun (Task 14).

**Files:**

- Create: `packages/annotate/src/components/NewClassRow.tsx`, `packages/annotate/src/components/NewClassRow.test.tsx`
- Modify: `packages/annotate/src/components.tsx` (the barrel next to the folder)
- Modify: `packages/annotate/src/components/SightingPicker.tsx` (class list ~line 121-140)
- Modify: `packages/annotate/src/components/IssueRegister.tsx` (Set class select ~line 580-596)

**Interfaces:**

- Consumes: `useAnnotateReadOnly()` from `../runtime`.
- Produces (exported from `@aio/annotate`):
  - `type ClassCreator = (label: string) => Promise<IssueClass>`
  - `registerClassCreator(fn: ClassCreator): () => void` (the app registers once; the returned function unregisters)
  - `useClassCreator(): ClassCreator | null`
  - `useNewClass(): { create: ClassCreator | null; disabledReason: string | null }`
  - `NEW_CLASS_OPTION = '__new-class__'` (option value pickers use for "+ New class...")
  - `NewClassRow(props: { onCreate: ClassCreator; onCreated: (cls: IssueClass) => void; disabledReason?: string | null; startOpen?: boolean; onCancel?: () => void; testId?: string })`

- [ ] **Step 1: Write the failing component test**

`packages/annotate/src/components/NewClassRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { IssueClass } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewClassRow, registerClassCreator, useClassCreator } from './NewClassRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const spalling: IssueClass = {
  id: 'spalling',
  label: 'Spalling',
  color: '#7cc46b',
  severityModel: 'sev',
};
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
});

describe('NewClassRow', () => {
  it('turns into a field; Enter creates and hands back the class', async () => {
    const onCreate = vi.fn(() => Promise.resolve(spalling));
    const onCreated = vi.fn();
    const el = render(<NewClassRow onCreate={onCreate} onCreated={onCreated} />);
    const button = el.querySelector('button');
    expect(button?.textContent).toBe('+ New class...');
    act(() => {
      button?.click();
    });
    const input = el.querySelector('input');
    if (!input) throw new Error('no field');
    act(() => {
      type(input, '  Spalling ');
    });
    await act(async () => {
      key(input, 'Enter');
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith('Spalling');
    expect(onCreated).toHaveBeenCalledWith(spalling);
    expect(el.querySelector('input')).toBeNull();
  });

  it('Escape cancels; an empty name and a refused create show the reason', async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn(() => Promise.reject(new Error('Classes not saved: disk full')));
    const el = render(
      <NewClassRow onCreate={onCreate} onCreated={vi.fn()} startOpen onCancel={onCancel} />,
    );
    const input = el.querySelector('input');
    if (!input) throw new Error('no field');
    act(() => {
      key(input, 'Enter');
    });
    expect(el.textContent).toContain('Type a name for the class.');
    act(() => {
      type(input, 'Rust');
    });
    await act(async () => {
      key(input, 'Enter');
      await Promise.resolve();
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Classes not saved: disk full');
    act(() => {
      key(input, 'Escape');
    });
    expect(onCancel).toHaveBeenCalled();
    expect(el.querySelector('input')).toBeNull();
  });

  it('is disabled with the reason', () => {
    const el = render(
      <NewClassRow onCreate={vi.fn()} onCreated={vi.fn()} disabledReason="Read-only project" />,
    );
    const button = el.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('Read-only project');
  });

  it('shares one registered creator with every picker', () => {
    let seen: unknown = 'unset';
    function Probe() {
      seen = useClassCreator();
      return null;
    }
    render(<Probe />);
    expect(seen).toBeNull();
    const fn = () => Promise.resolve(spalling);
    let off: () => void = () => undefined;
    act(() => {
      off = registerClassCreator(fn);
    });
    expect(seen).toBe(fn);
    act(() => {
      off();
    });
    expect(seen).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/annotate/src/components/NewClassRow.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement NewClassRow**

`packages/annotate/src/components/NewClassRow.tsx`:

```tsx
import type { IssueClass } from '@aio/schema';
import { useState, useSyncExternalStore } from 'react';
import { useAnnotateReadOnly } from '../runtime';

/*
 * "+ New class..." (ANN-7): a row that turns into a name field; Enter creates the class and hands
 * it back, Escape cancels. The package does no IO: the app registers how a class is created
 * (`registerClassCreator`), and pickers in this package read it with `useNewClass`.
 */

export type ClassCreator = (label: string) => Promise<IssueClass>;

/** Option value a class `<select>` uses for its "+ New class..." entry. */
export const NEW_CLASS_OPTION = '__new-class__';

let creator: ClassCreator | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** The app's class creator (one at a time); the returned function takes it back. */
export function registerClassCreator(fn: ClassCreator): () => void {
  creator = fn;
  emit();
  return () => {
    if (creator !== fn) return;
    creator = null;
    emit();
  };
}

export function useClassCreator(): ClassCreator | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => creator,
  );
}

/** For pickers: the registered creator (null hides the row) and why it is off. */
export function useNewClass(): { create: ClassCreator | null; disabledReason: string | null } {
  const create = useClassCreator();
  const readOnly = useAnnotateReadOnly();
  return {
    create,
    disabledReason: readOnly ? 'This project is read-only, so classes cannot be added.' : null,
  };
}

export interface NewClassRowProps {
  onCreate: ClassCreator;
  onCreated: (cls: IssueClass) => void;
  /** Why the row is off (a read-only project); shown as its title. */
  disabledReason?: string | null;
  /** Start as the name field (a picker's "+ New class..." option was chosen). */
  startOpen?: boolean;
  onCancel?: () => void;
  testId?: string;
}

export function NewClassRow({
  onCreate,
  onCreated,
  disabledReason = null,
  startOpen = false,
  onCancel,
  testId = 'new-class',
}: NewClassRowProps) {
  const [open, setOpen] = useState(startOpen);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="ann-btn ghost new-class"
        data-testid={testId}
        disabled={disabledReason !== null}
        title={disabledReason ?? 'Create a class with just a name'}
        onClick={() => {
          setOpen(true);
        }}
      >
        + New class...
      </button>
    );
  }

  const close = () => {
    setOpen(false);
    setLabel('');
    setError(null);
    onCancel?.();
  };
  const submit = async () => {
    const name = label.trim();
    if (!name) {
      setError('Type a name for the class.');
      return;
    }
    setBusy(true);
    try {
      const cls = await onCreate(name);
      setOpen(false);
      setLabel('');
      setError(null);
      onCreated(cls);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-class-row" data-testid={testId}>
      <input
        className="ann-input"
        autoFocus
        aria-label="New class name"
        placeholder="Class name"
        maxLength={80}
        value={label}
        disabled={busy}
        onChange={(e) => {
          setLabel(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      {error && (
        <span className="ann-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
```

`packages/annotate/src/components.tsx`, add:

```ts
export {
  NEW_CLASS_OPTION,
  NewClassRow,
  registerClassCreator,
  useClassCreator,
  useNewClass,
  type ClassCreator,
  type NewClassRowProps,
} from './components/NewClassRow';
```

- [ ] **Step 4: Wire the sighting picker and the Issues register**

`SightingPicker.tsx`: import `NewClassRow, useNewClass` from `./NewClassRow`; after `const { classes, models } = useTaxonomy();` add `const { create, disabledReason } = useNewClass();`. Replace the empty-state line and close the class list with the row:

```tsx
        {classes.length === 0 && (
          <div className="ann-faint">
            {create ? 'No classes yet. Create one below.' : 'This project has no class catalogue yet.'}
          </div>
        )}
        {classes.map((c) => (
          /* unchanged class buttons */
        ))}
        {create && (
          <NewClassRow
            onCreate={create}
            disabledReason={disabledReason}
            testId="picker-new-class"
            onCreated={(cls) => {
              setClassId(cls.id);
              setStage('severity');
            }}
          />
        )}
```

(The existing key handler already ignores keys typed into an `<input>`, so class hotkeys do not fire while the name is typed.)

`IssueRegister.tsx`: import `NEW_CLASS_OPTION, NewClassRow, useNewClass` from `./NewClassRow`; add `const { create, disabledReason } = useNewClass();` and `const [newClassOpen, setNewClassOpen] = useState(false);` next to the other state. Replace the Set class select with:

```tsx
<select
  className="ann-select"
  aria-label="Set class"
  value=""
  onChange={(e) => {
    const to = e.target.value;
    if (!to) return;
    if (to === NEW_CLASS_OPTION) {
      setNewClassOpen(true);
      return;
    }
    report(`Set to ${label(to)}:`, issueEditor.setClassMany([...live], to));
  }}
>
  <option value="">Set class</option>
  {classes.map((c) => (
    <option key={c.id} value={c.id}>
      {c.label}
    </option>
  ))}
  {create && <option value={NEW_CLASS_OPTION}>+ New class...</option>}
</select>;
{
  newClassOpen && create && (
    <NewClassRow
      startOpen
      onCreate={create}
      disabledReason={disabledReason}
      testId="register-new-class"
      onCancel={() => {
        setNewClassOpen(false);
      }}
      onCreated={(cls) => {
        setNewClassOpen(false);
        report(`Set to ${cls.label}:`, issueEditor.setClassMany([...live], cls.id));
      }}
    />
  );
}
```

- [ ] **Step 5: Run the component tests**

Run: `pnpm vitest run packages/annotate/src/components`
Expected: PASS (new test, `IssueRegister.test.tsx`, `components.test.tsx`).

- [ ] **Step 6: Commit**

```bash
git add packages/annotate/src/components/NewClassRow.tsx packages/annotate/src/components/NewClassRow.test.tsx packages/annotate/src/components.tsx packages/annotate/src/components/SightingPicker.tsx packages/annotate/src/components/IssueRegister.tsx
git commit -m "feat(annotate): New class row in the sighting picker and the Issues register" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Renderer class store, notice with Undo

**Packages:** desktop renderer. **Contract change:** none. **E2E:** Task 14.

**Files:**

- Create: `apps/desktop/src/renderer/classes/store.ts`, `apps/desktop/src/renderer/classes/store.test.ts`
- Create: `apps/desktop/src/renderer/classes/ClassNotice.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx` (imports; an effect inside `App()`; `<ClassNotice />` after `<Toasts />` ~line 433)

**Interfaces:**

- Consumes: Task 1 channels and keys; Task 2 `addClass`, `updateClass`, `removeClass`, `ClassPatch`, `NewClass`; Task 3 `issueEditor.reassignClass`, review action `reclass`; Task 5 `registerClassCreator`; existing `issueSaver.flush()`, `isAnnotateReadOnly()`, `bridge.call`, `shell.getState().pkg`, `workspace.getState().replaceManifest`, `loadDetections`, `dispatch` from `../detections/store`.
- Produces (module `apps/desktop/src/renderer/classes/store.ts`):
  - `classes` (zustand vanilla store `{ projectId; past: ClassEdit[]; future: ClassEdit[]; notice: ClassNotice | null }`), `useClasses(selector)`
  - `readOnlyReason(): string | null`
  - `createClass(label: string, extra?: Omit<NewClass, 'label'>): Promise<IssueClass>` (throws `Error` with the sentence on failure)
  - `editClass(id: string, patch: ClassPatch): Promise<string | null>`
  - `deleteClass(id: string, moveTo: string | null): Promise<string | null>`
  - `undoClassEdit(): Promise<boolean>`, `redoClassEdit(): Promise<boolean>`, `dismissNotice(): void`
  - `listLibrary(): Promise<LibraryClass[]>`, `saveToLibrary(cls: IssueClass): Promise<string | null>`, `removeFromLibrary(label: string): Promise<string | null>`, `addLibraryClasses(entries: readonly LibraryClass[]): Promise<string | null>`
  - `ClassNotice()` component (`data-testid="class-notice"`, Undo button `class-notice-undo`)

- [ ] **Step 1: Write the failing store test**

`apps/desktop/src/renderer/classes/store.test.ts`:

```ts
// @vitest-environment jsdom
import { issueEditor, issueSaver } from '@aio/annotate';
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; req: unknown }[],
  order: [] as string[],
  answer: null as null | { ok: false; error: string },
}));

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: {
    call: (channel: string, req: { catalogues?: unknown }) => {
      h.calls.push({ channel, req });
      h.order.push(channel);
      if (channel === 'builder:updateClasses') {
        if (h.answer) return Promise.resolve({ ok: true, value: h.answer });
        const m = workspace.getState().project?.manifest;
        return Promise.resolve({
          ok: true,
          value: { ok: true, backup: 'b', manifest: { ...m, classCatalogues: req.catalogues } },
        });
      }
      return Promise.resolve({ ok: true, value: [] });
    },
  },
}));
vi.mock('../detections/store', () => ({
  loadDetections: () => Promise.resolve(),
  dispatch: (a: { type: string }) => {
    h.order.push(`dispatch:${a.type}`);
  },
}));

const { classes, createClass, deleteClass, editClass, undoClassEdit, redoClassEdit } =
  await import('./store');

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [
        { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' },
        { value: 3, label: 'Severe', color: '#f05653', criteria: 'S' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
};

const issue = (id: string, code: string, classId: string): Issue => ({
  id,
  code,
  classId,
  severityModelId: 'sev',
  severity: 3,
  status: 'draft',
  title: code,
  note: '',
  author: 'DR',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 1, y: 1, w: 2, h: 2 } },
  ],
  source: 'human',
});

const labels = () =>
  (workspace.getState().project?.manifest.classCatalogues ?? []).flatMap((c) =>
    c.classes.map((k) => k.label),
  );

beforeEach(() => {
  h.calls = [];
  h.order = [];
  h.answer = null;
  workspace.setState({ project: null, issues: [] });
  workspace.setState({
    project: { id: 'p', root: '/p', manifest },
    issues: [issue('i1', 'F01', 'rust'), issue('i2', 'F02', 'rust')],
  });
  vi.spyOn(issueSaver, 'flush').mockImplementation(() => {
    h.order.push('flush');
    return Promise.resolve();
  });
  // no real issue writes from the shared saver in a unit test
  vi.spyOn(issueSaver, 'schedule').mockImplementation(() => undefined);
});

describe('class store', () => {
  it('creates a class with just a name, writes once, and undo removes it', async () => {
    const cls = await createClass('Spalling');
    expect(cls).toMatchObject({ id: 'spalling', label: 'Spalling', severityModel: 'sev' });
    expect(h.calls.filter((c) => c.channel === 'builder:updateClasses')).toHaveLength(1);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling']);
    expect(classes.getState().notice).toMatchObject({
      text: 'Class Spalling created.',
      undo: true,
    });
    expect(await undoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(await redoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling']);
  });

  it('returns the existing class for a known label without writing', async () => {
    const cls = await createClass('crack');
    expect(cls.id).toBe('crack');
    expect(h.calls).toHaveLength(0);
  });

  it('keeps the manifest and reports when the write is refused', async () => {
    h.answer = { ok: false, error: 'disk full' };
    await expect(createClass('Spalling')).rejects.toThrow('disk full');
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(classes.getState().notice).toMatchObject({
      text: 'Classes not saved: disk full',
      error: true,
    });
  });

  it('edits a class and refuses a reserved hotkey inline', async () => {
    expect(await editClass('crack', { label: 'Wide crack' })).toBeNull();
    expect(labels()).toEqual(['Wide crack', 'Rust']);
    expect(await editClass('crack', { hotkey: 'a' })).toMatch(/reserved/);
  });

  it('deletes a used class: moves issues and detections, flushes the issue saver before writing', async () => {
    expect(await deleteClass('rust', null)).toBe('Pick the class that takes over its issues.');
    expect(await deleteClass('rust', 'crack')).toBeNull();
    expect(workspace.getState().issues.map((i) => i.classId)).toEqual(['crack', 'crack']);
    expect(labels()).toEqual(['Crack']);
    expect(h.order).toEqual(['dispatch:reclass', 'flush', 'builder:updateClasses']);
    expect(issueEditor.state.undoLabel).toBe('Move 2 issues from Rust to Crack');
    expect(await undoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(workspace.getState().issues.map((i) => i.classId)).toEqual(['rust', 'rust']);
  });

  it('deletes an unused class directly', async () => {
    workspace.setState({ issues: [] });
    expect(await deleteClass('rust', null)).toBeNull();
    expect(labels()).toEqual(['Crack']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/classes/store.test.ts`
Expected: FAIL (module `./store` not found).

- [ ] **Step 3: Implement the store**

`apps/desktop/src/renderer/classes/store.ts`:

```ts
/**
 * Class editing for the open project (ANN-7): create (also from pickers, detections and the
 * assistant), edit, delete-and-move, undo, and the class library on this computer. Every catalogue
 * change is one `builder:updateClasses` write; when it fails the manifest stays as it was and the
 * notice says why. Undo restores the catalogues and, for a delete that moved issues, undoes the
 * issue editor's move command of the same label.
 */
import {
  addClass,
  isAnnotateReadOnly,
  issueEditor,
  issueSaver,
  removeClass,
  updateClass,
  type ClassPatch,
  type NewClass,
} from '@aio/annotate';
import type { ClassCatalogue, IssueClass, LibraryClass } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { dispatch, loadDetections } from '../detections/store';
import { bridge, shell } from '../shell';

export interface ClassEdit {
  label: string;
  before: ClassCatalogue[];
  after: ClassCatalogue[];
  /** The issue editor command that moved the deleted class's issues (undone with it). */
  issueCommand?: string;
}

export interface ClassNoticeState {
  text: string;
  undo: boolean;
  error: boolean;
  at: number;
}

interface ClassesState {
  projectId: string | null;
  past: ClassEdit[];
  future: ClassEdit[];
  notice: ClassNoticeState | null;
}

const LIMIT = 50;

export const classes = createStore<ClassesState>()(() => ({
  projectId: null,
  past: [],
  future: [],
  notice: null,
}));

export function useClasses<T>(selector: (s: ClassesState) => T): T {
  return useStore(classes, selector);
}

workspace.subscribe((s, prev) => {
  const id = s.project?.id ?? null;
  if (id === (prev.project?.id ?? null)) return;
  classes.setState({ projectId: id, past: [], future: [], notice: null });
});

/** Why classes cannot be changed now, or null. */
export function readOnlyReason(): string | null {
  if (!workspace.getState().project) return t('classes.noProject');
  if (shell.getState().pkg || isAnnotateReadOnly()) return t('classes.readOnly');
  return null;
}

function notify(text: string, opts: { undo?: boolean; error?: boolean } = {}): void {
  classes.setState({
    notice: { text, undo: opts.undo ?? false, error: opts.error ?? false, at: Date.now() },
  });
}

export function dismissNotice(): void {
  classes.setState({ notice: null });
}

const catalogues = () => workspace.getState().project?.manifest.classCatalogues ?? [];
const models = () => workspace.getState().project?.manifest.severityModels ?? [];

/** Save the catalogues; null when saved, else why not (the manifest is then unchanged). */
async function write(next: ClassCatalogue[]): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return t('classes.noProject');
  const r = await bridge.call('builder:updateClasses', { projectId: project.id, catalogues: next });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error !== null) {
    notify(t('classes.notSaved', { error }), { error: true });
    return error;
  }
  if (r.ok && r.value.ok && workspace.getState().project?.id === project.id) {
    workspace.getState().replaceManifest(r.value.manifest);
  }
  return null;
}

function push(edit: ClassEdit): void {
  classes.setState((s) => ({ past: [...s.past, edit].slice(-LIMIT), future: [] }));
}

/** A class from a name (and, from the library, a colour and hotkey). Throws with the sentence. */
export async function createClass(
  label: string,
  extra: Omit<NewClass, 'label'> = {},
): Promise<IssueClass> {
  const reason = readOnlyReason();
  if (reason) throw new Error(reason);
  const before = catalogues();
  const r = addClass(before, models(), { ...extra, label });
  if (!r.ok) throw new Error(r.error);
  if (!r.value.created) return r.value.cls;
  const e = await write(r.value.catalogues);
  if (e) throw new Error(t('classes.notSaved', { error: e }));
  push({ label: `Create class ${r.value.cls.label}`, before, after: r.value.catalogues });
  notify(t('classes.created', { label: r.value.cls.label }), { undo: true });
  return r.value.cls;
}

export async function editClass(id: string, patch: ClassPatch): Promise<string | null> {
  const reason = readOnlyReason();
  if (reason) return reason;
  const before = catalogues();
  const r = updateClass(before, models(), id, patch);
  if (!r.ok) return r.error;
  const e = await write(r.value.catalogues);
  if (e) return e;
  push({ label: `Edit class ${r.value.cls.label}`, before, after: r.value.catalogues });
  return null;
}

/** Waiting and rejected detections of class `from` go to `to` (loads the review if needed). */
async function moveDetections(projectId: string, from: string, to: string): Promise<void> {
  await loadDetections(projectId);
  dispatch({ type: 'reclass', from, to, now: new Date().toISOString() });
}

/**
 * Delete a class. A class issues use needs `moveTo`: its issues move there (one issue editor
 * command, severities mapped) and its detections too, then the catalogue is written.
 */
export async function deleteClass(id: string, moveTo: string | null): Promise<string | null> {
  const reason = readOnlyReason();
  if (reason) return reason;
  const project = workspace.getState().project;
  if (!project) return t('classes.noProject');
  const before = catalogues();
  const cls = before.flatMap((c) => c.classes).find((c) => c.id === id);
  if (!cls) return `Class "${id}" is not in the project.`;
  const removed = removeClass(before, id);
  if (!removed.ok) return removed.error;
  const used = workspace.getState().issues.some((i) => i.classId === id);
  if (used && (!moveTo || moveTo === id)) return t('classes.delete.pickTarget');
  let issueCommand: string | undefined;
  if (used && moveTo) {
    const moved = issueEditor.reassignClass(id, moveTo);
    if (moved.skipped.length > 0) {
      if (moved.changed > 0) issueEditor.undo();
      return moved.skipped[0]?.error ?? t('classes.delete.pickTarget');
    }
    issueCommand = issueEditor.state.undoLabel ?? undefined;
  }
  if (moveTo && moveTo !== id) await moveDetections(project.id, id, moveTo);
  // main checks issues.json: the moved issues must be on disk before the class goes
  await issueSaver.flush();
  const e = await write(removed.value);
  if (e) {
    if (issueCommand && issueEditor.state.undoLabel === issueCommand) issueEditor.undo();
    return e;
  }
  push({
    label: `Delete class ${cls.label}`,
    before,
    after: removed.value,
    ...(issueCommand ? { issueCommand } : {}),
  });
  notify(t('classes.deleted', { label: cls.label }), { undo: true });
  return null;
}

export async function undoClassEdit(): Promise<boolean> {
  const edit = classes.getState().past.at(-1);
  if (!edit || readOnlyReason()) return false;
  // the class comes back first, then its issues
  if (await write(edit.before)) return false;
  if (edit.issueCommand && issueEditor.state.undoLabel === edit.issueCommand) issueEditor.undo();
  classes.setState((s) => ({
    past: s.past.slice(0, -1),
    future: [...s.future, edit],
    notice: null,
  }));
  return true;
}

export async function redoClassEdit(): Promise<boolean> {
  const edit = classes.getState().future.at(-1);
  if (!edit || readOnlyReason()) return false;
  // issues move away first, then the class goes
  const movedIssues = !!edit.issueCommand && issueEditor.state.redoLabel === edit.issueCommand;
  if (movedIssues) {
    issueEditor.redo();
    await issueSaver.flush();
  }
  if (await write(edit.after)) {
    if (movedIssues) issueEditor.undo();
    return false;
  }
  classes.setState((s) => ({
    future: s.future.slice(0, -1),
    past: [...s.past, edit],
    notice: null,
  }));
  return true;
}

// ---- class library (this computer) ----

export async function listLibrary(): Promise<LibraryClass[]> {
  const r = await bridge.call('classLibrary:list', {});
  return r.ok ? r.value : [];
}

export async function saveToLibrary(cls: IssueClass): Promise<string | null> {
  const model = models().find((m) => m.id === cls.severityModel);
  const r = await bridge.call('classLibrary:save', {
    cls: {
      label: cls.label,
      color: cls.color,
      ...(cls.hotkey ? { hotkey: cls.hotkey } : {}),
      ...(model ? { severityLevels: model.levels.map((l) => l.label) } : {}),
    },
  });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error !== null) return error;
  notify(t('classes.savedToLibrary', { label: cls.label }));
  return null;
}

export async function removeFromLibrary(label: string): Promise<string | null> {
  const r = await bridge.call('classLibrary:remove', { label });
  return !r.ok ? r.error : r.value.ok ? null : r.value.error;
}

/** Add library classes to the open project in one write (new-project wizard). */
export async function addLibraryClasses(entries: readonly LibraryClass[]): Promise<string | null> {
  if (entries.length === 0) return null;
  let next = catalogues();
  for (const e of entries) {
    const r = addClass(next, models(), {
      label: e.label,
      color: e.color,
      ...(e.hotkey ? { hotkey: e.hotkey } : {}),
    });
    if (!r.ok) return r.error;
    next = r.value.catalogues;
  }
  return write(next);
}
```

- [ ] **Step 4: Notice component and App wiring**

`apps/desktop/src/renderer/classes/ClassNotice.tsx`:

```tsx
import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { dismissNotice, undoClassEdit, useClasses } from './store';

const SHOW_MS = 8000;

/** "Class X created." with Undo, bottom centre; errors stay until dismissed (ANN-7). */
export function ClassNotice() {
  const t = useT();
  const notice = useClasses((s) => s.notice);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(dismissNotice, SHOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      className={`class-notice notice${notice.error ? ' warn' : ''}`}
      role="status"
      data-testid="class-notice"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span>{notice.text}</span>
      {notice.undo && (
        <button
          type="button"
          className="btn ghost sm"
          data-testid="class-notice-undo"
          onClick={() => {
            void undoClassEdit();
          }}
        >
          {t('classes.undo')}
        </button>
      )}
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={t('classes.dismiss')}
        onClick={dismissNotice}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
```

(If `close` is not an `IconName`, use the icon the other dialogs use for closing; `grep -n "name=\"close\"\|name=\"x\"" apps/desktop/src/renderer -r | head`.)

`apps/desktop/src/renderer/App.tsx`:

- imports: `import { registerClassCreator } from '@aio/annotate';` (add to an existing `@aio/annotate` import if there is one), `import { ClassNotice } from './classes/ClassNotice';`, `import { createClass } from './classes/store';`
- inside `App()`, with the other effects:

```tsx
// "+ New class..." in every picker creates through the class store (ANN-7)
useEffect(() => registerClassCreator((label) => createClass(label)), []);
```

- after `<Toasts />`: `<ClassNotice />`

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/classes`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/classes/store.ts apps/desktop/src/renderer/classes/store.test.ts apps/desktop/src/renderer/classes/ClassNotice.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): class store with undo, delete-and-move, class library client and notice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Accept all and Reject all

**Packages:** desktop renderer (detections). **Contract change:** none. **E2E:** Task 14; rerun `detections.spec.ts`.

**Files:**

- Create: `apps/desktop/src/renderer/detections/batch.ts`, `apps/desktop/src/renderer/detections/batch.test.ts`
- Create: `apps/desktop/src/renderer/detections/BatchConfirm.tsx`, `apps/desktop/src/renderer/detections/BatchConfirm.test.tsx`
- Modify: `apps/desktop/src/renderer/detections/store.ts` (append after `acceptCurrent`)
- Modify: `apps/desktop/src/renderer/screens/Detections.tsx` (imports ~line 33; header ~line 437; key handler `case 'undo'`/`'redo'` ~line 370-374; undo/redo buttons ~line 446 and ~line 458)

**Interfaces:**

- Consumes: Task 3 `acceptMany`, `ReviewChange`, actions `acceptedMany`, `rejectMany`; `issueEditor.createMany`, `issueEditor.state.undoLabel/redoLabel`; Task 1 keys `det.acceptAll*`, `det.rejectAll*`, `det.batch.cancel`, `det.error.batchUndoMoved`.
- Produces:
  - `batch.ts`: `interface BatchPlan { accept: number; skip: number; reject: number }`, `planBatch(list: readonly Detection[], ctx: IssueContext, sizeOf?): BatchPlan`, `acceptLabel(n: number): string`, `rejectLabel(n: number): string`, `type UndoStep = 'review' | 'with-issues' | 'blocked' | 'none'`, `undoStep(top: ReviewChange | undefined, editorLabel: string | null): UndoStep`
  - store: `acceptAll(list: readonly Detection[]): { accepted: number; skipped: number } | { error: string }`, `rejectAll(list: readonly Detection[]): number`, `planFor(list): BatchPlan`, `undoReview(): void`, `redoReview(): void`
  - `BatchConfirm(props: { kind: 'accept' | 'reject'; plan: BatchPlan; onConfirm: () => void; onCancel: () => void })` with test ids `det-batch-confirm`, `det-batch-ok`, `det-batch-cancel`

- [ ] **Step 1: Write the failing pure test**

`apps/desktop/src/renderer/detections/batch.test.ts`:

```ts
import type { Detection, ReviewChange } from '@aio/annotate/detections';
import type { ClassCatalogue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { acceptLabel, planBatch, rejectLabel, undoStep } from './batch';

const model: SeverityModel = {
  id: 'sev',
  name: 'S',
  levels: [{ value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' }],
};
const catalogues: ClassCatalogue[] = [
  {
    id: 'c',
    name: 'C',
    assetType: 'asset',
    classes: [{ id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' }],
  },
];
const det = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'p.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p1' },
  size: [100, 100],
  geom: { type: 'box', x: 1, y: 1, w: 5, h: 5 },
  classId: 'crack',
  severity: 1,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'model', producer: 'm' },
  ...over,
});

describe('Accept all planning', () => {
  it('counts what Accept all and Reject all would do with the list on screen', () => {
    const plan = planBatch(
      [det('a'), det('b', { classId: '' }), det('c', { status: 'rejected' }), det('d')],
      { models: [model], catalogues },
    );
    expect(plan).toEqual({ accept: 2, skip: 1, reject: 3 });
  });

  it('names the commands the same in the editor and the review', () => {
    expect(acceptLabel(1)).toBe('Accept 1 detection');
    expect(acceptLabel(4)).toBe('Accept 4 detections');
    expect(rejectLabel(2)).toBe('Reject 2 detections');
  });
});

describe('undo step needs the issue editor matching command', () => {
  const batch: ReviewChange = { label: 'Accept 2 detections', before: {}, after: {}, issues: true };
  const plain: ReviewChange = { label: 'Reject detection', before: {}, after: {} };
  it('undoes review changes alone, an Accept all with its issues, refuses a moved one', () => {
    expect(undoStep(undefined, null)).toBe('none');
    expect(undoStep(plain, 'Edit F01')).toBe('review');
    expect(undoStep(batch, 'Accept 2 detections')).toBe('with-issues');
    expect(undoStep(batch, 'Edit F03')).toBe('blocked');
  });
});
```

Reject planning counts waiting detections only (the rejected one is not counted), so `reject: 3` for `a`, `b`, `d`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/detections/batch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement batch.ts**

`apps/desktop/src/renderer/detections/batch.ts`:

```ts
import type { IssueContext } from '@aio/annotate';
import { acceptMany, type Detection, type ReviewChange } from '@aio/annotate/detections';

/*
 * Accept all and Reject all (ANN-7) over the filtered list on screen. The issue editor command
 * and the review change of one Accept all carry the same label, so undo can do both or neither.
 */

export interface BatchPlan {
  /** Waiting detections Accept all turns into issues. */
  accept: number;
  /** Waiting detections it skips (no class, no severity...). */
  skip: number;
  /** Waiting detections Reject all rejects. */
  reject: number;
}

export function planBatch(
  list: readonly Detection[],
  ctx: IssueContext,
  sizeOf?: (d: Detection) => readonly [number, number] | undefined,
): BatchPlan {
  const r = acceptMany(list, ctx, sizeOf);
  return {
    accept: r.accepted.length,
    skip: r.skipped.length,
    reject: list.filter((d) => d.status === 'draft').length,
  };
}

const n = (count: number, one: string) => `${String(count)} ${one}${count === 1 ? '' : 's'}`;
export const acceptLabel = (count: number) => `Accept ${n(count, 'detection')}`;
export const rejectLabel = (count: number) => `Reject ${n(count, 'detection')}`;

export type UndoStep = 'none' | 'review' | 'with-issues' | 'blocked';

/** What undo may do with the review's last change, given the issue editor's undo label. */
export function undoStep(top: ReviewChange | undefined, editorLabel: string | null): UndoStep {
  if (!top) return 'none';
  if (!top.issues) return 'review';
  return editorLabel === top.label ? 'with-issues' : 'blocked';
}
```

- [ ] **Step 4: Run the pure test**

Run: `pnpm vitest run apps/desktop/src/renderer/detections/batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing confirm test**

`apps/desktop/src/renderer/detections/BatchConfirm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchConfirm } from './BatchConfirm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
});

function render(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

describe('Accept all confirm', () => {
  it('asks to accept N and says how many are skipped', () => {
    const onConfirm = vi.fn();
    const el = render(
      <BatchConfirm
        kind="accept"
        plan={{ accept: 4, skip: 2, reject: 6 }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(el.textContent).toContain('Accept 4 detections as issues?');
    expect(el.textContent).toContain('2 have no class or severity and will be skipped.');
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="det-batch-ok"]')?.click();
    });
    expect(onConfirm).toHaveBeenCalled();
  });

  it('says nothing about skips when there are none; Reject asks for the waiting count', () => {
    const onCancel = vi.fn();
    const el = render(
      <BatchConfirm
        kind="reject"
        plan={{ accept: 1, skip: 0, reject: 1 }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(el.textContent).toContain('Reject 1 detection?');
    expect(el.textContent).not.toContain('skipped');
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="det-batch-cancel"]')?.click();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Implement BatchConfirm, store functions, header**

`apps/desktop/src/renderer/detections/BatchConfirm.tsx`:

```tsx
import { useFocusTrap, useT } from '@aio/ui';
import { useRef } from 'react';
import type { BatchPlan } from './batch';

/** The question before Accept all or Reject all acts on the list on screen. */
export function BatchConfirm({
  kind,
  plan,
  onConfirm,
  onCancel,
}: {
  kind: 'accept' | 'reject';
  plan: BatchPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: onCancel });
  return (
    <div
      ref={ref}
      className="det-batch-confirm"
      role="alertdialog"
      aria-modal="true"
      data-testid="det-batch-confirm"
    >
      <p>
        {kind === 'accept'
          ? t('det.acceptAll.confirm', { count: plan.accept })
          : t('det.rejectAll.confirm', { count: plan.reject })}
      </p>
      {kind === 'accept' && plan.skip > 0 && (
        <p className="faint">{t('det.acceptAll.skip', { count: plan.skip })}</p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn ghost sm"
          data-testid="det-batch-cancel"
          onClick={onCancel}
        >
          {t('det.batch.cancel')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          data-testid="det-batch-ok"
          autoFocus
          onClick={onConfirm}
        >
          {kind === 'accept' ? t('det.accept') : t('det.reject')}
        </button>
      </div>
    </div>
  );
}
```

Append to `apps/desktop/src/renderer/detections/store.ts` (add `acceptMany` to the `@aio/annotate/detections` import, `import { t } from '@aio/ui';` is already there, and `import { acceptLabel, planBatch, rejectLabel, undoStep, type BatchPlan } from './batch';`):

```ts
const sizeOf = (d: Detection) => imageSizes.get(sourceKey(d.source));

/** What Accept all and Reject all would do with `list` (the filtered list on screen). */
export function planFor(list: readonly Detection[]): BatchPlan {
  return planBatch(list, issueEditor.context(), sizeOf);
}

/**
 * Accept all: every waiting detection of `list` that can be accepted becomes a draft issue, as one
 * issue editor command and one review change of the same label (one Ctrl+Z undoes both).
 */
export function acceptAll(
  list: readonly Detection[],
): { accepted: number; skipped: number } | { error: string } {
  const s = detections.getState();
  if (s.readOnly) return { error: t('det.save.readOnly') };
  const r = acceptMany(list, issueEditor.context(), sizeOf);
  if (r.accepted.length === 0) return { accepted: 0, skipped: r.skipped.length };
  const label = acceptLabel(r.accepted.length);
  const created = issueEditor.createMany(
    r.accepted.map((a) => a.input),
    label,
  );
  if (!created.ok) {
    detections.setState({ problem: null, issueError: created.error });
    return { error: created.error };
  }
  const items = r.accepted.flatMap((a, i) => {
    const issue = created.value[i];
    return issue ? [{ id: a.detection.id, issueId: issue.id }] : [];
  });
  dispatch({
    type: 'acceptedMany',
    items,
    label,
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  return { accepted: items.length, skipped: r.skipped.length };
}

/** Reject all: every waiting detection of `list`, one undo step. */
export function rejectAll(list: readonly Detection[]): number {
  if (detections.getState().readOnly) return 0;
  const ids = list.filter((d) => d.status === 'draft').map((d) => d.id);
  if (ids.length === 0) return 0;
  dispatch({
    type: 'rejectMany',
    ids,
    label: rejectLabel(ids.length),
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  return ids.length;
}

/** Undo in the review: an Accept all is undone with its issues, or not at all. */
export function undoReview(): void {
  const s = detections.getState();
  const step = undoStep(s.review.past.at(-1), issueEditor.state.undoLabel);
  if (step === 'none') return;
  if (step === 'blocked') {
    detections.setState({ issueError: t('det.error.batchUndoMoved') });
    return;
  }
  if (step === 'with-issues' && !issueEditor.undo()) return;
  dispatch({ type: 'undo' });
}

/** Redo in the review: an Accept all is redone with its issues, or not at all. */
export function redoReview(): void {
  const s = detections.getState();
  const step = undoStep(s.review.future.at(-1), issueEditor.state.redoLabel);
  if (step === 'none') return;
  if (step === 'blocked') {
    detections.setState({ issueError: t('det.error.batchUndoMoved') });
    return;
  }
  if (step === 'with-issues' && !issueEditor.redo()) return;
  dispatch({ type: 'redo' });
}
```

`apps/desktop/src/renderer/screens/Detections.tsx`:

- import: `import { acceptAll, acceptCurrent, dispatch, loadDetections, planFor, rejectAll, redoReview, undoReview, useDetections } from '../detections/store';` and `import { BatchConfirm } from '../detections/BatchConfirm';`
- state next to the others: `const [batch, setBatch] = useState<'accept' | 'reject' | null>(null);`
- after `const queue = useMemo(() => queueOf(review), [review]);`:

```ts
const plan = useMemo(() => planFor(queue), [queue, classes]);
```

- in the key handler, replace `dispatch({ type: 'undo' });` with `undoReview();` and `dispatch({ type: 'redo' });` with `redoReview();`; in the undo and redo buttons' `onClick` do the same.
- after `<span className="grow" />` in the header:

```tsx
        <button
          type="button"
          className="btn sm"
          data-testid="det-accept-all"
          disabled={readOnly || plan.accept === 0}
          onClick={() => {
            setBatch('accept');
          }}
        >
          {t('det.acceptAll', { count: plan.accept })}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          data-testid="det-reject-all"
          disabled={readOnly || plan.reject === 0}
          onClick={() => {
            setBatch('reject');
          }}
        >
          {t('det.rejectAll', { count: plan.reject })}
        </button>
        {batch && (
          <BatchConfirm
            kind={batch}
            plan={plan}
            onCancel={() => {
              setBatch(null);
            }}
            onConfirm={() => {
              if (batch === 'accept') acceptAll(queue);
              else rejectAll(queue);
              setBatch(null);
            }}
          />
        )}
```

`readOnly` and `classes` are already in scope in `DetectionsScreen` (lines 78 and 311 area); if `readOnly` is read later in the function, move its `useDetections` line above the new `plan` line. The `classes` dependency makes the counts follow a new class. Header buttons show the accept count; the spec's "N = pending detections in the current filtered list" is the accept count for Accept all and the waiting count for Reject all.

Add to the screen's CSS file (the one holding `.det-h`; `grep -rn "\.det-h" apps/desktop/src/renderer --include=*.css`):

```css
.det-batch-confirm {
  position: absolute;
  top: 44px;
  right: 16px;
  z-index: 20;
  max-width: min(360px, calc(100vw - 32px));
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-2);
}
.det-batch-confirm .row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

(Use the token names that CSS file already uses for panel background, border and shadow: check with `grep -n "var(--" <that css file> | head` and swap `--bg-2`, `--line`, `--shadow-2` for the file's own names where they differ.) If `.det-h` is not `position: relative`, add `position: relative;` to it.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/detections`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/detections/batch.ts apps/desktop/src/renderer/detections/batch.test.ts apps/desktop/src/renderer/detections/BatchConfirm.tsx apps/desktop/src/renderer/detections/BatchConfirm.test.tsx apps/desktop/src/renderer/detections/store.ts apps/desktop/src/renderer/screens/Detections.tsx
git add <the css file edited in Step 6>
git commit -m "feat(desktop): Accept all and Reject all on the filtered detections, one undo step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Create a class from detections (Inspector, LocalDetect)

**Packages:** desktop renderer (detections). **Contract change:** none. **E2E:** Task 14; rerun `detect-local.spec.ts` if present in CI.

**Files:**

- Create: `apps/desktop/src/renderer/detections/createFromLabel.ts`, `apps/desktop/src/renderer/detections/createFromLabel.test.ts`
- Modify: `apps/desktop/src/renderer/detections/Inspector.tsx` (imports; unknown-class hint ~line 241; class select ~line 245-263)
- Modify: `apps/desktop/src/renderer/detections/LocalDetect.tsx` (export `mapModelClass`; mapping selects ~line 446-460)

**Interfaces:**

- Consumes: Task 6 `createClass`; Task 5 `NewClassRow`, `NEW_CLASS_OPTION`, `useNewClass`; Task 1 `Detection.suggestedNew`, keys `det.class.new`, `det.createClass`, `det.suggestedClass`; existing `loadDetections(projectId, true)`.
- Produces: `createClassFromLabel(label: string): Promise<string | null>` (null when done, else the sentence); `mapModelClass(projectId: string, raw: string, classId: string): void` exported from `LocalDetect.tsx`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/detections/createFromLabel.test.ts`:

```ts
// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reloads: [] as [string, boolean][], created: [] as string[] }));
vi.mock('../classes/store', () => ({
  createClass: (label: string) => {
    h.created.push(label);
    if (label === 'bad') return Promise.reject(new Error('Classes not saved: disk full'));
    return Promise.resolve({ id: 'spalling', label, color: '#7cc46b', severityModel: 'sev' });
  },
}));
vi.mock('./store', () => ({
  loadDetections: (id: string, force: boolean) => {
    h.reloads.push([id, force]);
    return Promise.resolve();
  },
}));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() }, useCall: vi.fn() }));

const { createClassFromLabel } = await import('./createFromLabel');
const { mapModelClass } = await import('./LocalDetect');

beforeEach(() => {
  h.reloads = [];
  h.created = [];
  window.localStorage.clear();
  workspace.setState({ project: { id: 'p', root: '/p', manifest: {} as never }, issues: [] });
});

describe('Create class from a detection word', () => {
  it('creates the class, maps the local model word, and reads the detections again', async () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.yolo',
      JSON.stringify({ Spalling: '', crack: 'crack' }),
    );
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.other',
      JSON.stringify({ spalling: 'rust' }),
    );
    expect(await createClassFromLabel('Spalling')).toBeNull();
    expect(h.created).toEqual(['Spalling']);
    expect(h.reloads).toEqual([['p', true]]);
    expect(
      JSON.parse(window.localStorage.getItem('stratlas.detect.classMap.p.yolo') ?? ''),
    ).toEqual({
      Spalling: 'spalling',
      crack: 'crack',
    });
    // a word mapped to a class on purpose is left alone
    expect(
      JSON.parse(window.localStorage.getItem('stratlas.detect.classMap.p.other') ?? ''),
    ).toEqual({
      spalling: 'rust',
    });
  });

  it('reports a refused create and reads nothing', async () => {
    expect(await createClassFromLabel('bad')).toBe('Classes not saved: disk full');
    expect(h.reloads).toEqual([]);
  });

  it('mapModelClass ignores other projects and unreadable entries', () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.q.yolo',
      JSON.stringify({ Spalling: '' }),
    );
    window.localStorage.setItem('stratlas.detect.classMap.p.broken', '{');
    mapModelClass('p', 'Spalling', 'spalling');
    expect(window.localStorage.getItem('stratlas.detect.classMap.q.yolo')).toBe('{"Spalling":""}');
    expect(window.localStorage.getItem('stratlas.detect.classMap.p.broken')).toBe('{');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/detections/createFromLabel.test.ts`
Expected: FAIL (module not found, `mapModelClass` not exported).

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/detections/LocalDetect.tsx`, after `writeStore`:

```ts
/**
 * A class was made from a model's word (Create class in the review): every local model of this
 * project that keeps that word as it is ("keep the name") now maps it to the new class. A word
 * mapped to a class on purpose is left alone.
 */
export function mapModelClass(projectId: string, raw: string, classId: string): void {
  const prefix = `stratlas.detect.classMap.${projectId}.`;
  let keys: string[];
  try {
    keys = Object.keys(window.localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return;
  }
  const word = raw.trim().toLowerCase();
  for (const key of keys) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(readStore(key) ?? '{}') as Record<string, string>;
    } catch {
      continue;
    }
    const hit = Object.keys(map).find((k) => k.trim().toLowerCase() === word);
    if (hit === undefined || map[hit]) continue;
    writeStore(key, JSON.stringify({ ...map, [hit]: classId }));
  }
}
```

`apps/desktop/src/renderer/detections/createFromLabel.ts`:

```ts
import { workspace } from '@aio/workspace';
import { createClass } from '../classes/store';
import { mapModelClass } from './LocalDetect';
import { loadDetections } from './store';

/**
 * Create class 'X' (ANN-7): the class named by a detection's word, then every detection with that
 * word resolves to it (the passes are read again; the resolver matches labels) and local models
 * map the word to it. Null when done, else why not.
 */
export async function createClassFromLabel(label: string): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  let classId: string;
  try {
    classId = (await createClass(label)).id;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  mapModelClass(project.id, label, classId);
  await loadDetections(project.id, true);
  return null;
}
```

`Inspector.tsx`:

- imports: add `NEW_CLASS_OPTION, NewClassRow, useNewClass` to the `@aio/annotate` import; `import { createClassFromLabel } from './createFromLabel';`
- in the component, next to the other hooks:

```ts
const { create, disabledReason } = useNewClass();
const [newOpen, setNewOpen] = useState(false);
const [creating, setCreating] = useState(false);
const [createError, setCreateError] = useState<string | null>(null);
```

(`useState` is already imported. Keep hooks above any early return in the component.)

- replace the unknown-class hint (`{d.label && d.classId === '' && (...)}`) with:

```tsx
{
  d.label && d.classId === '' && (
    <div className="det-newclass" data-testid="det-unknown-class">
      <p className="ann-faint">
        {d.suggestedNew
          ? t('det.suggestedClass', { label: d.label })
          : t('det.modelSaid', { label: d.label })}
      </p>
      {!locked && create && (
        <button
          type="button"
          className="ann-btn"
          data-testid="det-create-class"
          disabled={disabledReason !== null || creating}
          title={disabledReason ?? ''}
          onClick={() => {
            const word = d.label;
            if (!word) return;
            setCreating(true);
            void createClassFromLabel(word).then((e) => {
              setCreating(false);
              setCreateError(e);
            });
          }}
        >
          {t('det.createClass', { label: d.label })}
        </button>
      )}
      {createError && (
        <p className="ann-err" role="alert">
          {createError}
        </p>
      )}
    </div>
  );
}
```

- in the class select, change `onChange` and add the option:

```tsx
            onChange={(e) => {
              if (e.target.value === NEW_CLASS_OPTION) {
                setNewOpen(true);
                return;
              }
              p.onPatch({ classId: e.target.value });
            }}
          >
            <option value="">{t('det.class.pick')}</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            {create && <option value={NEW_CLASS_OPTION}>{t('det.class.new')}</option>}
          </select>
        </label>
        {newOpen && create && !locked && (
          <NewClassRow
            startOpen
            onCreate={create}
            disabledReason={disabledReason}
            testId="det-new-class"
            onCancel={() => {
              setNewOpen(false);
            }}
            onCreated={(cls) => {
              setNewOpen(false);
              p.onPatch({ classId: cls.id });
            }}
          />
        )}
```

`LocalDetect.tsx` mapping selects: import `NEW_CLASS_OPTION, NewClassRow, useNewClass` from `@aio/annotate`; add `const { create, disabledReason } = useNewClass();` and `const [newFor, setNewFor] = useState<string | null>(null);` in the component; in each mapping select, change `onChange` to

```tsx
                        onChange={(e) => {
                          if (e.target.value === NEW_CLASS_OPTION) {
                            setNewFor(c);
                            return;
                          }
                          setClass(c, e.target.value);
                        }}
```

add `{create && <option value={NEW_CLASS_OPTION}>{t('det.class.new')}</option>}` after the project classes, and after the `</select>`:

```tsx
{
  newFor === c && create && (
    <NewClassRow
      startOpen
      onCreate={create}
      disabledReason={disabledReason}
      testId="det-local-new-class"
      onCancel={() => {
        setNewFor(null);
      }}
      onCreated={(cls) => {
        setNewFor(null);
        setClass(c, cls.id);
      }}
    />
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/detections`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/detections/createFromLabel.ts apps/desktop/src/renderer/detections/createFromLabel.test.ts apps/desktop/src/renderer/detections/Inspector.tsx apps/desktop/src/renderer/detections/LocalDetect.tsx
git commit -m "feat(desktop): create a class from a detection's word, in the inspector and local model mapping" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: AI Detect proposes new classes

**Packages:** `@aio/ai` (detect), desktop renderer (convert, dialog), e2e strings. **Contract change:** prompt version `detect-v2` (recorded in the Task 13 row). **E2E:** `detections.spec.ts` strings updated (runs only with the real project, `@realdata`).

**Files:**

- Modify: `packages/ai/src/detect.ts` (`DETECT_PROMPT_VERSION` line 13; `detectInstructions` ~line 41-68; `AiDetection` ~line 150; `parseDetectReply` ~line 236-239)
- Modify: `packages/ai/src/detect.test.ts` (append tests)
- Modify: `apps/desktop/src/renderer/detections/convert.ts` (`toDraftDetections` ~line 51-115; `promptTaxonomy` ~line 121-143)
- Modify: `apps/desktop/src/renderer/detections/convert.test.ts` (append tests)
- Modify: `apps/desktop/src/renderer/detections/AiDetectDialog.tsx:161`
- Modify: `apps/desktop/e2e/detections.spec.ts` lines 139, 189, 219 (`detect-v1` to `detect-v2`)

**Interfaces:**

- Consumes: annotate `Detection.suggestedNew` (Task 1).
- Produces: `AiDetection.suggestedNew?: boolean | undefined`; `DETECT_PROMPT_VERSION = 'detect-v2'`; `topModelId(models, catalogues): string | undefined` exported from `convert.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ai/src/detect.test.ts` (it already imports `parseDetectReply`, `detectInstructions` and defines `classes`; add `detectInstructions` to its import if missing):

```ts
describe('new classes (ANN-7)', () => {
  it('asks for new:<short name> when no class fits', () => {
    const text = detectInstructions({ classes: [{ id: 'crack', label: 'Crack' }] });
    expect(text).toContain('"class":"new:<short name>"');
  });

  it('reads new:<name> as a suggested class, and a known name as that class', () => {
    const r = parseDetectReply(
      '{"images":[{"image":1,"detections":[' +
        '{"class":"new: Spalling ","box":[0.1,0.1,0.2,0.2]},' +
        '{"class":"NEW:moderate","box":[0.3,0.3,0.2,0.2]},' +
        '{"class":"new:","box":[0.5,0.5,0.2,0.2]}' +
        ']}]}',
      1,
      classes,
    );
    if (typeof r === 'string') throw new Error(r);
    expect(r.results[0]?.map((d) => [d.classId, d.label, d.suggestedNew])).toEqual([
      ['', 'Spalling', true],
      ['moderate', 'moderate', undefined],
    ]);
    expect(r.warnings).toEqual(['Image 1: one proposal named no class and was skipped.']);
  });
});
```

If the fixture `classes` in `detect.test.ts` does not have a class whose id or label is `moderate`, use one of its ids in the second detection and in the expectation.

Append to `apps/desktop/src/renderer/detections/convert.test.ts`, inside the existing top-level `describe` or as a new one (reuse the file's `convert` helper and `frame` item):

```ts
it('keeps a suggested new class with its severity on the most used model', () => {
  const { detections } = convert([
    {
      key: itemKey(frame),
      detections: [
        { classId: '', label: 'Spalling', suggestedNew: true, box: [0, 0, 0.5, 0.5], severity: 2 },
      ],
    },
  ]);
  expect(detections[0]).toMatchObject({
    classId: '',
    label: 'Spalling',
    suggestedNew: true,
    severity: 2,
  });
});
```

(The fixture model `aik` has a level 2; if not, use a level value it has.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/ai/src/detect.test.ts apps/desktop/src/renderer/detections/convert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ai/src/detect.ts`:

- `export const DETECT_PROMPT_VERSION = 'detect-v2';`
- in `detectInstructions`, replace the `Classes (JSON, use the id)` line with:

```ts
    input.classes.length > 0
      ? `Classes (JSON, use the id): ${JSON.stringify(classes)}`
      : 'The project has no classes yet.',
    'If none of these classes fit a defect you see clearly, use "class":"new:<short name>" with a short name of two to four words. A person decides whether to create that class.',
```

- in `AiDetection`, after `label: string;`:

```ts
  /** The model asked for a new class (`new:<name>`); `label` is the name. */
  suggestedNew?: boolean | undefined;
```

- in `parseDetectReply`, replace the three lines from `const word = r.data.class.trim();` to `const out: AiDetection = { classId, label: word };` with:

```ts
const said = r.data.class.trim();
const proposed = NEW_CLASS.test(said);
const word = proposed ? said.replace(NEW_CLASS, '').trim().slice(0, 60) : said;
if (!word) {
  warnings.push(`Image ${String(img.image)}: one proposal named no class and was skipped.`);
  continue;
}
const key = word.toLowerCase();
const classId = byId.get(key) ?? byLabel.get(key) ?? '';
const out: AiDetection = { classId, label: word };
if (proposed && !classId) out.suggestedNew = true;
```

and above the function: `const NEW_CLASS = /^new\s*:\s*/i;`

`apps/desktop/src/renderer/detections/convert.ts`:

- add, above `toDraftDetections`:

```ts
/** The severity model most classes use (the one sent with a request), else the first. */
export function topModelId(
  models: readonly SeverityModel[],
  catalogues: readonly ClassCatalogue[],
): string | undefined {
  const uses = new Map<string, number>();
  for (const c of catalogues.flatMap((k) => k.classes)) {
    uses.set(c.severityModel, (uses.get(c.severityModel) ?? 0) + 1);
  }
  const top = [...uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (models.find((m) => m.id === top) ?? models[0])?.id;
}
```

- in `promptTaxonomy`, replace the four lines computing `uses`, `top` and `model` with `const model = models.find((m) => m.id === topModelId(models, catalogues));`
- in `toDraftDetections`, before the results loop: `const fallbackModel = models.get(topModelId(o.models, o.catalogues) ?? '');` and change `const model = cls ? models.get(cls.severityModel) : undefined;` to `const model = cls ? models.get(cls.severityModel) : a.suggestedNew ? fallbackModel : undefined;`; after `if (a.confidence !== undefined) d.confidence = a.confidence;` add `if (a.suggestedNew && !cls) d.suggestedNew = true;`

`AiDetectDialog.tsx:161`: `const canSend = ready && items.length > 0 && !running;` (a project without classes can now ask; the model proposes new ones). Keep the `noClasses` variable only if it is still used for a hint; otherwise remove it.

`apps/desktop/e2e/detections.spec.ts`: change `detect-v1` to `detect-v2` on lines 139, 189 and 219.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/ai/src/detect.test.ts apps/desktop/src/renderer/detections/convert.test.ts apps/desktop/src/renderer/detections/runner.test.ts`
Expected: PASS (runner fixtures carry their own `promptVersion` strings and do not depend on the constant).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/detect.ts packages/ai/src/detect.test.ts apps/desktop/src/renderer/detections/convert.ts apps/desktop/src/renderer/detections/convert.test.ts apps/desktop/src/renderer/detections/AiDetectDialog.tsx apps/desktop/e2e/detections.spec.ts
git commit -m "feat(ai): AI Detect may propose a new class (new:<name>, prompt detect-v2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The assistant's `propose_class` tool

**Packages:** `@aio/ai`, desktop renderer (agent hooks). **Contract change:** none (tool catalogue is internal to `@aio/ai`). **E2E:** rerun `agent.spec.ts`.

**Files:**

- Modify: `packages/ai/src/tools.ts` (`toolInputs` after `create_issue_draft` ~line 256; `BUILT_IN` after the `create_issue_draft` spec ~line 451)
- Modify: `packages/ai/src/tool-kit.ts` (`AppHooks` ~line 122-154; `issueClasses` error ~line 338)
- Create: `packages/ai/src/class-tools.ts`, `packages/ai/src/class-tools.test.ts`
- Modify: `packages/ai/src/renderer-tools.ts` (add `import './class-tools';` beside `import './camera-tools';`)
- Modify: `packages/ai/src/AgentPanel.tsx` (`describeStep` ~line 753), `packages/ai/src/AgentPanel.test.tsx` (append)
- Modify: `packages/ai/src/tool-kit.test.ts` (the "no issue classes yet" expectation ~line 74-75)
- Modify: `apps/desktop/src/renderer/agent/hooks.ts` (`registerAgentHooks` ~line 202)

**Interfaces:**

- Consumes: Task 6 `createClass(label)`.
- Produces: tool `propose_class` with input `{ label: string }` (1 to 60 chars), risk `write` (the agent card asks for approval before it runs), result `{ classId, label, created: boolean }`; `AppHooks.createClass?: (label: string) => Promise<{ id: string; label: string }>`.

- [ ] **Step 1: Write the failing test**

`packages/ai/src/class-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureWorkspace } from './test-fixtures';
import { approvalFor } from './tools';
import { registerAppHooks } from './tool-kit';

function ctx(ws = fixtureWorkspace()): RendererToolContext {
  return {
    workspace: ws,
    window: 'issues',
    scene: () => null,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-15T12:00:00Z'),
  };
}

describe('propose_class', () => {
  it('asks a person before it runs', () => {
    expect(approvalFor('propose_class')).toBe(true);
  });

  it('answers with an existing class (any case) without creating one', async () => {
    const r = await runRendererTool('propose_class', { label: 'CORROSION' }, ctx());
    expect(r.result).toEqual({ classId: 'corrosion', label: 'Corrosion', created: false });
  });

  it('creates the class through the app once approved', async () => {
    const asked: string[] = [];
    const off = registerAppHooks({
      createClass: (label) => {
        asked.push(label);
        return Promise.resolve({ id: 'spalling', label });
      },
    });
    try {
      const r = await runRendererTool('propose_class', { label: 'Spalling' }, ctx());
      expect(asked).toEqual(['Spalling']);
      expect(r.result).toEqual({ classId: 'spalling', label: 'Spalling', created: true });
      expect(r.summary).toBe('Created class Spalling');
    } finally {
      off();
    }
  });

  it('says so when the app cannot create classes', async () => {
    await expect(runRendererTool('propose_class', { label: 'Spalling' }, ctx())).rejects.toThrow(
      'This app cannot create classes.',
    );
  });
});
```

If the fixture class label is not `Corrosion` (`fixtureManifest` in `test-fixtures.ts`), use its exact label; the fixture has ids `corrosion` and `coating`.

Append to `packages/ai/src/AgentPanel.test.tsx`:

```tsx
describe('describeStep for propose_class', () => {
  it('asks to create the named class', () => {
    expect(describeStep({ name: 'propose_class', input: { label: 'Spalling' } })).toBe(
      "Create class 'Spalling'?",
    );
  });
});
```

(add `describeStep` to that file's import from `./AgentPanel` if missing).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/ai/src/class-tools.test.ts packages/ai/src/AgentPanel.test.tsx`
Expected: FAIL (unknown tool).

- [ ] **Step 3: Implement**

`packages/ai/src/tools.ts`, in `toolInputs` after `create_issue_draft`:

```ts
  propose_class: z
    .object({
      label: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe('Short name of a new issue class (two to four words)'),
    })
    .strict(),
```

and in `BUILT_IN` after the `create_issue_draft` spec:

```ts
  spec('propose_class', {
    description:
      'Propose a new issue class when no class of the project fits a finding. A person approves it before it exists; an existing class with that name is returned instead.',
    scope: 'project',
    risk: 'write',
  }),
```

(No `COMPACT_TOOLS` entry: the compact profile stays at its tool budget.)

`packages/ai/src/tool-kit.ts`, in `AppHooks`:

```ts
  /** Create an issue class in the open project (after the person approved `propose_class`). */
  createClass?: (label: string) => Promise<{ id: string; label: string }>;
```

and in `issueClasses` the error becomes:

```ts
throw new ToolError(
  'This project has no issue classes yet. Propose one with propose_class; a person confirms it.',
);
```

Update the expectation at `packages/ai/src/tool-kit.test.ts` (~line 74-75) to the new sentence.

`packages/ai/src/class-tools.ts`:

```ts
import { appHooks, define, project, ToolError } from './tool-kit';

/*
 * propose_class (ANN-7): the assistant proposes a class, the agent card asks the person
 * (risk `write`), and only then does the app create it. A name the project has is returned.
 */
define('propose_class', async (input, ctx) => {
  const label = input.label.trim();
  const classes = project(ctx).manifest.classCatalogues.flatMap((c) => c.classes);
  const same = classes.find((c) => c.label.trim().toLowerCase() === label.toLowerCase());
  if (same) {
    return {
      result: { classId: same.id, label: same.label, created: false },
      summary: `Class ${same.label} exists already`,
    };
  }
  const create = appHooks.createClass;
  if (!create) throw new ToolError('This app cannot create classes.');
  const cls = await create(label);
  return {
    result: { classId: cls.id, label: cls.label, created: true },
    summary: `Created class ${cls.label}`,
  };
});
```

(If `define` is not exported from `tool-kit.ts` but from another module, import it from where `camera-tools.ts` imports it.)

`packages/ai/src/renderer-tools.ts`: add `import './class-tools';` after `import './camera-tools';`.

`packages/ai/src/AgentPanel.tsx`, in `describeStep` after the `create_issue_draft` branch:

```ts
if (step.name === 'propose_class') {
  const label = typeof input.label === 'string' ? input.label : 'untitled';
  return `Create class '${label}'?`;
}
```

`apps/desktop/src/renderer/agent/hooks.ts`: `import { createClass } from '../classes/store';` and in `registerAppHooks({ ... })` inside `registerAgentHooks`:

```ts
    createClass: async (label) => {
      const cls = await createClass(label);
      return { id: cls.id, label: cls.label };
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/ai apps/desktop/src/renderer/agent`
Expected: PASS (including `tools.test.ts`: the full catalogue has an executor for `propose_class`; no dash characters in the description).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools.ts packages/ai/src/tool-kit.ts packages/ai/src/tool-kit.test.ts packages/ai/src/class-tools.ts packages/ai/src/class-tools.test.ts packages/ai/src/renderer-tools.ts packages/ai/src/AgentPanel.tsx packages/ai/src/AgentPanel.test.tsx apps/desktop/src/renderer/agent/hooks.ts
git commit -m "feat(ai): propose_class tool, created only after the person approves" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Classes panel in Settings

**Packages:** desktop renderer (settings). Load the `impeccable` and `frontend-design` skills first (UI work). **Contract change:** none. **E2E:** Task 14.

**Files:**

- Create: `apps/desktop/src/renderer/screens/settings/classesView.ts`, `classesView.test.ts`
- Replace: `apps/desktop/src/renderer/screens/settings/Classes.tsx`
- Create: `apps/desktop/src/renderer/screens/settings/Classes.test.tsx`, `apps/desktop/src/renderer/screens/settings/classes.css`

**Interfaces:**

- Consumes: Task 2 `classUsage`, `CLASS_PALETTE`; Task 5 `NewClassRow`; Task 6 `createClass`, `editClass`, `deleteClass`, `saveToLibrary`, `undoClassEdit`, `redoClassEdit`; `useDetections` from `../../detections/store`; `useShell` from `../../shell`; `useAnnotateReadOnly`.
- Produces: `classRows(catalogues, models, issues, detections): ClassRow[]` with `ClassRow = { cls: IssueClass; issues: number; detections: number; modelName: string }`; `moveTargets(rows: readonly ClassRow[], id: string): IssueClass[]`; `Classes()` with test ids `classes-panel`, `classes-row-<id>`, `classes-delete-<id>`, `classes-save-<id>`, `classes-delete-dialog`, `classes-move-to`, `classes-move-delete`, `classes-new`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/renderer/screens/settings/classesView.test.ts`:

```ts
import type { ClassCatalogue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { classRows, moveTargets } from './classesView';

const models: SeverityModel[] = [
  {
    id: 'sev',
    name: 'General',
    levels: [{ value: 1, label: 'Minor', color: '#000000', criteria: '' }],
  },
];
const catalogues: ClassCatalogue[] = [
  {
    id: 'cat',
    name: 'Classes',
    assetType: 'asset',
    classes: [
      { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' },
      { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'gone' },
    ],
  },
];

describe('classes view', () => {
  it('lists every class with its usage and model name', () => {
    const rows = classRows(
      catalogues,
      models,
      [{ classId: 'crack' }, { classId: 'crack' }],
      [{ classId: 'rust', status: 'draft' }],
    );
    expect(rows.map((r) => [r.cls.id, r.issues, r.detections, r.modelName])).toEqual([
      ['crack', 2, 0, 'General'],
      ['rust', 0, 1, 'gone'],
    ]);
  });

  it('offers every other class as the target of a delete', () => {
    const rows = classRows(catalogues, models, [], []);
    expect(moveTargets(rows, 'crack').map((c) => c.id)).toEqual(['rust']);
  });
});
```

`apps/desktop/src/renderer/screens/settings/Classes.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  editClass: vi.fn(() => Promise.resolve(null as string | null)),
  deleteClass: vi.fn(() => Promise.resolve(null as string | null)),
  saveToLibrary: vi.fn(() => Promise.resolve(null as string | null)),
  undoClassEdit: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../classes/store', () => ({
  createClass: vi.fn(),
  editClass: h.editClass,
  deleteClass: h.deleteClass,
  saveToLibrary: h.saveToLibrary,
  undoClassEdit: h.undoClassEdit,
  redoClassEdit: vi.fn(),
}));
vi.mock('../../detections/store', () => ({
  useDetections: <T,>(sel: (s: { projectId: string | null; review: { detections: [] } }) => T) =>
    sel({ projectId: null, review: { detections: [] } }),
}));
vi.mock('../../shell', () => ({
  useShell: <T,>(sel: (s: { pkg: null }) => T) => sel({ pkg: null }),
}));

const { Classes } = await import('./Classes');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'General',
      levels: [{ value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' }],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
};
const issue = { classId: 'rust' } as Issue;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  h.editClass.mockClear();
  h.deleteClass.mockClear();
  workspace.setState({ project: { id: 'p', root: '/p', manifest }, issues: [issue, issue] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Classes />);
  });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
});

const q = <T extends Element>(sel: string) => host?.querySelector<T>(sel) ?? null;
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Classes panel', () => {
  it('shows a row per class with its hotkey and issue count', () => {
    expect(q('[data-testid="classes-row-crack"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[aria-label="Hotkey of Crack"]')?.value).toBe('c');
    expect(q('[data-testid="classes-row-rust"]')?.textContent).toContain('2');
  });

  it('renames on Enter', async () => {
    const name = q<HTMLInputElement>('[aria-label="Name of Crack"]');
    if (!name) throw new Error('no name field');
    act(() => {
      type(name, 'Wide crack');
    });
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(h.editClass).toHaveBeenCalledWith('crack', { label: 'Wide crack' });
  });

  it('locks the severity scale of a used class', () => {
    expect(q<HTMLSelectElement>('[aria-label="Severity scale of Rust"]')?.disabled).toBe(true);
    expect(q<HTMLSelectElement>('[aria-label="Severity scale of Crack"]')?.disabled).toBe(false);
  });

  it('asks where the issues of a used class go before deleting it', async () => {
    act(() => {
      q<HTMLButtonElement>('[data-testid="classes-delete-rust"]')?.click();
    });
    const dlg = q('[data-testid="classes-delete-dialog"]');
    expect(dlg?.textContent).toContain('2 issues and 0 detections use Rust. Move them to:');
    const select = q<HTMLSelectElement>('[data-testid="classes-move-to"]');
    expect(select?.value).toBe('crack');
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="classes-move-delete"]')?.click();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('rust', 'crack');
  });

  it('deletes an unused class without asking', async () => {
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="classes-delete-crack"]')?.click();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('crack', null);
    expect(q('[data-testid="classes-delete-dialog"]')).toBeNull();
  });

  it('undoes with Ctrl+Z in the panel', () => {
    act(() => {
      q('[data-testid="classes-panel"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
      );
    });
    expect(h.undoClassEdit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/renderer/screens/settings/classesView.test.ts apps/desktop/src/renderer/screens/settings/Classes.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/screens/settings/classesView.ts`:

```ts
import { classUsage } from '@aio/annotate';
import type { ClassCatalogue, IssueClass, SeverityModel } from '@aio/schema';

export interface ClassRow {
  cls: IssueClass;
  issues: number;
  detections: number;
  /** The severity model's name, or its id when the project does not have it. */
  modelName: string;
}

export function classRows(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  issues: readonly { classId: string }[],
  detections: readonly { classId: string; status: string }[],
): ClassRow[] {
  return catalogues.flatMap((c) =>
    c.classes.map((cls) => ({
      cls,
      ...classUsage(issues, detections, cls.id),
      modelName: models.find((m) => m.id === cls.severityModel)?.name ?? cls.severityModel,
    })),
  );
}

/** The classes that can take over the issues of class `id`. */
export function moveTargets(rows: readonly ClassRow[], id: string): IssueClass[] {
  return rows.filter((r) => r.cls.id !== id).map((r) => r.cls);
}
```

Replace `apps/desktop/src/renderer/screens/settings/Classes.tsx`:

```tsx
import { CLASS_PALETTE, NewClassRow, useAnnotateReadOnly } from '@aio/annotate';
import type { ClassPatch } from '@aio/annotate';
import type { SeverityModel } from '@aio/schema';
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef, useState } from 'react';
import {
  createClass,
  deleteClass,
  editClass,
  redoClassEdit,
  saveToLibrary,
  undoClassEdit,
} from '../../classes/store';
import { useDetections } from '../../detections/store';
import { useShell } from '../../shell';
import { classRows, moveTargets, type ClassRow } from './classesView';
import './classes.css';

const NO_DETECTIONS: readonly { classId: string; status: string }[] = [];

/** Settings, Classes (ANN-7): rename, recolour, hotkey, severity scale, delete, save to library. */
export function Classes() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const detections = useDetections((s) =>
    s.projectId !== null && s.projectId === project?.id ? s.review.detections : NO_DETECTIONS,
  );
  const pkg = useShell((s) => s.pkg);
  const annotateReadOnly = useAnnotateReadOnly();
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<ClassRow | null>(null);

  if (!project) return <p className="help">{t('classes.noProject')}</p>;
  const readOnly = pkg || annotateReadOnly ? t('classes.readOnly') : null;
  const models = project.manifest.severityModels;
  const rows = classRows(project.manifest.classCatalogues, models, issues, detections);

  const run = async (id: string, p: Promise<string | null>) => {
    const e = await p;
    setError(e ? { id, text: e } : null);
  };

  return (
    <div
      className="cls-ed"
      data-testid="classes-panel"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) return;
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          void undoClassEdit();
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          void redoClassEdit();
        }
      }}
    >
      {readOnly && (
        <p className="notice warn" role="status">
          <Icon name="warn" size={14} />
          {readOnly}
        </p>
      )}
      <div className="cls-grid" role="table" aria-label={t('settings.page.classes')}>
        <div className="cls-h" role="row">
          <span role="columnheader">{t('classes.col.colour')}</span>
          <span role="columnheader">{t('classes.col.name')}</span>
          <span role="columnheader">{t('classes.col.hotkey')}</span>
          <span role="columnheader">{t('classes.col.severity')}</span>
          <span role="columnheader">{t('classes.col.issues')}</span>
          <span />
        </div>
        {rows.length === 0 && <p className="help">{t('classes.empty')}</p>}
        {rows.map((r) => (
          <ClassRowView
            key={r.cls.id}
            row={r}
            models={models}
            disabled={readOnly !== null}
            error={error?.id === r.cls.id ? error.text : null}
            onEdit={(patch) => void run(r.cls.id, editClass(r.cls.id, patch))}
            onSave={() => void run(r.cls.id, saveToLibrary(r.cls))}
            onDelete={() => {
              if (r.issues + r.detections > 0) setDeleting(r);
              else void run(r.cls.id, deleteClass(r.cls.id, null));
            }}
          />
        ))}
      </div>
      <NewClassRow
        onCreate={(label) => createClass(label)}
        onCreated={() => undefined}
        disabledReason={readOnly}
        testId="classes-new"
      />
      {deleting && (
        <DeleteDialog
          row={deleting}
          targets={moveTargets(rows, deleting.cls.id)}
          onCancel={() => {
            setDeleting(null);
          }}
          onMove={(to) => {
            const id = deleting.cls.id;
            setDeleting(null);
            void run(id, deleteClass(id, to));
          }}
        />
      )}
    </div>
  );
}

function ClassRowView({
  row,
  models,
  disabled,
  error,
  onEdit,
  onSave,
  onDelete,
}: {
  row: ClassRow;
  models: readonly SeverityModel[];
  disabled: boolean;
  error: string | null;
  onEdit: (patch: ClassPatch) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { cls } = row;
  const [name, setName] = useState(cls.label);
  const [hotkey, setHotkey] = useState(cls.hotkey ?? '');
  const [palette, setPalette] = useState(false);
  const commitName = () => {
    if (name.trim() && name.trim() !== cls.label) onEdit({ label: name });
    else setName(cls.label);
  };
  return (
    <div className="cls-row" role="row" data-testid={`classes-row-${cls.id}`}>
      <span className="cls-sw-cell">
        <button
          type="button"
          className="cls-sw"
          style={{ background: cls.color }}
          aria-label={t('classes.colour', { label: cls.label })}
          disabled={disabled}
          onClick={() => {
            setPalette(!palette);
          }}
        />
        {palette && (
          <span
            className="cls-palette"
            role="listbox"
            aria-label={t('classes.colour', { label: cls.label })}
          >
            {CLASS_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={c === cls.color}
                aria-label={c}
                style={{ background: c }}
                onClick={() => {
                  setPalette(false);
                  onEdit({ color: c });
                }}
              />
            ))}
          </span>
        )}
      </span>
      <input
        className="input"
        aria-label={t('classes.name', { label: cls.label })}
        value={name}
        maxLength={80}
        disabled={disabled}
        onChange={(e) => {
          setName(e.target.value);
        }}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitName();
          } else if (e.key === 'Escape') {
            setName(cls.label);
          }
        }}
      />
      <input
        className="input mono cls-key"
        aria-label={t('classes.hotkey', { label: cls.label })}
        value={hotkey}
        maxLength={1}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value.slice(-1);
          setHotkey(v);
          onEdit({ hotkey: v === '' ? null : v });
        }}
      />
      <select
        className="input"
        aria-label={t('classes.severity', { label: cls.label })}
        value={cls.severityModel}
        disabled={disabled || row.issues > 0}
        title={row.issues > 0 ? t('classes.severityLocked') : ''}
        onChange={(e) => {
          onEdit({ severityModel: e.target.value });
        }}
      >
        {!models.some((m) => m.id === cls.severityModel) && (
          <option value={cls.severityModel}>{row.modelName}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <span className="mono">{row.issues}</span>
      <span className="cls-acts">
        <button
          type="button"
          className="btn ghost sm"
          data-testid={`classes-save-${cls.id}`}
          onClick={onSave}
        >
          {t('classes.saveToLibrary')}
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          data-testid={`classes-delete-${cls.id}`}
          aria-label={t('classes.delete', { label: cls.label })}
          title={t('classes.delete', { label: cls.label })}
          disabled={disabled}
          onClick={onDelete}
        >
          <Icon name="trash" size={14} />
        </button>
      </span>
      {error && (
        <p className="cls-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DeleteDialog({
  row,
  targets,
  onMove,
  onCancel,
}: {
  row: ClassRow;
  targets: readonly { id: string; label: string }[];
  onMove: (to: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  useFocusTrap(ref, true, { onEscape: onCancel });
  return (
    <div className="cls-dlg-back">
      <div
        ref={ref}
        className="cls-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('classes.delete.title', { label: row.cls.label })}
        data-testid="classes-delete-dialog"
      >
        <h3>{t('classes.delete.title', { label: row.cls.label })}</h3>
        <p>
          {t('classes.delete.used', {
            issues: row.issues,
            detections: row.detections,
            label: row.cls.label,
          })}
        </p>
        <select
          className="input"
          data-testid="classes-move-to"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
          }}
        >
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="cls-dlg-f">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('classes.delete.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            data-testid="classes-move-delete"
            disabled={!to}
            onClick={() => {
              onMove(to);
            }}
          >
            {t('classes.delete.move')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

(If `trash` or `warn` is not an `IconName`, use the icon the Settings page uses for delete and warnings; `grep -n "IconName =" -A80 packages/ui/src/icons*.ts* | head -100`.)

`apps/desktop/src/renderer/screens/settings/classes.css` (use the app's tokens; check names in `screens/settings/teamServer.css` first and keep the same ones):

```css
.cls-ed {
  display: grid;
  gap: 12px;
  outline: none;
}
.cls-grid {
  display: grid;
  gap: 4px;
}
.cls-h,
.cls-row {
  display: grid;
  grid-template-columns: 40px minmax(140px, 1fr) 56px minmax(120px, 180px) 56px auto;
  gap: 8px;
  align-items: center;
}
.cls-h {
  font-size: 11px;
  text-transform: uppercase;
  opacity: 0.7;
}
.cls-sw-cell {
  position: relative;
}
.cls-sw {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid rgb(0 0 0 / 0.25);
}
.cls-palette {
  position: absolute;
  top: 28px;
  left: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(6, 20px);
  gap: 4px;
  padding: 6px;
  border-radius: 8px;
  background: var(--bg-2, #1d2128);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
}
.cls-palette button {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid rgb(0 0 0 / 0.25);
}
.cls-key {
  text-align: center;
  text-transform: lowercase;
}
.cls-acts {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.cls-err {
  grid-column: 2 / -1;
  margin: 0;
  color: var(--danger, #e5484d);
}
.cls-dlg-back {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 0.4);
}
.cls-dlg {
  display: grid;
  gap: 10px;
  width: min(420px, calc(100vw - 32px));
  padding: 16px;
  border-radius: 10px;
  background: var(--bg-1, #15181d);
}
.cls-dlg-f {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 900px) {
  .cls-h,
  .cls-row {
    grid-template-columns: 32px minmax(110px, 1fr) 44px minmax(100px, 140px) 40px auto;
  }
}
```

The Settings window is at least 1100 px wide in CI; the panel must not scroll sideways at 1100 x 720.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/screens/settings`
Expected: PASS. Then `pnpm typecheck` and `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/screens/settings/classesView.ts apps/desktop/src/renderer/screens/settings/classesView.test.ts apps/desktop/src/renderer/screens/settings/Classes.tsx apps/desktop/src/renderer/screens/settings/Classes.test.tsx apps/desktop/src/renderer/screens/settings/classes.css
git commit -m "feat(desktop): Classes page in Settings: rename, colour, hotkey, scale, delete and move, save to library" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Class library in the new-project wizard

**Packages:** desktop renderer (builder). **Contract change:** none (classes are added after creation with `builder:updateClasses`; `builder:createProject` is unchanged). **E2E:** rerun `templates.spec.ts` and `builder.spec.ts`.

**Files:**

- Create: `apps/desktop/src/renderer/builder/libraryPick.ts`, `apps/desktop/src/renderer/builder/libraryPick.test.ts`
- Modify: `apps/desktop/src/renderer/builder/NewProjectWizard.tsx` (state near the form state; step 2 ~line 533-576; `create` ~line 224-275)

**Interfaces:**

- Consumes: Task 6 `listLibrary()`, `addLibraryClasses(entries)`; Task 1 keys `builder.library.*`.
- Produces: `libraryChoices(lib: readonly LibraryClass[], template: SeverityTemplate | undefined): { cls: LibraryClass; inTemplate: boolean }[]`; `pickedEntries(lib: readonly LibraryClass[], picked: ReadonlySet<string>, template: SeverityTemplate | undefined): LibraryClass[]`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/builder/libraryPick.test.ts`:

```ts
import type { LibraryClass, SeverityTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { libraryChoices, pickedEntries } from './libraryPick';

const lib: LibraryClass[] = [
  { label: 'Crack', color: '#e5484d' },
  { label: 'Spalling', color: '#7cc46b', hotkey: 's' },
];
const template: SeverityTemplate = {
  id: 'general-inspection',
  label: 'General',
  source: 'Built in',
  model: {
    id: 'g',
    name: 'G',
    levels: [{ value: 1, label: 'Minor', color: '#000000', criteria: '' }],
  },
  catalogue: {
    id: 'c',
    name: 'C',
    assetType: 'asset',
    classes: [{ id: 'crack', label: 'crack', color: '#000000', severityModel: 'g' }],
  },
};

describe('class library in the wizard', () => {
  it('marks library classes the template has already (any case)', () => {
    expect(libraryChoices(lib, template).map((c) => [c.cls.label, c.inTemplate])).toEqual([
      ['Crack', true],
      ['Spalling', false],
    ]);
    expect(libraryChoices(lib, undefined).every((c) => !c.inTemplate)).toBe(true);
  });

  it('adds only ticked classes the template does not have', () => {
    expect(
      pickedEntries(lib, new Set(['Crack', 'Spalling']), template).map((c) => c.label),
    ).toEqual(['Spalling']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/libraryPick.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/builder/libraryPick.ts`:

```ts
import type { LibraryClass, SeverityTemplate } from '@aio/schema';

const key = (s: string) => s.trim().toLowerCase();

/** The class library as wizard choices; classes the template brings already are marked. */
export function libraryChoices(
  lib: readonly LibraryClass[],
  template: SeverityTemplate | undefined,
): { cls: LibraryClass; inTemplate: boolean }[] {
  const has = new Set((template?.catalogue?.classes ?? []).map((c) => key(c.label)));
  return lib.map((cls) => ({ cls, inTemplate: has.has(key(cls.label)) }));
}

/** The ticked library classes to add to the new project (not those the template has). */
export function pickedEntries(
  lib: readonly LibraryClass[],
  picked: ReadonlySet<string>,
  template: SeverityTemplate | undefined,
): LibraryClass[] {
  return libraryChoices(lib, template)
    .filter((c) => !c.inTemplate && picked.has(c.cls.label))
    .map((c) => c.cls);
}
```

`NewProjectWizard.tsx`:

- imports: `import type { LibraryClass } from '@aio/schema';` (merge into an existing `@aio/schema` import), `import { addLibraryClasses, listLibrary } from '../classes/store';`, `import { libraryChoices, pickedEntries } from './libraryPick';`
- state next to the form state:

```ts
const [library, setLibrary] = useState<LibraryClass[]>([]);
const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
useEffect(() => {
  let live = true;
  void listLibrary().then((l) => {
    if (live) setLibrary(l);
  });
  return () => {
    live = false;
  };
}, []);
```

(`useEffect` and `useState` are imported in the file already; add them to the React import if not.)

- in step 2, after the `</div>` that closes the severity model `b-field`, before `<p className="faint small">{t('builder.reportBranding')}</p>`:

```tsx
{
  library.length > 0 && (
    <div className="b-field" data-testid="wizard-library">
      <span>{t('builder.library.title')}</span>
      <p className="faint small">{t('builder.library.lead')}</p>
      <div className="b-list" style={{ maxHeight: 160 }}>
        {libraryChoices(library, template).map(({ cls, inTemplate }) => (
          <label key={cls.label} className="ann-check">
            <input
              type="checkbox"
              disabled={inTemplate}
              checked={inTemplate || picked.has(cls.label)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(cls.label);
                else next.delete(cls.label);
                setPicked(next);
              }}
            />
            <i
              style={{
                background: cls.color,
                width: 10,
                height: 10,
                borderRadius: 3,
                display: 'inline-block',
              }}
            />
            {cls.label}
            {inTemplate && <small className="faint"> {t('builder.library.inTemplate')}</small>}
          </label>
        ))}
      </div>
    </div>
  );
}
```

(`template` is the selected template object the summary already uses at ~line 610, `template?.label`; reuse that variable.)

- in `create`, after `await builder.getState().created(r.value.path);`:

```ts
const extra = pickedEntries(library, picked, template);
if (extra.length > 0) {
  const e = await addLibraryClasses(extra);
  if (e) {
    builder.setState({
      importResult: { items: [], error: t('builder.library.notAdded', { error: e }) },
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/builder`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/libraryPick.ts apps/desktop/src/renderer/builder/libraryPick.test.ts apps/desktop/src/renderer/builder/NewProjectWizard.tsx
git commit -m "feat(desktop): new projects offer classes from the class library" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs: guide, known limits, data conventions, contract change row

**Packages:** docs only. **Contract change:** records it. **E2E:** none. Check: `pnpm format:check` and `node tools/agent/check-public-text.mjs <files>`.

**Files:**

- Modify: `docs/guide/05-annotation-and-issues.md` (new `## Classes` section after `## Severity models` ~line 86-88)
- Modify: `docs/guide/08-building-projects.md` (`## Review detections` ~line 138-153, `## Detect with AI` ~line 155-167, `## Create a project` step on the severity model)
- Modify: `docs/KNOWN-LIMITS.md` (a bullet in the team or annotation area)
- Modify: `docs/architecture/data-conventions.md` (section 11 review fields ~line 208; a class library paragraph near the userData files or section 11)
- Modify: `docs/architecture/contract-changes.md` (append a row)

- [ ] **Step 1: Guide, chapter 5**

After the `## Severity models` paragraph in `docs/guide/05-annotation-and-issues.md`, add:

```markdown
## Classes

Each project sorts findings into classes: a name, a colour, an optional hotkey and the severity scale its issues are graded on. **Settings**, **Classes** lists the classes of the open project.

- **Rename** a class in its name field and press Enter. **Colour** opens the palette. **Hotkey** takes one letter or digit; `a` and `u` are kept for the class picker (add to the selected issue, uncertain).
- **Severity scale** can be changed while no issue uses the class.
- **Delete** a class nobody uses at once. When issues or waiting detections use it, you pick the class that takes them over; their severities move to the nearest level of that class's scale.
- **Save to my class library** keeps the class on this computer. A new project offers library classes under **From your class library**.
- **Ctrl+Z** in the page, or **Undo** on the notice, takes the last class change back.

You can also make a class while you work: choose **+ New class...** in the class picker of a new shape, in **Set class** of the Issues register, in the class field of a detection, or in the class mapping of a local model, type the name and press Enter.
```

- [ ] **Step 2: Guide, chapter 8**

In `## Review detections`, after the step that sets the class, add a step:

```markdown
5. When the detector named something the project has no class for, the inspector shows what it said and **Create class 'name'**. One click makes the class; every detection with that word takes it.
6. **Accept all (N)** turns every waiting detection in the list you are looking at (filter and minimum confidence applied) into draft issues, after a question that also says how many are skipped for lack of a class or severity. **Reject all (N)** rejects them. Each is one step: **Ctrl+Z** in the review undoes the whole batch.
```

(Renumber the following steps.) In `## Detect with AI` add:

```markdown
When none of the project's classes fits, the model may suggest a new one. The inspector shows **Suggested class: name** with **Create class**; nothing is created until you click it. The assistant can suggest a class too; it asks for your approval first.
```

- [ ] **Step 3: Known limits, data conventions, contract change**

`docs/KNOWN-LIMITS.md`, under the heading that covers team work or annotation:

```markdown
- Class changes travel with the project settings as one record: when two people edit classes at the same time, the later change wins for the whole class list.
- Undoing an Accept all in the Issues register leaves its detections accepted; undo it in the detection review to put them back to waiting.
```

`docs/architecture/data-conventions.md`, section 11, in the review fields sentence after `` `label` (the proposer's word when it matched no class), ``: add `` `suggestedNew` (the proposer asks for a new class named `label`; AI Detect `new:<name>`, prompt `detect-v2`; nothing is created until a person clicks Create class), ``. Add a paragraph at the end of section 11:

```markdown
**Classes after creation (ANN-7).** `builder:updateClasses` replaces `manifest.classCatalogues` (validated: unique catalogue and class ids, unique hotkeys, `a` and `u` reserved, severity models the project has, no class removed while `issues.json` uses it; backed up and journaled as a `manifest.json` write). New class ids are slugs of the label (`-2`, `-3` when taken). The class library on this computer is `userData/class-library.json`: `{ "schema": "aio.classLibrary/1", "classes": [{ "label", "color", "hotkey"?, "severityLevels"? }] }`, labels unique in any case; a damaged file is never overwritten.
```

`docs/architecture/contract-changes.md`, append:

```markdown
| 2026-10-15 | IPC additive: `builder:updateClasses` (`{ projectId, catalogues }` → `{ manifest, backup }`; validated: unique ids and hotkeys, `a`/`u` reserved, known severity models, no class removed while `issues.json` uses it; journaled as a `manifest.json` write), `classLibrary:list`, `classLibrary:save` (`{ cls }`), `classLibrary:remove` (`{ label }`) over `userData/class-library.json` (`aio.classLibrary/1`); new `LibraryClass` schema; detections pass entry gains optional `suggestedNew` (data-conventions section 11); AI Detect prompt `detect-v2` (`new:<name>`) | Classes on the fly and Accept all (plan `2026-10-15-class-editing`, ANN-7): inspectors and the AI record findings the catalogue does not have, classes are edited after the project is created, and a class library carries classes to new projects | `@aio/schema`, `@aio/project`, `@aio/annotate`, `@aio/ai`, desktop main, preload, renderer | founder 2026-10-15 |
```

- [ ] **Step 4: Check and commit**

Run: `npx prettier --write docs/guide/05-annotation-and-issues.md docs/guide/08-building-projects.md docs/KNOWN-LIMITS.md docs/architecture/data-conventions.md docs/architecture/contract-changes.md` then `node tools/agent/check-public-text.mjs docs/guide/05-annotation-and-issues.md docs/guide/08-building-projects.md docs/KNOWN-LIMITS.md docs/architecture/data-conventions.md docs/architecture/contract-changes.md`
Expected: no findings.

```bash
git add docs/guide/05-annotation-and-issues.md docs/guide/08-building-projects.md docs/KNOWN-LIMITS.md docs/architecture/data-conventions.md docs/architecture/contract-changes.md
git commit -m "docs: classes on the fly, Accept all, class library, contract change row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: End to end `classes.spec.ts`, affected specs, `pnpm check`

**Packages:** desktop e2e. **Contract change:** none. **E2E:** adds `apps/desktop/e2e/classes.spec.ts`; reruns `detections.spec.ts`, `inspection.spec.ts`, `issue-card.spec.ts`, `agent.spec.ts`, `templates.spec.ts`.

**Files:**

- Create: `apps/desktop/e2e/classes.spec.ts`

**Interfaces:**

- Consumes: test ids from Tasks 6, 7, 8, 11 (`class-notice`, `det-accept-all`, `det-batch-ok`, `det-create-class`, `det-class`, `det-new-class`, `classes-panel`, `classes-delete-<id>`, `classes-delete-dialog`, `classes-move-to`, `classes-move-delete`); fixtures `createDataRoot`, `launchApp`, `NetworkGuard`, `expect`, `test`, `tinyGlb`.

- [ ] **Step 1: Write the spec**

`apps/desktop/e2e/classes.spec.ts`:

```ts
/**
 * Classes on the fly and Accept all (ANN-7), end to end on a synthetic project: two small photos,
 * one severity model, classes Crack and Corrosion, two Corrosion issues and four waiting detections
 * from a local model, one of them with a word the project has no class for.
 *
 * Covers: Create class from an unknown detection word; "+ New class..." in the inspector's class
 * picker; Accept all on the filtered list and its one-step undo; rename in Settings, Classes;
 * deleting a used class while moving its issues, and Ctrl+Z bringing it back.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyGlb,
  type DataRoot,
} from './fixtures';

const ID = 'e2e-classes';
const W = 64;
const H = 48;

function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const NOW = '2026-10-15T08:00:00Z';

async function writeClassesProject(c: DataRoot): Promise<string> {
  const dir = join(c.root, 'projects', ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  await mkdir(join(dir, 'detections'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(join(dir, 'photos', 'p1.png'), png(W, H));
  await writeFile(join(dir, 'photos', 'p2.png'), png(W, H));
  const manifest = {
    schema: 'aio.project/1',
    id: ID,
    name: 'E2E classes',
    customer: 'E2E',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [
          { id: 'p1', src: { path: 'photos/p1.png' } },
          { id: 'p2', src: { path: 'photos/p2.png' } },
        ],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#ebc751', criteria: 'Plan' },
          { value: 3, label: 'Severe', color: '#f05653', criteria: 'Act' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'asset',
        classes: [
          { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
          { id: 'corrosion', label: 'Corrosion', color: '#f08a3e', severityModel: 'sev' },
        ],
      },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const issue = (id: string, code: string) => ({
    id,
    code,
    classId: 'corrosion',
    severityModelId: 'sev',
    severity: 2,
    status: 'draft',
    title: `Corrosion ${code}`,
    note: '',
    author: 'E2E',
    createdAt: NOW,
    updatedAt: NOW,
    source: 'human',
    sightings: [
      { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 2, y: 2, w: 6, h: 6 } },
    ],
  });
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify(
      { schema: 'aio.issues/1', issues: [issue('i1', 'F01'), issue('i2', 'F02')] },
      null,
      2,
    ),
  );
  const det = (id: string, photo: string, cls: string, severity: number, bbox: number[]) => ({
    id,
    photo,
    class: cls,
    severity,
    confidence: 0.9,
    status: 'draft',
    space: 'source',
    width: W,
    height: H,
    bbox,
  });
  await writeFile(
    join(dir, 'detections', 'model-e2e.json'),
    JSON.stringify(
      {
        schema: 'aio.detections/1',
        source: 'model',
        producer: 'e2e-detector',
        createdAt: NOW,
        detections: [
          det('d1', 'p1', 'crack', 2, [5, 5, 15, 15]),
          det('d2', 'p1', 'crack', 3, [30, 25, 40, 35]),
          det('d3', 'p2', 'spalling', 2, [5, 5, 15, 15]),
          det('d4', 'p2', 'crack', 1, [30, 25, 40, 35]),
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

const readManifest = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    classCatalogues: { classes: { id: string; label: string }[] }[];
  };
const classIds = async (dir: string) =>
  (await readManifest(dir)).classCatalogues.flatMap((c) => c.classes.map((k) => k.id));
const issuesOnDisk = async (dir: string) =>
  (
    JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as {
      issues: { classId: string }[];
    }
  ).issues;

const issueCount = (win: Page) =>
  win.evaluate(
    () =>
      (
        window as unknown as { __stratlas: { workspace: { getState(): { issues: unknown[] } } } }
      ).__stratlas.workspace.getState().issues.length,
  );

async function finish(app: ElectronApplication, network: NetworkGuard) {
  const outbound = await network.outbound();
  await app.close();
  expect(outbound, 'the app made network requests').toEqual([]);
}

test('classes on the fly, Accept all with one undo, rename and delete-and-move in Settings', async () => {
  test.setTimeout(180_000);
  const c = await createDataRoot();
  const dir = await writeClassesProject(c);
  const app = await launchApp(c);
  const network = new NetworkGuard();
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'E2E classes' }).click();
    await expect(win.locator('.crumbs')).toContainText('E2E classes');
    await win.locator('.nav-item', { hasText: 'Detections' }).click();
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');

    // Step to the detection whose word has no class (review order: p1 then p2, top-left first).
    const inspector = win.getByTestId('det-inspector');
    await win.locator('.det-screen').focus();
    await win.keyboard.press('j');
    await win.keyboard.press('j');
    await expect(inspector.getByTestId('det-unknown-class')).toContainText('spalling');

    // 1. Create class from an unknown detection.
    await inspector.getByTestId('det-create-class').click();
    await expect(inspector.getByTestId('det-class')).toHaveValue('spalling');
    await expect(win.getByTestId('class-notice')).toContainText('Class spalling created.');
    await expect.poll(() => classIds(dir)).toEqual(['crack', 'corrosion', 'spalling']);

    // 2. "+ New class..." in the inspector's class picker.
    await win.locator('.det-screen').focus();
    await win.keyboard.press('j');
    await inspector.getByTestId('det-class').selectOption({ label: '+ New class...' });
    const field = inspector.getByTestId('det-new-class').getByRole('textbox');
    await field.fill('Hairline crack');
    await field.press('Enter');
    await expect(inspector.getByTestId('det-class')).toHaveValue('hairline-crack');
    await expect.poll(() => classIds(dir)).toContain('hairline-crack');

    // 3. Accept all on the filtered list, then one undo.
    const acceptAll = win.getByTestId('det-accept-all');
    await expect(acceptAll).toHaveText('Accept all (4)');
    await acceptAll.click();
    await expect(win.getByTestId('det-batch-confirm')).toContainText(
      'Accept 4 detections as issues?',
    );
    await win.getByTestId('det-batch-ok').click();
    await expect(win.getByTestId('det-counts')).toContainText('0 waiting');
    await expect(win.getByTestId('det-counts')).toContainText('4 accepted');
    expect(await issueCount(win)).toBe(6);
    await win.getByRole('button', { name: /^Undo review change/ }).click();
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');
    expect(await issueCount(win)).toBe(2);
    await expect.poll(async () => (await issuesOnDisk(dir)).length).toBe(2);

    // 4. Rename in Settings, Classes.
    await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
    await win.getByRole('button', { name: 'Classes', exact: true }).click();
    const panel = win.getByTestId('classes-panel');
    await expect(panel).toBeVisible();
    const name = panel.getByLabel('Name of spalling');
    await name.fill('Spalling');
    await name.press('Enter');
    await expect
      .poll(
        async () =>
          (await readManifest(dir)).classCatalogues
            .flatMap((k) => k.classes)
            .find((k) => k.id === 'spalling')?.label,
      )
      .toBe('Spalling');

    // 5. Delete a used class, moving its issues; Ctrl+Z brings both back.
    await panel.getByTestId('classes-delete-corrosion').click();
    const dialog = win.getByTestId('classes-delete-dialog');
    await expect(dialog).toContainText('2 issues and 0 detections use Corrosion. Move them to:');
    await dialog.getByTestId('classes-move-to').selectOption({ label: 'Crack' });
    await dialog.getByTestId('classes-move-delete').click();
    await expect.poll(() => classIds(dir)).not.toContain('corrosion');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).map((i) => i.classId))
      .toEqual(['crack', 'crack']);
    await panel.focus();
    await win.keyboard.press('Control+z');
    await expect.poll(() => classIds(dir)).toContain('corrosion');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).map((i) => i.classId))
      .toEqual(['corrosion', 'corrosion']);
  } finally {
    await finish(app, network);
  }
});
```

If `createDataRoot` does not clean up after itself in this usage, add `await rm(c.base, { recursive: true, force: true })` after `finish` (import `rm`), matching how other specs that call `createDataRoot()` directly clean up (`grep -n "createDataRoot()" apps/desktop/e2e/*.spec.ts`).

- [ ] **Step 2: Build and run the new spec the way CI does**

From the worktree root (PowerShell):

```powershell
pnpm demo:change --quick
cd apps/desktop
pnpm exec electron-vite build
$env:QUADRION_WINDOW_SIZE = '1100x720'
$env:QUADRION_E2E_SCALE = '1'
$env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/classes.spec.ts --workers=1
```

Expected: `[e2e] window 1100 x 720 px at display scale 1` printed, 1 passed. Then `--repeat-each=3` once to catch timing problems: `npx playwright test e2e/classes.spec.ts --workers=1 --repeat-each=3`.

- [ ] **Step 3: Rerun the affected specs, one at a time**

```powershell
npx playwright test e2e/detections.spec.ts --workers=1
npx playwright test e2e/inspection.spec.ts --workers=1
npx playwright test e2e/issue-card.spec.ts --workers=1
npx playwright test e2e/agent.spec.ts --workers=1
npx playwright test e2e/templates.spec.ts --workers=1
```

Expected: pass, or skip where real data is missing (`@realdata` specs skip without the real project; say so in the hand-off).

- [ ] **Step 4: Full checks**

From the worktree root: `pnpm check`
Expected: lint, format, typecheck and tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/classes.spec.ts
git commit -m "test(e2e): classes on the fly, Accept all and one undo, rename and delete-and-move" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## How to test (for the founder)

1. Open a project with photos and waiting detections, go to **Detections**.
2. Step to a detection whose class the project does not know: the inspector shows what the detector said and **Create class 'word'**. Click it: the class exists, the detection takes it, a notice says "Class word created." with **Undo**.
3. On another detection, open the class field and choose **+ New class...**, type a name, press Enter: the detection takes the new class.
4. Click **Accept all (N)** in the header: the question names N and how many are skipped. Accept: N draft issues appear in **Issues**. Press **Ctrl+Z** in the review: all of them are gone and the detections wait again.
5. **Reject all (N)** rejects the waiting ones; Ctrl+Z brings them back.
6. Draw a shape in the 3D view or on a photo: the class picker has **+ New class...** at the bottom.
7. **Settings**, **Classes**: rename a class, change its colour and hotkey (try `a`: it is refused with the reason), save one to your class library.
8. Delete a class that issues use: the dialog asks where they go; after Move and delete the issues have the new class. Ctrl+Z in the page brings the class and the issues back.
9. **New project**: on the severity step, **From your class library** lists the saved class; tick it and create the project: the class is in Settings, Classes.
10. In the assistant, ask it to record a finding of a kind the project has no class for: it asks "Create class 'name'?" with Approve and Reject; the class exists only after Approve.

## Self-review notes

- Spec coverage: section 1 (Tasks 1, 2, 3, 4, 6), section 2 (Tasks 5, 8), section 3 (Tasks 9, 10), section 4 (Task 11), section 5 (Tasks 4, 6, 12), section 6 (Tasks 3, 7), section 7 and Errors (Tasks 6, 13), contract changes (Tasks 1, 13), tests (each task, Task 14).
- Adjusted from the spec, with reasons:
  - The `propose_class` confirm card is the agent panel's existing approval row ("Create class 'X'?" with Reject and Approve) instead of new Create and Dismiss buttons: every `write` tool already waits for approval there, so a second card would ask twice.
  - The "new:" instruction lives in `detectInstructions` (`packages/ai/src/detect.ts`), not in `promptTaxonomy`, which returns data only; the prompt version moves to `detect-v2`, so `detections.spec.ts` strings change.
  - Accept all's confirm counts every skipped detection ("no class or severity"), because a missing severity also blocks acceptance.
  - A class's severity scale can be changed only while no issue uses it (otherwise issues would sit on a scale their class no longer has).
  - Undo after a delete restores the catalogue and the moved issues; moved detections stay on their new class (they are waiting proposals, re-classed in one review step that the review's own Ctrl+Z undoes).
  - No toast with Undo existed: Task 6 adds a small notice component; no confirm dialog existed: Tasks 7 and 11 add their own.
  - Hotkeys are limited to one letter or digit (a space or symbol would never be typed as a picker key).

/**
 * The agent's project notes (A3, plan decision 5): the executors of `remember_note` and
 * `forget_note` (specs in `@aio/ai` memory-tool-specs.ts), their approval card lines and undos.
 * The dock reads the notes through its session (`@aio/ai` session.ts), which also names the note
 * on a forget card.
 * Notes live in `<project>/ai/memory.json`; main reads and writes them (`ai:memory`,
 * `ai:remember`, `ai:forget`) and tells the fact index.
 */
import {
  ToolError,
  memoryToolInputs,
  registerRendererTool,
  registerStepDescriber,
  type RendererToolContext,
} from '@aio/ai';
import type { AgentNote } from '@aio/schema';
import { t } from '@aio/ui';
import type { Res } from '../bridge';
import { bridge } from '../shell';

type Answer = { ok: true; note: AgentNote } | { ok: false; error: string };

function answer(
  r: Res<{ ok: boolean; note?: AgentNote | undefined; error?: string | undefined }>,
  fallback: string,
): Answer {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok || !r.value.note) return { ok: false, error: r.value.error ?? fallback };
  return { ok: true, note: r.value.note };
}

/** Save a note (the agent after approval, or the person); `restore` puts a deleted one back. */
export async function rememberNote(req: {
  projectId: string;
  text: string;
  about?: string | undefined;
  by: 'agent' | 'person';
  restore?: AgentNote | undefined;
}): Promise<Answer> {
  const r = await bridge.call('ai:remember', {
    projectId: req.projectId,
    text: req.text,
    by: req.by,
    ...(req.about ? { about: req.about } : {}),
    ...(req.restore ? { restore: req.restore } : {}),
  });
  return answer(r, 'The note could not be saved.');
}

/** Delete a note; answers the deleted note, for an undo. */
export async function forgetNote(projectId: string, id: string): Promise<Answer> {
  const r = await bridge.call('ai:forget', { projectId, id });
  return answer(r, 'The note could not be deleted.');
}

function projectOf(ctx: RendererToolContext): string {
  const p = ctx.workspace.getState().project;
  if (!p) throw new ToolError('No project is open. Project notes belong to a project.');
  return p.id;
}

/** An undo that refuses in another project, and says why a write back failed. */
const undoIn =
  (ctx: RendererToolContext, projectId: string, run: () => Promise<Answer>) =>
  async (): Promise<string | null> => {
    if (ctx.workspace.getState().project?.id !== projectId) return t('agentTool.undo.otherProject');
    const r = await run();
    return r.ok ? null : t('agentTool.undo.noteFailed', { error: r.error });
  };

async function runRemember(input: unknown, ctx: RendererToolContext) {
  const { text, about } = memoryToolInputs.remember_note.parse(input);
  const projectId = projectOf(ctx);
  const r = await rememberNote({ projectId, text, about, by: 'agent' });
  if (!r.ok) throw new ToolError(r.error);
  const note = r.note;
  return {
    result: {
      saved: { id: note.id, text: note.text, ...(note.about ? { about: note.about } : {}) },
    },
    summary: t('agentTool.summary.remembered', { text: note.text }),
    undo: undoIn(ctx, projectId, () => forgetNote(projectId, note.id)),
  };
}

async function runForget(input: unknown, ctx: RendererToolContext) {
  const { id } = memoryToolInputs.forget_note.parse(input);
  const projectId = projectOf(ctx);
  const r = await forgetNote(projectId, id);
  if (!r.ok) throw new ToolError(r.error);
  const note = r.note;
  return {
    result: { deleted: { id: note.id, text: note.text } },
    summary: t('agentTool.summary.forgot', { text: note.text }),
    undo: undoIn(ctx, projectId, () =>
      rememberNote({ projectId, text: note.text, by: note.by, restore: note }),
    ),
  };
}

/** The approval card of a save: the note as it will be kept. */
export function describeRemember(input: unknown): string | null {
  const p = memoryToolInputs.remember_note.safeParse(input);
  if (!p.success) return null;
  const text = p.data.text.trim();
  // the subject is on the card too: a note about one thing steers answers about it
  return p.data.about
    ? t('agentTool.card.rememberAbout', { text, about: p.data.about })
    : t('agentTool.card.remember', { text });
}

/**
 * The approval card of a delete when the dock does not hold the note (another project's id, say):
 * its id. The dock names the note from its session's notes first (AgentPanel `describeStep`).
 */
export function describeForget(input: unknown): string | null {
  const p = memoryToolInputs.forget_note.safeParse(input);
  return p.success ? t('agentTool.card.forget', { text: p.data.id }) : null;
}

let registered = false;

/** Register the executors and card lines, once (the specs come with `@aio/ai`). */
export function registerMemoryTools(): void {
  if (registered) return;
  registered = true;
  registerRendererTool('remember_note', runRemember);
  registerRendererTool('forget_note', runForget);
  registerStepDescriber('remember_note', describeRemember);
  registerStepDescriber('forget_note', describeForget);
}

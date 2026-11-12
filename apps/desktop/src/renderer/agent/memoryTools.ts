/**
 * The agent's project notes (A3, plan decision 5): the executors of `remember_note` and
 * `forget_note` (specs in `@aio/ai` memory-tool-specs.ts), their approval card lines and undos,
 * and a small store of the open project's notes that the dock's project panel reads (T5).
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
import { createStore, useStore } from 'zustand';
import type { Res } from '../bridge';
import { bridge } from '../shell';

export interface AgentNotesView {
  /** The project the notes are of; null before the first read. */
  projectId: string | null;
  notes: AgentNote[];
  /** Notes cannot be saved or deleted (a package, or a read-only folder). */
  readOnly: boolean;
  /** The last read or write that failed, for the panel. */
  error: string | null;
}

export const agentNotes = createStore<AgentNotesView>()(() => ({
  projectId: null,
  notes: [],
  readOnly: false,
  error: null,
}));

export const useAgentNotes = <T>(pick: (s: AgentNotesView) => T): T => useStore(agentNotes, pick);

/** Read a project's notes into the store; answers them ([] when they could not be read). */
export async function loadNotes(projectId: string): Promise<AgentNote[]> {
  const r = await bridge.call('ai:memory', { projectId });
  const v = r.ok ? r.value : { ok: false, notes: [], readOnly: true, error: r.error };
  agentNotes.setState({
    projectId,
    notes: v.notes,
    readOnly: v.readOnly,
    error: v.ok ? null : (v.error ?? null),
  });
  return v.notes;
}

type Answer = { ok: true; note: AgentNote } | { ok: false; error: string };

function answer(
  r: Res<{ ok: boolean; note?: AgentNote | undefined; error?: string | undefined }>,
  fallback: string,
): Answer {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok || !r.value.note) return { ok: false, error: r.value.error ?? fallback };
  return { ok: true, note: r.value.note };
}

/** Keep the store in step after a write in the project it shows. */
function settle(projectId: string): void {
  if (agentNotes.getState().projectId === projectId) void loadNotes(projectId);
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
  const a = answer(r, 'The note could not be saved.');
  if (a.ok) settle(req.projectId);
  return a;
}

/** Delete a note; answers the deleted note, for an undo. */
export async function forgetNote(projectId: string, id: string): Promise<Answer> {
  const r = await bridge.call('ai:forget', { projectId, id });
  const a = answer(r, 'The note could not be deleted.');
  if (a.ok) settle(projectId);
  return a;
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
  return p.success ? t('agentTool.card.remember', { text: p.data.text.trim() }) : null;
}

/** The approval card of a delete: the note's text when the panel has read it, else its id. */
export function describeForget(input: unknown): string | null {
  const p = memoryToolInputs.forget_note.safeParse(input);
  if (!p.success) return null;
  const note = agentNotes.getState().notes.find((n) => n.id === p.data.id);
  return t('agentTool.card.forget', { text: note?.text ?? p.data.id });
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

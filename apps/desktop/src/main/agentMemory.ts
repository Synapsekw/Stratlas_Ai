/**
 * The agent's project memory (A3, decision 5): a few durable notes per project in
 * `<root>/ai/memory.json`, next to the conversations, so they travel with the project. Written
 * atomically, like the conversations, and like them not a journaled record: the handlers still
 * wait for the folder's open check (main's journal wraps every channel naming a project).
 *
 * A package (or a folder that cannot be written) is read-only: the notes are shown, saving and
 * deleting are refused with the reason.
 */
import {
  AGENT_MEMORY_MAX_NOTES,
  AGENT_NOTE_MAX_CHARS,
  AgentMemoryFile,
  AgentNote,
  type IpcResponse,
} from '@aio/schema';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import type { Handle } from './notYet';

export const MEMORY_FILE = join('ai', 'memory.json');
/** A memory file larger than this is not read: 30 notes of 300 characters are far smaller. */
const MAX_BYTES = 1024 * 1024;

const READ_ONLY_PACKAGE = 'This project is a read-only package, so its notes cannot be changed.';

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'the project folder is read only';
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The notes of a project folder, and why they must not be written when the file is not one this
 * build fully reads. Only a missing file is no notes: a file that is too large, not JSON, from a
 * newer version or with notes this build cannot read is shown as far as it can be read and is
 * never written over, so a save never drops the notes it could not read.
 */
export async function readMemory(
  root: string,
): Promise<{ notes: AgentNote[]; problem: string | null }> {
  const file = join(root, MEMORY_FILE);
  const unreadable = (what: string) => ({
    notes: [],
    problem: `The notes file ${what}, so the notes cannot be changed here.`,
  });
  let raw: unknown;
  try {
    if ((await stat(file)).size > MAX_BYTES) return unreadable('is too large to read');
    raw = await readJson(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { notes: [], problem: null };
    return unreadable(`could not be read (${why(e)})`);
  }
  if (raw === undefined) return { notes: [], problem: null };
  const strict = AgentMemoryFile.safeParse(raw);
  if (strict.success) return { notes: strict.data.notes, problem: null };
  const head: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const schema: string = typeof head.schema === 'string' ? head.schema : '';
  const version: string | undefined = /^aio\.agent-memory\/(\d+)$/.exec(schema)?.[1];
  if (version === undefined) return unreadable('is not a notes file');
  // the notes this build can read, for the panel and the agent
  const listed: unknown[] = Array.isArray(head.notes) ? (head.notes as unknown[]) : [];
  const notes: AgentNote[] = [];
  for (const n of listed) {
    const one = AgentNote.safeParse(n);
    if (one.success) notes.push(one.data);
  }
  return {
    notes,
    problem:
      Number(version) > 1
        ? 'These notes were saved by a newer version of the app. Update the app to change them.'
        : 'Some of these notes could not be read, so the notes cannot be changed here.',
  };
}

/** The notes of a project folder that can be read (see `readMemory`). */
export async function readNotes(root: string): Promise<AgentNote[]> {
  return (await readMemory(root)).notes;
}

async function writable(root: string): Promise<boolean> {
  try {
    await access(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function newId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `n-${BigInt(`0x${randomBytes(6).toString('hex')}`)
      .toString(36)
      .padStart(6, '0')}`;
    if (!taken.has(id)) return id;
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface MemoryProjects {
  root(projectId: string): string | undefined;
  package(projectId: string): unknown;
}

export interface MemoryDeps {
  projects: MemoryProjects;
  /** The project's notes changed: the fact index updates (`facts.changed`). */
  changed?: (projectId: string) => void;
  now?: () => Date;
}

export function createAgentMemory({ projects, changed, now = () => new Date() }: MemoryDeps) {
  // one write at a time per folder, so two quick saves never lose one another
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
    const prev = queues.get(root) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => undefined);
    queues.set(root, tail);
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root);
    });
    return next;
  }

  function open(projectId: string): { root: string } | { error: string } {
    const root = projects.root(projectId);
    return root === undefined
      ? { error: `Project "${projectId}" is not open. Open it, then try again.` }
      : { root };
  }

  async function refusal(projectId: string, root: string): Promise<string | null> {
    if (projects.package(projectId) !== undefined) return READ_ONLY_PACKAGE;
    if (!(await writable(root)))
      return 'The project folder is read only, so its notes cannot be changed.';
    return null;
  }

  async function save(root: string, notes: AgentNote[]): Promise<string | null> {
    try {
      await mkdir(join(root, 'ai'), { recursive: true });
      const file: AgentMemoryFile = { schema: 'aio.agent-memory/1', notes };
      await writeJsonAtomic(join(root, MEMORY_FILE), file);
      return null;
    } catch (e) {
      return `Could not save the notes: ${why(e)}.`;
    }
  }

  async function memory(projectId: string): Promise<IpcResponse<'ai:memory'>> {
    const r = open(projectId);
    if ('error' in r) return { ok: false, notes: [], readOnly: true, error: r.error };
    const [read, refused] = await Promise.all([readMemory(r.root), refusal(projectId, r.root)]);
    return {
      ok: true,
      notes: read.notes,
      readOnly: refused !== null || read.problem !== null,
      ...(read.problem ? { error: read.problem } : {}),
    };
  }

  async function remember(req: {
    projectId: string;
    text: string;
    about?: string | undefined;
    by: 'agent' | 'person';
    restore?: AgentNote | undefined;
  }): Promise<IpcResponse<'ai:remember'>> {
    const r = open(req.projectId);
    if ('error' in r) return { ok: false, error: r.error };
    const root = r.root;
    const refused = await refusal(req.projectId, root);
    if (refused) return { ok: false, error: refused };
    const text = (req.restore?.text ?? req.text).trim();
    if (!text) return { ok: false, error: 'The note is empty. Say what to remember.' };
    if (text.length > AGENT_NOTE_MAX_CHARS) {
      return {
        ok: false,
        error: `A note can be at most ${AGENT_NOTE_MAX_CHARS} characters; this one has ${text.length}. Make it shorter.`,
      };
    }
    // '' is no subject: the note is about the whole project
    const about = (req.restore ? req.restore.about : req.about)?.trim() ?? '';
    if (about && !AgentNote.shape.about.safeParse(about).success) {
      return {
        ok: false,
        error: `"${about}" is not a subject the notes can point to (like measurement:m-3).`,
      };
    }
    const result = await serial(root, async (): Promise<IpcResponse<'ai:remember'>> => {
      const { notes, problem } = await readMemory(root);
      if (problem) return { ok: false, error: problem };
      if (req.restore && notes.some((n) => n.id === req.restore?.id)) {
        return { ok: true, note: notes.find((n) => n.id === req.restore?.id) };
      }
      if (notes.length >= AGENT_MEMORY_MAX_NOTES) {
        return {
          ok: false,
          error: `This project already has ${AGENT_MEMORY_MAX_NOTES} notes. Forget one first.`,
        };
      }
      if (notes.some((n) => same(n.text, text))) {
        return { ok: false, error: 'This project already has that note.' };
      }
      const note: AgentNote = req.restore
        ? { ...req.restore, text, ...(about ? { about } : {}) }
        : {
            id: newId(new Set(notes.map((n) => n.id))),
            text,
            ...(about ? { about } : {}),
            by: req.by,
            createdAt: now().toISOString(),
          };
      const parsed = AgentNote.safeParse(note);
      if (!parsed.success) return { ok: false, error: 'That note could not be saved.' };
      // a restored note goes back where it was in time order
      const next = [...notes, parsed.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const failed = await save(root, next);
      return failed ? { ok: false, error: failed } : { ok: true, note: parsed.data };
    });
    if (result.ok) changed?.(req.projectId);
    return result;
  }

  async function forget(req: { projectId: string; id: string }): Promise<IpcResponse<'ai:forget'>> {
    const r = open(req.projectId);
    if ('error' in r) return { ok: false, error: r.error };
    const root = r.root;
    const refused = await refusal(req.projectId, root);
    if (refused) return { ok: false, error: refused };
    const result = await serial(root, async (): Promise<IpcResponse<'ai:forget'>> => {
      const { notes, problem } = await readMemory(root);
      if (problem) return { ok: false, error: problem };
      const note = notes.find((n) => n.id === req.id);
      if (!note) return { ok: false, error: `There is no note ${req.id} in this project.` };
      const failed = await save(
        root,
        notes.filter((n) => n.id !== req.id),
      );
      return failed ? { ok: false, error: failed } : { ok: true, note };
    });
    if (result.ok) changed?.(req.projectId);
    return result;
  }

  return { memory, remember, forget };
}

export function registerAgentMemoryIpc({ handle, ...deps }: MemoryDeps & { handle: Handle }): void {
  const store = createAgentMemory(deps);
  handle('ai:memory', ({ projectId }) => store.memory(projectId));
  handle('ai:remember', (req) => store.remember(req));
  handle('ai:forget', (req) => store.forget(req));
}

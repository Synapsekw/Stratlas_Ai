/**
 * Agent conversations saved with the project (AI-8): `<root>/ai/conversations/<id>.json`, one
 * file per conversation, written atomically. Ids are validated by the contract and checked again
 * here, so a request can never name a file outside that folder.
 */
import {
  Conversation,
  ConversationId,
  type ConversationSummary,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

export const CONVERSATIONS_DIR = join('ai', 'conversations');
/** Larger files are not listed or loaded: a conversation is text only. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LISTED = 500;

function fileOf(root: string, id: string): string | null {
  if (!ConversationId.safeParse(id).success) return null;
  return join(root, CONVERSATIONS_DIR, `${id}.json`);
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'the project folder is read only';
  }
  return e instanceof Error ? e.message : String(e);
}

async function readConversation(file: string): Promise<Conversation | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return null;
    const r = Conversation.safeParse(await readJson(file));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function summary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    window: c.window,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    turns: c.turns.length,
    pending: Object.values(c.steps).filter((s) => s.status === 'awaiting').length,
  };
}

export async function listConversations(
  root: string,
): Promise<IpcResponse<'ai:listConversations'>> {
  const dir = join(root, CONVERSATIONS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, conversations: [] };
    return { ok: false, conversations: [], error: `Could not list conversations: ${why(e)}.` };
  }
  const files = names.filter((n) => n.endsWith('.json')).slice(0, MAX_LISTED);
  const loaded = await Promise.all(files.map((n) => readConversation(join(dir, n))));
  const conversations = loaded
    .filter((c): c is Conversation => c !== null)
    .map(summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { ok: true, conversations };
}

export async function loadConversation(
  root: string,
  id: string,
): Promise<IpcResponse<'ai:loadConversation'>> {
  const file = fileOf(root, id);
  if (!file) return { ok: false, error: 'That conversation id is not valid.' };
  const c = await readConversation(file);
  if (!c)
    return { ok: false, error: 'This conversation could not be read. It may have been removed.' };
  return { ok: true, conversation: c };
}

export async function saveConversation(
  root: string,
  conversation: Conversation,
): Promise<IpcResponse<'ai:saveConversation'>> {
  const file = fileOf(root, conversation.id);
  if (!file) return { ok: false, error: 'That conversation id is not valid.' };
  const body = JSON.stringify(conversation);
  if (body.length > MAX_BYTES) {
    return { ok: false, error: 'This conversation is too long to save. Start a new one.' };
  }
  try {
    await mkdir(join(root, CONVERSATIONS_DIR), { recursive: true });
    await writeJsonAtomic(file, conversation);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not save the conversation: ${why(e)}.` };
  }
}

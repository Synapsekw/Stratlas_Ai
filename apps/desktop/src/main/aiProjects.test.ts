import type { Conversation } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiProjectStore, projectKey, readAiPolicy } from './aiProjects';
import { listConversations, loadConversation, saveConversation } from './conversations';
import { sampleManifest, writeProject } from './testing';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-ai-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    schema: 'aio.conversation/1',
    id: 'c1',
    title: 'Draft it',
    window: 'scene3d',
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:05:00.000Z',
    turns: [{ kind: 'user', id: 'u1', text: 'Draft it', chips: [], frame: false }],
    steps: {
      k1: {
        callId: 'k1',
        name: 'create_issue_draft',
        input: { title: 'Rust' },
        risk: 'write',
        status: 'awaiting',
        canUndo: false,
      },
    },
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true },
    ...over,
  };
}

describe('conversations in the project', () => {
  it('saves, lists newest first with pending approvals, and loads', async () => {
    const root = await writeProject(join(dir, 'p'));
    expect(await listConversations(root)).toEqual({ ok: true, conversations: [] });
    expect(await saveConversation(root, conversation())).toEqual({ ok: true });
    expect(
      await saveConversation(
        root,
        conversation({
          id: 'c2',
          title: 'Later',
          updatedAt: '2026-10-04T11:00:00.000Z',
          steps: {},
        }),
      ),
    ).toEqual({ ok: true });
    const listed = await listConversations(root);
    expect(listed.conversations.map((c) => [c.id, c.pending])).toEqual([
      ['c2', 0],
      ['c1', 1],
    ]);
    const raw = JSON.parse(
      await readFile(join(root, 'ai', 'conversations', 'c1.json'), 'utf8'),
    ) as Conversation;
    expect(raw.steps.k1?.status).toBe('awaiting');
    const loaded = await loadConversation(root, 'c1');
    expect(loaded.conversation?.title).toBe('Draft it');
  });

  it('refuses ids that leave the folder and skips broken files', async () => {
    const root = await writeProject(join(dir, 'p'));
    expect(await loadConversation(root, '../manifest')).toMatchObject({ ok: false });
    expect(await saveConversation(root, conversation({ id: '..\\x' }))).toMatchObject({
      ok: false,
    });
    await mkdir(join(root, 'ai', 'conversations'), { recursive: true });
    await writeFile(join(root, 'ai', 'conversations', 'bad.json'), '{ nope');
    expect((await listConversations(root)).conversations).toEqual([]);
  });
});

describe('per-project AI store', () => {
  it('keeps consent and usage per project folder', async () => {
    const file = join(dir, 'ai-projects.json');
    const store = createAiProjectStore(file, {
      now: () => new Date('2026-10-04T10:00:00Z'),
      writeDelayMs: 0,
    });
    expect(await store.get('E:/P')).toEqual({ alwaysAllow: false, usage: [] });
    await store.setConsent('E:/P', 'Plant', true);
    store.addUsage('E:/P', 'Plant', {
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.5,
    });
    store.addUsage('E:/P', 'Plant', { provider: 'local', inputTokens: 5, outputTokens: 1 });
    await store.flush();
    await new Promise((r) => setTimeout(r, 5));
    await store.flush();
    expect(await store.get('E:/P')).toMatchObject({ alwaysAllow: true });
    const reopened = createAiProjectStore(file);
    expect(await reopened.list()).toEqual([
      {
        key: projectKey('E:/P'),
        name: 'Plant',
        updatedAt: '2026-10-04T10:00:00.000Z',
        providers: [
          {
            provider: 'anthropic',
            inputTokens: 10,
            outputTokens: 2,
            costUsd: 0.5,
            costKnown: true,
          },
          { provider: 'local', inputTokens: 5, outputTokens: 1, costUsd: 0, costKnown: true },
        ],
      },
    ]);
  });

  it('treats folders that differ only in case as one project on Windows', () => {
    expect(projectKey('E:\\Data\\P', 'win32')).toBe(projectKey('e:\\data\\p', 'win32'));
  });
});

describe('package AI policy', () => {
  it('reads aiPolicy forbid from the raw manifest, top level or under package', async () => {
    const a = await writeProject(join(dir, 'a'), { ...sampleManifest(), aiPolicy: 'forbid' });
    const b = await writeProject(join(dir, 'b'), {
      ...sampleManifest(),
      package: { aiPolicy: 'forbid' },
    });
    const c = await writeProject(join(dir, 'c'));
    expect(await readAiPolicy(a)).toBe('forbid');
    expect(await readAiPolicy(b)).toBe('forbid');
    expect(await readAiPolicy(c)).toBe('allow');
    expect(await readAiPolicy(join(dir, 'missing'))).toBe('allow');
  });
});

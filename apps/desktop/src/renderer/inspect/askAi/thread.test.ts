// @vitest-environment jsdom
import type { IpcRequest, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state: { ask: IpcRequest<'ai:ask'>[]; reply: unknown; prepared: number } = {
    ask: [],
    reply: null,
    prepared: 0,
  };
  return state;
});

vi.mock('../../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore(() => ({ jobs: [] })),
    bridge: {
      call: (channel: string, req: unknown) => {
        if (channel === 'ai:ask') {
          h.ask.push(req as IpcRequest<'ai:ask'>);
          return Promise.resolve(h.reply);
        }
        return Promise.resolve({ ok: false, error: 'not in this test' });
      },
    },
  };
});
vi.mock('../../detections/prepare', () => ({
  prepareItem: () => {
    h.prepared += 1;
    return Promise.resolve({ dataUrl: 'data:image/jpeg;base64,x', width: 4000, height: 3000 });
  },
}));

const { detections } = await import('../../detections/store');
const { askThread, askInThread, answerToDraft, resetThread } = await import('./thread');
const { skipCloudConfirm } = await import('./prefs');

const MANIFEST = {
  layers: [{ kind: 'photos', id: 'ph', name: 'Photos', items: [] }],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;
const PHOTO = { kind: 'photo' as const, layer: 'ph', photo: 'p1' };
const SONNET = {
  kind: 'cloud' as const,
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5-5',
};

const said = (text: string) => ({
  ok: true,
  value: {
    ok: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    promptVersion: 'ask-v1',
    items: [],
    text,
    inputTokens: 10,
    outputTokens: 5,
    warnings: [],
  },
});
const ask = (text: string, over: object = {}) =>
  askInThread({
    projectId: 'p',
    manifest: MANIFEST,
    item: PHOTO,
    text,
    route: SONNET,
    ...over,
  });

beforeEach(() => {
  h.ask = [];
  h.prepared = 0;
  window.localStorage.clear();
  resetThread();
  workspace.setState({
    project: { id: 'p', root: '/projects/p', manifest: MANIFEST },
    issues: [],
  } as never);
  detections.setState({
    projectId: 'p',
    readOnly: false,
    review: { ...detections.getState().review, detections: [], runs: [] },
  });
});

describe('Ask AI threads', () => {
  it('does not send the first cloud question before the person confirms', async () => {
    await expect(ask('Is the ladder safe?')).rejects.toThrow();
    expect(h.ask).toHaveLength(0);
    skipCloudConfirm('p');
    h.reply = said('It looks intact.');
    await ask('Is the ladder safe?');
    expect(h.ask).toHaveLength(1);
  });

  it('sends a follow-up with the earlier turns and the same image, without a new confirm', async () => {
    h.reply = said('The ladder looks intact.');
    await ask('Is the ladder safe?', { confirmed: true });
    expect(h.ask[0]).toMatchObject({
      kind: 'ask',
      backend: SONNET,
      prompt: 'Is the ladder safe?',
      fields: [],
      images: [{ key: 'photo:ph:p1', width: 1568, height: 1176 }],
    });
    expect(h.ask[0]?.turns).toBeUndefined();
    h.reply = said('No rust is visible on the rungs.');
    await ask('Any rust?');
    expect(h.ask[1]?.turns).toEqual([
      { role: 'user', text: 'Is the ladder safe?' },
      { role: 'assistant', text: 'The ladder looks intact.' },
    ]);
    expect(h.prepared).toBe(1);
    expect(askThread.getState()).toMatchObject({
      key: 'photo:ph:p1',
      pending: false,
      error: null,
      confirmed: true,
    });
    expect(askThread.getState().turns).toHaveLength(4);
  });

  it('a long thread keeps the first question and its answer, the oldest follow-ups drop', async () => {
    h.reply = said('Answer.');
    await ask('Question 0', { confirmed: true });
    for (let n = 1; n <= 11; n++) await ask(`Question ${String(n)}`);
    const turns = h.ask.at(-1)?.turns ?? [];
    expect(turns).toHaveLength(20);
    expect(turns[0]).toEqual({ role: 'user', text: 'Question 0' });
    expect(turns[2]).toEqual({ role: 'user', text: 'Question 2' });
    expect(turns.at(-2)).toEqual({ role: 'user', text: 'Question 10' });
    expect(h.ask.at(-1)?.prompt).toBe('Question 11');
  });

  it('another photo starts a new thread, which needs its own confirm', async () => {
    h.reply = said('Yes.');
    await ask('Is the ladder safe?', { confirmed: true });
    await expect(ask('And here?', { item: { ...PHOTO, photo: 'p2' } })).rejects.toThrow();
    expect(askThread.getState().turns).toEqual([]);
    await ask('And here?', { item: { ...PHOTO, photo: 'p2' }, confirmed: true });
    expect(h.ask.at(-1)?.turns).toBeUndefined();
    expect(askThread.getState().key).toBe('photo:ph:p2');
    expect(askThread.getState().turns).toHaveLength(2);
  });

  it('a question that does not finish leaves the thread as it was and says why', async () => {
    h.reply = { ok: true, value: { ok: false, error: 'rate limited' } };
    await ask('Is the ladder safe?', { confirmed: true });
    expect(askThread.getState()).toMatchObject({
      turns: [],
      pending: false,
      error: 'The request did not finish: rate limited',
    });
  });

  it('makes a whole-image draft from an answer, the answer as its note', async () => {
    h.reply = said('The ladder cage is bent near the top.');
    await ask('Is the ladder safe?', { confirmed: true });
    const id = await answerToDraft({ projectId: 'p', manifest: MANIFEST, item: PHOTO, turn: 1 });
    const d = detections.getState().review.detections.find((x) => x.id === id);
    expect(d).toMatchObject({
      status: 'draft',
      source: { kind: 'photo', layer: 'ph', photo: 'p1' },
      size: [4000, 3000],
      geom: { type: 'box', x: 0, y: 0, w: 4000, h: 3000 },
      classId: '',
      label: 'AI answer',
      severity: null,
      note: 'The ladder cage is bent near the top.',
      origin: { kind: 'ai', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    await expect(
      answerToDraft({ projectId: 'p', manifest: MANIFEST, item: PHOTO, turn: 0 }),
    ).rejects.toThrow();
  });
});

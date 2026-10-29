import {
  AI_REQUEST_SCHEMA,
  type AiRequest,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Handler } from '../ipc';
import { registerRequestsIpc } from './requestsIpc';

const req = (id: string): AiRequest => ({
  schema: AI_REQUEST_SCHEMA,
  id,
  name: id,
  kind: 'ask',
  prompt: 'What is this?',
  fields: [],
  scope: 'photo',
  model: 'auto',
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

let root: string;
const handlers = new Map<string, unknown>();
const call = <C extends IpcChannel>(c: C, r: IpcRequest<C>): Promise<IpcResponse<C>> =>
  Promise.resolve((handlers.get(c) as Handler<C>)(r) as Promise<IpcResponse<C>>);
let opened: string | null = null;
let savedAs: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-requests-ipc-'));
  handlers.clear();
  opened = null;
  savedAs = null;
  registerRequestsIpc({
    handle: <C extends IpcChannel>(c: C, h: Handler<C>) => {
      handlers.set(c, h);
    },
    userData: () => join(root, 'user'),
    projectDir: (id) => (id === 'p1' || id === 'pkg' ? join(root, id) : null),
    isPackage: (id) => id === 'pkg',
    chooseOpen: () => Promise.resolve(opened),
    chooseSave: () => Promise.resolve(savedAs),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('requests IPC', () => {
  it('saves, lists and removes in the project and the library', async () => {
    expect(
      await call('requests:save', { projectId: 'p1', where: 'project', request: req('aa') }),
    ).toEqual({ ok: true });
    expect(await call('requests:save', { where: 'library', request: req('bb') })).toEqual({
      ok: true,
    });
    const l = await call('requests:list', { projectId: 'p1' });
    expect(l.items.map((i) => i.where)).toEqual(['project', 'library']);
    expect(await call('requests:remove', { projectId: 'p1', where: 'project', id: 'aa' })).toEqual({
      ok: true,
    });
    expect((await call('requests:list', { projectId: 'p1' })).items).toHaveLength(1);
  });

  it('refuses a project save or remove on a package, but lists it', async () => {
    const s = await call('requests:save', {
      projectId: 'pkg',
      where: 'project',
      request: req('aa'),
    });
    expect(s).toMatchObject({ ok: false, code: 'read-only' });
    const r = await call('requests:remove', { projectId: 'pkg', where: 'project', id: 'aa' });
    expect(r).toMatchObject({ ok: false, code: 'read-only' });
    expect((await call('requests:list', { projectId: 'pkg' })).items).toEqual([]);
    expect(
      await call('requests:save', { projectId: 'pkg', where: 'library', request: req('aa') }),
    ).toEqual({ ok: true });
  });

  it('answers a failure for an unknown project', async () => {
    const s = await call('requests:save', {
      projectId: 'nope',
      where: 'project',
      request: req('aa'),
    });
    expect(s.ok).toBe(false);
  });

  it('export with the dialog closed answers ok without a path', async () => {
    await call('requests:save', { where: 'library', request: req('aa') });
    expect(await call('requests:export', { where: 'library', id: 'aa' })).toEqual({ ok: true });
  });

  it('exports to the chosen file and imports it back', async () => {
    await call('requests:save', { where: 'library', request: req('aa') });
    savedAs = join(root, 'aa.aioreq');
    expect(await call('requests:export', { where: 'library', id: 'aa' })).toEqual({
      ok: true,
      path: savedAs,
    });
    opened = savedAs;
    const i = await call('requests:import', { where: 'library' });
    expect(i).toMatchObject({ ok: true, request: { id: 'aa-2' } });
  });

  it('import with the dialog closed answers ok without a request; a package refuses a project import', async () => {
    expect(await call('requests:import', { where: 'library' })).toEqual({ ok: true });
    const r = await call('requests:import', { projectId: 'pkg', where: 'project' });
    expect(r).toMatchObject({ ok: false, code: 'read-only' });
  });
});

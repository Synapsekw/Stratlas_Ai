import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measurement, result, writeFixtureProject } from '@aio/facts/testing';
import type { FactIndexStatus } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFactService, indexFileOf, registerFactIpc } from './facts';

let tmp: string;
let root: string;
let dir: string;
let events: { projectId: string; status: FactIndexStatus }[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fact-service-'));
  root = join(tmp, 'project');
  dir = join(tmp, 'userData', 'fact-index');
  writeFixtureProject(root, { journal: true });
  events = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const service = (pkg = false) =>
  createFactService({
    dir,
    root: (id) => (id === 'p' ? root : undefined),
    isPackage: () => pkg,
    emit: (e) => events.push(e),
    openDelayMs: 0,
    changeDelayMs: 0,
  });

/** Wait for the timers, then for the queued builds. */
const settle = async (s: ReturnType<typeof service>) => {
  await new Promise((r) => setTimeout(r, 5));
  await s.idle();
};

describe('the fact index service', () => {
  it('builds on open in userData, never in the project folder', async () => {
    const s = service();
    expect(s.status('p').state).not.toBe('ready');
    s.opened('p');
    await settle(s);
    expect(s.status('p').state).toBe('ready');
    expect(existsSync(indexFileOf(dir, root))).toBe(true);
    expect(existsSync(join(root, 'fact-index'))).toBe(false);
    expect(events.map((e) => e.status.state)).toEqual(['building', 'ready']);
    const q = s.query('p', { text: 'stockpile' });
    expect('facts' in q && q.facts[0]?.subject).toBe('measurement:pile-north');
    s.closeAll();
  });

  it('updates after a change and equals a rebuild', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    writeFileSync(
      join(root, 'survey', 'measurements.json'),
      JSON.stringify({
        schema: 'aio.measurements/1',
        measurements: [measurement([result('c1', 1200), result('c2', 700)])],
      }),
    );
    s.changed('p');
    await settle(s);
    const after = s.query('p', { kinds: ['volume'], capture: 'c2' });
    expect('facts' in after && after.facts[0]?.value).toBe(700);
    // an update never shows "building": the tools stay offered
    expect(events.slice(2).every((e) => e.status.state === 'ready')).toBe(true);
    const before = s.history('p', 'measurement:pile-north');
    const status = await s.rebuild('p');
    expect(status.ok && status.status.state).toBe('ready');
    expect(s.history('p', 'measurement:pile-north')).toEqual(before);
    s.closeAll();
  });

  it('gives packages no index', async () => {
    const s = service(true);
    s.opened('p');
    await settle(s);
    expect(s.status('p').state).toBe('none');
    expect(s.query('p', {})).toEqual({ error: 'Packages have no fact index.' });
  });

  it('answers not built yet before the first build', () => {
    const s = service();
    expect(s.query('p', {})).toEqual({ error: 'The fact index of this project is not built yet.' });
    expect(s.query('other', {})).toEqual({
      error: 'The fact index of this project is not built yet.',
    });
  });

  it('forgets a deleted project and its file', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    await s.forget(root);
    expect(existsSync(indexFileOf(dir, root))).toBe(false);
  });

  it('drops a damaged index file and builds again', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    s.closeAll();
    for (const f of ['', '-wal', '-shm']) rmSync(`${indexFileOf(dir, root)}${f}`, { force: true });
    writeFileSync(indexFileOf(dir, root), 'not a database at all, just text '.repeat(200));
    const t = service();
    t.opened('p');
    await settle(t);
    expect(t.status('p').state).toBe('ready');
    t.closeAll();
  });

  it('registers the four channels', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    const handlers = new Map<string, (req: never) => unknown>();
    registerFactIpc((channel, handler) => handlers.set(channel, handler), s);
    expect([...handlers.keys()].sort()).toEqual([
      'facts:history',
      'facts:query',
      'facts:rebuild',
      'facts:status',
    ]);
    const q = (await handlers.get('facts:query')?.({
      projectId: 'p',
      query: { text: 'crack' },
    } as never)) as {
      ok: boolean;
    };
    expect(q.ok).toBe(true);
    const bad = (await handlers.get('facts:history')?.({
      projectId: 'x',
      subject: 'issue:i1',
    } as never)) as {
      ok: boolean;
    };
    expect(bad.ok).toBe(false);
    s.closeAll();
  });
});

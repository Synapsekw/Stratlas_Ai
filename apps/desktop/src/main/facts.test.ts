import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { measurement, result, writeFixtureProject } from '@aio/facts/testing';
import type { FactIndexStatus } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFactService, indexFileOf, registerFactIpc, runInProcess } from './facts';
import { createWorkerRunner } from './factsWorkerRunner';
import { validated } from './ipc';

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
    expect(s.query('p', {})).toEqual({ error: 'Packages have no fact index.', reason: 'package' });
  });

  it('answers not built yet before the first build', () => {
    const s = service();
    expect(s.query('p', {})).toMatchObject({ reason: 'not-built' });
    expect(s.query('other', {})).toMatchObject({ reason: 'not-open' });
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

  it('answers a 1,000-character issue title through the validated IPC path', async () => {
    const raw = JSON.parse(readFileSync(join(root, 'issues.json'), 'utf8')) as {
      issues: { title: string; note: string }[];
    };
    const first = raw.issues[0];
    if (!first) throw new Error('fixture has an issue');
    first.title = `Crack ${'very long words '.repeat(70)}`.slice(0, 1000);
    first.note = 'n'.repeat(5000);
    writeFileSync(join(root, 'issues.json'), JSON.stringify(raw));
    const s = service();
    s.opened('p');
    await settle(s);
    const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
    registerFactIpc((channel, handler) => {
      handlers.set(channel, validated(channel, handler));
    }, s);
    const q = (await handlers.get('facts:query')?.({
      projectId: 'p',
      query: { text: 'crack' },
    })) as {
      ok: true;
      facts: { id: string; label: string; text?: string }[];
    };
    expect(q.ok).toBe(true);
    const issue = q.facts.find((f) => f.id === 'issue:i1');
    expect(issue?.label.length).toBeLessThanOrEqual(400);
    expect(issue?.label.endsWith('...')).toBe(true);
    expect((issue?.text ?? '').length).toBeLessThanOrEqual(4000);
    const h = (await handlers.get('facts:history')?.({ projectId: 'p', subject: 'issue:i1' })) as {
      ok: boolean;
    };
    expect(h.ok).toBe(true);
    s.closeAll();
  });

  it('starts no build after closeAll', async () => {
    let jobs = 0;
    const s = createFactService({
      dir,
      root: () => root,
      isPackage: () => false,
      openDelayMs: 0,
      run: (job) => {
        if (job.kind === 'sync') jobs++;
        return runInProcess(job);
      },
    });
    s.opened('p');
    s.closeAll();
    await settle(s);
    expect(jobs).toBe(0);
    expect(s.status('p').state).toBe('none');
  });

  it('prunes on start the index files of folders that are gone', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    s.closeAll();
    const file = indexFileOf(dir, root);
    expect(existsSync(file)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    writeFileSync(join(dir, 'orphan.sqlite-wal'), 'x');
    const t = service();
    await t.idle();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
    expect(existsSync(join(dir, 'orphan.sqlite-wal'))).toBe(false);
  });

  it('keeps the index file of a folder that is still there', async () => {
    const s = service();
    s.opened('p');
    await settle(s);
    s.closeAll();
    const t = service();
    await t.idle();
    expect(existsSync(indexFileOf(dir, root))).toBe(true);
  });
});

describe('the worker runner', () => {
  /** A stand-in worker: answers with `answer`, or fails at once. */
  class FakeWorker extends EventEmitter {
    constructor(private readonly answer: 'ok' | 'fail-start') {
      super();
    }
    postMessage(m: { id: number }) {
      setTimeout(() => {
        if (this.answer === 'fail-start') this.emit('error', new Error('cannot load'));
        else this.emit('message', { id: m.id, ok: true, result: { pruned: ['x'] } });
      }, 0);
    }
    unref() {
      return this;
    }
    terminate() {
      return Promise.resolve(0);
    }
  }

  it('answers through the worker', async () => {
    const run = createWorkerRunner('w.js', {
      make: () => new FakeWorker('ok') as unknown as Worker,
    });
    expect(await run({ kind: 'prune', dir })).toEqual({ pruned: ['x'] });
  });

  it('runs in process when the worker cannot start, from then on', async () => {
    let made = 0;
    const lines: string[] = [];
    const run = createWorkerRunner('w.js', {
      make: () => {
        made++;
        return new FakeWorker('fail-start') as unknown as Worker;
      },
      fallback: () => Promise.resolve({ pruned: ['in-process'] }),
      log: (l) => lines.push(l),
    });
    expect(await run({ kind: 'prune', dir })).toEqual({ pruned: ['in-process'] });
    expect(await run({ kind: 'prune', dir })).toEqual({ pruned: ['in-process'] });
    expect(made).toBe(1);
    expect(lines[0]).toMatch(/could not start/);
  });
});

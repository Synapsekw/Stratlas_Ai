import { ChangeSet, type IpcEvent, type ProjectManifestInput } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerChangeIpc, type Archive } from './change';
import { collectHandlers } from './notYet';
import { writeProject } from './testing';

/** A synthetic two-date site (no client data): a model and a photo set per date. */
const DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const manifest: ProjectManifestInput = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Synthetic two-date site',
  crs: { epsg: 32640 },
  origin: [400000, 2700000, 0],
  captures: [
    { id: 'd1', label: 'First survey', date: '2026-03-01' },
    { id: 'd2', label: 'Second survey', date: '2026-09-01' },
  ],
  layers: ['d1', 'd2'].flatMap((d) => [
    {
      kind: 'mesh' as const,
      id: `model-${d}`,
      name: 'Site model',
      capture: d,
      src: { path: `models/${d}.glb` },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
    {
      kind: 'photos' as const,
      id: `photos-${d}`,
      name: 'Photos',
      capture: d,
      items: [
        {
          id: `${d}-p1`,
          src: { path: `photos/${d}-p1.jpg` },
          pos: [0, 50, 0],
          q: DOWN,
          lens: { model: 'pinhole' as const, hfovDeg: 80, aspect: 1.5 },
        },
      ],
    },
  ]),
  severityModels: [
    {
      id: 'sev',
      name: 'Levels',
      levels: [{ value: 1, label: 'Low', color: '#888888', criteria: '' }],
    },
  ],
  classCatalogues: [],
};

const issue = (code: string, layer: string, p: number[]) => ({
  id: `i-${code}`,
  code,
  classId: 'corrosion',
  severityModelId: 'sev',
  severity: 1,
  status: 'reviewed',
  title: code,
  note: '',
  author: 'tester',
  createdAt: '2026-09-02T10:00:00Z',
  updatedAt: '2026-09-02T10:00:00Z',
  sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p, n: [0, 1, 0] } }],
  source: 'human',
});

const archiveOf = (files: Record<string, string>): Archive => ({
  entries: new Map(Object.keys(files).map((k) => [k, {}])),
  read: (name) => Promise.resolve(Buffer.from(files[name] ?? '', 'utf8')),
});

let base: string;
let root: string;
let events: IpcEvent<'change:progress'>[];
let pkg: { archive: Archive } | undefined;

function ipc() {
  return collectHandlers((handle) => {
    registerChangeIpc({
      handle,
      registry: {
        root: (id) => (id === 'p' ? root : undefined),
        package: (id) => (id === 'pkg' ? (pkg as never) : undefined),
      },
      emit: (e) => events.push(e),
      now: () => '2026-10-06T12:00:00.000Z',
    });
  });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-change-'));
  events = [];
  pkg = undefined;
  root = await writeProject(join(base, 'p'), manifest, {
    'issues.json': JSON.stringify({
      schema: 'aio.issues/1',
      issues: [issue('F01', 'model-d1', [0, 0, 0]), issue('F02', 'model-d2', [10, 0, 5])],
    }),
  });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('change IPC', () => {
  it('registers every change channel', () => {
    expect(ipc().channels()).toEqual([
      'change:cancel',
      'change:compute',
      'change:list',
      'change:read',
      'change:write',
    ]);
  });

  it('computes the issue change of a pair, writes it and lists it', async () => {
    const h = ipc();
    const r = await h.call('change:compute', {
      jobId: 'j1',
      projectId: 'p',
      from: 'd1',
      to: 'd2',
      kinds: ['issue'],
    });
    expect(r).toEqual({ ok: true, ids: ['d1-d2-issues'] });
    expect(events.at(-1)).toEqual({ jobId: 'j1', phase: 'done', done: 1, total: 1 });
    const list = await h.call('change:list', { projectId: 'p' });
    expect(list).toMatchObject({
      ok: true,
      readOnly: false,
      problems: [],
      sets: [{ id: 'd1-d2-issues', from: 'd1', to: 'd2', producer: 'issues', items: 2, open: 2 }],
    });
    const read = await h.call('change:read', { projectId: 'p', id: 'd1-d2-issues' });
    expect(read.ok && read.set.items.map((i) => [i.id, i.verdict])).toEqual([
      ['issue:F01', 'resolved'],
      ['issue:F02', 'new'],
    ]);
  });

  it('writes atomically and keeps the previous file as .bak', async () => {
    const h = ipc();
    await h.call('change:compute', {
      jobId: 'j1',
      projectId: 'p',
      from: 'd1',
      to: 'd2',
      kinds: ['issue'],
    });
    const read = await h.call('change:read', { projectId: 'p', id: 'd1-d2-issues' });
    if (!read.ok) throw new Error(read.error);
    const review = { status: 'confirmed' as const, by: 'tester', at: '2026-10-06T13:00:00Z' };
    const set = {
      ...read.set,
      items: read.set.items.map((i) => (i.id === 'issue:F02' ? { ...i, review } : i)),
    };
    expect(await h.call('change:write', { projectId: 'p', set })).toEqual({ ok: true });
    const file = join(root, 'change', 'd1-d2-issues.json');
    const bak = ChangeSet.parse(JSON.parse(await readFile(`${file}.bak`, 'utf8')));
    expect(bak.items.find((i) => i.id === 'issue:F02')?.review).toBeUndefined();
    // a recompute keeps the review
    await h.call('change:compute', {
      jobId: 'j2',
      projectId: 'p',
      from: 'd2',
      to: 'd1',
      kinds: ['issue'],
    });
    const again = ChangeSet.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(again.items.find((i) => i.id === 'issue:F02')?.review).toEqual(review);
  });

  it('lists a bad file as a problem and leaves it alone', async () => {
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const h = ipc();
    await h.call('change:compute', {
      jobId: 'j1',
      projectId: 'p',
      from: 'd1',
      to: 'd2',
      kinds: ['issue'],
    });
    await writeFile(join(root, 'change', 'broken.json'), '{nope');
    const list = await h.call('change:list', { projectId: 'p' });
    expect(list.ok && list.problems.map((p) => p.name)).toEqual(['broken.json']);
    expect(list.ok && list.sets).toHaveLength(1);
    expect(await readFile(join(root, 'change', 'broken.json'), 'utf8')).toBe('{nope');
  });

  it('refuses a change set saved by a newer version and never writes over it', async () => {
    const h = ipc();
    const args = { projectId: 'p', from: 'd1', to: 'd2', kinds: ['issue' as const] };
    await h.call('change:compute', { jobId: 'j1', ...args });
    const file = join(root, 'change', 'd1-d2-issues.json');
    // the current file still reads
    const current = await h.call('change:read', { projectId: 'p', id: 'd1-d2-issues' });
    expect(current).toMatchObject({ ok: true, set: { schema: 'aio.change/1' } });
    if (!current.ok) throw new Error(current.error);
    const newer = `${JSON.stringify({ ...current.set, schema: 'aio.change/2', extra: 1 })}\n`;
    await writeFile(file, newer);
    const message =
      'change/d1-d2-issues.json was saved by a newer version of Stratlas (aio.change/2). Update the app to open it. The file was not changed.';
    expect(await h.call('change:read', { projectId: 'p', id: 'd1-d2-issues' })).toEqual({
      ok: false,
      error: message,
    });
    const list = await h.call('change:list', { projectId: 'p' });
    expect(list.ok && list.problems).toEqual([{ name: 'd1-d2-issues.json', error: message }]);
    // neither a save nor a recompute of the same pair replaces it
    expect(await h.call('change:write', { projectId: 'p', set: current.set })).toEqual({
      ok: false,
      error: message,
    });
    expect(await h.call('change:compute', { jobId: 'j2', ...args })).toEqual({
      ok: false,
      error: message,
    });
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('reads a package in place and refuses to write or compute in it', async () => {
    const set = {
      schema: 'aio.change/1',
      id: 'd1-d2-issues',
      from: 'd1',
      to: 'd2',
      producer: 'issues',
      createdAt: '2026-10-06T08:00:00Z',
      items: [{ kind: 'issue', id: 'issue:F01', verdict: 'new' }],
    };
    pkg = { archive: archiveOf({ 'change/d1-d2-issues.json': JSON.stringify(set) }) };
    const h = ipc();
    expect(await h.call('change:list', { projectId: 'pkg' })).toMatchObject({
      ok: true,
      readOnly: true,
      sets: [{ id: 'd1-d2-issues', items: 1 }],
    });
    const read = await h.call('change:read', { projectId: 'pkg', id: 'd1-d2-issues' });
    expect(read).toMatchObject({ ok: true, readOnly: true });
    expect(
      await h.call('change:write', { projectId: 'pkg', set: ChangeSet.parse(set) }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(
      await h.call('change:compute', {
        jobId: 'j',
        projectId: 'pkg',
        from: 'd1',
        to: 'd2',
        kinds: ['issue'],
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
  });

  it('says what is wrong: unknown project, unknown set, same date twice', async () => {
    const h = ipc();
    expect(await h.call('change:list', { projectId: 'x' })).toMatchObject({ ok: false });
    expect(await h.call('change:read', { projectId: 'p', id: 'nope' })).toEqual({
      ok: false,
      error: 'There is no change set "nope" in this project.',
    });
    expect(
      await h.call('change:compute', {
        jobId: 'j',
        projectId: 'p',
        from: 'd1',
        to: 'd1',
        kinds: ['issue'],
      }),
    ).toMatchObject({ ok: false, error: 'Pick two different survey dates of this project.' });
    expect(await h.call('change:cancel', { jobId: 'none' })).toEqual({ ok: false });
  });
});

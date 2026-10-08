import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerTilesetsIpc, type PackageMembers } from './tilesets';

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'mesh' as const,
  src: `tiles/${id}/tileset.json`,
  visible: true,
  ...over,
});

let root: string;
const packages = new Map<string, PackageMembers>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-tilesets-'));
  packages.clear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ipc = collectHandlers((handle) => {
  registerTilesetsIpc({
    handle,
    projectRoot: (id) => (id === 'p' ? root : undefined),
    projectPackage: (id) => packages.get(id),
  });
});

describe('tilesets IPC (G7)', () => {
  it('registers the tileset channels', () => {
    expect(ipc.channels()).toEqual(['tilesets:import', 'tilesets:list', 'tilesets:write']);
  });

  it('lists none for a project without tilesets.json', async () => {
    expect(await ipc.call('tilesets:list', { projectId: 'p' })).toEqual({
      ok: true,
      file: { schema: 'aio.tilesets/1', entries: [] },
    });
  });

  it('writes atomically with a .bak and reads back, unknown fields kept', async () => {
    const first = { schema: 'aio.tilesets/1' as const, entries: [entry('a')] };
    expect(await ipc.call('tilesets:write', { projectId: 'p', file: first })).toEqual({ ok: true });
    const second = {
      schema: 'aio.tilesets/1' as const,
      entries: [entry('a', { visible: false, future: 1 }), entry('b', { kind: 'points' })],
    };
    expect(await ipc.call('tilesets:write', { projectId: 'p', file: second })).toEqual({
      ok: true,
    });
    const bak = JSON.parse(await readFile(join(root, 'tilesets.json.bak'), 'utf8')) as unknown;
    expect(bak).toEqual(first);
    const r = await ipc.call('tilesets:list', { projectId: 'p' });
    expect(r.ok && r.file.entries.map((e) => [e.id, e.visible])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(r.ok && (r.file.entries[0] as Record<string, unknown>).future).toBe(1);
  });

  it('refuses a write over a file someone else changed since it was read', async () => {
    const file = { schema: 'aio.tilesets/1' as const, entries: [entry('a')] };
    await ipc.call('tilesets:write', { projectId: 'p', file });
    await ipc.call('tilesets:list', { projectId: 'p' });
    await writeFile(join(root, 'tilesets.json'), JSON.stringify({ ...file, entries: [] }));
    const r = await ipc.call('tilesets:write', { projectId: 'p', file });
    expect(r.ok).toBe(false);
  });

  it('reports a broken file instead of half reading it', async () => {
    await writeFile(
      join(root, 'tilesets.json'),
      JSON.stringify({ schema: 'aio.tilesets/1', entries: [entry('a'), entry('a')] }),
    );
    const r = await ipc.call('tilesets:list', { projectId: 'p' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/Duplicate tileset/);
  });

  it('refuses to write into a src outside the project (contract) and into packages', async () => {
    const bad = { schema: 'aio.tilesets/1' as const, entries: [entry('x', { src: '../x.json' })] };
    await expect(ipc.call('tilesets:write', { projectId: 'p', file: bad })).rejects.toThrow();
    const content = JSON.stringify({ schema: 'aio.tilesets/1', entries: [entry('pkg')] });
    packages.set('pkg', {
      entries: new Map([['tilesets.json', {}]]),
      read: () => Promise.resolve(Buffer.from(content)),
    });
    const listed = await ipc.call('tilesets:list', { projectId: 'pkg' });
    expect(listed.ok && listed.file.entries[0]?.id).toBe('pkg');
    expect(
      await ipc.call('tilesets:write', {
        projectId: 'pkg',
        file: { schema: 'aio.tilesets/1', entries: [] },
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(await ipc.call('tilesets:list', { projectId: 'nope' })).toMatchObject({ ok: false });
  });
});

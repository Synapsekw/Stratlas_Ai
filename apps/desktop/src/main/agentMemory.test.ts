import { AgentMemoryFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FILE, createAgentMemory, readNotes, registerAgentMemoryIpc } from './agentMemory';
import { collectHandlers } from './notYet';

let dir: string;
let changed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-memory-'));
  changed = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(pkg = false) {
  return createAgentMemory({
    projects: {
      root: (id) => (id === 'p1' ? dir : undefined),
      package: () => (pkg ? {} : undefined),
    },
    changed: (id) => changed.push(id),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
}

describe('agent memory', () => {
  it('has no notes when the file is missing or bad', async () => {
    expect(await store().memory('p1')).toEqual({ ok: true, notes: [], readOnly: false });
    await mkdir(join(dir, 'ai'), { recursive: true });
    await writeFile(join(dir, MEMORY_FILE), '{ not json');
    expect(await readNotes(dir)).toEqual([]);
  });

  it('saves a trimmed note, writes the file and tells the fact index', async () => {
    const s = store();
    const r = await s.remember({
      projectId: 'p1',
      text: '  Piles here are named SP-1 to SP-9  ',
      about: 'measurement:m-3',
      by: 'agent',
    });
    expect(r.ok).toBe(true);
    expect(r.note).toMatchObject({
      text: 'Piles here are named SP-1 to SP-9',
      about: 'measurement:m-3',
      by: 'agent',
      createdAt: '2026-11-12T10:00:00.000Z',
    });
    expect(r.note?.id).toMatch(/^n-[0-9a-z]{4,32}$/);
    const file = AgentMemoryFile.parse(JSON.parse(await readFile(join(dir, MEMORY_FILE), 'utf8')));
    expect(file.notes).toHaveLength(1);
    expect(changed).toEqual(['p1']);
    expect((await s.memory('p1')).notes).toEqual([r.note]);
  });

  it('refuses empty, too long and duplicate text with a plain message', async () => {
    const s = store();
    const empty = await s.remember({ projectId: 'p1', text: '   ', by: 'person' });
    expect([empty.ok, empty.error]).toEqual([false, 'The note is empty. Say what to remember.']);
    const long = await s.remember({ projectId: 'p1', text: 'x'.repeat(301), by: 'person' });
    expect(long.ok).toBe(false);
    expect(long.error).toMatch(/at most 300 characters/);
    await s.remember({ projectId: 'p1', text: 'Units are metres', by: 'person' });
    expect(await s.remember({ projectId: 'p1', text: 'units are metres ', by: 'agent' })).toEqual({
      ok: false,
      error: 'This project already has that note.',
    });
    expect(changed).toEqual(['p1']);
  });

  it('refuses a 31st note', async () => {
    const s = store();
    for (let i = 0; i < 30; i++) {
      expect((await s.remember({ projectId: 'p1', text: `note ${i}`, by: 'person' })).ok).toBe(
        true,
      );
    }
    expect(await s.remember({ projectId: 'p1', text: 'one more', by: 'person' })).toEqual({
      ok: false,
      error: 'This project already has 30 notes. Forget one first.',
    });
  });

  it('keeps both of two saves made at once', async () => {
    const s = store();
    await Promise.all([
      s.remember({ projectId: 'p1', text: 'first', by: 'person' }),
      s.remember({ projectId: 'p1', text: 'second', by: 'person' }),
    ]);
    expect((await readNotes(dir)).map((n) => n.text).sort()).toEqual(['first', 'second']);
  });

  it('forgets a note and restores it as it was', async () => {
    const s = store();
    const a = (await s.remember({ projectId: 'p1', text: 'a', by: 'person' })).note;
    if (!a) throw new Error('saved');
    const gone = await s.forget({ projectId: 'p1', id: a.id });
    expect(gone).toEqual({ ok: true, note: a });
    expect(await readNotes(dir)).toEqual([]);
    expect(await s.forget({ projectId: 'p1', id: a.id })).toMatchObject({ ok: false });
    const back = await s.remember({ projectId: 'p1', text: '', by: 'agent', restore: a });
    expect(back).toEqual({ ok: true, note: a });
    expect(await readNotes(dir)).toEqual([a]);
  });

  it('is read-only in a package and refuses writes with the reason', async () => {
    const s = store(true);
    expect(await s.memory('p1')).toMatchObject({ ok: true, readOnly: true });
    const r = await s.remember({ projectId: 'p1', text: 'a', by: 'person' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read-only package/);
    expect(await s.forget({ projectId: 'p1', id: 'n-abcd' })).toMatchObject({ ok: false });
    expect(changed).toEqual([]);
  });

  it('never writes over a notes file it cannot fully read, and says why', async () => {
    const s = store();
    const file = join(dir, MEMORY_FILE);
    await mkdir(join(dir, 'ai'), { recursive: true });
    const good = {
      id: 'n-good1',
      text: 'kept',
      by: 'person',
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const cases: [string, RegExp][] = [
      [
        JSON.stringify({ schema: 'aio.agent-memory/1', notes: [good, { id: 'bad', text: '' }] }),
        /Some of these notes could not be read/,
      ],
      [JSON.stringify({ schema: 'aio.agent-memory/2', notes: [good] }), /newer version/],
      ['{ not json', /could not be read/],
      [JSON.stringify({ schema: 'something-else' }), /not a notes file/],
    ];
    for (const [body, why] of cases) {
      await writeFile(file, body);
      const m = await s.memory('p1');
      expect(m.readOnly, body).toBe(true);
      expect(m.error, body).toMatch(why);
      const r = await s.remember({ projectId: 'p1', text: 'new one', by: 'person' });
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(why);
      expect((await s.forget({ projectId: 'p1', id: 'n-good1' })).ok, body).toBe(false);
      expect(await readFile(file, 'utf8'), body).toBe(body);
    }
    // the readable notes still show
    await writeFile(file, cases[1]?.[0] ?? '');
    expect((await s.memory('p1')).notes.map((n) => n.id)).toEqual(['n-good1']);
    expect(changed).toEqual([]);
  });

  it('answers plainly for a project that is not open', async () => {
    expect(await store().memory('nope')).toMatchObject({ ok: false, notes: [], readOnly: true });
  });

  it('registers the three channels', () => {
    const t = collectHandlers((handle) => {
      registerAgentMemoryIpc({ handle, projects: { root: () => dir, package: () => undefined } });
    });
    expect(t.channels()).toEqual(['ai:forget', 'ai:memory', 'ai:remember']);
  });
});

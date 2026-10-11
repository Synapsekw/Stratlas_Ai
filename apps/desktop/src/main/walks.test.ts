import { WALK_SCHEMA, type WalkFile } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTA360_MARK,
  endsWithInsta360Mark,
  listProjectWalks,
  packageWalks,
  stitchProgress,
} from './walks';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-walks-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const walk = (id: string, createdAt: string): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: id,
  createdAt,
  source: {
    file: `${id}.insv`,
    layout: 'insv-dual-stream',
    streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
  },
  video: {
    src: `walks/${id}/playback.mp4`,
    width: 256,
    height: 128,
    durationS: 1,
    fps: 30,
    audio: false,
  },
});

describe('listProjectWalks', () => {
  it('lists the walks of a project folder, newest first', async () => {
    for (const [id, at] of [
      ['a', '2026-10-10T08:00:00.000Z'],
      ['b', '2026-10-11T08:00:00.000Z'],
    ] as const) {
      await mkdir(join(base, 'walks', id), { recursive: true });
      await writeFile(join(base, 'walks', id, 'walk.json'), JSON.stringify(walk(id, at)));
    }
    expect((await listProjectWalks(base)).map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('is empty for a project without walks', async () => {
    expect(await listProjectWalks(base)).toEqual([]);
  });
});

describe('packageWalks', () => {
  it('reads the walks a package carries, and skips members that are not walks', async () => {
    const members = new Map<string, string>([
      ['manifest.json', '{}'],
      ['walks/a/walk.json', JSON.stringify(walk('a', '2026-10-10T08:00:00.000Z'))],
      ['walks/a/playback.mp4', 'video'],
      ['walks/b/walk.json', JSON.stringify(walk('b', '2026-10-11T08:00:00.000Z'))],
      // a walk.json that names another folder, a broken one and one too deep
      ['walks/c/walk.json', JSON.stringify(walk('zzz', '2026-10-11T08:00:00.000Z'))],
      ['walks/d/walk.json', 'not json'],
      ['walks/e/deep/walk.json', JSON.stringify(walk('e', '2026-10-11T08:00:00.000Z'))],
    ]);
    const archive = {
      entries: new Map([...members.keys()].map((k) => [k, {}])),
      read: (name: string) => Promise.resolve(Buffer.from(members.get(name) ?? '')),
    };
    expect((await packageWalks(archive)).map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('does not read a staging folder or a walk.json far larger than a real one', async () => {
    const good = JSON.stringify(walk('a', '2026-10-10T08:00:00.000Z'));
    let reads = 0;
    const archive = {
      entries: new Map([
        ['walks/a/walk.json', { size: good.length }],
        ['walks/big/walk.json', { size: 5 * 1024 * 1024 }],
        ['walks/.staging-b-00112233/walk.json', { size: good.length }],
      ]),
      read: (name: string) => {
        reads++;
        return Promise.resolve(Buffer.from(name === 'walks/a/walk.json' ? good : '{}'));
      },
    };
    expect((await packageWalks(archive)).map((w) => w.id)).toEqual(['a']);
    expect(reads).toBe(1);
  });

  it('answers with an empty list when a member cannot be read', async () => {
    const archive = {
      entries: new Map([['walks/a/walk.json', {}]]),
      read: () => Promise.reject(new Error('locked')),
    };
    expect(await packageWalks(archive)).toEqual([]);
  });
});

describe('endsWithInsta360Mark', () => {
  it('is true for a file that ends with the trailer mark, false otherwise', async () => {
    const yes = join(base, 'yes.insv');
    const no = join(base, 'no.insv');
    const tiny = join(base, 'tiny.insv');
    await writeFile(yes, `some video bytes${INSTA360_MARK}`);
    await writeFile(no, `some video bytes${INSTA360_MARK} and more`);
    await writeFile(tiny, 'x');
    expect(await endsWithInsta360Mark(yes)).toBe(true);
    expect(await endsWithInsta360Mark(no)).toBe(false);
    expect(await endsWithInsta360Mark(tiny)).toBe(false);
    expect(await endsWithInsta360Mark(join(base, 'missing.insv'))).toBe(false);
  });
});

describe('stitchProgress', () => {
  it('reports whole percent steps once each, with the file and the part', () => {
    const sent: { done: number; total: number; file: string; part?: number }[] = [];
    const p = stitchProgress((e) => sent.push(e), 3);
    p.file(1, 3, 'photo.jpg');
    p.part('VID.insv', 0.004);
    p.part('VID.insv', 0.421);
    p.part('VID.insv', 0.424);
    p.part('VID.insv', 1);
    p.file(2, 3, 'VID.insv');
    expect(sent).toEqual([
      { done: 1, total: 3, file: 'photo.jpg' },
      { done: 1, total: 3, file: 'VID.insv, playback copy 0 %', part: 0 },
      { done: 1, total: 3, file: 'VID.insv, playback copy 42 %', part: 0.42 },
      { done: 1, total: 3, file: 'VID.insv, playback copy 100 %', part: 1 },
      { done: 2, total: 3, file: 'VID.insv' },
    ]);
  });
});

import type { BoundaryEdit, BoundaryEditsFile } from '@aio/schema';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPackageVolumes, readVolumes, writeBoundaries } from './boundaries';
import { sampleManifest, writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-bounds-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const fcn = { fill: 2, cut: 1, net: 1 };
const ring: [number, number][] = [
  [0, 0],
  [4, 0],
  [4, -4],
];
const volumes = {
  schema: 'aio.volumes/1',
  densityTPerM3: 1.6,
  deadbandM: 0.1,
  defaultBase: 'tin',
  bases: [{ id: 'tin', label: 'Triangulated toe' }],
  captures: [
    { epoch: 'e1', captureId: 'c1', date: '2023-02-21', label: 'a' },
    { epoch: 'e2', captureId: 'c2', date: '2024-01-10', label: 'b' },
  ],
  piles: [{ id: 'P01', name: 'Pile 01', zoneRing: ring, change: fcn, epochs: {} }],
  totals: {},
  pileChange: fcn,
  siteChange: fcn,
};

function edit(over: Partial<BoundaryEdit> = {}): BoundaryEdit {
  return {
    pile: 'P01',
    epoch: 'e2',
    ring,
    volumes: { tin: fcn, plane: fcn, avg: fcn, low: fcn },
    areaM2: 8,
    topM: 60,
    heightM: 2,
    autoNet: 10,
    updatedAt: '2026-10-04T10:00:00.000Z',
    ...over,
  };
}
const file = (...edits: BoundaryEdit[]): BoundaryEditsFile => ({
  schema: 'aio.boundaries/1',
  edits,
});

describe('readVolumes', () => {
  it('reads volumes.json and the saved edits', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify(volumes),
      'edits/boundaries.json': JSON.stringify(file(edit())),
    });
    const r = await readVolumes(dir);
    expect(r.ok && r.volumes?.piles[0]?.id).toBe('P01');
    expect(r.ok && r.edits?.edits).toHaveLength(1);
  });

  it('gives nulls for a project without volumes or edits', async () => {
    const dir = await writeProject(join(base, 'p'));
    expect(await readVolumes(dir)).toEqual({ ok: true, volumes: null, edits: null });
  });

  it('says which file is invalid', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify({ ...volumes, defaultBase: 'mean' }),
    });
    const r = await readVolumes(dir);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/volumes\.json/);
  });
});

describe('writeBoundaries', () => {
  it('writes edits/boundaries.json, creating the folder, and backs up the previous file', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify(volumes),
    });
    expect(await writeBoundaries(dir, file(edit()))).toEqual({ ok: true });
    const second = file(edit(), edit({ epoch: 'e1' }));
    expect(await writeBoundaries(dir, second)).toEqual({ ok: true });
    const out = JSON.parse(
      await readFile(join(dir, 'edits', 'boundaries.json'), 'utf8'),
    ) as unknown;
    expect(out).toEqual(second);
    const bak = JSON.parse(
      await readFile(join(dir, 'edits', 'boundaries.json.bak'), 'utf8'),
    ) as unknown;
    expect(bak).toEqual(file(edit()));
  });

  it('saves edits sent before the save before them answered', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify(volumes),
      'edits/boundaries.json': JSON.stringify(file(edit())),
    });
    expect((await readVolumes(dir)).ok).toBe(true);
    // quick edits of one outline: each is sent while the ones before are still being written
    const tops = [61, 62, 63, 64];
    const sent = tops.map((topM) => writeBoundaries(dir, file(edit({ topM }))));
    expect(await Promise.all(sent)).toEqual(sent.map(() => ({ ok: true })));
    // every one was written whole, one after the other: the file and its backup are two of them
    // (called at the same instant like this, the order they reach the file in is not the order
    // of the calls: each checks volumes.json first)
    const path = join(dir, 'edits', 'boundaries.json');
    const topOf = async (p: string) =>
      (JSON.parse(await readFile(p, 'utf8')) as BoundaryEditsFile).edits[0]?.topM;
    const [last, before] = [await topOf(path), await topOf(`${path}.bak`)];
    expect(tops).toContain(last);
    expect(tops).toContain(before);
    expect(before).not.toBe(last);
    expect((await readdir(join(dir, 'edits'))).sort()).toEqual([
      'boundaries.json',
      'boundaries.json.bak',
    ]);
  });

  it('refuses every overlapping save when someone else saved the edits meanwhile', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify(volumes),
      'edits/boundaries.json': JSON.stringify(file(edit())),
    });
    expect((await readVolumes(dir)).ok).toBe(true);
    const path = join(dir, 'edits', 'boundaries.json');
    const theirs = JSON.stringify(file(edit({ topM: 99 })));
    await writeFile(path, theirs);
    const sent = [61, 62, 63].map((topM) => writeBoundaries(dir, file(edit({ topM }))));
    for (const r of await Promise.all(sent)) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/edits\/boundaries\.json was changed by someone else/);
    }
    expect(await readFile(path, 'utf8')).toBe(theirs);
  });

  it('refuses an edit of a pile or date the project does not have', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'volumes.json': JSON.stringify(volumes),
    });
    const a = await writeBoundaries(dir, file(edit({ pile: 'P99' })));
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/P99/);
    const b = await writeBoundaries(dir, file(edit({ epoch: 'e7' })));
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/e7/);
  });

  it('refuses a project without volumes.json', async () => {
    const dir = await writeProject(join(base, 'p'));
    const r = await writeBoundaries(dir, file(edit()));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/volumes\.json/);
  });
});

describe('volumes inside a package', () => {
  const archive = (files: Record<string, string>) => ({
    entries: new Map(Object.keys(files).map((k) => [k, {}])),
    read: (name: string) => Promise.resolve(Buffer.from(files[name] ?? '')),
  });

  it('reads volumes.json and the edits from the package members', async () => {
    const r = await readPackageVolumes(
      archive({
        'volumes.json': JSON.stringify(volumes),
        'edits/boundaries.json': JSON.stringify(file(edit())),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.volumes?.piles[0]?.id).toBe('P01');
    expect(r.ok && r.edits?.edits).toHaveLength(1);
  });

  it('answers no volumes for a package without them and names a broken member', async () => {
    const none = await readPackageVolumes(archive({}));
    expect(none).toEqual({ ok: true, volumes: null, edits: null });
    const bad = await readPackageVolumes(archive({ 'volumes.json': '{"schema":1}' }));
    expect(bad.ok).toBe(false);
  });
});

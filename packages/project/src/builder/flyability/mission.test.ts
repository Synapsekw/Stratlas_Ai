import type { ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeInspectorFixture } from './fixture';
import { findInspectorExports, inspectionIdsOf, scanInspectorMission } from './mission';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inspector-mission-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(path: string, text = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

/**
 * A mission folder as a field team leaves it: raw drone folders, a report, ROV dive folders and
 * the exports two levels down, beside a report folder of their own.
 */
async function mission(root: string): Promise<{ a: string; b: string }> {
  const a = join(root, 'Drone', 'Exports', 'Chamber A');
  const b = join(root, 'Drone', 'Exports', 'Chamber B');
  await writeInspectorFixture(a, { inspectionName: 'Inspection 1' });
  await writeInspectorFixture(b, { seed: 1, inspectionName: 'Inspection 2' });
  await file(join(root, 'Raw drone data', 'Flight 1', 'video.mov'));
  await file(join(root, 'Raw drone data', 'Flight 2', 'log.bin'));
  await file(join(root, 'Reports', 'report.pdf'));
  await file(join(root, 'Dive 1', 'dive.mp4'));
  await file(join(root, 'Drone', 'Report', 'summary.pdf'));
  await file(join(root, 'notes.txt'));
  await file(join(root, 'Thumbs.db'));
  await mkdir(join(root, '.hidden', 'flights'), { recursive: true });
  return { a, b };
}

describe('findInspectorExports', () => {
  it('finds every export in a mission folder and lists what it skipped', async () => {
    const { a, b } = await mission(dir);
    const r = await findInspectorExports(dir);
    expect(r.exports).toEqual([a, b]);
    expect(r.capped).toBe(false);
    // the folders beside the exports' path, never their insides; hidden and OS ones not at all
    expect(r.skipped.folders).toEqual([
      'Dive 1',
      'Raw drone data',
      'Reports',
      join('Drone', 'Report'),
    ]);
    // loose files at the levels walked (notes.txt), not the files inside skipped folders
    expect(r.skipped.files).toBe(1);
  });

  it('takes the export folder itself', async () => {
    await writeInspectorFixture(dir);
    const r = await findInspectorExports(dir);
    expect(r.exports).toEqual([dir]);
    expect(r.skipped).toEqual({ folders: [], files: 0 });
  });

  it('never looks inside an export', async () => {
    const { a } = await mission(dir);
    // an export-shaped folder inside an export is part of it, not a second export
    await writeInspectorFixture(join(a, 'assets', 'nested'), { seed: 2 });
    expect((await findInspectorExports(dir)).exports).toHaveLength(2);
  });

  it('stops at the depth limit', async () => {
    const deep = join(dir, '1', '2', '3', '4', '5', '6');
    await writeInspectorFixture(deep);
    expect((await findInspectorExports(dir)).exports).toEqual([]);
    expect((await findInspectorExports(dir, { maxDepth: 6 })).exports).toEqual([deep]);
  });

  it('says so when it hits the folder cap', async () => {
    for (let i = 0; i < 6; i++) await mkdir(join(dir, `Folder ${i}`, 'inner'), { recursive: true });
    const r = await findInspectorExports(dir, { maxDirs: 4 });
    expect(r.capped).toBe(true);
    expect(r.exports).toEqual([]);
  });

  it('orders chambers by number, Chamber 2 before Chamber 10', async () => {
    await writeInspectorFixture(join(dir, 'Chamber 10'), { seed: 1 });
    await writeInspectorFixture(join(dir, 'Chamber 2'), { seed: 2 });
    expect((await findInspectorExports(dir)).exports).toEqual([
      join(dir, 'Chamber 2'),
      join(dir, 'Chamber 10'),
    ]);
  });

  it('finds nothing in a folder without an export, and skips its folders', async () => {
    await file(join(dir, 'Photos', 'a.jpg'));
    await file(join(dir, 'b.jpg'));
    const r = await findInspectorExports(dir);
    expect(r.exports).toEqual([]);
    expect(r.skipped).toEqual({ folders: ['Photos'], files: 1 });
  });

  it('a missing folder finds nothing', async () => {
    const r = await findInspectorExports(join(dir, 'gone'));
    expect(r.exports).toEqual([]);
  });
});

describe('scanInspectorMission', () => {
  it('names each chamber after its folder and counts what it holds', async () => {
    const { a, b } = await mission(dir);
    const m = await scanInspectorMission(dir, null);
    expect(m.root).toBe(dir);
    expect(m.exports.map((e) => [e.path, e.name])).toEqual([
      [a, 'Chamber A'],
      [b, 'Chamber B'],
    ]);
    const first = m.exports[0]?.scan.inspections[0];
    expect(first).toMatchObject({ name: 'Inspection 1', findings: 3, photos: 4 });
    expect(m.skipped.folders).toHaveLength(4);
    expect(m.capped).toBe(false);
  });

  it('names an export picked itself after its sole inspection', async () => {
    await writeInspectorFixture(dir, { inspectionName: 'Room 7' });
    const m = await scanInspectorMission(dir, null);
    expect(m.exports.map((e) => e.name)).toEqual(['Room 7']);
  });

  it('marks chambers already imported', async () => {
    await mission(dir);
    const ids = await inspectionIdsOf(join(dir, 'Drone', 'Exports', 'Chamber B'));
    const manifest = {
      name: 'P',
      layers: [],
      spaces: [{ id: 'fly-b', name: 'B', source: { kind: 'flyability', inspectionId: ids[0] } }],
    } as unknown as ProjectManifest;
    const m = await scanInspectorMission(dir, manifest);
    expect(m.exports.map((e) => e.scan.inspections[0]?.importedAs)).toEqual([null, 'fly-b']);
  });
});

describe('inspectionIdsOf', () => {
  it('reads the inspection ids of an export', async () => {
    const ids = await writeInspectorFixture(dir, { seed: 3 });
    expect(await inspectionIdsOf(dir)).toEqual([ids.inspectionId]);
  });
});

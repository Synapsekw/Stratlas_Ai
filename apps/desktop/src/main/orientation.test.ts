import { emptyOrientation, type OrientationFile } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ORIENTATION_PATH,
  readOrientation,
  readPackageOrientation,
  writeOrientation,
} from './orientation';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-orientation-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = (yaw: number): OrientationFile => ({
  ...emptyOrientation(),
  clips: { 'clip-1': { keys: [{ t: 0, yaw, pitch: -30, roll: 0, fill: 'smooth' }] } },
  photos: { photos: { p1: { yawDeg: -2, pitchDeg: 0, rollDeg: 0 } } },
});

describe('orientation.json store', () => {
  it('reads nothing before the first save, then the saved directions, with a backup', async () => {
    expect(await readOrientation(root)).toEqual({ ok: true, file: null, readOnly: false });
    expect(await writeOrientation(root, file(10))).toEqual({ ok: true });
    expect(await writeOrientation(root, file(20))).toEqual({ ok: true });
    expect(await readOrientation(root)).toEqual({ ok: true, file: file(20), readOnly: false });
    const bak = JSON.parse(await readFile(join(root, `${ORIENTATION_PATH}.bak`), 'utf8')) as {
      clips: Record<string, { keys: { yaw: number }[] }>;
    };
    expect(bak.clips['clip-1']?.keys[0]?.yaw).toBe(10);
  });

  it('refuses a file saved by a newer version and never saves over it', async () => {
    const newer = JSON.stringify({ ...file(10), schema: 'aio.orientation/2' });
    await writeFile(join(root, ORIENTATION_PATH), newer);
    const r = await readOrientation(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version of Quadrion AI/);
    expect((await writeOrientation(root, file(30))).ok).toBe(false);
    expect(await readFile(join(root, ORIENTATION_PATH), 'utf8')).toBe(newer);
  });

  it('reports an invalid file instead of losing it', async () => {
    await writeFile(join(root, ORIENTATION_PATH), '{"schema":"aio.orientation/1","clips":5}');
    expect((await readOrientation(root)).ok).toBe(false);
  });

  it('reads a package file read only', async () => {
    const archive = {
      entries: new Map([[ORIENTATION_PATH, {}]]),
      read: () => Promise.resolve(Buffer.from(JSON.stringify(file(5)))),
    };
    expect(await readPackageOrientation(archive)).toEqual({
      ok: true,
      file: file(5),
      readOnly: true,
    });
    expect(await readPackageOrientation({ entries: new Map(), read: archive.read })).toEqual({
      ok: true,
      file: null,
      readOnly: true,
    });
  });
});

import { applyMat4, projectToLocal } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPix4dOffset,
  looksProjected,
  objPlacement,
  objShift,
  parseOffsetXyz,
} from './objPlacement';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-objplace-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ORIGIN: Vec3 = [500_000, 3_200_000, 20];

/** A Pix4D folder layout with the offset file; returns the OBJ path. */
async function pix4d(offset = '530000 3200000 12\n'): Promise<string> {
  const mesh = join(dir, 'tower', '2_densification', '3d_mesh');
  const params = join(dir, 'tower', '1_initial', 'params');
  await mkdir(mesh, { recursive: true });
  await mkdir(params, { recursive: true });
  await writeFile(join(params, 'tower_offset.xyz'), offset);
  return join(mesh, 'tower_simplifiedmesh.obj');
}

describe('Pix4D offset', () => {
  it('reads "E N H"', () => {
    expect(parseOffsetXyz('243 3178 97\n')).toEqual([243, 3178, 97]);
    expect(parseOffsetXyz('1 2')).toBeNull();
    expect(parseOffsetXyz('a b c')).toBeNull();
  });
  it('finds the offset two folders above the mesh folder', async () => {
    const obj = await pix4d();
    expect(await findPix4dOffset(obj)).toEqual({
      offset: [530000, 3200000, 12],
      file: 'tower_offset.xyz',
    });
  });
  it('finds nothing for an OBJ outside a Pix4D layout', async () => {
    expect(await findPix4dOffset(join(dir, 'loose.obj'))).toBeNull();
  });
});

describe('placement', () => {
  const small = { min: [-5, -5, 0] as Vec3, max: [5, 5, 40] as Vec3 };
  it('stands a Pix4D export up at its offset', () => {
    const p = objPlacement({
      pix4d: { offset: [530000, 3200000, 12], file: 'tower_offset.xyz' },
      bounds: small,
      shift: [0, 0, 0],
      origin: ORIGIN,
      epsg: 32639,
    });
    expect(p.up).toBe('z');
    // the model's top (0, 0, 40) is 40 m above the offset in the scene
    expect(applyMat4(p.transform, [0, 0, 40])).toEqual(
      projectToLocal([530000, 3200000, 52], ORIGIN),
    );
    expect(p.note).toContain('Z up');
  });
  it('takes map grid coordinates as z up and stores them shifted by their centre', () => {
    const b = { min: [499_990, 3_199_990, 15] as Vec3, max: [500_010, 3_200_010, 60] as Vec3 };
    expect(looksProjected(b)).toBe(true);
    const shift = objShift(null, b);
    expect(shift).toEqual([500_000, 3_200_000, 38]);
    const p = objPlacement({ pix4d: null, bounds: b, shift, origin: ORIGIN, epsg: 32639 });
    const v: Vec3 = [500_010, 3_199_990, 60];
    const stored: Vec3 = [v[0] - shift[0], v[1] - shift[1], v[2] - shift[2]];
    expect(applyMat4(p.transform, stored)).toEqual(projectToLocal(v, ORIGIN));
  });
  it('keeps a small local model y up with no transform', () => {
    expect(looksProjected(small)).toBe(false);
    const p = objPlacement({
      pix4d: null,
      bounds: small,
      shift: [0, 0, 0],
      origin: ORIGIN,
      epsg: 1,
    });
    expect(p.up).toBe('y');
    expect(p.transform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(p.note).toBeNull();
  });
});

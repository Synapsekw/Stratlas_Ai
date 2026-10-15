import { decodeSelection, encodeSelection } from '@aio/schema';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSelection } from './selection';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-sel-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const readBack = async (name: string) =>
  decodeSelection(new Uint8Array(await readFile(join(root, 'selections', `${name}.sel`))));

describe('writeSelection', () => {
  it('writes selections/<name>.sel and answers its project path', async () => {
    const data = encodeSelection(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
    expect(await writeSelection(root, 'i1-cloud', data)).toEqual({
      ok: true,
      path: 'selections/i1-cloud.sel',
    });
    const back = await readBack('i1-cloud');
    expect(back?.lod).toBe(3);
    expect(back?.positions.length).toBe(6);
    // no temporary file left beside it
    expect(await readdir(join(root, 'selections'))).toEqual(['i1-cloud.sel']);
  });

  it('replaces a selection of the same name', async () => {
    await writeSelection(root, 'a', encodeSelection(new Float32Array([0, 0, 0]), 1));
    await writeSelection(root, 'a', encodeSelection(new Float32Array([1, 1, 1, 2, 2, 2]), 2));
    expect((await readBack('a'))?.positions.length).toBe(6);
  });

  it('refuses bytes that are not a selection file', async () => {
    expect(await writeSelection(root, 'a', new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      error: 'The point selection is not a valid selection file.',
    });
  });
});

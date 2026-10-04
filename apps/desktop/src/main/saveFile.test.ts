import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFileName, saveFile } from './saveFile';

describe('safeFileName', () => {
  it.each([
    ['register.csv', 'register.csv'],
    ['../../evil.csv', 'evil.csv'],
    ['C:\\Users\\x\\b.csv', 'b.csv'],
    ['a<b>:c|d?.csv', 'a_b__c_d_.csv'],
    ['', 'download'],
    ['..', 'download'],
    ['  .hidden ', 'hidden'],
  ])('%j becomes %j', (name, expected) => {
    expect(safeFileName(name)).toBe(expected);
  });
});

describe('saveFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-save-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('offers the cleaned name in the downloads folder and writes text', async () => {
    let offered = '';
    const r = await saveFile(
      { defaultName: '../register.csv', data: 'a,b\n' },
      {
        downloadsDir: dir,
        choose: (defaultPath) => {
          offered = defaultPath;
          return Promise.resolve(join(dir, 'out.csv'));
        },
      },
    );
    expect(offered).toBe(join(dir, 'register.csv'));
    expect(r).toEqual({ path: join(dir, 'out.csv') });
    expect(await readFile(join(dir, 'out.csv'), 'utf8')).toBe('a,b\n');
  });

  it('writes bytes', async () => {
    const target = join(dir, 'model.glb');
    await saveFile(
      { defaultName: 'model.glb', data: new Uint8Array([1, 2, 3]) },
      { downloadsDir: dir, choose: () => Promise.resolve(target) },
    );
    expect([...(await readFile(target))]).toEqual([1, 2, 3]);
  });

  it('returns a null path when the person cancels', async () => {
    const r = await saveFile(
      { defaultName: 'x.csv', data: 'x' },
      { downloadsDir: dir, choose: () => Promise.resolve(null) },
    );
    expect(r).toEqual({ path: null });
  });

  it('reports a write failure in words', async () => {
    const r = await saveFile(
      { defaultName: 'x.csv', data: 'x' },
      { downloadsDir: dir, choose: () => Promise.resolve(join(dir, 'missing', 'x.csv')) },
    );
    expect(r.path).toBeNull();
    expect(r.error).toMatch(/could not be saved/);
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASS_LIBRARY_SCHEMA, createClassLibraryStore } from './classLibrary';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-class-library-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('class library store', () => {
  it('starts empty, saves sorted by label, replaces a label of any case, removes', async () => {
    const file = join(base, 'class-library.json');
    const store = createClassLibraryStore(file);
    expect(await store.list()).toEqual([]);
    await store.save({ label: 'Spalling', color: '#7cc46b' });
    await store.save({ label: 'Efflorescence', color: '#34a6d9', hotkey: 'e' });
    const after = await store.save({ label: 'spalling', color: '#000000' });
    expect(after.map((c) => [c.label, c.color])).toEqual([
      ['Efflorescence', '#34a6d9'],
      ['spalling', '#000000'],
    ]);
    const disk = JSON.parse(await readFile(file, 'utf8')) as { schema: string; classes: unknown[] };
    expect(disk.schema).toBe(CLASS_LIBRARY_SCHEMA);
    expect(disk.classes).toHaveLength(2);
    expect((await store.remove('EFFLORESCENCE')).map((c) => c.label)).toEqual(['spalling']);
  });

  it('keeps a letter hotkey and drops a digit, a, u or a long one', async () => {
    const store = createClassLibraryStore(join(base, 'class-library.json'));
    await store.save({ label: 'Keep', color: '#111111', hotkey: 'K' });
    await store.save({ label: 'Digit', color: '#222222', hotkey: '3' });
    await store.save({ label: 'Reserved a', color: '#333333', hotkey: 'a' });
    await store.save({ label: 'Reserved u', color: '#444444', hotkey: 'U' });
    const all = await store.save({ label: 'Symbol', color: '#555555', hotkey: '-' });
    const byLabel = new Map(all.map((c) => [c.label, c.hotkey]));
    expect(byLabel.get('Keep')).toBe('K');
    for (const l of ['Digit', 'Reserved a', 'Reserved u', 'Symbol']) {
      expect(byLabel.has(l)).toBe(true);
      expect(byLabel.get(l)).toBeUndefined();
    }
    expect(all.find((c) => c.label === 'Digit')).not.toHaveProperty('hotkey');
  });

  it('skips entries it cannot read and keeps the good ones', async () => {
    const file = join(base, 'class-library.json');
    await writeFile(
      file,
      JSON.stringify({
        classes: [
          { label: 'Rust', color: '#f08a3e' },
          { label: '', color: 'x' },
        ],
      }),
    );
    expect((await createClassLibraryStore(file).list()).map((c) => c.label)).toEqual(['Rust']);
  });

  it('does not overwrite a damaged library file', async () => {
    const file = join(base, 'class-library.json');
    await writeFile(file, '{ not json');
    const store = createClassLibraryStore(file);
    expect(await store.list()).toEqual([]);
    await expect(store.save({ label: 'Rust', color: '#f08a3e' })).rejects.toThrow(/damaged/);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });
});

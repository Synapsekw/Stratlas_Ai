import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic } from './fsutil';

describe('writeJsonAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-fsutil-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a file another process is reading at that moment', async () => {
    // Windows refuses the rename while a handle is open (EPERM); the write waits it out.
    const file = join(dir, 'settings.json');
    await writeFile(file, '{"v":1}');
    const reader = await open(file, 'r');
    const write = writeJsonAtomic(file, { v: 2 });
    setTimeout(() => void reader.close(), 50);
    await write;
    expect(await readJson(file)).toEqual({ v: 2 });
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('keeps writes of one file in the same millisecond apart', async () => {
    const file = join(dir, 'issues.json');
    await Promise.all([1, 2, 3].map((v) => writeJsonAtomic(file, { v })));
    expect(await readJson(file)).toMatchObject({ v: expect.any(Number) as number });
    expect(await readdir(dir)).toEqual(['issues.json']);
  });
});

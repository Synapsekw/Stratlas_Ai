import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverFile, coverHash, coverStamp, registerCoverIpc } from './covers';
import { collectHandlers } from './notYet';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-covers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('covers (read side)', () => {
  it('names a cover by the sha256 hex of its library key', () => {
    expect(coverHash('demo:survey-demo')).toMatch(/^[0-9a-f]{64}$/);
    expect(coverHash('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(coverFile(dir, 'a')).toBe(join(dir, `${coverHash('a')}.jpg`));
  });

  it('has no stamp when the key has no cover', async () => {
    expect(await coverStamp(dir, 'k')).toBeNull();
    expect(await coverStamp(join(dir, 'missing'), 'k')).toBeNull();
  });

  it('stamps a cover with its hash and modification time', async () => {
    await writeFile(coverFile(dir, 'k'), 'jpeg');
    const { mtimeMs } = await stat(coverFile(dir, 'k'));
    expect(await coverStamp(dir, 'k')).toEqual({ hash: coverHash('k'), mtimeMs });
  });

  it('answers library:setThumbnail as not yet available', async () => {
    const h = collectHandlers((handle) => {
      registerCoverIpc({
        handle,
        projects: { path: () => 'x', package: () => undefined },
        isDemo: () => Promise.resolve(false),
        coversDir: () => dir,
      });
    });
    expect(await h.call('library:setThumbnail', { projectId: 'a', data: null })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});

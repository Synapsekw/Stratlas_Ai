import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProject } from './create';

vi.mock('./manifestFile', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeManifestFile: vi.fn(() => Promise.reject(new Error('disk full'))),
}));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-create-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('createProject', () => {
  it('a project that fails to write leaves no folder behind', async () => {
    await expect(
      createProject(dir, {
        name: 'Broken',
        type: 'inspection',
        epsg: 32639,
        origin: [0, 0, 0],
        severityTemplate: null,
      }),
    ).rejects.toThrow('disk full');
    expect(await readdir(join(dir, 'projects'))).toEqual([]);
  });
});

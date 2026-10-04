import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoProjectPaths } from './demo';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-demo-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), '{}');
}

describe('demoProjectPaths', () => {
  it('lists bundled demo projects in resources/demo when packaged', async () => {
    await project(join(base, 'demo', 'tank-demo'));
    await mkdir(join(base, 'demo', 'not-a-project'), { recursive: true });
    expect(await demoProjectPaths({ env: {}, packaged: true, resourcesPath: base })).toEqual([
      join(base, 'demo', 'tank-demo'),
    ]);
  });

  it('takes STRATLAS_DEMO in development and nothing otherwise', async () => {
    await project(join(base, 'x', 'site'));
    expect(
      await demoProjectPaths({
        env: { STRATLAS_DEMO: join(base, 'x') },
        packaged: false,
        resourcesPath: '/none',
      }),
    ).toEqual([join(base, 'x', 'site')]);
    expect(await demoProjectPaths({ env: {}, packaged: false, resourcesPath: base })).toEqual([]);
  });
});

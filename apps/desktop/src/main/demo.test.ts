import type { LibraryEntry } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  demoLibraryPaths,
  demoOpenPath,
  demoProjectPaths,
  findDemos,
  markDemoEntries,
} from './demo';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-demo-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(dir: string, issues = '[]') {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), '{}');
  await writeFile(join(dir, 'issues.json'), issues);
}

async function demoFolder(build: string) {
  const root = join(base, 'resources', 'demo');
  await project(join(root, 'demo-site'));
  await project(join(root, 'demo-road'));
  await writeFile(
    join(root, 'demo.json'),
    JSON.stringify({ schema: 'aio.demo/1', build, primary: 'demo-site' }),
  );
  return root;
}

describe('demoProjectPaths', () => {
  it('lists bundled demo projects in resources/demo when packaged', async () => {
    await project(join(base, 'demo', 'tank-demo'));
    await mkdir(join(base, 'demo', 'not-a-project'), { recursive: true });
    expect(await demoProjectPaths({ env: {}, packaged: true, resourcesPath: base })).toEqual([
      join(base, 'demo', 'tank-demo'),
    ]);
  });

  it('takes QUADRION_DEMO in development and nothing otherwise', async () => {
    await project(join(base, 'x', 'site'));
    expect(
      await demoProjectPaths({
        env: { QUADRION_DEMO: join(base, 'x') },
        packaged: false,
        resourcesPath: '/none',
      }),
    ).toEqual([join(base, 'x', 'site')]);
    expect(await demoProjectPaths({ env: {}, packaged: false, resourcesPath: base })).toEqual([]);
  });
});

describe('demo working copies', () => {
  it('reads demo.json: the build stamp and the primary project', async () => {
    const root = await demoFolder('b1');
    const demos = await findDemos(root);
    expect(demos).toMatchObject({ root, build: 'b1', primary: 'demo-site' });
    expect(demos?.projects).toEqual([join(root, 'demo-road'), join(root, 'demo-site')]);
    expect(await findDemos(join(base, 'missing'))).toBeNull();
    expect(await findDemos(undefined)).toBeNull();
  });

  it('opens a bundled project as a working copy and never writes the bundle', async () => {
    const root = await demoFolder('b1');
    const copies = join(base, 'user', 'demo');
    const demos = await findDemos(root);
    expect(await demoLibraryPaths(demos, copies)).toEqual([
      { path: join(root, 'demo-road'), primary: false },
      { path: join(root, 'demo-site'), primary: true },
    ]);

    const opened = await demoOpenPath(join(root, 'demo-site'), demos, copies);
    expect(opened).toBe(join(copies, 'demo-site'));
    expect(await readFile(join(opened, 'manifest.json'), 'utf8')).toBe('{}');
    // the library now lists the copy, still marked primary
    expect(await demoLibraryPaths(demos, copies)).toEqual([
      { path: join(root, 'demo-road'), primary: false },
      { path: join(copies, 'demo-site'), primary: true },
    ]);
    // edits in the copy survive the next open of the same build
    await writeFile(join(opened, 'issues.json'), '["edited"]');
    expect(await demoOpenPath(join(root, 'demo-site'), demos, copies)).toBe(opened);
    expect(await readFile(join(opened, 'issues.json'), 'utf8')).toBe('["edited"]');
    expect(await readFile(join(root, 'demo-site', 'issues.json'), 'utf8')).toBe('[]');
    // paths outside the demo folder are untouched
    expect(await demoOpenPath(join(base, 'elsewhere'), demos, copies)).toBe(
      join(base, 'elsewhere'),
    );
  });

  it('replaces the working copy when the app ships another demo build', async () => {
    const copies = join(base, 'user', 'demo');
    let demos = await findDemos(await demoFolder('b1'));
    const opened = await demoOpenPath(join(base, 'resources', 'demo', 'demo-site'), demos, copies);
    await writeFile(join(opened, 'issues.json'), '["edited"]');
    demos = await findDemos(await demoFolder('b2'));
    // listed as the bundle again until it is opened
    expect((await demoLibraryPaths(demos, copies))[1]?.path).toBe(
      join(base, 'resources', 'demo', 'demo-site'),
    );
    expect(await demoOpenPath(join(base, 'resources', 'demo', 'demo-site'), demos, copies)).toBe(
      opened,
    );
    expect(await readFile(join(opened, 'issues.json'), 'utf8')).toBe('[]');
  });

  it('marks demo entries in the library', () => {
    const entry = (path: string): LibraryEntry => ({ id: path, name: path, path, kind: 'native' });
    const marked = markDemoEntries(
      [entry(join(base, 'a')), entry(join(base, 'b')), entry(join(base, 'own'))],
      [
        { path: join(base, 'a'), primary: true },
        { path: join(base, 'b'), primary: false },
      ],
    );
    expect(marked.map((e) => e.demo)).toEqual([{ primary: true }, { primary: false }, undefined]);
  });
});

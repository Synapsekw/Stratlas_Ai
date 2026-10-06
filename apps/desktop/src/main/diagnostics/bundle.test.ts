import { openZip } from '@aio/project/package';
import type { JobRecord } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectBundle,
  lastErrors,
  openProjectSizes,
  writeBundle,
  type BundleSources,
} from './bundle';
import { createCrashStore } from './crash';
import { clearSecrets, maskId, registerSecret } from './redact';

const KEY = `sk-ant-api03-${'B7'.repeat(24)}`;
const OWN_KEY = 'gateway-0000-1111-2222-3333';
const WORKSPACE = 'wrkspc_01ZyXwVuTsRqPoNm';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-bundle-'));
});
afterEach(async () => {
  clearSecrets();
  await rm(dir, { recursive: true, force: true });
});

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'job-1',
  pipeline: 'road.build',
  project: 'D:\\Client\\secret-site',
  params: { centreline: 'D:\\Client\\secret-site\\line.geojson' },
  status: 'failed',
  progress: 0.5,
  steps: [{ name: 'tiles', state: 'failed', message: 'detail' }],
  error: `Upload refused for ${KEY}`,
  artifacts: [{ path: 'D:\\Client\\secret-site\\out.json', kind: 'json' }],
  createdAt: '2026-10-05T08:00:00.000Z',
  updatedAt: '2026-10-05T08:05:00.000Z',
  ...over,
});

async function sources(): Promise<BundleSources> {
  const logsDir = join(dir, 'logs');
  await mkdir(logsDir);
  await writeFile(
    join(logsDir, 'main.1.log'),
    `2026-10-05T07:00:00.000Z INFO older line\n2026-10-05T07:00:01.000Z ERROR old failure with key ${KEY}\n`,
  );
  await writeFile(
    join(logsDir, 'main.log'),
    `2026-10-05T08:00:00.000Z WARN gateway said no to ${OWN_KEY}\n`,
  );
  await writeFile(
    join(logsDir, 'renderer.log'),
    `2026-10-05T07:30:00.000Z ERROR WebGL context lost; {"apiKey":"${KEY}"}\n`,
  );
  const crash = createCrashStore(join(dir, 'crash'), {
    version: '0.7.0',
    electron: '44.5.1',
    platform: 'test',
  });
  crash.write({ process: 'GPU', reason: 'crashed', details: `with ${KEY}` });
  const dumps = join(dir, 'Crashpad', 'reports');
  await mkdir(dumps, { recursive: true });
  await writeFile(join(dumps, 'abc.dmp'), Buffer.alloc(64));
  return {
    logsDir,
    crash,
    crashDumpsDir: join(dir, 'Crashpad'),
    system: () => ({
      app: { version: '0.7.0' },
      versions: { electron: '44.5.1', chrome: '140', node: '24' },
      gpu: { gpuDevice: [{ vendorId: 4318 }], auxAttributes: { token: KEY } },
    }),
    settings: () => ({
      cloudAi: false,
      theme: 'dark',
      dataRoot: 'D:\\Stratlas Data',
      anthropicWorkspaceId: WORKSPACE,
      openaiKey: KEY,
    }),
    packs: () => Promise.resolve([{ id: 'gcc', label: 'Gulf', sizeBytes: 10 }]),
    jobs: () =>
      Promise.resolve({
        runtime: { found: true, version: '1.4.0' },
        jobs: [
          job({}),
          job({
            id: 'job-2',
            status: 'done',
            error: undefined,
            updatedAt: '2026-10-05T09:00:00.000Z',
          }),
        ],
      }),
    projects: () => Promise.resolve([{ id: 'hcl', kind: 'folder', sizeBytes: 1234, files: 3 }]),
    now: () => new Date('2026-10-05T10:00:00.000Z'),
  };
}

describe('diagnostics bundle', () => {
  it('holds every part, and no key, token or client path anywhere', async () => {
    registerSecret(OWN_KEY);
    const files = await collectBundle(await sources(), {
      problem: { what: `The map stayed grey. My key is ${KEY}`, steps: '1. Open hcl\n2. Map' },
      graphics: { tier: 'low', detected: 'low', override: null, renderer: 'Intel UHD 620' },
    });
    const names = files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'system.json',
        'settings.json',
        'packs.json',
        'jobs.json',
        'projects.json',
        'errors.txt',
        'logs/main.1.log',
        'logs/main.log',
        'logs/renderer.log',
        'crash/minidumps.txt',
        'problem.md',
      ]),
    );
    expect(names.some((n) => /^crash\/crash-.*\.json$/.test(n))).toBe(true);

    const all = files.map((f) => f.text).join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(OWN_KEY);
    expect(all).not.toContain(WORKSPACE);
    // job parameters and artifacts (paths into client folders) stay out
    expect(all).not.toContain('line.geojson');
    expect(all).not.toContain('out.json');

    const read = (n: string) => files.find((f) => f.name === n)?.text ?? '';
    const settings = JSON.parse(read('settings.json')) as Record<string, unknown>;
    expect(settings.anthropicWorkspaceId).toBe(maskId(WORKSPACE));
    expect(settings._omitted).toEqual(['openaiKey']);
    const system = JSON.parse(read('system.json')) as Record<string, unknown>;
    expect(system.graphics).toMatchObject({ tier: 'low', renderer: 'Intel UHD 620' });
    const jobs = JSON.parse(read('jobs.json')) as { id: string; steps: unknown[] }[];
    expect(jobs.map((j) => j.id)).toEqual(['job-2', 'job-1']);
    expect(jobs[1]?.steps).toEqual([{ name: 'tiles', state: 'failed' }]);
    expect(JSON.parse(read('packs.json'))).toMatchObject({
      mapPacks: [{ id: 'gcc' }],
      pipelinePack: { found: true, version: '1.4.0' },
    });
    expect(read('problem.md')).toContain('## What happened');
    expect(read('problem.md')).toContain('The map stayed grey.');
    expect(read('crash/minidumps.txt')).toContain('abc.dmp');
    // warnings and errors from every log, in time order
    expect(read('errors.txt').trim().split('\n')).toEqual([
      expect.stringContaining('[main] 2026-10-05T07:00:01.000Z ERROR old failure'),
      expect.stringContaining('[renderer] 2026-10-05T07:30:00.000Z ERROR WebGL'),
      expect.stringContaining('[main] 2026-10-05T08:00:00.000Z WARN gateway'),
    ]);
  });

  it('still saves when a source fails', async () => {
    const src = await sources();
    src.packs = () => Promise.reject(new Error(`pack folder unreadable ${KEY}`));
    const files = await collectBundle(src);
    const packs = files.find((f) => f.name === 'packs.json')?.text ?? '';
    expect(packs).toContain('pack folder unreadable');
    expect(packs).not.toContain(KEY);
    expect(files.some((f) => f.name === 'problem.md')).toBe(false);
  });

  it('writes a zip that opens with the same members', async () => {
    const files = await collectBundle(await sources(), { problem: { what: 'x' } });
    const out = join(dir, 'bundle.zip');
    await writeBundle(out, files);
    const zip = await openZip(out);
    expect([...zip.entries.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    expect((await zip.read('problem.md')).toString('utf8')).toContain('# Problem report');
  });

  it('lists open projects by id and size only', async () => {
    const root = join(dir, 'proj');
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'manifest.json'), '{}');
    await writeFile(join(root, 'models', 'a.glb'), Buffer.alloc(100));
    const pkg = join(dir, 'p.aio');
    await writeFile(pkg, Buffer.alloc(50));
    const list = await openProjectSizes(
      ['proj', 'pkg'],
      {
        root: (id) => (id === 'proj' ? root : undefined),
        packageFile: (id) => (id === 'pkg' ? pkg : undefined),
      },
      'pkg',
    );
    expect(list).toEqual([
      { id: 'proj', kind: 'folder', sizeBytes: 102, files: 2 },
      { id: 'pkg', kind: 'package', sizeBytes: 50, current: true },
    ]);
  });

  it('picks warnings and errors only', () => {
    expect(
      lastErrors([{ name: 'main.log', text: 'T1 INFO a\nT2 ERROR b\nT3 WARN c\nT4 DEBUG d\n' }]),
    ).toEqual(['[main] T2 ERROR b', '[main] T3 WARN c']);
  });
});

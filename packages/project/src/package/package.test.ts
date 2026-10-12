import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPackage, openPackage, scanProject } from './package';
import { writeZip } from './writer';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function manifest(): ProjectManifest {
  const m: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'tiny',
    name: 'Tiny tank',
    customer: 'KOC',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [{ id: 'c', label: 'Survey', date: '2023-11-22' }],
    layers: [
      { kind: 'mesh', id: 'tank', name: 'Tank', src: { path: 'models/tank.glb' }, transform: I },
      {
        kind: 'pointcloud',
        id: 'cloud',
        name: 'Cloud',
        src: { path: 'clouds/f101.bin' },
        format: 'kit-packed',
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  return ProjectManifest.parse(m);
}

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-pkg-'));
  root = join(dir, 'tiny');
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(manifest()),
    'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
    'models/tank.glb': 'glb'.repeat(100),
    'clouds/f101.bin': 'xyz'.repeat(1000),
    'thumbnail.jpg': 'jpg',
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), body);
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scanProject', () => {
  it('lists every file with its size and a forward-slash path', async () => {
    const files = await scanProject(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'clouds/f101.bin',
      'issues.json',
      'manifest.json',
      'models/tank.glb',
      'thumbnail.jpg',
    ]);
    expect(files.find((f) => f.path === 'clouds/f101.bin')?.size).toBe(3000);
  });
});

describe('exportPackage and openPackage', () => {
  it('writes a customer package that opens with its header, manifest and issues', async () => {
    const out = join(dir, 'tiny.aio');
    const r = await exportPackage({
      root,
      out,
      manifest: manifest(),
      exclude: ['cloud'],
      header: { readOnly: true, aiPolicy: 'forbid', exports: ['issues-csv'] },
      createdBy: 'Quadrion AI 0.1.0',
    });
    expect(r.bytes).toBeGreaterThan(300);

    const opened = await openPackage(out);
    if (!opened.ok) throw new Error(opened.error);
    const { header, manifest: m, archive, issuesJson } = opened.value;
    expect(header).toMatchObject({
      schema: 'aio.package/1',
      projectId: 'tiny',
      readOnly: true,
      aiPolicy: 'forbid',
      exports: ['issues-csv'],
      excludedLayers: ['cloud'],
      createdBy: 'Quadrion AI 0.1.0',
    });
    expect(m.layers.map((l) => l.id)).toEqual(['tank']);
    expect(archive.entries.has('clouds/f101.bin')).toBe(false);
    expect(issuesJson).toEqual({ schema: 'aio.issues/1', issues: [] });
    // Header first, then the manifest: a reader finds the policy without scanning.
    expect([...archive.entries.keys()].slice(0, 2)).toEqual(['aio-package.json', 'manifest.json']);
  });

  it('asks for the passphrase of an encrypted package and refuses a wrong one', async () => {
    const out = join(dir, 'tiny.aio');
    await exportPackage({
      root,
      out,
      manifest: manifest(),
      exclude: [],
      header: { readOnly: true, aiPolicy: 'allow', exports: [] },
      passphrase: 'correct horse',
    });
    const locked = await openPackage(out);
    expect(locked.ok).toBe(false);
    expect(!locked.ok && locked.needsPassphrase).toBe(true);
    const wrong = await openPackage(out, 'battery staple');
    expect(!wrong.ok && wrong.needsPassphrase).toBe(true);
    expect(!wrong.ok && wrong.error).toMatch(/passphrase/i);
    const right = await openPackage(out, 'correct horse');
    expect(right.ok && right.value.header.aiPolicy).toBe('allow');
    expect(right.ok && right.value.archive.encrypted).toBe(true);
  });

  it('treats a package without a header as a read-only customer package', async () => {
    const out = join(dir, 'bare.aio');
    await writeZip(out, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest())) },
      { name: 'models/tank.glb', data: Buffer.from('glb') },
      { name: 'clouds/f101.bin', data: Buffer.from('xyz') },
    ]);
    const r = await openPackage(out);
    expect(r.ok && r.value.header).toMatchObject({ readOnly: true, aiPolicy: 'forbid' });
  });

  it('names the missing file and the fix when a layer file is not in the package', async () => {
    const out = join(dir, 'partial.aio');
    await writeZip(out, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest())) },
      { name: 'models/tank.glb', data: Buffer.from('glb') },
    ]);
    const r = await openPackage(out);
    expect(!r.ok && r.error).toMatch(/clouds\/f101\.bin/);
    expect(!r.ok && r.error).toMatch(/Cloud/);
    expect(!r.ok && r.error).toMatch(/new copy|export/i);
  });

  describe('a retired viewer layer', () => {
    const withViewer = (): ProjectManifest => {
      const m = manifest();
      return ProjectManifest.parse({
        ...m,
        layers: [
          ...m.layers,
          {
            kind: 'legacy',
            id: 'legacy',
            name: 'Original review',
            viewer: 'volumetric',
            entry: { path: 'legacy/Review.html' },
          },
        ],
      });
    };

    it('is left out of a new package, which keeps the grids and still opens', async () => {
      for (const [rel, body] of [
        ['legacy/Review.html', '<!doctype html>'],
        ['legacy/lib/viewer.js', 'js'],
        ['legacy/data/vol.js', 'grid'],
      ] as const) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), body);
      }
      const out = join(dir, 'tiny.aio');
      await exportPackage({ root, out, manifest: withViewer(), exclude: [], header: {} });

      const opened = await openPackage(out);
      if (!opened.ok) throw new Error(opened.error);
      const { header, manifest: m, archive } = opened.value;
      expect(m.layers.map((l) => l.id)).toEqual(['tank', 'cloud']);
      expect(header.excludedLayers).toEqual(['legacy']);
      expect(archive.entries.has('legacy/Review.html')).toBe(false);
      expect(archive.entries.has('legacy/lib/viewer.js')).toBe(false);
      expect(archive.entries.has('legacy/data/vol.js')).toBe(true);
    });

    it('does not stop a package made before it was retired from opening', async () => {
      const out = join(dir, 'older.aio');
      await writeZip(out, [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(withViewer())) },
        { name: 'models/tank.glb', data: Buffer.from('glb') },
        { name: 'clouds/f101.bin', data: Buffer.from('xyz') },
        { name: 'legacy/Review.html', data: Buffer.from('<!doctype html>') },
        { name: 'legacy/data/vol.js', data: Buffer.from('grid') },
      ]);
      const r = await openPackage(out);
      if (!r.ok) throw new Error(r.error);
      // The entry is kept as it was written; consumers ignore it.
      expect(r.value.manifest.layers.map((l) => l.id)).toEqual(['tank', 'cloud', 'legacy']);
      expect(r.value.archive.entries.has('legacy/Review.html')).toBe(true);
    });

    it('needs no viewer file in the package', async () => {
      const out = join(dir, 'no-viewer.aio');
      await writeZip(out, [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(withViewer())) },
        { name: 'models/tank.glb', data: Buffer.from('glb') },
        { name: 'clouds/f101.bin', data: Buffer.from('xyz') },
      ]);
      const r = await openPackage(out);
      expect(r.ok).toBe(true);
    });
  });

  it('a walk layer needs its record and playback copy', async () => {
    const m = ProjectManifest.parse({
      ...manifest(),
      layers: [
        {
          kind: 'walk',
          id: 'walk-a',
          name: 'Walk',
          record: { path: 'walks/a/walk.json' },
          src: { path: 'walks/a/playback.mp4' },
          durationS: 30,
        },
      ],
    });
    const out = join(dir, 'walk.aio');
    await writeZip(out, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) },
      { name: 'walks/a/walk.json', data: Buffer.from('{}') },
    ]);
    const r = await openPackage(out);
    expect(!r.ok && r.error).toMatch(/walks\/a\/playback\.mp4/);
    await writeZip(out, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) },
      { name: 'walks/a/playback.mp4', data: Buffer.from('v') },
    ]);
    const r2 = await openPackage(out);
    expect(!r2.ok && r2.error).toMatch(/walks\/a\/walk\.json/);
  });

  it('refuses a target without enough free space before it starts', async () => {
    await expect(
      exportPackage({
        root,
        out: join(dir, 'tiny.aio'),
        manifest: manifest(),
        exclude: [],
        header: {},
        freeBytes: () => Promise.resolve(10),
      }),
    ).rejects.toThrow(/space/i);
  });
});

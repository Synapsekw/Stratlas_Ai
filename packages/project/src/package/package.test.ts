import { georefToLayerTransform, worldOfModelPoint, type ProjectGeo } from '@aio/geo';
import { ProjectManifest, type Georef, type ProjectManifestInput, type Vec3 } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifestFile } from '../builder/create';
import { encodeGlb, parseGlb } from '../import/glb';
import { exportPackage, openPackage, scanProject } from './package';
import { extractProject } from './unpack';
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

describe('an engineering model through a .aio package (acceptance E)', () => {
  const rad = Math.PI / 180;
  // synthetic: the model 12.5 m east, 40 m north and 3 m up from the origin, turned 30 degrees
  const anchor: Vec3 = [400012.5, 3100040, 33];
  const c = Math.cos(30 * rad);
  const s = Math.sin(30 * rad);
  const georef: Georef = {
    schema: 'aio.georef/1',
    crs: { epsg: 32639 },
    anchor,
    axes: 'x-east,y-up,z-south',
    units: 'm',
    modelToCrs: [c, -s, 0, 0, 0, 0, 1, 0, -s, -c, 0, 0, ...anchor, 1],
    heading: { deg: 30, status: 'measured' },
    scale: { factor: 1, status: 'measured' },
    horizontal: { status: 'surveyed', accuracyM: 0.02 },
    vertical: { datum: 'unknown', status: 'unknown' },
    provenance: { by: 'engineer', runId: 'run-1' },
  };
  const project: ProjectGeo = { crs: { epsg: 32639 }, origin: [400000, 3100000, 30] };
  const extras = (id: string, h: number) => ({
    component: id,
    name: id,
    description: `Synthetic flue ${id}, ${String(h)} m`,
    category: 'Flues',
    kind: 'flue',
    status: 'accepted',
    part: id,
    basis: 'measured',
    quality: { params: { height: 'measured' }, residualM: 0.01 },
    dimensions: { height: h },
  });
  const POSITIONS = new Float32Array([0, 0, 0, 3.5, 50, -2, -4, 120, 6]);

  /** A bundle-like GLB: two component nodes with extras, `aioGeoref` in the asset extras. */
  function bundleGlb(): Uint8Array {
    const g = encodeGlb({
      generator: 'test',
      nodes: [
        { name: 'flue-1', mesh: 0, extras: extras('flue-1', 6) },
        { name: 'flue-2', mesh: 0, extras: extras('flue-2', 7) },
      ],
      scene: [0, 1],
      meshes: [
        {
          name: 'flue',
          primitives: [{ material: 0, positions: POSITIONS, indices: new Uint32Array([0, 1, 2]) }],
        },
      ],
      materials: [{ name: 'steel' }],
      images: [],
    });
    const { json, bin } = parseGlb(g);
    const text = new TextEncoder().encode(
      JSON.stringify({ ...json, asset: { ...json.asset, extras: { aioGeoref: georef } } }),
    );
    const jsonLen = text.length + ((4 - (text.length % 4)) % 4);
    const total = 20 + jsonLen + 8 + bin.byteLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    out.fill(0x20, 20 + text.length, 20 + jsonLen);
    dv.setUint32(20 + jsonLen, bin.byteLength, true);
    dv.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
    return out;
  }

  function engineeringManifest(): ProjectManifest {
    const placed = georefToLayerTransform(georef, project);
    if (placed.kind !== 'placed') throw new Error('not placed');
    return ProjectManifest.parse({
      schema: 'aio.project/1',
      id: 'stack',
      name: 'Synthetic stack',
      crs: project.crs,
      origin: project.origin,
      captures: [],
      layers: [
        {
          kind: 'mesh',
          id: 'model-stack',
          name: 'Stack',
          visible: true,
          src: { path: 'models/stack.glb' },
          transform: placed.transform,
          georef,
          placement: 'placed',
          derived: { kind: 'model', source: ['stack'] },
        },
      ],
      severityModels: [],
      classCatalogues: [],
    });
  }

  let eroot: string;
  let glb: Uint8Array;
  const MODEL_FILES = [
    'models/stack.glb',
    'models/stack.procmodel.json',
    'models/stack.georeference.json',
    'models/stack.components.json',
  ];
  beforeEach(async () => {
    eroot = join(dir, 'stack');
    glb = bundleGlb();
    const files: Record<string, string | Uint8Array> = {
      'manifest.json': JSON.stringify(engineeringManifest()),
      'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
      'models/stack.glb': glb,
      'models/stack.procmodel.json': '{"schema":"aio.procmodel/2"}',
      'models/stack.georeference.json': JSON.stringify(georef),
      'models/stack.components.json': '[{"id":"flue-1"},{"id":"flue-2"}]',
      'engineering/run-1/run.json': '{}',
      'engineering/run-1/evidence.json': '{}',
      'engineering/run-1/img/photo-1.jpg': 'jpg',
      'engineering/run-1/ai/abc.json': '{}',
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(eroot, rel)), { recursive: true });
      await writeFile(join(eroot, rel), body);
    }
  });

  async function pack(readOnly: boolean): Promise<string> {
    const out = join(dir, readOnly ? 'stack-view.aio' : 'stack.aio');
    await exportPackage({
      root: eroot,
      out,
      manifest: engineeringManifest(),
      exclude: [],
      header: { readOnly, aiPolicy: 'forbid', exports: [] },
    });
    return out;
  }

  it('keeps the placement, the model files and the GLB, and leaves the run folder out', async () => {
    const out = await pack(false);
    const opened = await openPackage(out);
    if (!opened.ok) throw new Error(opened.error);
    const { manifest: m, archive, header } = opened.value;
    const layer = m.layers.find((l) => l.id === 'model-stack');
    expect(layer?.kind === 'mesh' && layer.georef).toEqual(georef);
    expect(layer?.kind === 'mesh' && layer.placement).toBe('placed');
    for (const f of MODEL_FILES) expect(archive.entries.has(f), f).toBe(true);
    expect([...archive.entries.keys()].filter((k) => k.startsWith('engineering/'))).toEqual([]);

    const ex = await extractProject({
      archive,
      header,
      manifest: m,
      file: out,
      dataRoot: join(dir, 'data'),
      freeBytes: () => Promise.resolve(undefined),
    });
    // the manifest is read back through the schema, as opening the project does
    const back = await readManifestFile(ex.root);
    const before = engineeringManifest().layers[0];
    const after = back.layers.find((l) => l.id === 'model-stack');
    if (before?.kind !== 'mesh' || after?.kind !== 'mesh') throw new Error('no mesh layer');
    expect(after.georef).toEqual(before.georef);
    expect(after.placement).toBe('placed');
    expect(after.transform).toEqual(before.transform);
    expect(await readdir(ex.root)).not.toContain('engineering');

    // the GLB is the same bytes, so every component's extras and vertex are too
    const copy = new Uint8Array(await readFile(join(ex.root, 'models', 'stack.glb')));
    expect(Buffer.from(copy).equals(Buffer.from(glb))).toBe(true);
    const nodes = (parseGlb(copy).json.nodes ?? []).map((n) => [n.name, n.extras]);
    expect(nodes).toEqual([
      ['flue-1', extras('flue-1', 6)],
      ['flue-2', extras('flue-2', 7)],
    ]);
    const exProject: ProjectGeo = { crs: back.crs, origin: back.origin };
    for (let i = 0; i < 3; i++) {
      const v: Vec3 = [
        POSITIONS[3 * i] ?? NaN,
        POSITIONS[3 * i + 1] ?? NaN,
        POSITIONS[3 * i + 2] ?? NaN,
      ];
      const a = worldOfModelPoint(before.transform, project, v);
      const b = worldOfModelPoint(after.transform, exProject, v);
      for (let k = 0; k < 3; k++)
        expect(Math.abs((a[k] ?? NaN) - (b[k] ?? NaN))).toBeLessThan(0.001);
      // and both are where the georeference puts that vertex
      const at = (j: number) => georef.modelToCrs[j] ?? NaN;
      const truth = [0, 1, 2].map(
        (k) => at(k) * v[0] + at(4 + k) * v[1] + at(8 + k) * v[2] + at(12 + k),
      );
      for (let k = 0; k < 3; k++)
        expect(Math.abs((b[k] ?? NaN) - (truth[k] ?? NaN))).toBeLessThan(0.001);
    }
    for (const f of MODEL_FILES) expect(existsSync(join(ex.root, ...f.split('/'))), f).toBe(true);
  });

  it('a read-only package keeps the placement and cannot be extracted to edit', async () => {
    const out = await pack(true);
    const opened = await openPackage(out);
    if (!opened.ok) throw new Error(opened.error);
    const layer = opened.value.manifest.layers.find((l) => l.id === 'model-stack');
    expect(layer?.kind === 'mesh' && layer.georef).toEqual(georef);
    expect(opened.value.header.readOnly).toBe(true);
    await expect(
      extractProject({
        archive: opened.value.archive,
        header: opened.value.header,
        manifest: opened.value.manifest,
        file: out,
        dataRoot: join(dir, 'data'),
      }),
    ).rejects.toThrow(/read-only/);
  });

  it('leaving the model layer out leaves its model files out too', async () => {
    const out = join(dir, 'without.aio');
    await exportPackage({
      root: eroot,
      out,
      manifest: engineeringManifest(),
      exclude: ['model-stack'],
      header: { readOnly: true, aiPolicy: 'forbid', exports: [] },
    });
    const opened = await openPackage(out);
    if (!opened.ok) throw new Error(opened.error);
    for (const f of MODEL_FILES) expect(opened.value.archive.entries.has(f), f).toBe(false);
  });
});

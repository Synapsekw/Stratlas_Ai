import { readManifestFile, writeManifestFile } from '@aio/project/builder';
import type { EngineerSetup, ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  engineerRuntimeHost,
  engineeringSourceStamp,
  evidencePolicy,
  MANIFEST_UNREADABLE,
  registerEvidencePolicyIpc,
  resizeDataUrl,
  type NativeImageLike,
} from './evidencePolicy';
import type { ModelProjects } from './modelBuilder';
import { collectHandlers } from './notYet';

function ipc(o: { package?: () => unknown } = {}) {
  return collectHandlers((handle) => {
    registerEvidencePolicyIpc({
      handle,
      projects: {
        root: (id) => (id === 'site' ? root : undefined),
        package: (o.package ?? (() => undefined)) as ModelProjects['package'],
      },
    });
  });
}

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'site',
  name: 'Synthetic site',
  crs: { epsg: 32640 },
  origin: [400000, 2800000, 0],
  captures: [{ id: 'c1', label: 'First', date: '2026-01-10' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

let dir = '';
let root = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quadrion-evidence-'));
  root = join(dir, 'site');
  await mkdir(root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('evidencePolicy', () => {
  it('invalidates measurements from the previous fitting algorithm without source edits', async () => {
    await writeManifestFile(root, manifest);
    const setup: EngineerSetup = {
      sources: { clouds: [], meshes: [], photos: [] },
      family: 'auto',
      scope: 'asset',
      detail: 'fast',
      placement: 'from-source',
    };
    const oldStamp = createHash('sha256')
      .update(
        JSON.stringify({
          algorithm: 'components/5',
          origin: manifest.origin,
          crs: manifest.crs,
          frames: [],
          identity: [],
        }),
      )
      .digest('hex');
    expect(await engineeringSourceStamp(root, setup)).not.toBe(oldStamp);
  });

  it('invalidates a PNG cloud when a referenced point chunk changes', async () => {
    await writeFile(join(root, 'index.json'), JSON.stringify({ chunks: [{ file: 'chunk.png' }] }));
    await writeFile(join(root, 'chunk.png'), 'old points');
    await writeManifestFile(root, {
      ...manifest,
      layers: [
        {
          id: 'scan',
          name: 'Scan',
          kind: 'pointcloud',
          src: { path: 'index.json' },
          format: 'png-packed',
          visible: true,
        },
      ],
    });
    const setup: EngineerSetup = {
      sources: { clouds: [{ layer: 'scan' }], meshes: [], photos: [] },
      family: 'auto',
      scope: 'asset',
      detail: 'fast',
      placement: 'from-source',
    };
    const before = await engineeringSourceStamp(root, setup);
    await writeFile(join(root, 'chunk.png'), 'changed points');
    expect(await engineeringSourceStamp(root, setup)).not.toBe(before);
  });
  it('refuses a source or point chunk outside the project', async () => {
    await writeFile(join(root, '..', 'outside.png'), 'not the project');
    await writeFile(
      join(root, 'index.json'),
      JSON.stringify({ chunks: [{ file: '../outside.png' }] }),
    );
    await writeManifestFile(root, {
      ...manifest,
      layers: [
        {
          id: 'scan',
          name: 'Scan',
          kind: 'pointcloud',
          src: { path: 'index.json' },
          format: 'png-packed',
          visible: true,
        },
      ],
    });
    const setup: EngineerSetup = {
      sources: { clouds: [{ layer: 'scan' }], meshes: [], photos: [] },
      family: 'auto',
      scope: 'asset',
      detail: 'fast',
      placement: 'from-source',
    };
    await expect(engineeringSourceStamp(root, setup)).rejects.toThrow(/inside the project/);
    await writeFile(join(root, 'index.json'), JSON.stringify({ chunks: [] }));
    await expect(
      engineeringSourceStamp(root, {
        ...setup,
        sources: { ...setup.sources, photos: [{ path: '../outside.png' }] },
      }),
    ).rejects.toThrow(/inside the project/);
  });
  it('stamps photos and drawings picked from files outside the project', async () => {
    await writeManifestFile(root, manifest);
    const photo = join(dir, 'picked.jpg');
    await writeFile(photo, 'a photo');
    const setup: EngineerSetup = {
      sources: { clouds: [], meshes: [], photos: [{ path: photo }], drawings: [{ path: photo }] },
      family: 'auto',
      scope: 'asset',
      detail: 'fast',
      placement: 'from-source',
    };
    const before = await engineeringSourceStamp(root, setup);
    await writeFile(photo, 'another photo');
    expect(await engineeringSourceStamp(root, setup)).not.toBe(before);
    await expect(
      engineeringSourceStamp(root, {
        ...setup,
        sources: { ...setup.sources, photos: [{ path: '\\\\server\\share\\a.jpg' }] },
      }),
    ).rejects.toThrow(/on this computer/);
  });
  it('invalidates measurements when a selected source changes in place or its cloud offset changes', async () => {
    const layer = {
      id: 'scan',
      name: 'Scan',
      kind: 'pointcloud' as const,
      src: { path: 'scan.laz' },
      format: 'copc' as const,
      visible: true,
    };
    const setup: EngineerSetup = {
      sources: { clouds: [{ layer: 'scan' }], meshes: [], photos: [] },
      family: 'auto',
      scope: 'asset',
      detail: 'fast',
      placement: 'from-source',
    };
    await writeFile(join(root, 'scan.laz'), 'original');
    await writeManifestFile(root, { ...manifest, layers: [layer] });
    const a = await engineeringSourceStamp(root, setup);
    await writeFile(join(root, 'scan.laz'), 'changed point data');
    const b = await engineeringSourceStamp(root, setup);
    expect(b).not.toBe(a);
    await writeManifestFile(root, { ...manifest, layers: [{ ...layer, heightOffsetM: -32.542 }] });
    expect(await engineeringSourceStamp(root, setup)).not.toBe(b);
    await rm(join(root, 'scan.laz'));
    await expect(engineeringSourceStamp(root, setup)).rejects.toThrow();
  });
  it('is off for photos and scans when the flags are absent', async () => {
    await writeManifestFile(root, manifest);
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: false });
  });

  it('reads each flag on its own, from the file on disk', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudPhotos: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: true, scans: false });
    await writeManifestFile(root, { ...manifest, aiCloudScans: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: true });
  });

  it('drawing consent does not allow photos or scans', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudDrawings: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: false });
  });

  it('a package that forbids cloud AI forbids, whatever the flags say', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudPhotos: true, aiCloudScans: true });
    const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as object;
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...raw, aiPolicy: 'forbid' }));
    expect(await evidencePolicy(root)).toMatchObject({ ai: 'forbid' });
  });

  it('refuses with a reason when the manifest cannot be read (never "allow")', async () => {
    await writeFile(join(root, 'manifest.json'), '{"aiCloudPhotos": true, broken');
    expect(await evidencePolicy(root)).toEqual({ error: MANIFEST_UNREADABLE });
    expect(await evidencePolicy(join(dir, 'missing'))).toEqual({ error: MANIFEST_UNREADABLE });
  });

  it('ai:setCloudEvidence sets and removes each consent on its own', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudDrawings: true });
    const t = ipc();
    expect(await t.call('ai:setCloudEvidence', { projectId: 'site', photos: true })).toEqual({
      ok: true,
    });
    expect(await evidencePolicy(root)).toMatchObject({ photos: true, scans: false });
    await t.call('ai:setCloudEvidence', { projectId: 'site', scans: true });
    expect(await evidencePolicy(root)).toMatchObject({ photos: true, scans: true });
    await t.call('ai:setCloudEvidence', { projectId: 'site', photos: false });
    const m = await readManifestFile(root);
    expect(m.aiCloudPhotos).toBeUndefined();
    expect(m.aiCloudScans).toBe(true);
    // drawing consent and the rest of the manifest are untouched
    expect(m.aiCloudDrawings).toBe(true);
    expect(m.name).toBe('Synthetic site');
  });

  it('ai:setCloudEvidence refuses a package and a project that is not open', async () => {
    await writeManifestFile(root, manifest);
    const pkg = ipc({ package: () => ({}) });
    expect(
      await pkg.call('ai:setCloudEvidence', { projectId: 'site', photos: true }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(await evidencePolicy(root)).toMatchObject({ photos: false });
    expect(
      await ipc().call('ai:setCloudEvidence', { projectId: 'other', scans: true }),
    ).toMatchObject({ ok: false });
  });

  it('the engineer host reads the consents from disk on every request', async () => {
    await writeManifestFile(root, manifest);
    const h = engineerRuntimeHost({
      projects: { root: (id) => (id === 'site' ? root : undefined), package: () => undefined },
      packagePolicy: () => 'forbid',
    });
    expect(await h.policy('site')).toEqual({ ai: 'allow', photos: false, scans: false });
    await writeManifestFile(root, { ...manifest, aiCloudPhotos: true });
    expect(await h.policy('site')).toEqual({ ai: 'allow', photos: true, scans: false });
    expect(await h.policy('other')).toBeNull();
    expect(h.runDir?.('site', 'run-a')).toBe(join(root, 'engineering', 'run-a'));
  });

  it('a package shares no photos or scans and keeps no cache', async () => {
    const h = engineerRuntimeHost({
      projects: { root: () => undefined, package: () => ({}) as never },
      packagePolicy: () => 'allow',
    });
    expect(await h.policy('pkg')).toEqual({ ai: 'allow', photos: false, scans: false });
    expect(h.runDir?.('pkg', 'run-a')).toBeUndefined();
  });

  it('a flag that is not a boolean makes the manifest invalid: refused, not allowed', async () => {
    await writeManifestFile(root, manifest);
    const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as object;
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({ ...raw, aiCloudPhotos: 'yes', aiCloudScans: 1 }),
    );
    expect(await evidencePolicy(root)).toEqual({ error: MANIFEST_UNREADABLE });
  });
});

describe('resizeDataUrl', () => {
  function fake(width: number, height: number, empty = false) {
    const resized: { width: number; height: number }[] = [];
    const img: NativeImageLike = {
      isEmpty: () => empty,
      getSize: () => ({ width, height }),
      resize: (o) => {
        resized.push({ width: o.width, height: o.height });
        return img;
      },
      toPNG: () => Buffer.from('png-bytes'),
      toJPEG: (q) => Buffer.from(`jpeg-${String(q)}`),
    };
    return { img, resized };
  }

  it('fits the long side and keeps a PNG a PNG', async () => {
    const f = fake(4000, 3000);
    const out = await resizeDataUrl('data:image/png;base64,AAAA', 1568, () => f.img);
    expect(f.resized).toEqual([{ width: 1568, height: 1176 }]);
    expect(out).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
  });

  it('re-encodes JPEG and WebP as JPEG at 90', async () => {
    for (const type of ['jpeg', 'webp']) {
      const f = fake(1000, 3000);
      const out = await resizeDataUrl(`data:image/${type};base64,AAAA`, 1024, () => f.img);
      expect(f.resized).toEqual([{ width: 341, height: 1024 }]);
      expect(out).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-90').toString('base64')}`);
    }
  });

  it('refuses an image it cannot decode', async () => {
    await expect(
      resizeDataUrl('data:image/png;base64,AAAA', 1024, () => fake(0, 0, true).img),
    ).rejects.toThrow('could not be decoded');
  });
});

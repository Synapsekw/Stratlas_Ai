import { PackageOrigin, ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPackage, openPackage, type OpenedPackage } from './package';
import { extractProject } from './unpack';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function manifest(): ProjectManifest {
  const m: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'tank',
    name: 'Tank 7',
    crs: { epsg: 32639 },
    origin: [216108, 3220019, 0],
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

const ISSUES = JSON.stringify({
  schema: 'aio.issues/1',
  issues: [{ id: 'i1', code: 'F01', note: 'kept' }],
});

let dir: string;
let root: string;
let dataRoot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-unpack-'));
  root = join(dir, 'tank');
  dataRoot = join(dir, 'data');
  const files: Record<string, string | Buffer> = {
    'manifest.json': JSON.stringify(manifest()),
    'issues.json': ISSUES,
    'edits/boundaries.json': JSON.stringify({ schema: 'aio.boundaries/1', edits: [] }),
    'models/tank.glb': 'glb'.repeat(100),
    'clouds/f101.bin': Buffer.alloc(300_000, 7),
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

async function pack(
  o: { readOnly: boolean; editPolicy?: 'allow' | 'forbid'; passphrase?: string },
  name = 'Tank delivery.aio',
): Promise<{ file: string; opened: OpenedPackage }> {
  const file = join(dir, name);
  await exportPackage({
    root,
    out: file,
    manifest: manifest(),
    exclude: [],
    header: {
      readOnly: o.readOnly,
      aiPolicy: 'forbid',
      exports: ['issues-csv'],
      ...(o.editPolicy ? { editPolicy: o.editPolicy } : {}),
    },
    createdBy: 'Stratlas 0.1.0',
    ...(o.passphrase ? { passphrase: o.passphrase } : {}),
  });
  const r = await openPackage(file, o.passphrase);
  if (!r.ok) throw new Error(r.error);
  return { file, opened: r.value };
}

const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');

describe('extractProject', () => {
  it('copies an encrypted package into a new editable project with an origin note', async () => {
    const { file, opened } = await pack({
      readOnly: true,
      editPolicy: 'allow',
      passphrase: 'correct horse battery',
    });
    const before = { hash: await sha(file), mtime: (await stat(file)).mtimeMs };
    const seen: number[] = [];
    const r = await extractProject({
      ...opened,
      file,
      dataRoot,
      extractedBy: 'surveyor',
      now: () => new Date('2026-10-05T09:00:00.000Z'),
      onProgress: (p) => seen.push(p.bytesDone),
    });

    expect(r.id).toBe('tank-delivery-edit');
    expect(r.root).toBe(join(dataRoot, 'projects', 'tank-delivery-edit'));
    expect((await readdir(r.root)).sort()).toEqual([
      'clouds',
      'edits',
      'issues.json',
      'manifest.json',
      'models',
      'package-origin.json',
      'thumbnail.jpg',
    ]);
    expect(await readFile(join(r.root, 'issues.json'), 'utf8')).toBe(ISSUES);
    expect(await readFile(join(r.root, 'clouds/f101.bin'))).toEqual(Buffer.alloc(300_000, 7));
    expect(await readFile(join(r.root, 'edits/boundaries.json'), 'utf8')).toContain(
      'aio.boundaries/1',
    );
    const m = JSON.parse(await readFile(join(r.root, 'manifest.json'), 'utf8')) as {
      id: string;
      layers: unknown[];
    };
    expect(m.id).toBe('tank-delivery-edit');
    expect(m.layers).toHaveLength(2);
    const origin = PackageOrigin.parse(
      JSON.parse(await readFile(join(r.root, 'package-origin.json'), 'utf8')),
    );
    expect(origin).toMatchObject({
      package: 'Tank delivery.aio',
      projectId: 'tank',
      exportedAt: opened.header.createdAt,
      exportedBy: 'Stratlas 0.1.0',
      extractedAt: '2026-10-05T09:00:00.000Z',
      extractedBy: 'surveyor',
      encrypted: true,
    });
    expect(seen.at(-1)).toBeGreaterThan(300_000);
    // The package is never touched.
    expect({ hash: await sha(file), mtime: (await stat(file)).mtimeMs }).toEqual(before);

    // A second extract never reuses the folder.
    const again = await extractProject({ ...opened, file, dataRoot });
    expect(again.id).toBe('tank-delivery-edit-2');
  });

  it('refuses a package whose policy forbids editing, and old customer packages', async () => {
    const forbid = await pack({ readOnly: false, editPolicy: 'forbid' }, 'a.aio');
    await expect(extractProject({ ...forbid.opened, file: forbid.file, dataRoot })).rejects.toThrow(
      /did not allow editing/,
    );
    // Written before the edit policy existed: a customer package stays read-only ...
    const customer = await pack({ readOnly: true }, 'b.aio');
    await expect(
      extractProject({ ...customer.opened, file: customer.file, dataRoot }),
    ).rejects.toThrow(/read-only delivery/);
    // ... and a working package may be extracted.
    const working = await pack({ readOnly: false }, 'c.aio');
    await expect(
      extractProject({ ...working.opened, file: working.file, dataRoot }),
    ).resolves.toMatchObject({ id: 'c-edit' });
    expect(await readdir(join(dataRoot, 'projects'))).toEqual(['c-edit']);
  });

  it('leaves nothing behind when a member is damaged or the extract is cancelled', async () => {
    const { file, opened } = await pack({ readOnly: false, editPolicy: 'allow' });
    const ac = new AbortController();
    ac.abort();
    await expect(extractProject({ ...opened, file, dataRoot, signal: ac.signal })).rejects.toThrow(
      /cancelled/i,
    );
    expect(await readdir(join(dataRoot, 'projects'))).toEqual([]);

    // Flip one byte of the point cloud inside the package (a copy: the test owns it).
    const cloud = opened.archive.entries.get('clouds/f101.bin');
    if (!cloud) throw new Error('no cloud member');
    const at = (await opened.archive.dataOffset('clouds/f101.bin')) + 1000;
    const fh = await open(file, 'r+');
    await fh.write(Buffer.from([8]), 0, 1, at);
    await fh.close();
    await expect(extractProject({ ...opened, file, dataRoot })).rejects.toThrow(/checksum/);
    expect(await readdir(join(dataRoot, 'projects'))).toEqual([]);
  });

  it('checks free space before writing', async () => {
    const { file, opened } = await pack({ readOnly: false });
    await expect(
      extractProject({ ...opened, file, dataRoot, freeBytes: () => Promise.resolve(1000) }),
    ).rejects.toThrow(/Not enough space/);
  });
});

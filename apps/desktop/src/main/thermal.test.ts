import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManifest, SCHEMA_VERSION, THERMAL_SCHEMA, type ThermalFile } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import type { SurveyArchive } from './survey';
import { probeThermal, readThermal, registerThermalIpc, writeThermal } from './thermal';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manifest = ProjectManifest.parse({
  schema: SCHEMA_VERSION,
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Photos',
      items: [
        { id: 'a', src: { path: 'photos/a.jpg' } },
        { id: 'b', src: { path: 'photos/b.jpg' } },
        { id: 'c', src: { path: 'photos/c.jpg' } },
        { id: 'gone', src: { path: 'photos/gone.jpg' } },
      ],
    },
  ],
  severityModels: [],
  classCatalogues: [],
});

const seg = (marker: number, payload: Buffer): Buffer => {
  const n = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, n >> 8, n & 0xff]), payload]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const flirJpeg = (): Buffer =>
  Buffer.concat([SOI, seg(0xe1, Buffer.from('FLIR\0\x01\x00\x00FFF\0', 'latin1'))]);
const plainJpeg = (): Buffer => Buffer.concat([SOI, seg(0xe1, Buffer.from('Exif\0\0', 'latin1'))]);
const djiJpeg = (): Buffer =>
  Buffer.concat([
    SOI,
    seg(
      0xe1,
      Buffer.from(
        'http://ns.adobe.com/xap/1.0/\0<x drone-dji:Model="M30T" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"/>',
        'latin1',
      ),
    ),
    seg(0xe3, Buffer.from('thermal', 'latin1')),
  ]);

function setup(pkgMembers?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'aio-thermal-'));
  dirs.push(root);
  const archive: SurveyArchive = {
    entries: new Map(Object.entries(pkgMembers ?? {})),
    read: (name) => Promise.resolve(Buffer.from(JSON.stringify(pkgMembers?.[name]), 'utf8')),
  };
  const projects = {
    root: (id: string) => (id === 'p' ? root : undefined),
    package: (id: string) => (id === 'pkg' ? { archive } : undefined),
  };
  return { root, projects };
}
const filePath = (root: string) => join(root, 'thermal', 'thermal.json');
const sample = (): ThermalFile => ({
  schema: THERMAL_SCHEMA,
  photos: {},
  readings: [],
  hotspots: [],
});

describe('thermal:probe', () => {
  it('names the family of each photo of a layer', async () => {
    const { root, projects } = setup();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    mkdirSync(join(root, 'photos'));
    writeFileSync(join(root, 'photos', 'a.jpg'), flirJpeg());
    writeFileSync(join(root, 'photos', 'b.jpg'), plainJpeg());
    writeFileSync(join(root, 'photos', 'c.jpg'), djiJpeg());
    const r = await probeThermal(projects, 'p', 'ph');
    expect(r).toEqual({
      ok: true,
      photos: [
        { photoId: 'a', family: 'flir', make: 'FLIR', model: '' },
        { photoId: 'b', family: null, make: null, model: null },
        { photoId: 'c', family: 'dji-tsdk', make: 'DJI', model: 'M30T' },
        { photoId: 'gone', family: null, make: null, model: null },
      ],
    });
  });

  it('reads only the first 256 KB of a photo', async () => {
    const { root, projects } = setup();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    mkdirSync(join(root, 'photos'));
    // a FLIR segment after 256 KB of padding is not seen
    const pad = seg(0xe2, Buffer.alloc(60000));
    const late = Buffer.concat([
      SOI,
      pad,
      pad,
      pad,
      pad,
      pad,
      seg(0xe1, Buffer.from('FLIR\0\x01\x00\x00FFF\0', 'latin1')),
    ]);
    writeFileSync(join(root, 'photos', 'a.jpg'), late);
    const r = await probeThermal(projects, 'p', 'ph');
    expect(r.ok && r.photos[0]?.family).toBeNull();
  });

  it('fails for an unknown layer, an unknown project and a package', async () => {
    const { root, projects } = setup();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    expect((await probeThermal(projects, 'p', 'nope')).ok).toBe(false);
    expect((await probeThermal(projects, 'zz', 'ph')).ok).toBe(false);
    expect((await probeThermal(projects, 'pkg', 'ph')).ok).toBe(false);
  });
});

describe('thermal file', () => {
  it('reads null when nothing was written yet', async () => {
    const { projects } = setup();
    expect(await readThermal(projects, 'p')).toEqual({ ok: true, file: null });
  });

  it('writes atomically with a .bak and reads it back', async () => {
    const { root, projects } = setup();
    expect(await writeThermal(projects, 'p', sample())).toEqual({ ok: true });
    expect(existsSync(`${filePath(root)}.bak`)).toBe(false);
    const second = { ...sample(), defaults: undefined, readings: [] };
    expect(await writeThermal(projects, 'p', second)).toEqual({ ok: true });
    expect(existsSync(`${filePath(root)}.bak`)).toBe(true);
    expect(await readThermal(projects, 'p')).toEqual({ ok: true, file: sample() });
  });

  it('refuses a package, an unknown project and a file that fails ThermalFile', async () => {
    const { root, projects } = setup({ 'thermal/thermal.json': sample() });
    expect(await writeThermal(projects, 'pkg', sample())).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect((await writeThermal(projects, 'zz', sample())).ok).toBe(false);
    const bad = { ...sample(), schema: 'nope' } as unknown as ThermalFile;
    const w = await writeThermal(projects, 'p', bad);
    expect(w.ok).toBe(false);
    expect(existsSync(filePath(root))).toBe(false);
    expect(await readThermal(projects, 'pkg')).toEqual({ ok: true, file: sample() });
  });

  it('returns the error text for a corrupt file and refuses a newer one', async () => {
    const { root, projects } = setup();
    mkdirSync(join(root, 'thermal'));
    writeFileSync(filePath(root), '{ not json');
    const r = await readThermal(projects, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/thermal analysis/i);
    writeFileSync(filePath(root), JSON.stringify({ schema: 'aio.thermal/2' }));
    const n = await readThermal(projects, 'p');
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.error).toMatch(/newer version/i);
    const w = await writeThermal(projects, 'p', sample());
    expect(w.ok).toBe(false);
    expect(readFileSync(filePath(root), 'utf8')).toBe(JSON.stringify({ schema: 'aio.thermal/2' }));
  });

  it('registers the three channels', () => {
    const { projects } = setup();
    const h = collectHandlers((handle) => {
      registerThermalIpc({ handle, projects });
    });
    expect(h.channels()).toEqual(['thermal:probe', 'thermal:read', 'thermal:write']);
  });
});

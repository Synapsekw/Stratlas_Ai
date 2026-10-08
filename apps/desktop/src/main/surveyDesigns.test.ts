import type { DesignEntry, DesignsFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerSurveyIpc, type SurveyProjects } from './survey';

const SHA = 'a'.repeat(64);

const entry = (over: Partial<DesignEntry> = {}): DesignEntry => ({
  id: 'pad',
  name: 'Pad design',
  src: 'pad.xml',
  sha256: SHA,
  bytes: 1200,
  format: 'landxml',
  units: 'm',
  crs: { epsg: 32639 },
  calibrated: false,
  importedAt: '2026-10-09T10:00:00Z',
  layers: [
    {
      id: 'Pad-design',
      name: 'Pad design',
      kind: 'surface',
      file: 'Pad-design.tin',
      glb: 'Pad-design.glb',
      counts: { triangles: 8, vertices: 9 },
      visible: true,
      archived: false,
      verticalOffsetM: 0,
    },
    {
      id: 'CL1',
      name: 'CL1',
      kind: 'alignment',
      file: 'CL1.alignment.json',
      counts: { elements: 3 },
      visible: true,
      archived: false,
      verticalOffsetM: 0,
    },
  ],
  ...over,
});

const file = (designs: DesignEntry[], extra: Partial<DesignsFile> = {}): DesignsFile => ({
  schema: 'aio.designs/1',
  designs,
  ...extra,
});

describe('survey designs (G6)', () => {
  let root: string;
  let pkgEntries: Map<string, unknown>;
  let pkgFiles: Map<string, Buffer>;
  const projects: SurveyProjects = {
    root: (id) => (id === 'p' ? root : undefined),
    package: (id) =>
      id === 'pkg'
        ? {
            archive: {
              entries: pkgEntries,
              read: (name) => {
                const b = pkgFiles.get(name);
                return b ? Promise.resolve(b) : Promise.reject(new Error('missing'));
              },
            },
          }
        : undefined,
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyIpc({ handle, projects });
  });
  const designsPath = () => join(root, 'survey', 'designs.json');
  const seed = async (f: DesignsFile) => {
    await mkdir(join(root, 'survey', 'designs', 'pad'), { recursive: true });
    await writeFile(join(root, 'survey', 'designs', 'pad', 'pad.xml'), '<LandXML/>');
    await writeFile(designsPath(), JSON.stringify(f));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aio-designs-'));
    pkgEntries = new Map();
    pkgFiles = new Map();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads an empty list for a site without designs', async () => {
    expect(await ipc.call('survey:readDesigns', { projectId: 'p' })).toEqual({
      ok: true,
      file: { schema: 'aio.designs/1', designs: [] },
    });
  });

  it('saves what a person may change, atomically with a .bak', async () => {
    await seed(file([entry()]));
    const read = await ipc.call('survey:readDesigns', { projectId: 'p' });
    expect(read.ok).toBe(true);
    const next = entry({ name: 'Pad v2', folder: 'Earthworks' });
    const [surface, al] = next.layers;
    if (!surface || !al) throw new Error('fixture');
    next.layers = [
      { ...surface, verticalOffsetM: -0.3, visible: false },
      { ...al, archived: false, intervalM: 25 },
    ];
    const saved = await ipc.call('survey:writeDesigns', {
      projectId: 'p',
      file: file([next], { activeAlignment: 'pad/CL1' }),
    });
    expect(saved).toEqual({ ok: true });
    const disk = JSON.parse(await readFile(designsPath(), 'utf8')) as DesignsFile;
    expect(disk.designs[0]?.name).toBe('Pad v2');
    expect(disk.designs[0]?.layers[0]?.verticalOffsetM).toBe(-0.3);
    expect(disk.designs[0]?.layers[1]).toMatchObject({ intervalM: 25 });
    expect(disk.activeAlignment).toBe('pad/CL1');
    const bak = JSON.parse(await readFile(`${designsPath()}.bak`, 'utf8')) as DesignsFile;
    expect(bak.designs[0]?.name).toBe('Pad design');
  });

  it('refuses changes to what the import wrote, removals and a bad active alignment', async () => {
    await seed(file([entry()]));
    await ipc.call('survey:readDesigns', { projectId: 'p' });
    const write = (f: DesignsFile) => ipc.call('survey:writeDesigns', { projectId: 'p', file: f });
    expect(await write(file([]))).toMatchObject({
      ok: false,
      error: 'The design "Pad design" cannot be removed; archive its layers instead.',
    });
    expect(await write(file([entry({ sha256: 'b'.repeat(64) })]))).toMatchObject({
      ok: false,
      error: 'The design "Pad design" keeps the sha256 it was imported with.',
    });
    const e = entry();
    e.layers = e.layers.slice(0, 1);
    expect(await write(file([e]))).toMatchObject({ ok: false, error: /archive a layer instead/ });
    const f = entry();
    const first = f.layers[0];
    if (!first) throw new Error('fixture');
    f.layers[0] = { ...first, file: 'other.tin' };
    expect(await write(file([f]))).toMatchObject({
      ok: false,
      error: 'The layer "Pad design" keeps the file it was imported with.',
    });
    expect(await write(file([entry()], { activeAlignment: 'pad/Pad-design' }))).toMatchObject({
      ok: false,
      error: 'The active alignment "pad/Pad-design" is not an alignment layer of this site.',
    });
    expect(await write(file([entry(), entry({ id: 'ghost', src: 'g.xml' })]))).toMatchObject({
      ok: false,
      error: /has no imported file in survey\/designs\/ghost\//,
    });
    const archived = entry();
    archived.layers = archived.layers.map((l) => ({ ...l, archived: true }));
    expect(await write(file([archived], { activeAlignment: 'pad/CL1' }))).toMatchObject({
      ok: false,
      error: 'The alignment "CL1" is archived; restore it to activate it.',
    });
    expect(await write(file([archived]))).toEqual({ ok: true });
  });

  it('reads a package in place and never writes it', async () => {
    pkgEntries.set('survey/designs.json', {});
    pkgFiles.set('survey/designs.json', Buffer.from(JSON.stringify(file([entry()]))));
    const r = await ipc.call('survey:readDesigns', { projectId: 'pkg' });
    expect(r.ok && r.file.designs[0]?.id).toBe('pad');
    expect(
      await ipc.call('survey:writeDesigns', { projectId: 'pkg', file: file([entry()]) }),
    ).toMatchObject({ ok: false, error: /read-only package/ });
    expect(await ipc.call('survey:readDesigns', { projectId: 'nope' })).toMatchObject({
      ok: false,
    });
  });

  it('refuses a file saved by a newer build', async () => {
    await mkdir(join(root, 'survey'), { recursive: true });
    await writeFile(designsPath(), JSON.stringify({ schema: 'aio.designs/9', designs: [] }));
    const r = await ipc.call('survey:readDesigns', { projectId: 'p' });
    expect(r.ok).toBe(false);
  });
});

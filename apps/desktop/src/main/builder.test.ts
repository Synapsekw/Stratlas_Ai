import { withExif } from '@aio/project/builder/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builderAddDrawingPage,
  builderCloseDrawing,
  builderImport,
  builderEnsureCapture,
  builderTemplates,
  builderUpdateCapture,
  builderUpdateLayers,
  createBuilderProject,
  drawingJobRefusal,
  photoGps,
} from './builder';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-builder-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const request = {
  name: 'New flare',
  type: 'inspection' as const,
  epsg: 32639,
  origin: [221029, 3214462, 31.7] as [number, number, number],
  severityTemplate: null,
};

describe('builder main handlers', () => {
  it('offers the severity models of the library projects and the report brands', async () => {
    await writeProject(join(base, 'projects', 'hcl'), sampleManifest());
    const t = await builderTemplates(base, []);
    expect(t.severity.map((s) => s.id)).toContain(sampleManifest().severityModels[0]?.id);
    expect(t.severity.slice(-2).map((s) => s.id)).toEqual([
      'general-inspection',
      'road-astm-d6433',
    ]);
    expect(t.brands.map((b) => b.id)).toContain('eand');
  });

  it('creates a project in the data folder from a template id, and refuses unknown ids', async () => {
    await writeProject(join(base, 'projects', 'hcl'), sampleManifest());
    const id = sampleManifest().severityModels[0]?.id ?? '';
    const ok = await createBuilderProject({ ...request, severityTemplate: id }, base, []);
    expect(ok).toMatchObject({ ok: true, path: join(base, 'projects', 'new-flare') });
    expect(ok.ok && ok.manifest.severityModels[0]?.id).toBe(id);
    const bad = await createBuilderProject({ ...request, severityTemplate: 'nope' }, base, []);
    expect(bad).toMatchObject({ ok: false });
    expect(await createBuilderProject(request, '', [])).toMatchObject({ ok: false });
  });

  it('reads the GPS position of a photo, or says it has none', async () => {
    const a = join(base, 'a.jpg');
    await writeFile(
      a,
      withExif({ lat: 29.0276, lon: 48.1352, alt: 31.7, dateTimeOriginal: '2019:01:24 11:45:58' }),
    );
    const r = await photoGps(a);
    expect(r).toMatchObject({ ok: true, takenAt: '2019-01-24T11:45:58' });
    expect(r.ok && r.lat).toBeCloseTo(29.0276, 6);
    const b = join(base, 'b.jpg');
    await writeFile(b, withExif({ make: 'X' }));
    expect(await photoGps(b)).toMatchObject({ ok: false });
  });

  it('only saves alignments to open projects', async () => {
    const r = await builderUpdateLayers(
      { projectId: 'x', layerIds: ['m'], patch: { offsetMs: 1 } },
      new ProjectRegistry(),
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('renames and colours a survey date of an open project, and only that', async () => {
    const dir = join(base, 'projects', 'dated');
    const manifest = sampleManifest();
    await writeProject(dir, manifest);
    const registry = new ProjectRegistry();
    const closed = await builderUpdateCapture(
      { projectId: 'x', captureId: 'c1', patch: { label: 'Baseline' } },
      registry,
    );
    expect(closed).toMatchObject({ ok: false });
    const projectId = registry.register(dir);
    const r = await builderUpdateCapture(
      { projectId, captureId: 'c1', patch: { label: 'Baseline', colour: 4 } },
      registry,
    );
    expect(r.ok && r.manifest.captures).toEqual([
      { id: 'c1', label: 'Baseline', date: '2023-02-21', colour: 4 },
      { id: 'c2', label: 'Resurvey', date: '2024-01-10' },
    ]);
    expect(r.ok && r.manifest.layers.map((l) => l.id)).toEqual(manifest.layers.map((l) => l.id));
    const unknown = await builderUpdateCapture(
      { projectId, captureId: 'nope', patch: { icon: 'flag' } },
      registry,
    );
    expect(unknown).toMatchObject({ ok: false });
  });

  it('a drawing page lands in an open project, after its original was staged', async () => {
    const dir = join(base, 'projects', 'drawn');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    // an 8 byte signature and an IHDR saying 30 x 20: all the page check reads
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    png[19] = 30;
    png[23] = 20;
    const page = { stem: 'sheets', name: 'sheets.pdf', png };
    const closed = await builderAddDrawingPage({ projectId: 'x', ...page }, registry);
    expect(closed).toMatchObject({ ok: false });
    const projectId = registry.register(dir);
    // a file lying in drawings/ is not a staged drawing: only an import makes one
    await mkdir(join(dir, 'drawings'), { recursive: true });
    await writeFile(join(dir, 'drawings', 'sheets.pdf'), '%PDF-1.4');
    const unstaged = await builderAddDrawingPage({ projectId, ...page }, registry);
    expect(unstaged).toEqual({
      ok: false,
      error: 'The drawing "sheets" is not waiting for pages. Import it again.',
    });
    await rm(join(dir, 'drawings'), { recursive: true });
    const pdf = join(base, 'sheets.pdf');
    await writeFile(pdf, '%PDF-1.4');
    const imported = await builderImport(
      { projectId, paths: [pdf] },
      { registry, images: { resizeJpeg: () => Promise.resolve() }, emit: () => undefined },
    );
    expect(imported.ok && imported.items[0]?.drawing?.stem).toBe('sheets');
    const r = await builderAddDrawingPage({ projectId, ...page, page: 2, pages: 4 }, registry);
    expect(r.ok && r.layerId).toBe('sheet-sheets-p2');
    expect(r.ok && r.manifest.layers.find((l) => l.id === 'sheet-sheets-p2')).toMatchObject({
      kind: 'raster',
      name: 'sheets.pdf, page 2',
      visible: false,
      role: 'plan',
      format: 'image',
      src: { path: 'drawings/sheets-p2/plan.png' },
    });
    // closed: no more pages; it got one, so its original stays
    expect(await builderCloseDrawing({ projectId, stem: 'sheets' }, registry)).toEqual({
      ok: true,
      removed: false,
    });
    expect(await builderAddDrawingPage({ projectId, ...page }, registry)).toMatchObject({
      ok: false,
    });
    expect(await builderCloseDrawing({ projectId: 'x', stem: 'sheets' }, registry)).toMatchObject({
      ok: false,
    });
  });

  it('a drawing.import job started by hand never lands on a picture drawing', async () => {
    const dir = join(base, 'projects', 'clash');
    await writeProject(dir, sampleManifest());
    const job = (src: string) =>
      drawingJobRefusal({ pipeline: 'drawing.import', project: dir, params: { src } });
    expect(await job('C:/in/Layout.dxf')).toBeNull();
    // a picture drawing called layout: its original lies in drawings/
    await mkdir(join(dir, 'drawings', 'layout'), { recursive: true });
    await writeFile(join(dir, 'drawings', 'layout.png'), 'png');
    expect(await job('C:/in/Layout.dxf')).toBe(
      'A picture drawing is already called Layout. Rename the DXF file, then import it.',
    );
    expect(await job('C:/in/other.dxf')).toBeNull();
    // other pipelines are not looked at
    expect(
      await drawingJobRefusal({
        pipeline: 'pointcloud.to_copc',
        project: dir,
        params: { src: 'C:/in/Layout.dxf' },
      }),
    ).toBeNull();
  });

  it('ensureCapture adds the survey date of a day once, and refuses a closed project', async () => {
    const dir = join(base, 'projects', 'dated');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const closed = await builderEnsureCapture({ projectId: 'x', date: '2026-03-14' }, registry);
    expect(closed).toEqual({
      ok: false,
      error: 'Project "x" is not open. Open it, then try again.',
    });
    const first = await builderEnsureCapture({ projectId, date: '2026-03-14' }, registry);
    expect(first.ok && first.created).toBe(true);
    expect(first.ok && first.captureId).toBe('capture-2026-03-14');
    const again = await builderEnsureCapture({ projectId, date: '2026-03-14' }, registry);
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.manifest.captures.filter((c) => c.date === '2026-03-14')).toHaveLength(
      1,
    );
  });
});

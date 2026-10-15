import { MAX_FOLDER_FILES } from '@aio/project/builder';
import { withExif } from '@aio/project/builder/testing';
import type { Georef } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builderAddDrawingPage,
  builderAltitudePlan,
  builderRemoveCapture,
  FOLDER_LIMIT_TEXT,
  builderCloseDrawing,
  builderImport,
  builderEnsureCapture,
  builderTemplates,
  builderUpdateCapture,
  builderLayerExtents,
  builderRecentre,
  builderUpdateLayers,
  createBuilderProject,
  drawingJobRefusal,
  photoGps,
  outsidePanoFolder,
  withoutExcluded,
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

  it('logs each walk file that could not be used when a walk is placed', async () => {
    const dir = join(base, 'projects', 'walked');
    const manifest = sampleManifest();
    await writeProject(dir, {
      ...manifest,
      layers: [
        ...manifest.layers,
        {
          kind: 'walk',
          id: 'walk-w',
          name: 'W',
          visible: true,
          record: { path: 'walks/w/walk.json' },
          src: { path: 'walks/w/playback.mp4' },
          durationS: 10,
        },
      ],
    });
    await mkdir(join(dir, 'walks', 'w'), { recursive: true });
    await writeFile(join(dir, 'walks', 'w', 'raw-path.json'), '{ not json');
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const lines: string[] = [];
    const r = await builderUpdateLayers(
      {
        projectId,
        layerIds: ['walk-w'],
        patch: {
          walk: {
            pins: [
              { t: 0, surface: '@model', at: [0, 0], y: 0 },
              { t: 10, surface: '@model', at: [10, 0], y: 0 },
            ],
            yawOffsetDeg: 0,
            heightM: 1.7,
            quality: 'unplaced',
          },
        },
      },
      registry,
      (l) => lines.push(l),
    );
    expect(r.ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('walks/w/raw-path.json');
  });

  it("rewrites a model's georeference sidecar when its layer is placed, so the two agree", async () => {
    const dir = join(base, 'projects', 'placed');
    const manifest = sampleManifest();
    const layer = (id: string, draft = false) => ({
      kind: 'mesh' as const,
      id,
      name: id,
      visible: true,
      src: { path: `models/${id}.glb` },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      derived: { kind: 'model' as const, source: ['stack'], ...(draft ? { draft: true } : {}) },
    });
    await writeProject(dir, {
      ...manifest,
      layers: [...manifest.layers, layer('model-stack'), layer('model-draft-stack', true)],
    });
    await mkdir(join(dir, 'models'), { recursive: true });
    await writeFile(join(dir, 'models', 'stack.procmodel.json'), '{}');
    await writeFile(join(dir, 'models', 'stack.georeference.json'), '{"stale":true}\n');
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const georef: Georef = {
      schema: 'aio.georef/1',
      crs: { epsg: 32639 },
      anchor: [221030, 3214470, 32],
      axes: 'x-east,y-up,z-south',
      units: 'm',
      modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 221030, 3214470, 32, 1],
      heading: { deg: 0, status: 'user' },
      scale: { factor: 1, status: 'user' },
      horizontal: { status: 'user' },
      vertical: { datum: 'unknown', status: 'unknown' },
      provenance: { by: 'place-model' },
    };
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0.3, -8, 1];
    const r = await builderUpdateLayers(
      { projectId, layerIds: ['model-stack'], patch: { transform, georef, placement: 'placed' } },
      registry,
    );
    expect(r.ok).toBe(true);
    const sidecar = join(dir, 'models', 'stack.georeference.json');
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toEqual(georef);
    // the draft preview is not the model's placement: its sidecar is left alone
    await writeFile(sidecar, '{"kept":true}\n');
    await builderUpdateLayers(
      { projectId, layerIds: ['model-draft-stack'], patch: { georef, placement: 'placed' } },
      registry,
    );
    expect(await readFile(sidecar, 'utf8')).toBe('{"kept":true}\n');
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

describe('folder imports and removeCapture', () => {
  const known = (ext: string): boolean => ext === '.mp4' || ext === '.srt';
  const images = { resizeJpeg: () => Promise.resolve() };

  async function flightFolder(): Promise<string> {
    const folder = join(base, 'flight');
    await mkdir(folder);
    for (const f of ['DJI_0001.MP4', 'DJI_0001.SRT', 'DJI_0001.LRF', 'Thumbs.db'])
      await writeFile(join(folder, f), 'x');
    return folder;
  }

  it('imports a folder, answers one summary row for the left-out files and counts two files', async () => {
    const dir = join(base, 'projects', 'folder');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = await flightFolder();
    const events: { total: number }[] = [];
    const r = await builderImport(
      { projectId, paths: [folder] },
      { registry, images, emit: (e) => events.push(e), known },
    );
    expect(r.ok).toBe(true);
    const rows = r.ok ? r.items : [];
    // the SRT pairs with its MP4: no row of its own, and the clip is not the "no SRT" skip
    // (the stand-in file is not a real movie, so the clip itself ends as a read error)
    expect(rows.some((i) => i.file.toLowerCase().endsWith('.srt'))).toBe(false);
    const clip = rows.find((i) => i.file === 'DJI_0001.MP4');
    expect(clip).toBeDefined();
    expect(clip?.message ?? '').not.toContain('No DJI SRT');
    expect(clip?.status).not.toBe('skipped');
    const summary = rows.filter((i) => i.file === 'flight');
    expect(summary).toEqual([
      {
        file: 'flight',
        kind: 'unknown',
        status: 'skipped',
        message: '2 files in flight are not data this app imports (.db, .lrf).',
      },
    ]);
    expect(rows.some((i) => i.file.endsWith('.LRF') || i.file === 'Thumbs.db')).toBe(false);
    expect(events.length > 0 && events.every((e) => e.total === 2)).toBe(true);
    // the files the folder expanded to, absolute, so the app can find a walk's original
    expect(r.ok ? [...(r.files ?? [])].sort() : []).toEqual(
      [join(folder, 'DJI_0001.MP4'), join(folder, 'DJI_0001.SRT')].sort(),
    );
  });

  it('hands back the survey dates the import itself created', async () => {
    const dir = join(base, 'projects', 'dates');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const photo = join(base, 'a.jpg');
    await writeFile(
      photo,
      withExif({ dateTimeOriginal: '2024:11:06 10:00:00', lat: 25.2, lon: 55.3, alt: 100 }),
    );
    const first = await builderImport(
      { projectId, paths: [photo] },
      { registry, images, emit: () => undefined },
    );
    expect(first.ok && first.createdCaptures).toEqual(['capture-2024-11-06']);
    const again = await builderImport(
      { projectId, paths: [photo] },
      { registry, images, emit: () => undefined },
    );
    expect(again.ok && again.createdCaptures).toEqual([]);
  });

  it('answers an error for a folder over the limit and for an empty folder', async () => {
    const dir = join(base, 'projects', 'big');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = await flightFolder();
    const over = await builderImport(
      { projectId, paths: [folder] },
      { registry, images, emit: () => undefined, known, limit: 1 },
    );
    expect(over).toEqual({
      ok: false,
      error: 'flight holds more than 20,000 files. Import a smaller folder.',
    });
    expect(FOLDER_LIMIT_TEXT).toBe(MAX_FOLDER_FILES.toLocaleString('en-US'));
    const empty = join(base, 'empty');
    await mkdir(empty);
    const none = await builderImport(
      { projectId, paths: [empty] },
      { registry, images, emit: () => undefined, known },
    );
    expect(none).toEqual({ ok: false, error: 'The folder holds no files to import.' });
  });

  it('the altitude plan accepts a folder and refuses one over the limit', async () => {
    const dir = join(base, 'projects', 'alt');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = await flightFolder();
    const ok = await builderAltitudePlan({ projectId, paths: [folder] }, registry, { known });
    expect(ok.ok).toBe(true);
    const over = await builderAltitudePlan({ projectId, paths: [folder] }, registry, {
      known,
      limit: 1,
    });
    expect(over).toEqual({
      ok: false,
      error: 'flight holds more than 20,000 files. Import a smaller folder.',
    });
  });

  it('removeCapture removes an empty date, refuses a named date and a closed project', async () => {
    const dir = join(base, 'projects', 'rm');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    expect(await builderRemoveCapture({ projectId: 'x', captureId: 'c' }, registry)).toEqual({
      ok: false,
      error: 'Project "x" is not open. Open it, then try again.',
    });
    const added = await builderEnsureCapture({ projectId, date: '2026-03-14' }, registry);
    expect(added.ok && added.created).toBe(true);
    const gone = await builderRemoveCapture(
      { projectId, captureId: 'capture-2026-03-14' },
      registry,
    );
    expect(gone.ok && gone.manifest.captures.some((c) => c.id === 'capture-2026-03-14')).toBe(
      false,
    );
    const missing = await builderRemoveCapture(
      { projectId, captureId: 'capture-2026-03-14' },
      registry,
    );
    expect(missing.ok).toBe(false);
    const filed = await builderUpdateLayers(
      { projectId, layerIds: ['plant'], patch: { capture: 'c1' } },
      registry,
    );
    expect(filed.ok).toBe(true);
    const refused = await builderRemoveCapture({ projectId, captureId: 'c1' }, registry);
    expect(refused.ok).toBe(false);
  });
});

describe('withoutExcluded', () => {
  it('leaves out the excluded files, without case on Windows', () => {
    const files = ['D:\\card\\SYN_0001.JPG', 'D:\\card\\SYN_0002.JPG', 'D:\\card\\notes.las'];
    const out = withoutExcluded(files, ['d:\\card\\syn_0001.jpg']);
    expect(out).toEqual(process.platform === 'win32' ? files.slice(1) : files);
    expect(withoutExcluded(files, ['D:\\card\\SYN_0001.JPG'])).toEqual(files.slice(1));
    expect(withoutExcluded(files, undefined)).toBe(files);
  });

  it('matches forward and back slashes alike on Windows', () => {
    if (process.platform !== 'win32') return;
    const files = ['D:\\card\\100MEDIA\\SYN_0001.JPG', 'D:\\card\\100MEDIA\\SYN_0002.JPG'];
    expect(withoutExcluded(files, ['d:/card/100media/syn_0002.JPG'])).toEqual(files.slice(0, 1));
    expect(withoutExcluded(['d:/Card/100MEDIA/SYN_0001.jpg'], files.slice(0, 1))).toEqual([]);
  });
});

describe('builder:import exclude', () => {
  it('imports and counts only the files not handed to the panorama import', async () => {
    const dir = join(base, 'projects', 'exclude');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = join(base, 'excl');
    await mkdir(folder);
    for (const f of ['SYN_0001.MP4', 'SYN_0002.MP4']) await writeFile(join(folder, f), 'x');
    const events: { total: number }[] = [];
    const known = (ext: string): boolean => ext === '.mp4';
    // the scan reports resolved paths; Add data may hold them in another spelling
    const other =
      process.platform === 'win32'
        ? join(folder, 'syn_0002.mp4').replaceAll('\\', '/').toUpperCase()
        : join(folder, 'SYN_0002.MP4');
    const r = await builderImport(
      { projectId, paths: [folder], exclude: [other] },
      {
        registry,
        images: { resizeJpeg: () => Promise.resolve() },
        emit: (e) => events.push(e),
        known,
      },
    );
    expect(r.ok).toBe(true);
    expect(r.ok ? r.files : []).toEqual([join(folder, 'SYN_0001.MP4')]);
    expect(r.ok ? r.items.map((i) => i.file) : []).toEqual(['SYN_0001.MP4']);
    expect(events.length > 0 && events.every((e) => e.total === 1)).toBe(true);
  });

  it('answers ok with nothing imported when every file is excluded', async () => {
    const dir = join(base, 'projects', 'exclude-all');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = join(base, 'excl-all');
    await mkdir(folder);
    await writeFile(join(folder, 'SYN_0001.MP4'), 'x');
    const r = await builderImport(
      { projectId, paths: [folder], exclude: [join(folder, 'SYN_0001.MP4')] },
      {
        registry,
        images: { resizeJpeg: () => Promise.resolve() },
        emit: () => undefined,
        known: (ext) => ext === '.mp4',
      },
    );
    expect(r).toMatchObject({ ok: true, items: [], files: [], createdCaptures: [] });
    expect(r.ok ? r.manifest.id : null).toBe(sampleManifest().id);
  });

  it('leaves the excluded frames out of the camera heights', async () => {
    const dir = join(base, 'projects', 'exclude-heights');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const folder = join(base, 'excl-heights');
    await mkdir(folder);
    const frames = ['SYN_0001.JPG', 'SYN_0002.JPG'].map((f) => join(folder, f));
    for (const f of frames)
      await writeFile(
        f,
        withExif({
          make: 'DJI',
          dji: { GpsLatitude: '28.9', GpsLongitude: '51.0', RelativeAltitude: '70' },
        }),
      );
    const known = (ext: string): boolean => ext === '.jpg';
    const all = await builderAltitudePlan({ projectId, paths: [folder] }, registry, { known });
    expect(all.ok ? all.plan.files : -1).toBe(2);
    const rest = await builderAltitudePlan(
      { projectId, paths: [folder], exclude: [frames[0] ?? ''] },
      registry,
      { known },
    );
    expect(rest.ok ? rest.plan.files : -1).toBe(1);
  });
});

describe("builder:import leaves the project's panorama frames out", () => {
  it('drops files under <root>/panoramas/ only', () => {
    const root = join(base, 'proj');
    const inside = join(root, 'panoramas', 'panos-1', 'p01', 'frames', 'SYN_0001.JPG');
    const near = join(root, 'panoramas-old', 'SYN_0002.JPG');
    const other = join(base, 'card', 'SYN_0003.JPG');
    expect(outsidePanoFolder(root, [inside, near, other])).toEqual([near, other]);
    if (process.platform === 'win32')
      expect(outsidePanoFolder(root, [inside.toUpperCase().replaceAll('\\', '/')])).toEqual([]);
  });

  it('imports nothing from the frames folder of a sphere', async () => {
    const dir = join(base, 'projects', 'frames');
    await writeProject(dir, sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const frames = join(dir, 'panoramas', 'panos-1', 'p01', 'frames');
    await mkdir(frames, { recursive: true });
    await writeFile(join(frames, 'SYN_0001.MP4'), 'x');
    const r = await builderImport(
      { projectId, paths: [frames] },
      {
        registry,
        images: { resizeJpeg: () => Promise.resolve() },
        emit: () => undefined,
        known: (ext) => ext === '.mp4',
      },
    );
    expect(r).toMatchObject({ ok: true, items: [], files: [] });
  });
});

it('answers layer extents and the re-centre blockers, and re-centres an open project', async () => {
  const dir = join(base, 'projects', 'placed');
  await writeProject(dir, sampleManifest({ layers: [] }));
  const registry = new ProjectRegistry();
  const projectId = registry.register(dir);
  const ex = await builderLayerExtents({ projectId }, registry);
  expect(ex).toEqual({ ok: true, extents: [], recentre: { blockers: [] } });
  const r = await builderRecentre({ projectId, at: [245984.4, 3179697.6] }, registry);
  expect(r.ok && r.manifest.origin).toEqual([245984, 3179698, 0]);
  expect(await builderRecentre({ projectId: 'nope', at: [0, 0] }, registry)).toMatchObject({
    ok: false,
  });
});

import { describe, expect, it } from 'vitest';
import {
  CapturePatch,
  ImportItem,
  ipc,
  LayerPatch,
  NewProjectRequest,
  PhotoEstimate,
  ProjectManifest,
  ProjectPurpose,
  projectPurpose,
  ProjectType,
  PURPOSE_TYPE,
} from './index';

const base = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

describe('LayerPatch height offset', () => {
  it('takes a height offset patch and null', () => {
    expect(LayerPatch.safeParse({ heightOffsetM: 12.5 }).success).toBe(true);
    expect(LayerPatch.safeParse({ heightOffsetM: null }).success).toBe(true);
    expect(LayerPatch.safeParse({ heightOffsetM: 1, name: 'x' }).success).toBe(false);
  });
});

describe('project type', () => {
  it('is optional and one of the builder types', () => {
    expect(ProjectManifest.safeParse(base).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'inspection' }).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'fusion' }).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'cinema' }).success).toBe(false);
  });
});

describe('project purpose', () => {
  const parse = (purpose: unknown) => {
    const r = ProjectManifest.safeParse({ ...base, type: 'inspection', purpose });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  };

  it('is optional: a manifest without it parses to what it was', () => {
    const r = ProjectManifest.safeParse({ ...base, type: 'inspection' });
    expect(r.success && 'purpose' in r.data).toBe(false);
    expect(r.success && r.data).toEqual({ ...base, type: 'inspection' });
    expect(r.success && projectPurpose(r.data)).toBeUndefined();
  });

  it('keeps each purpose the wizard offers', () => {
    for (const purpose of ProjectPurpose.options) {
      const m = parse(purpose);
      expect(m.purpose).toBe(purpose);
      expect(projectPurpose(m)).toBe(purpose);
    }
  });

  it('never refuses the value of a later build: it reads as none and stays in the file', () => {
    const m = parse('tunnel');
    expect(m.purpose).toBe('tunnel');
    expect(projectPurpose(m)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(m))).toMatchObject({ type: 'inspection', purpose: 'tunnel' });
  });

  it('reads a malformed value as absent instead of failing', () => {
    for (const bad of [7, null, '', 'Has Spaces', ['survey'], 'x'.repeat(33)]) {
      const m = parse(bad);
      expect(m.purpose).toBeUndefined();
      expect(projectPurpose(m)).toBeUndefined();
      expect('purpose' in JSON.parse(JSON.stringify(m))).toBe(false);
    }
  });

  it('maps every purpose to one of the five existing types', () => {
    expect(PURPOSE_TYPE).toEqual({
      survey: 'volumetric',
      construction: 'fusion',
      'vertical-asset': 'inspection',
      'confined-space': 'inspection',
      'data-fusion': 'fusion',
      road: 'road',
    });
    expect(Object.keys(PURPOSE_TYPE).sort()).toEqual([...ProjectPurpose.options].sort());
    for (const type of Object.values(PURPOSE_TYPE)) expect(ProjectType.options).toContain(type);
  });

  it('is an optional, closed field of the new project request', () => {
    const good = {
      name: 'Tank 4',
      type: 'inspection',
      epsg: 32639,
      origin: [0, 0, 0],
      severityTemplate: null,
    };
    expect(NewProjectRequest.safeParse(good).success).toBe(true);
    expect(NewProjectRequest.safeParse({ ...good, purpose: 'confined-space' }).success).toBe(true);
    expect(NewProjectRequest.safeParse({ ...good, purpose: 'tunnel' }).success).toBe(false);
  });
});

describe('capture colour and icon', () => {
  const withCapture = (extra: Record<string, unknown>) =>
    ProjectManifest.safeParse({
      ...base,
      captures: [{ id: 'c1', label: 'Survey', date: '2026-01-10', ...extra }],
    });

  it('are optional, so older manifests stay valid', () => {
    const r = withCapture({});
    expect(r.success && r.data.captures[0]).toEqual({
      id: 'c1',
      label: 'Survey',
      date: '2026-01-10',
    });
  });

  it('take a palette colour 1 to 8 and an icon name', () => {
    const r = withCapture({ colour: 3, icon: 'flag' });
    expect(r.success && r.data.captures[0]).toMatchObject({ colour: 3, icon: 'flag' });
    expect(withCapture({ colour: 9 }).success).toBe(false);
    expect(withCapture({ colour: 1.5 }).success).toBe(false);
    expect(withCapture({ icon: '../x' }).success).toBe(false);
  });
});

describe('capture line-up patch', () => {
  it('takes a lineUp patch and null', () => {
    const lineUp = { eastM: 1, northM: -2, with: 'c0', at: '2026-10-16T08:00:00Z' };
    expect(CapturePatch.safeParse({ lineUp }).success).toBe(true);
    expect(CapturePatch.safeParse({ lineUp: null }).success).toBe(true);
    expect(CapturePatch.safeParse({ lineUp: { ...lineUp, eastM: 600 } }).success).toBe(false);
    const empty = CapturePatch.safeParse({});
    expect(!empty.success && empty.error.issues[0]?.message).toBe(
      'Give label, colour, icon or lineUp',
    );
  });
});

describe('builder ipc contracts', () => {
  it('validates a new project request', () => {
    const req = ipc['builder:createProject'].request;
    const good = {
      name: 'EBSM flare',
      type: 'inspection',
      epsg: 32639,
      origin: [221029.4, 3214462, 31.7],
      severityTemplate: 'aik-stack',
    };
    expect(req.safeParse(good).success).toBe(true);
    expect(req.safeParse({ ...good, name: '' }).success).toBe(false);
    expect(req.safeParse({ ...good, origin: [1, 2] }).success).toBe(false);
    expect(req.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(req.safeParse({ ...good, severityTemplate: null, brand: 'eand' }).success).toBe(true);
  });

  it('validates an import request and its item results', () => {
    const req = ipc['builder:import'].request;
    expect(req.safeParse({ projectId: 'p', paths: ['C:/a.jpg'] }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', paths: [] }).success).toBe(false);
    const res = ipc['builder:import'].response;
    const ok = res.safeParse({
      ok: true,
      manifest: { ...base },
      items: [
        { file: 'a.las', kind: 'pointcloud', status: 'needs-pipeline', message: 'm' },
        { file: 'b.mp4', kind: 'video', status: 'imported', layerId: 'clip-b' },
      ],
    });
    expect(ok.success).toBe(true);
    // the survey dates the import itself created (Timeline T2)
    const dated = res.safeParse({
      ok: true,
      manifest: { ...base },
      items: [],
      createdCaptures: ['capture-2024-11-06'],
    });
    expect(dated.success && dated.data.ok && dated.data.createdCaptures).toEqual([
      'capture-2024-11-06',
    ]);
    expect(
      res.safeParse({ ok: true, manifest: { ...base }, items: [], createdCaptures: [''] }).success,
    ).toBe(false);
  });

  it('patches either a mesh transform or a video calibration', () => {
    const req = ipc['builder:updateLayers'].request;
    const mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(
      req.safeParse({ projectId: 'p', layerIds: ['m'], patch: { transform: mat } }).success,
    ).toBe(true);
    expect(
      req.safeParse({
        projectId: 'p',
        layerIds: ['v1', 'v2'],
        patch: { lens: { model: 'pinhole', hfovDeg: 71.6, aspect: 1.7778 }, offsetMs: -120 },
      }).success,
    ).toBe(true);
    expect(
      req.safeParse({
        projectId: 'p',
        layerIds: ['v1'],
        patch: { orientation: { yawDeg: 0.4, pitchDeg: -7.9, rollDeg: 0.2 } },
      }).success,
    ).toBe(true);
    expect(
      req.safeParse({ projectId: 'p', layerIds: ['v1'], patch: { orientation: null } }).success,
    ).toBe(true);
    expect(
      req.safeParse({ projectId: 'p', layerIds: ['v1'], patch: { positionOffsetM: [1, 40, -2] } })
        .success,
    ).toBe(true);
    expect(
      req.safeParse({ projectId: 'p', layerIds: ['v1'], patch: { positionOffsetM: [1, 40] } })
        .success,
    ).toBe(false);
    expect(
      req.safeParse({
        projectId: 'p',
        layerIds: ['v1'],
        patch: { orientation: { yawDeg: 0, pitchDeg: 120, rollDeg: 0 } },
      }).success,
    ).toBe(false);
    expect(req.safeParse({ projectId: 'p', layerIds: [], patch: { offsetMs: 1 } }).success).toBe(
      false,
    );
    expect(req.safeParse({ projectId: 'p', layerIds: ['m'], patch: {} }).success).toBe(false);
  });

  it('patches the name, colour and icon of a survey date, never its date', () => {
    const req = ipc['builder:updateCapture'].request;
    const ok = (patch: unknown) =>
      req.safeParse({ projectId: 'p', captureId: 'c1', patch }).success;
    expect(ok({ label: 'Baseline' })).toBe(true);
    expect(ok({ colour: 8, icon: 'flag' })).toBe(true);
    expect(ok({ colour: null, icon: null })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ label: '   ' })).toBe(false);
    expect(ok({ colour: 9 })).toBe(false);
    expect(ok({ colour: 0 })).toBe(false);
    expect(ok({ icon: 'Not An Icon' })).toBe(false);
    expect(ok({ date: '2026-01-01' })).toBe(false);
  });

  it('lets the open-files dialog take filters', () => {
    const req = ipc['dialog:openFiles'].request;
    expect(
      req.safeParse({ title: 'Photos', filters: [{ name: 'JPEG', extensions: ['jpg'] }] }).success,
    ).toBe(true);
  });
});

describe('survey date of a photo run', () => {
  const estimate = { minutes: [1, 2], diskBytes: 0, memoryBytes: 0 };

  it('photoDays is optional and holds days with photo counts', () => {
    expect(PhotoEstimate.safeParse(estimate).success).toBe(true);
    const r = PhotoEstimate.safeParse({
      ...estimate,
      photoDays: [{ date: '2026-03-14', photos: 12 }],
    });
    expect(r.success && r.data.photoDays).toEqual([{ date: '2026-03-14', photos: 12 }]);
    expect(
      PhotoEstimate.safeParse({ ...estimate, photoDays: [{ date: '14/03/2026', photos: 12 }] })
        .success,
    ).toBe(false);
  });

  it('builder:ensureCapture takes a project and a day, nothing else', () => {
    const req = ipc['builder:ensureCapture'].request;
    expect(req.safeParse({ projectId: 'p', date: '2026-03-14' }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', date: 'tomorrow' }).success).toBe(false);
    expect(req.safeParse({ projectId: 'p', date: '2026-03-14', label: 'x' }).success).toBe(false);
    const res = ipc['builder:ensureCapture'].response;
    expect(res.safeParse({ ok: false, error: 'no' }).success).toBe(true);
  });

  it('builder:removeCapture takes a project and a survey date, nothing else', () => {
    const req = ipc['builder:removeCapture'].request;
    expect(req.safeParse({ projectId: 'p', captureId: 'c1' }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', captureId: '' }).success).toBe(false);
    expect(req.safeParse({ projectId: 'p', captureId: 'c1', force: true }).success).toBe(false);
    const res = ipc['builder:removeCapture'].response;
    expect(res.safeParse({ ok: false, error: 'no' }).success).toBe(true);
  });
});

describe('drawings (PDF and picture imports, placement)', () => {
  const corners = { tl: [-50, 0, -35], tr: [50, 0, -35], bl: [-50, 0, 35] };

  it('the layer patch takes the corners of an image raster, and nothing beside them', () => {
    const req = ipc['builder:updateLayers'].request;
    const ok = (patch: unknown) =>
      req.safeParse({ projectId: 'p', layerIds: ['sheet-a'], patch }).success;
    expect(ok({ corners })).toBe(true);
    expect(ok({ corners: { tl: [0, 0, 0], tr: [1, 0, 0] } })).toBe(false);
    expect(ok({ corners, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })).toBe(
      false,
    );
    // the patches that were there before still parse
    expect(ok({ capture: null })).toBe(true);
    expect(ok({ offsetMs: 12 })).toBe(true);
  });

  it('builder:import takes the drawings flag and still refuses unknown keys', () => {
    const req = ipc['builder:import'].request;
    expect(req.safeParse({ projectId: 'p', paths: ['a.jpg'] }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', paths: ['a.jpg'], drawings: true }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', paths: ['a.jpg'], drawings: 'yes' }).success).toBe(
      false,
    );
    expect(req.safeParse({ projectId: 'p', paths: ['a.jpg'], as: 'drawing' }).success).toBe(false);
  });

  it('an import item may carry the drawing whose pages the app window still draws', () => {
    const item = { file: 'site.pdf', kind: 'drawing', status: 'queued' };
    expect(ImportItem.safeParse(item).success).toBe(true);
    const r = ImportItem.safeParse({
      ...item,
      drawing: { stem: 'site', src: 'drawings/site.pdf', name: 'site.pdf' },
    });
    expect(r.success && r.data.drawing?.stem).toBe('site');
    expect(
      ImportItem.safeParse({ ...item, drawing: { stem: '../x', src: 'a', name: 'a' } }).success,
    ).toBe(false);
  });

  it('builder:addDrawingPage takes one PNG page of a staged drawing', () => {
    const req = ipc['builder:addDrawingPage'].request;
    const page = { projectId: 'p', stem: 'site', name: 'site.pdf', png: new Uint8Array([1, 2]) };
    expect(req.safeParse(page).success).toBe(true);
    expect(req.safeParse({ ...page, page: 2, pages: 5 }).success).toBe(true);
    expect(req.safeParse({ ...page, page: 0 }).success).toBe(false);
    expect(req.safeParse({ ...page, stem: 'Site Plan' }).success).toBe(false);
    expect(req.safeParse({ ...page, png: 'data' }).success).toBe(false);
    expect(req.safeParse({ ...page, corners }).success).toBe(false);
    const res = ipc['builder:addDrawingPage'].response;
    expect(res.safeParse({ ok: false, error: 'no' }).success).toBe(true);
  });

  it('builder:closeDrawing ends a staged drawing by its stem, nothing else', () => {
    const req = ipc['builder:closeDrawing'].request;
    expect(req.safeParse({ projectId: 'p', stem: 'site' }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', stem: '../site' }).success).toBe(false);
    expect(req.safeParse({ projectId: 'p', stem: 'site', path: 'x' }).success).toBe(false);
    const res = ipc['builder:closeDrawing'].response;
    expect(res.safeParse({ ok: true, removed: true }).success).toBe(true);
    expect(res.safeParse({ ok: false, error: 'no' }).success).toBe(true);
  });
});

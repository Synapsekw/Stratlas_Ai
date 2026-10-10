import { describe, expect, it } from 'vitest';
import { ipc, ProjectManifest } from './index';

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

describe('project type', () => {
  it('is optional and one of the builder types', () => {
    expect(ProjectManifest.safeParse(base).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'inspection' }).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'fusion' }).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...base, type: 'cinema' }).success).toBe(false);
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

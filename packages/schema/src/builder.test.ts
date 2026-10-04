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

  it('lets the open-files dialog take filters', () => {
    const req = ipc['dialog:openFiles'].request;
    expect(
      req.safeParse({ title: 'Photos', filters: [{ name: 'JPEG', extensions: ['jpg'] }] }).success,
    ).toBe(true);
  });
});

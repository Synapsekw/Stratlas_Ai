import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { ipc } from './ipc';
import { LayerInfo } from './layerInfo';

describe('dataset menus contract', () => {
  it('renames a layer with a trimmed name of 1 to 120 characters', () => {
    expect(LayerPatch.parse({ name: '  Site model ' })).toEqual({ name: 'Site model' });
    expect(LayerPatch.safeParse({ name: '   ' }).success).toBe(false);
    expect(LayerPatch.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(LayerPatch.safeParse({ name: 'a', capture: null }).success).toBe(false);
  });

  it('reads layer info with files, sizes, count, extent and import time', () => {
    const info = {
      layerId: 'm',
      name: 'Model',
      kind: 'mesh',
      files: [{ path: 'models/m.glb', bytes: 2048 }],
      bytes: 2048,
      count: null,
      countKind: null,
      extent: { min: [0, 0, 0], max: [1, 2, 3] },
      crs: { epsg: 32639 },
      importedAt: '2026-10-15T09:00:00.000Z',
      mainFile: 'models/m.glb',
    };
    expect(LayerInfo.parse(info)).toEqual(info);
    expect(ipc['layer:info'].response.safeParse({ ok: true, info }).success).toBe(true);
    expect(ipc['layer:info'].request.safeParse({ projectId: 'p', layerId: 'm' }).success).toBe(
      true,
    );
  });

  it('exports layers by id into a folder under a job id, and reveals by layer id', () => {
    const req = { projectId: 'p', jobId: 'j1', layerIds: ['m'], dir: 'C:/out' };
    expect(ipc['layer:export'].request.safeParse(req).success).toBe(true);
    expect(ipc['layer:export'].request.safeParse({ ...req, layerIds: [] }).success).toBe(false);
    expect(
      ipc['layer:export'].response.safeParse({
        ok: true,
        written: 1,
        skipped: ['Model'],
        cancelled: false,
      }).success,
    ).toBe(true);
    expect(ipc['layer:reveal'].request.safeParse({ projectId: 'p', layerId: 'm' }).success).toBe(
      true,
    );
    expect(ipc['layer:reveal'].request.safeParse({ projectId: 'p', path: 'C:/x' }).success).toBe(
      false,
    );
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLayerIpc } from './layers';
import { collectHandlers } from './notYet';
import { writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-layers-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const manifest = {
  schema: 'aio.project/1',
  id: 'yard',
  name: 'Yard',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [],
  severityModels: [],
  classCatalogues: [],
  layers: [
    {
      kind: 'mesh',
      id: 'm',
      name: 'Model',
      visible: true,
      src: { path: 'models/m.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
};

describe('layer channels', () => {
  it('answers info, reveals the main file, exports with progress, refuses a package', async () => {
    const dir = await writeProject(join(base, 'p'), manifest, { 'models/m.glb': 'glb' });
    const reveal = vi.fn();
    const emit = vi.fn();
    const roots: Record<string, string> = { p1: dir };
    let jobs: { cancel(id: string): boolean } | undefined;
    const t = collectHandlers((handle) => {
      jobs = registerLayerIpc({
        handle,
        projects: { root: (id) => roots[id], package: (id) => (id === 'pkg' ? {} : undefined) },
        reveal,
        emit,
      });
    });
    expect(t.channels()).toEqual(['layer:export', 'layer:info', 'layer:reveal']);
    const info = await t.call('layer:info', { projectId: 'p1', layerId: 'm' });
    expect(info.ok && info.info.files).toEqual([{ path: 'models/m.glb', bytes: 3 }]);
    expect((await t.call('layer:reveal', { projectId: 'p1', layerId: 'm' })).ok).toBe(true);
    expect(reveal).toHaveBeenCalledWith(join(dir, 'models', 'm.glb'));
    const out = join(base, 'out');
    const r = await t.call('layer:export', {
      projectId: 'p1',
      jobId: 'j',
      layerIds: ['m'],
      dir: out,
    });
    expect(r).toEqual({ ok: true, written: 1, skipped: [], cancelled: false });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j', total: 2 })); // the file and its sidecar
    expect(jobs?.cancel('nothing')).toBe(false);
    const pkg = await t.call('layer:export', {
      projectId: 'pkg',
      jobId: 'k',
      layerIds: ['m'],
      dir: out,
    });
    expect(pkg.ok).toBe(false);
    expect((await t.call('layer:info', { projectId: 'nope', layerId: 'm' })).ok).toBe(false);
  });
});

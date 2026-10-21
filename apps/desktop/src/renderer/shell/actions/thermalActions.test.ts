// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { bridge } from '../../shell';
import { loadRasterIndex } from '../../thermal/raster';
import { workbench } from '../../workspace/workbench/workbenchStore';
import {
  forgetThermal,
  primeThermal,
  registerThermalActions,
  thermalPrimed,
} from './thermalActions';

vi.mock('../../thermal/raster', () => ({ loadRasterIndex: vi.fn(), loadRaster: vi.fn() }));
const open = vi.hoisted(() =>
  vi.fn<
    (
      projectId: string,
      layerId: string,
      photoId?: string,
      opts?: { readOnly?: boolean },
    ) => Promise<void>
  >(() => Promise.resolve()),
);
vi.mock('../../thermal/thermalStore', () => ({ useThermal: { getState: () => ({ open }) } }));

const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });
const manifest = {
  captures: [],
  layers: [
    { kind: 'photos', id: 'th', name: 'Thermal', visible: true, items: [photo('r1'), photo('w1')] },
    { kind: 'photos', id: 'vis', name: 'Visual', visible: true, items: [photo('v1')] },
    { kind: 'vector', id: 'v', name: 'Outline', visible: true, src: { path: 'v.geojson' } },
  ],
} as unknown as ProjectManifest;

const probe = {
  th: [
    { photoId: 'r1', family: 'flir', make: 'DJI', model: 'XT2' },
    { photoId: 'w1', family: null, make: null, model: null },
  ],
  vis: [{ photoId: 'v1', family: null, make: null, model: null }],
} as const;

let off: () => void;
let call: MockInstance<typeof bridge.call>;
beforeEach(async () => {
  forgetThermal();
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as unknown as Partial<
    ReturnType<typeof workspace.getState>
  >);
  call = vi.spyOn(bridge, 'call').mockImplementation(((channel: string, req: unknown) => {
    if (channel !== 'thermal:probe') return Promise.resolve({ ok: false, error: channel });
    const { layerId } = req as { layerId: keyof typeof probe };
    return Promise.resolve({ ok: true, value: { ok: true, photos: probe[layerId] } });
  }) as never);
  off = registerThermalActions();
  await thermalPrimed();
  forgetThermal();
  workbench.getState().reset();
});
afterEach(() => {
  off();
  call.mockRestore();
  vi.mocked(loadRasterIndex).mockReset();
});

const ids = (target: MenuTarget, over = {}) =>
  actionsFor(target, makeActionCtx({ manifest, ...over })).map((i) => i.id);

describe('thermal.analyse', () => {
  it('probes a set again when its photo count changes', async () => {
    workspace.setState({ project: null } as never);
    workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as never);
    await thermalPrimed();
    call.mockClear();
    const grown = {
      ...manifest,
      layers: manifest.layers.map((l) =>
        l.id === 'th' && l.kind === 'photos' ? { ...l, items: [...l.items, photo('r9')] } : l,
      ),
    } as ProjectManifest;
    workspace.setState({ project: { id: 'p', root: 'C:/p', manifest: grown } } as never);
    await thermalPrimed();
    const probed = call.mock.calls.filter((c) => c[0] === 'thermal:probe').map((c) => c[1]);
    expect(probed).toContainEqual({ projectId: 'p', layerId: 'th' });
    expect(probed).not.toContainEqual({ projectId: 'p', layerId: 'vis' });
  });

  it('is hidden until the probe has answered', () => {
    forgetThermal();
    expect(ids({ kind: 'layers', layerIds: ['th'] })).not.toContain('thermal.analyse');
  });

  it('shows on a photo set the probe finds thermal photos in, not on others', async () => {
    await primeThermal('p', 'th', false);
    await primeThermal('p', 'vis', false);
    expect(ids({ kind: 'layers', layerIds: ['th'] })).toContain('thermal.analyse');
    expect(ids({ kind: 'layers', layerIds: ['vis'] })).not.toContain('thermal.analyse');
    expect(ids({ kind: 'layers', layerIds: ['v'] })).not.toContain('thermal.analyse');
  });

  it('shows on a thermal photo and not on a visual one', async () => {
    await primeThermal('p', 'th', false);
    expect(ids({ kind: 'photos', picks: [{ layerId: 'th', photoId: 'r1' }] })).toContain(
      'thermal.analyse',
    );
    expect(ids({ kind: 'photos', picks: [{ layerId: 'th', photoId: 'w1' }] })).not.toContain(
      'thermal.analyse',
    );
  });

  it('is in the open section', async () => {
    await primeThermal('p', 'th', false);
    const item = actionsFor({ kind: 'layers', layerIds: ['th'] }, makeActionCtx({ manifest })).find(
      (i) => i.id === 'thermal.analyse',
    );
    expect(item?.section).toBe('open');
    expect(item?.label).toBe('Analyse thermal');
  });

  it('reads a package from its raster index, never the probe', async () => {
    vi.mocked(loadRasterIndex).mockResolvedValue({
      schema: 'aio.thermalRaster/1',
      photos: { r1: { status: 'ok' } },
    });
    call.mockClear();
    await primeThermal('p', 'th', true);
    expect(call).not.toHaveBeenCalledWith('thermal:probe', expect.anything());
    expect(ids({ kind: 'layers', layerIds: ['th'] }, { pkg: true, canEdit: false })).toContain(
      'thermal.analyse',
    );
  });

  it('a package without rasters offers nothing', async () => {
    vi.mocked(loadRasterIndex).mockResolvedValue(null);
    await primeThermal('p', 'th', true);
    expect(ids({ kind: 'layers', layerIds: ['th'] }, { pkg: true })).not.toContain(
      'thermal.analyse',
    );
  });

  it('opens the bench on the picked photo, or the first thermal photo of the set', async () => {
    await primeThermal('p', 'th', false);
    open.mockClear();
    const run = (target: MenuTarget) =>
      actionsFor(target, makeActionCtx({ manifest }))
        .find((i) => i.id === 'thermal.analyse')
        ?.run();
    run({ kind: 'layers', layerIds: ['th'] });
    expect(open).toHaveBeenLastCalledWith('p', 'th', 'r1', { readOnly: false });
    expect(workbench.getState().front).toBe('thermal');
    run({ kind: 'photos', picks: [{ layerId: 'th', photoId: 'r1' }] });
    expect(open).toHaveBeenLastCalledWith('p', 'th', 'r1', { readOnly: false });
  });

  it('opens a package read-only', async () => {
    vi.mocked(loadRasterIndex).mockResolvedValue({
      schema: 'aio.thermalRaster/1',
      photos: { r1: { status: 'ok' } },
    });
    await primeThermal('p', 'th', true);
    open.mockClear();
    actionsFor(
      { kind: 'layers', layerIds: ['th'] },
      makeActionCtx({ manifest, pkg: true, canEdit: false }),
    )
      .find((i) => i.id === 'thermal.analyse')
      ?.run();
    expect(open).toHaveBeenLastCalledWith('p', 'th', 'r1', { readOnly: true });
  });

  it('probes the photo sets of a project when it opens', async () => {
    forgetThermal();
    off();
    call.mockClear();
    workspace.setState({ project: null } as never);
    off = registerThermalActions();
    workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as never);
    await thermalPrimed();
    expect(ids({ kind: 'layers', layerIds: ['th'] })).toContain('thermal.analyse');
    const probed = call.mock.calls.filter((c) => c[0] === 'thermal:probe').map((c) => c[1]);
    expect(probed).toEqual([
      { projectId: 'p', layerId: 'th' },
      { projectId: 'p', layerId: 'vis' },
    ]);
  });
});

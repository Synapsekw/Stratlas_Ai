// @vitest-environment jsdom
import type { JobRecord, Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { start, go, jobsList } = vi.hoisted(() => ({
  start: vi.fn(),
  go: vi.fn(),
  jobsList: { jobs: [] as JobRecord[] },
}));
vi.mock('../shell', () => ({
  jobs: { getState: () => ({ start }) },
  useJobs: <T,>(sel: (s: { jobs: JobRecord[] }) => T) => sel(jobsList),
  shell: { getState: () => ({ go }) },
  bridge: { call: vi.fn() },
}));

import { PanoSphereRows } from './PanoSphereRows';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;
const layer: PanoLayer = {
  kind: 'panoramas',
  id: 'panos-2026-09-10',
  name: 'Panoramas 10 Sep',
  visible: false,
  items: [
    {
      id: 'p01',
      src: { path: 'x' },
      pos: [10, 70, -20],
      headingDeg: 0,
      name: 'Pano 1',
      stitch: { run: 'r1', status: 'done' },
    },
    {
      id: 'p02',
      src: { path: 'y' },
      pos: [150, 70, -20],
      headingDeg: 0,
      name: 'Pano 2',
      stitch: { status: 'failed', error: 'Too few frames' },
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  start.mockResolvedValue(null);
  workspace.getState().openProject({
    id: 'p1',
    root: 'D:/projects/p1',
    manifest: {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [layer],
      severityModels: [],
      classCatalogues: [],
    },
  } as never);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('PanoSphereRows', () => {
  it('lists each sphere with its state', () => {
    act(() => {
      root.render(<PanoSphereRows layer={layer} canEdit />);
    });
    expect(q('pano-status-p01')?.textContent).toBe('Stitched');
    expect(q('pano-status-p02')?.textContent).toBe('Stitch failed: Too few frames');
    expect(q('pano-stitch-p01')).toBeNull();
    expect(q('pano-open-p02')).toBeNull(); // nothing to open yet
  });

  it('opens a stitched sphere: layer shown, 3D view, sphere view asked for', () => {
    act(() => {
      root.render(<PanoSphereRows layer={layer} canEdit />);
    });
    act(() => q('pano-open-p01')?.click());
    expect(workspace.getState().isLayerVisible('panos-2026-09-10')).toBe(true);
    expect(go).toHaveBeenCalledWith('scene');
    expect(workspace.getState().panoRequest).toMatchObject({
      layer: 'panos-2026-09-10',
      id: 'p01',
    });
  });

  it('flies to a sphere and stitches a failed one again', () => {
    act(() => {
      root.render(<PanoSphereRows layer={layer} canEdit />);
    });
    act(() => q('pano-fly-p02')?.click());
    expect(workspace.getState().camera?.target).toEqual({
      kind: 'point',
      p: [150, 70, -20],
      distance: 120,
    });
    act(() => q('pano-stitch-p02')?.click());
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: 'D:/projects/p1',
      params: { layer: 'panos-2026-09-10', pano: 'p02', quality: 'standard' },
    });
  });

  it('offers no Stitch to someone who may only look', () => {
    act(() => {
      root.render(<PanoSphereRows layer={layer} canEdit={false} />);
    });
    expect(q('pano-stitch-p02')).toBeNull();
  });
});

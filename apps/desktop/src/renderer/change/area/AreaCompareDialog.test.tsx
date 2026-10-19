// @vitest-environment jsdom
import type { ChangePairContext } from '@aio/change';
import type { Layer, ProjectManifest, SitePoint } from '@aio/schema';
import { emptyMeasurements } from '@aio/schema';
import { formatDate } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  shell: { getState: () => ({ screen: 'scene', go: vi.fn() }) },
}));

const runAreaCompare = vi.hoisted(() => vi.fn());
vi.mock('./run', () => ({ runAreaCompare }));

const notes = vi.hoisted(() => vi.fn());
vi.mock('../../shell/actions/toastHost', () => ({
  toastHost: () => ({ note: notes }),
}));

const surfaces = vi.hoisted(() => ({ on: true }));
const DEPS = vi.hoisted(() => ({ deps: true }));
vi.mock('../producers/register', () => ({
  appProducerDeps: () => DEPS,
  pairContext: (projectId: string, from: string, to: string): ChangePairContext => {
    const l = (id: string, role: 'ortho' | 'dsm') =>
      ({ kind: 'raster', id, role, format: 'cog', src: { path: id } }) as Layer;
    const of = (c: string) => [l(`o-${c}`, 'ortho'), ...(surfaces.on ? [l(`d-${c}`, 'dsm')] : [])];
    return {
      projectId,
      manifest: {} as ProjectManifest,
      from,
      to,
      layersFrom: of(from),
      layersTo: of(to),
    };
  },
}));

const { AreaCompareHost } = await import('./AreaCompareDialog');
const { areaCompare, VOLUMES_KEY } = await import('./areaCompareStore');
const { measureStore } = await import('../../survey/measureStore');

const manifest = {
  captures: [
    { id: 'c1', label: 'c1', date: '2026-09-01' },
    { id: 'c2', label: 'c2', date: '2026-10-01' },
  ],
  layers: [],
  crs: { kind: 'epsg', epsg: 32639 },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;

const pad = {
  id: 'pad',
  family: 'polygon' as const,
  tool: 'area' as const,
  label: 'Pad A',
  scope: { kind: 'site' as const },
  items: [],
  results: [],
  points: [
    [500000, 3200000, 0],
    [500010, 3200000, 0],
    [500010, 3200010, 0],
    [500000, 3200010, 0],
  ] as SitePoint[],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const volumesBox = () =>
  host.querySelector<HTMLInputElement>('[data-testid="area-compare-volumes"]');
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function mount() {
  root = createRoot(host);
  act(() => root?.render(<AreaCompareHost />));
  act(() => {
    areaCompare.getState().ask({ measurementId: 'pad', from: 'c1', to: 'c2' });
  });
}

beforeEach(() => {
  localStorage.clear();
  surfaces.on = true;
  runAreaCompare.mockReset();
  runAreaCompare.mockResolvedValue({ ok: true, notes: [] });
  notes.mockReset();
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  const file = { ...emptyMeasurements(), measurements: [pad] };
  measureStore.setState({
    file,
    savedText: JSON.stringify(file),
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
  });
  areaCompare.getState().close();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('AreaCompareDialog', () => {
  it('shows the polygon label and the two dates', () => {
    mount();
    expect(q('area-compare-dialog')).not.toBeNull();
    expect(q('area-compare-name')?.textContent).toBe('Pad A');
    expect(q('area-compare-dates')?.textContent).toBe(
      `${formatDate('2026-09-01')} to ${formatDate('2026-10-01')}`,
    );
  });

  it('names a polygon with a blank label as the area is stored', () => {
    const file = { ...emptyMeasurements(), measurements: [{ ...pad, label: '   ' }] };
    measureStore.setState({ file, savedText: JSON.stringify(file) });
    mount();
    expect(q('area-compare-name')?.textContent).toBe('pad');
  });

  it('keeps volumes off by default and remembers on after a run', async () => {
    mount();
    expect(volumesBox()?.checked).toBe(false);
    act(() => volumesBox()?.click());
    act(() => q('area-compare-run')?.click());
    await flush();
    expect(runAreaCompare).toHaveBeenCalledWith(
      DEPS,
      expect.objectContaining({ from: 'c1', to: 'c2' }),
      expect.objectContaining({ scope: { id: 'pad', name: 'Pad A' } }),
      { volumes: true },
    );
    expect(localStorage.getItem(VOLUMES_KEY)).toBe('1');
    expect(areaCompare.getState().request).toBeNull();
    expect(notes).toHaveBeenCalled();

    act(() => root?.unmount());
    mount();
    expect(volumesBox()?.checked).toBe(true);
  });

  it('runs without volumes when the box stays off', async () => {
    mount();
    act(() => q('area-compare-run')?.click());
    await flush();
    expect(runAreaCompare).toHaveBeenCalledWith(DEPS, expect.anything(), expect.anything(), {
      volumes: false,
    });
    expect(localStorage.getItem(VOLUMES_KEY)).toBe('0');
  });

  it('disables volumes with the reason when a date has no elevation', () => {
    surfaces.on = false;
    localStorage.setItem(VOLUMES_KEY, '1');
    mount();
    expect(volumesBox()?.disabled).toBe(true);
    expect(volumesBox()?.checked).toBe(false);
    const reason = 'Surface change needs a DSM or a point cloud on each date.';
    expect(q('area-compare-volumes-reason')?.textContent).toBe(reason);
    expect(volumesBox()?.getAttribute('aria-describedby')).toBe('area-compare-volumes-reason');
  });

  it('keeps a start error in the box', async () => {
    runAreaCompare.mockResolvedValue({ ok: false, error: 'No project folder.' });
    mount();
    act(() => q('area-compare-run')?.click());
    await flush();
    expect(q('area-compare-error')?.textContent).toContain('No project folder.');
    expect(areaCompare.getState().request).not.toBeNull();
  });

  it('turns notes into toasts', async () => {
    runAreaCompare.mockResolvedValue({ ok: true, notes: ['Volumes were not started: x'] });
    mount();
    act(() => q('area-compare-run')?.click());
    await flush();
    expect(notes).toHaveBeenCalledWith('Volumes were not started: x', true);
  });

  it('closes on Escape and on Cancel', () => {
    mount();
    act(() => {
      q('area-compare-run')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(areaCompare.getState().request).toBeNull();
    expect(q('area-compare-dialog')).toBeNull();
    act(() => {
      areaCompare.getState().ask({ measurementId: 'pad', from: 'c1', to: 'c2' });
    });
    act(() => q('area-compare-cancel')?.click());
    expect(areaCompare.getState().request).toBeNull();
  });
});

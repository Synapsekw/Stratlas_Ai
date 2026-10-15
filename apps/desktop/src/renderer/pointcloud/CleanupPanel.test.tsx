// @vitest-environment jsdom
import { ProjectManifest, emptyCleanup, type Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupPanel } from './CleanupPanel';
import { cleanup } from './cleanupStore';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const copc = (id: string, format = 'copc'): Layer =>
  ({
    kind: 'pointcloud',
    id,
    name: `Scan ${id}`,
    visible: true,
    src: { path: `clouds/${id}.copc.laz` },
    format,
  }) as Layer;

function project(layers: Layer[]) {
  workspace.getState().openProject({
    id: 'p',
    root: 'D:/p',
    manifest: ProjectManifest.parse({
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      customer: 'E2E',
      site: 'Synthetic site',
      origin: [500000, 3200000, 0],
      crs: { epsg: 32639 },
      captures: [],
      layers,
      severityModels: [],
      classCatalogues: [],
    }),
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  cleanup.store.setState({
    projectId: 'p',
    readOnly: false,
    layers: {},
    active: null,
    panelOpen: true,
    section: null,
    pending: null,
    busy: null,
    notice: null,
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<CleanupPanel stage={null} />));
};
const setValue = (el: HTMLInputElement, value: string) => {
  // React tracks the value setter: set it the native way, then fire input
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('CleanupPanel', () => {
  it('acts on the only cloud and offers every section', () => {
    project([copc('a')]);
    render();
    expect(q('cleanup-panel')).not.toBeNull();
    expect(q('cleanup-layer')).toBeNull(); // one cloud: no picker
    for (const id of [
      'cleanup-box-fit',
      'cleanup-height-min',
      'cleanup-select-lasso',
      'cleanup-noise-run',
      'cleanup-save',
    ])
      expect(q(id), id).not.toBeNull();
    expect((q('cleanup-save-name') as HTMLInputElement).value).toBe('Scan a');
  });

  it('says COPC only and disables the tools for a png-packed cloud', () => {
    project([copc('a', 'png-packed')]);
    render();
    expect(q('cleanup-hint')?.textContent).toBe(
      'Cleanup works on COPC clouds. Convert this cloud to COPC to clean it up.',
    );
    expect((q('cleanup-noise-run') as HTMLButtonElement).disabled).toBe(true);
    expect((q('cleanup-select-box') as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits a height range on blur, not while typing', () => {
    project([copc('a')]);
    const commit = vi.spyOn(cleanup, 'commit').mockResolvedValue(true);
    render();
    const min = q('cleanup-height-min') as HTMLInputElement;
    act(() => {
      setValue(min, '12.5');
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      min.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(commit).toHaveBeenCalledWith('a', expect.objectContaining({ height: { min: 12.5 } }));
    commit.mockRestore();
  });

  it('refuses a lowest height above the highest without committing', () => {
    project([copc('a')]);
    cleanup.store.setState({
      layers: {
        a: { past: [], present: { ...emptyCleanup('a'), height: { max: 10 } }, future: [] },
      },
    });
    const commit = vi.spyOn(cleanup, 'commit').mockResolvedValue(true);
    render();
    const min = q('cleanup-height-min') as HTMLInputElement;
    act(() => {
      setValue(min, '20');
      min.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(commit).not.toHaveBeenCalled();
    expect(q('cleanup-error')).not.toBeNull();
    commit.mockRestore();
  });

  it('shows the noise result with an Undo', () => {
    project([copc('a')]);
    const r = {
      ...emptyCleanup('a'),
      hiddenClasses: [7],
      noise: {
        path: 'edits/pointcloud/a.noise-j1.copc.laz',
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 60,
        total: 16060,
        runId: 'j1',
      },
    };
    cleanup.store.setState({ layers: { a: { past: [null], present: r, future: [] } } });
    render();
    expect(q('cleanup-noise-result')?.textContent).toContain('60 points (0.4 %) marked as noise');
    expect(q('cleanup-noise-undo')).not.toBeNull();
    expect((q('cleanup-undo') as HTMLButtonElement).disabled).toBe(false);
    expect((q('cleanup-redo') as HTMLButtonElement).disabled).toBe(true);
    expect((q('cleanup-reset') as HTMLButtonElement).disabled).toBe(false);
  });

  it('noise Undo takes the run step back when it was the last step', () => {
    project([copc('a')]);
    const r = {
      ...emptyCleanup('a'),
      hiddenClasses: [7],
      noise: {
        path: 'edits/pointcloud/a.noise-j1.copc.laz',
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 60,
        total: 16060,
        runId: 'j1',
      },
    };
    cleanup.store.setState({ layers: { a: { past: [null], present: r, future: [] } } });
    const undo = vi.spyOn(cleanup, 'undo').mockResolvedValue(true);
    render();
    act(() => {
      q('cleanup-noise-undo')?.click();
    });
    expect(undo).toHaveBeenCalledWith('a');
    undo.mockRestore();
  });

  it('picks among several clouds', () => {
    project([copc('a'), copc('b')]);
    render();
    const pick = q('cleanup-layer') as HTMLSelectElement;
    act(() => {
      pick.value = 'b';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(cleanup.store.getState().active).toBe('b');
  });

  it('puts the stage tool back to select when the box goes while the gizmo is on', () => {
    project([copc('a')]);
    const box = {
      center: [500000, 3200000, 5] as [number, number, number],
      size: [10, 10, 10] as [number, number, number],
      yaw: 0,
      keep: 'inside' as const,
    };
    cleanup.store.setState({
      layers: { a: { past: [], present: { ...emptyCleanup('a'), clipBox: box }, future: [] } },
    });
    const setTool = vi.fn((tool: string) => {
      stage.tool = tool;
    });
    const stage = { tool: 'clipbox', setTool, onStateChange: () => () => undefined };
    root = createRoot(host);
    act(() => root?.render(<CleanupPanel stage={stage as never} />));
    expect(setTool).not.toHaveBeenCalled();
    expect(q('cleanup-box-size')?.textContent).toBe('10.0 x 10.0 x 10.0 m');
    // an undo (or Reset, or Remove box) takes the box away
    act(() => {
      cleanup.store.setState({
        layers: { a: { past: [], present: emptyCleanup('a'), future: [] } },
      });
    });
    expect(setTool).toHaveBeenCalledWith('select');
  });

  it('closes on Escape inside the panel', () => {
    project([copc('a')]);
    render();
    act(() => {
      q('cleanup-box-fit')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(cleanup.store.getState().panelOpen).toBe(false);
  });
});

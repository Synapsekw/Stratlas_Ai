// @vitest-environment jsdom
import { setAnnotateReadOnly } from '@aio/annotate';
import { ProjectManifest, emptyCleanup, type Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupHost } from './CleanupHost';
import { CleanupPanel } from './CleanupPanel';
import type * as Jobs from './cleanupJobs';
import { runNoise } from './cleanupJobs';
import { cleanup, followProjectForCleanup } from './cleanupStore';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

vi.mock('./cleanupJobs', async (original) => ({
  ...(await original<typeof Jobs>()),
  runNoise: vi.fn(() => Promise.resolve(null)),
  saveCleaned: vi.fn(() => {
    // as the job module does once main accepts the job
    cleanup.notify({
      text: 'Saving the cleaned copy. It appears in Datasets when it is done.',
      undo: false,
      error: false,
      layerId: 'a',
    });
    return saveResult.promise;
  }),
}));

/** What the mocked save job ends with (null: done, text: the job error). */
const saveResult: { promise: Promise<string | null> } = { promise: Promise.resolve(null) };

Element.prototype.scrollIntoView = function scrollIntoView() {
  /* jsdom has no layout */
};

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

describe('CleanupHost', () => {
  it('Escape in the selection bar cancels the selection', () => {
    project([copc('a')]);
    root = createRoot(host);
    act(() => root?.render(<CleanupHost engine={null} />));
    act(() => {
      cleanup.setPending({
        layerId: 'a',
        shape: 'box',
        polygon: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        viewProj: Array.from({ length: 16 }, () => 0),
        count: 12,
      });
    });
    expect(q('cleanup-selection-count')?.textContent).toBe('12 loaded points selected');
    act(() => {
      q('cleanup-set-class')?.click();
    });
    expect(q('cleanup-class-list')).not.toBeNull();
    act(() => {
      q('cleanup-hide')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q('cleanup-class-list')).toBeNull(); // first Escape closes the class list
    expect(cleanup.store.getState().pending).not.toBeNull();
    act(() => {
      q('cleanup-hide')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(cleanup.store.getState().pending).toBeNull();
  });

  it('draws the notice at the top of the stage, beside the open panel', () => {
    project([copc('a')]);
    root = createRoot(host);
    act(() => root?.render(<CleanupHost engine={null} />));
    act(() => {
      cleanup.notify({ text: 'Cleanup reset.', undo: true, error: false, layerId: 'a' });
    });
    const notice = q('cleanup-notice');
    expect(notice?.className).toContain('cleanup-notice');
    expect(notice?.className).toContain('beside-panel');
    expect(notice?.getAttribute('style')).toBeNull(); // placed by cleanup.css only
    act(() => {
      cleanup.closePanel();
    });
    expect(q('cleanup-notice')?.className).not.toContain('beside-panel');
  });

  it('closes the panel and forgets the recipes when the project changes', () => {
    project([copc('a')]);
    const stop = followProjectForCleanup();
    cleanup.store.setState({ panelOpen: true, active: 'a' });
    act(() => {
      workspace.getState().closeProject();
    });
    expect(cleanup.store.getState().panelOpen).toBe(false);
    expect(cleanup.store.getState().projectId).toBeNull();
    stop();
  });
});

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

  it('shows a look-only reviewer the cleanup with every tool off', () => {
    project([copc('a')]);
    setAnnotateReadOnly(true);
    try {
      render();
      expect(q('cleanup-hint')?.textContent).toBe(
        'You can look at this project but not change it: the cleanup is shown, not changed.',
      );
      expect((q('cleanup-noise-run') as HTMLButtonElement).disabled).toBe(true);
      expect((q('cleanup-select-box') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      setAnnotateReadOnly(false);
    }
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
    expect(q('cleanup-error')?.textContent).toBe(
      'The lowest height must not be above the highest.',
    );
    commit.mockRestore();
  });

  it('does not commit a field that was only focused and left', () => {
    project([copc('a')]);
    cleanup.store.setState({
      layers: {
        a: { past: [], present: { ...emptyCleanup('a'), height: { min: 1.2345 } }, future: [] },
      },
    });
    const commit = vi.spyOn(cleanup, 'commit').mockResolvedValue(true);
    render();
    const min = q('cleanup-height-min') as HTMLInputElement;
    act(() => {
      min.focus();
      min.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(commit).not.toHaveBeenCalled();
    // the other field edited: the untouched end keeps its exact value
    const max = q('cleanup-height-max') as HTMLInputElement;
    act(() => {
      setValue(max, '20');
      max.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(commit).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ height: { min: 1.2345, max: 20 } }),
    );
    commit.mockRestore();
  });

  it('keeps the range and marks the field when a height does not parse', () => {
    project([copc('a')]);
    cleanup.store.setState({
      layers: {
        a: { past: [], present: { ...emptyCleanup('a'), height: { min: 3 } }, future: [] },
      },
    });
    const commit = vi.spyOn(cleanup, 'commit').mockResolvedValue(true);
    render();
    const min = q('cleanup-height-min') as HTMLInputElement;
    act(() => {
      setValue(min, '12,5x');
      min.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(commit).not.toHaveBeenCalled();
    expect(min.getAttribute('aria-invalid')).toBe('true');
    expect(q('cleanup-error')).not.toBeNull();
    commit.mockRestore();
  });

  it('clamps the noise settings to their ranges', () => {
    project([copc('a')]);
    render();
    const settings = q('cleanup-noise-settings') as HTMLDetailsElement;
    const [neighbours, distance] = [...settings.querySelectorAll<HTMLInputElement>('input')];
    act(() => {
      if (neighbours) setValue(neighbours, '500');
      if (distance) setValue(distance, '0.001');
    });
    act(() => {
      q('cleanup-noise-run')?.click();
    });
    expect(runNoise).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      outlier: { meanK: 64, multiplier: 0.1 },
    });
  });

  it.each([
    ['done', null],
    ['failed', 'The save did not finish.'],
  ])('clears the saving notice as soon as the save job is %s', async (_how, error) => {
    project([copc('a')]);
    let finish: (e: string | null) => void = () => undefined;
    saveResult.promise = new Promise((resolve) => {
      finish = resolve;
    });
    render();
    act(() => {
      q('cleanup-save')?.click();
    });
    expect(cleanup.store.getState().notice?.text).toContain('Saving the cleaned copy');
    await act(async () => {
      finish(error);
      await saveResult.promise;
    });
    expect(cleanup.store.getState().notice).toBeNull();
    if (error) expect(q('cleanup-error')?.textContent).toBe(error);
  });

  it('leaves a newer notice in place when the save ends', async () => {
    project([copc('a')]);
    let finish: (e: string | null) => void = () => undefined;
    saveResult.promise = new Promise((resolve) => {
      finish = resolve;
    });
    render();
    act(() => {
      q('cleanup-save')?.click();
    });
    act(() => {
      cleanup.notify({
        text: 'Points hidden in the view.',
        undo: true,
        error: false,
        layerId: 'a',
      });
    });
    await act(async () => {
      finish(null);
      await saveResult.promise;
    });
    expect(cleanup.store.getState().notice?.text).toBe('Points hidden in the view.');
  });

  it('focuses the section the right-click menu asked for', () => {
    project([copc('a')]);
    cleanup.store.setState({ section: 'save' });
    render();
    expect(document.activeElement).toBe(q('cleanup-save-name'));
  });

  it('takes focus on open and gives it back to the toolbar button on close', () => {
    project([copc('a')]);
    const button = document.createElement('button');
    button.dataset.testid = 'cleanup-tool';
    document.body.append(button);
    render();
    expect(q('cleanup-panel')?.contains(document.activeElement)).toBe(true);
    act(() => {
      q('cleanup-close')?.click();
    });
    act(() => root?.render(<></>));
    expect(document.activeElement).toBe(button);
    button.remove();
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

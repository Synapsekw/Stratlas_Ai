// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type { EngineerRun, ProcModel, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What a click in the 3D view hits (the scene's raycast). */
const scene = { hit: { point: { x: 12, y: 4, z: -7 } } as unknown };
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveScene: () => ({ raycast: () => scene.hit }),
}));

const { EngineerLayer } = await import('./EngineerLayer');
import { ENGINEERING_MODEL_UI } from './flags';
import { activeEngineerSession } from '../modeller/engineerTools';
import { engineerHost } from './host';
import type { RunState } from './runStore';
import { engineerUi } from './ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'pointcloud',
      id: 'scan',
      name: 'Scan',
      visible: true,
      src: { path: 'clouds/scan.copc.laz' },
      format: 'copc',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const run = (stages: EngineerRun['stages']): EngineerRun => ({
  schema: 'aio.engineer-run/1',
  id: 'run-1',
  modelId: 'stack',
  createdAt: '2026-10-15T10:00:00.000Z',
  setup: {
    sources: { clouds: [{ layer: 'scan' }], meshes: [], photos: [] },
    family: 'auto',
    scope: 'asset',
    detail: 'standard',
    placement: 'from-source',
  },
  stages,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
});

const model = (accepted: boolean) =>
  ({
    id: 'stack',
    assemblies: [{ id: 'shaft-1', status: accepted ? 'accepted' : 'draft' }],
    parts: [],
  }) as unknown as ProcModel;

/** The open project's run store, its actions replaced by mocks. */
function fake(state: Partial<RunState>) {
  const store = engineerHost.getState().store;
  if (!store) throw new Error('no run store');
  const actions = {
    start: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    retry: vi.fn(() => Promise.resolve()),
    accept: vi.fn(() => Promise.resolve()),
    dropImages: vi.fn(() => Promise.resolve()),
    sendPreview: vi.fn(),
    declinePreview: vi.fn(),
    allowProject: vi.fn(() => Promise.resolve()),
  };
  act(() => {
    store.setState({ ...actions, ...state });
  });
  return actions;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  act(() => root?.render(<EngineerLayer />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  engineerUi.setState({ open: false, preselect: [] });
  workspace.getState().closeProject();
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing');
  return v;
}

/** The 3D view's pane, with a canvas, for the pick to listen on. */
function pane(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pane-3d';
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  el.append(canvas);
  document.body.append(el);
  return el;
}

/** A click (no drag) in the 3D view. */
function clickScene(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 }));
    el.dispatchEvent(new MouseEvent('pointerup', { clientX: 400, clientY: 300, button: 0 }));
  });
}

const setupShown = () =>
  must(q('eng-setup')).closest<HTMLElement>('.dlg-scrim')?.style.display !== 'none';

describe('EngineerLayer', () => {
  it('is on, makes a run store for the open project and hands the agent a session', () => {
    expect(ENGINEERING_MODEL_UI).toBe(true);
    expect(engineerHost.getState()).toMatchObject({ projectId: 'p' });
    expect(engineerHost.getState().store).not.toBeNull();
    expect(activeEngineerSession()).not.toBeNull();
    // nothing shows until it is asked for
    expect(q('eng-setup')).toBeNull();
  });

  it('opens the setup with the chosen layer, and Start hands the setup to the run store', async () => {
    const a = fake({});
    act(() => {
      engineerUi.getState().show(['scan']);
    });
    expect((q('eng-source-scan') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      q('eng-start')?.click();
      await Promise.resolve();
    });
    expect(a.start).toHaveBeenCalledTimes(1);
  });

  it('shows the run: stages, why it stopped, identity conflicts with the photos to drop', () => {
    const a = fake({
      run: run({ inspect: { status: 'done' }, identify: { status: 'failed', message: 'x' } }),
      error: 'The provider refused the request.',
      notice: 'Identify was skipped.',
      conflicts: [{ imageIds: ['img-photo-a', 'img-photo-b'], reason: 'two towers' }],
    });
    act(() => {
      engineerUi.getState().show();
    });
    expect(q('eng-run')).not.toBeNull();
    expect(q('eng-run-error')?.textContent).toContain('refused');
    expect(q('eng-run-notice')?.textContent).toContain('skipped');
    const drop = q('eng-conflicts')?.querySelector('button');
    expect(drop?.textContent).toBe('Leave out these 2 photos');
    act(() => drop?.click());
    expect(a.dropImages).toHaveBeenCalledWith(['img-photo-a', 'img-photo-b']);
    act(() => q('eng-retry')?.click());
    expect(a.retry).toHaveBeenCalled();
  });

  it('keeps Accept off, and says why, until a component is accepted in the review', async () => {
    const a = fake({ run: run({ validate: { status: 'done' } }), model: model(false) });
    act(() => {
      engineerUi.getState().show();
    });
    expect((q('eng-accept') as HTMLButtonElement).disabled).toBe(true);
    expect(q('eng-accept-needs')?.textContent).toContain('Accept at least one component');
    act(() => {
      engineerHost.getState().store?.setState({ model: model(true) });
    });
    expect((q('eng-accept') as HTMLButtonElement).disabled).toBe(false);
    expect(q('eng-accept-needs')).toBeNull();
    await act(async () => {
      q('eng-accept')?.click();
      await Promise.resolve();
    });
    expect(a.accept).toHaveBeenCalled();
  });

  it('picks a region and an anchor in the 3D view and keeps every other choice', async () => {
    fake({ run: null, preview: null });
    const el = pane();
    try {
      act(() => {
        engineerUi.getState().show(['scan']);
      });
      act(() => q('eng-detail-fast')?.click());
      act(() => q('eng-region-pick')?.click());
      // the setup steps aside (still there, with its choices) while the bar says what to do
      expect(setupShown()).toBe(false);
      expect(q('eng-pick-bar')?.textContent).toContain(
        'Click the asset in the 3D view. Escape cancels.',
      );
      expect(el.dataset.picking).toBe('true');
      clickScene(el);
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('eng-pick-bar')).toBeNull();
      expect(setupShown()).toBe(true);
      expect(q('eng-region')?.textContent).toBe('Around E 12 N 7, 30 m');
      expect((q('eng-detail-fast') as HTMLInputElement).checked).toBe(true);
      expect((q('eng-source-scan') as HTMLInputElement).checked).toBe(true);

      act(() => q('eng-placement-anchor')?.click());
      act(() => q('eng-anchor-pick')?.click());
      expect(setupShown()).toBe(false);
      scene.hit = { point: { x: 1, y: 2, z: -3 } };
      clickScene(el);
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('eng-anchor')?.textContent).toBe('At E 1 N 3 H 2');
      expect(q('eng-region')?.textContent).toBe('Around E 12 N 7, 30 m');
    } finally {
      el.remove();
      scene.hit = { point: { x: 12, y: 4, z: -7 } };
    }
  });

  it('Escape or Cancel on the bar lets the pick go and brings the setup back unchanged', async () => {
    fake({ run: null, preview: null });
    const el = pane();
    try {
      act(() => {
        engineerUi.getState().show(['scan']);
      });
      act(() => q('eng-region-pick')?.click());
      // the key comes from the pick button, still focused inside the hidden setup
      act(() => {
        must(q('eng-region-pick')).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('eng-pick-bar')).toBeNull();
      expect(el.dataset.picking).toBeUndefined();
      expect(setupShown()).toBe(true);
      expect(q('eng-region')).toBeNull();
      act(() => q('eng-region-pick')?.click());
      act(() => q('eng-pick-cancel')?.click());
      expect(q('eng-pick-bar')).toBeNull();
      expect(setupShown()).toBe(true);
    } finally {
      el.remove();
    }
  });

  it('lets a pick go when the setup is closed or another project opens', () => {
    fake({ run: null, preview: null });
    const el = pane();
    try {
      act(() => {
        engineerUi.getState().show(['scan']);
      });
      act(() => q('eng-region-pick')?.click());
      act(() => {
        engineerUi.getState().hide();
      });
      expect(q('eng-pick-bar')).toBeNull();
      expect(el.dataset.picking).toBeUndefined();
      act(() => {
        engineerUi.getState().show(['scan']);
      });
      expect(setupShown()).toBe(true);
      act(() => q('eng-region-pick')?.click());
      act(() => {
        workspace.getState().openProject({ id: 'q', root: 'E:/q', manifest });
      });
      expect(q('eng-pick-bar')).toBeNull();
      expect(el.dataset.picking).toBeUndefined();
    } finally {
      el.remove();
    }
  });

  it('shows a send waiting for consent, whether or not the panel is open; Cancel declines', () => {
    const a = fake({
      preview: {
        pass: 1,
        route: { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' },
        cloud: true,
        flags: { photos: false, scans: false },
        estimateUsd: 0.2,
        content: { text: 'Pass 1.', images: [], leftOut: [], bytes: 7 },
      },
    });
    expect(document.body.textContent).toContain('Send evidence to');
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Cancel',
    );
    act(() => cancel?.click());
    expect(a.declinePreview).toHaveBeenCalled();
  });
});

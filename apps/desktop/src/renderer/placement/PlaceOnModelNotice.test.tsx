// @vitest-environment jsdom
import type { EditorState, PlaceResult } from '@aio/annotate';
import { ok, type ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceOnModelNotice } from './PlaceOnModelNotice';
import { createPlacementStore, type PlaceSummary } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'mesh',
      id: 'model',
      name: 'Mesh 3 Mar',
      visible: true,
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud 3 Mar',
      visible: true,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const LABEL = 'Place 12 issues on Mesh 3 Mar';

function summary(over: Partial<PlaceSummary> = {}): PlaceSummary {
  return {
    layerId: 'model',
    layerName: 'Mesh 3 Mar',
    total: 14,
    placed: 12,
    missed: 2,
    noPhoto: 0,
    notLoaded: 0,
    changed: 0,
    selectionFailed: 0,
    label: LABEL,
    outcomes: [],
    ...over,
  };
}

function mount(undoLabel = LABEL) {
  workspace.getState().openProject({ id: 'p', root: 'r', manifest }, []);
  const undo = vi.fn(() => true);
  const state = {
    canUndo: true,
    canRedo: false,
    undoLabel,
    redoLabel: null,
    save: { state: 'saved' },
    lastError: null,
  } as unknown as EditorState;
  const store = createPlacementStore({
    workspace,
    editor: { state, commitIssues: vi.fn(() => ok(null)), undo },
    prepare: vi.fn(() => Promise.resolve()),
    place: vi.fn(() => Promise.resolve<PlaceResult>({ ok: false, reason: 'missed' })),
    writeSelection: vi.fn(() => Promise.resolve({ error: 'no' })),
    ready: vi.fn(() => Promise.resolve(true)),
    now: () => '2026-10-15T12:00:00.000Z',
    newId: () => 't',
  });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(<PlaceOnModelNotice store={store} />);
  });
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`);
  const click = (id: string) => {
    act(() => {
      q(id)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  return {
    store,
    undo,
    el,
    q,
    click,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      el.remove();
    },
  };
}

afterEach(() => {
  workspace.getState().closeProject();
});

describe('PlaceOnModelNotice', () => {
  it('shows nothing until there is an offer, a result or a match', () => {
    const ui = mount();
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('asks to connect the findings, lists the layers and closes on Not now', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ offer: { ids: ['a', 'b'], source: 'detections' }, layerId: 'model' });
    });
    expect(ui.q('place-offer')?.textContent).toContain('Connect 2 findings to a model?');
    const options = [...(ui.q('place-layer')?.querySelectorAll('option') ?? [])].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Mesh 3 Mar (mesh)', 'Cloud 3 Mar (point cloud)']);
    ui.click('place-not-now');
    expect(ui.store.getState().offer).toBeNull();
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('says so when the project has no mesh or point cloud', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ offer: { ids: ['a'], source: 'menu' }, layerId: null, noLayers: true });
    });
    expect(ui.q('place-notice')?.textContent).toContain(
      'This project has no mesh or point cloud to place findings on.',
    );
    expect(ui.q('place-go')).toBeNull();
    ui.unmount();
  });

  it('shows the layer it is placing on while busy', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ busy: true, layerId: 'cloud' });
    });
    expect(ui.q('place-busy')?.textContent).toBe('Placing on Cloud 3 Mar');
    ui.unmount();
  });

  it('reports the result with Undo, then a match with Same, Different and Skip all', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({
        result: summary(),
        matches: [
          { issueId: 'x', code: 'AI-31', otherId: 'y', otherCode: 'AI-12', date: '3 Mar' },
          { issueId: 'z', code: 'AI-32', otherId: 'w', otherCode: 'AI-13', date: '3 Mar' },
        ],
      });
    });
    expect(ui.q('place-result-text')?.textContent).toBe(
      'Placed 12 of 14 on Mesh 3 Mar. 2 missed the model.',
    );
    expect(ui.q('place-match')?.textContent).toContain('AI-31 looks like AI-12 from 3 Mar');
    ui.click('place-different');
    expect(ui.q('place-match')?.textContent).toContain('AI-32 looks like AI-13');
    ui.click('place-skip-all');
    expect(ui.q('place-match')).toBeNull();
    ui.click('place-undo');
    expect(ui.undo).toHaveBeenCalledTimes(1);
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('says a match is tracked as one after Same', () => {
    const ui = mount();
    const same = vi.fn(() => {
      ui.store.setState({ matches: [] });
    });
    act(() => {
      ui.store.setState({
        same,
        matches: [{ issueId: 'x', code: 'AI-31', otherId: 'y', otherCode: 'AI-12', date: '3 Mar' }],
      });
    });
    ui.click('place-same');
    expect(same).toHaveBeenCalledTimes(1);
    expect(ui.q('place-match')).toBeNull();
    expect(ui.q('place-matched')?.textContent).toBe('AI-31 and AI-12 are tracked as one finding.');
    ui.click('place-dismiss');
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('does not claim a match when Same was refused', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({
        same: () => {
          ui.store.setState({ matches: [], error: 'The project is read only.' });
        },
        matches: [{ issueId: 'x', code: 'AI-31', otherId: 'y', otherCode: 'AI-12', date: '3 Mar' }],
      });
    });
    ui.click('place-same');
    expect(ui.q('place-matched')).toBeNull();
    expect(ui.q('place-error')?.textContent).toBe('The project is read only.');
    ui.unmount();
  });

  it('tells apart findings that changed while placing from those that missed', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ result: summary({ total: 3, placed: 1, missed: 0, changed: 2 }) });
    });
    const text = ui.q('place-result-text')?.textContent ?? '';
    expect(text).toBe(
      'Placed 1 of 3 on Mesh 3 Mar. 2 changed while placing and were left as they are.',
    );
    expect(text).not.toContain('missed');
    ui.unmount();
  });

  it('says once when point selections could not be saved', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({
        result: summary({
          layerId: 'cloud',
          layerName: 'Cloud 3 Mar',
          total: 1,
          placed: 1,
          missed: 0,
          selectionFailed: 1,
          outcomes: [{ id: 'a', code: 'AI-1', ok: true, selectionError: 'disk full' }],
        }),
        error: 'disk full',
      });
    });
    expect(ui.q('place-result-text')?.textContent).toBe(
      'Placed 1 of 1 on Cloud 3 Mar. The points of 1 finding could not be saved: disk full',
    );
    expect(ui.q('place-error')).toBeNull();
    ui.unmount();
  });

  it('says it could not undo when another edit came after the placement', () => {
    const ui = mount('Rename AI-3');
    act(() => {
      ui.store.setState({ result: summary() });
    });
    ui.click('place-undo');
    expect(ui.undo).not.toHaveBeenCalled();
    expect(ui.q('place-undo-stale')?.textContent).toBe(
      'Not undone: another change came after the placement. Ctrl+Z undoes one step at a time.',
    );
    ui.click('place-dismiss');
    expect(ui.store.getState().undoStale).toBe(false);
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('shows an error until dismissed', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ error: 'Saving failed.' });
    });
    expect(ui.q('place-error')?.textContent).toBe('Saving failed.');
    ui.click('place-dismiss');
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('uses no em or en dash in what it shows', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ offer: { ids: ['a'], source: 'menu' }, layerId: 'cloud' });
    });
    expect(ui.el.textContent).not.toMatch(/[–—]/);
    ui.unmount();
  });
});

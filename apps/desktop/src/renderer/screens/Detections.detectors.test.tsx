// @vitest-environment jsdom
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft = {
  id: 'm1',
  pass: 'vlm-run-a.json',
  source: { kind: 'photo', layer: 'p', photo: 'a.jpg' },
  size: [100, 100],
  geom: { type: 'box', x: 0, y: 0, w: 10, h: 10 },
  classId: 'rust',
  severity: null,
  uncertain: false,
  note: '',
  status: 'draft',
  confidence: 0.9,
  origin: {
    kind: 'model',
    producer: 'local',
    detector: { id: 'rust', version: 1, modelSha256: 'a'.repeat(64), threshold: 0.6 },
  },
} as unknown as Detection;

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: null as object | null,
  shapes: [] as { detection: { id: string } }[],
}));

vi.mock('../detections/store', () => ({
  dispatch: h.dispatch,
  useDetections: (sel: (s: unknown) => unknown) => sel(h.state),
  loadDetections: () => Promise.resolve(),
  passHeaders: () => new Map(),
  acceptAll: vi.fn(),
  acceptCurrent: vi.fn(),
  planFor: () => ({ accept: 0, reject: 0 }),
  redoReview: vi.fn(),
  rejectAll: vi.fn(),
  undoReview: vi.fn(),
}));
vi.mock('@aio/workspace', () => ({
  assetUrl: () => '',
  useWorkspace: (sel: (s: unknown) => unknown) =>
    sel({
      project: { id: 'x', root: '', manifest: { layers: [], severityModels: [] } },
      issues: [],
    }),
  workspace: { getState: () => ({ select: vi.fn(), focusedWindow: 'photo', focus: vi.fn() }) },
}));
vi.mock('@aio/annotate', () => ({ useTaxonomy: () => ({ classById: new Map(), classes: [] }) }));
vi.mock('../author', () => ({ authorName: () => 'tester' }));
vi.mock('../media', () => ({ useMedia: () => ({ durations: {} }) }));
vi.mock('../shell', () => ({
  bridge: { call: vi.fn(() => Promise.resolve({ ok: true, value: { items: [] } })) },
  shell: { getState: () => ({ go: vi.fn() }) },
  useCall: () => null,
}));
vi.mock('../processing/store', () => ({ processing: { getState: () => ({}) } }));
vi.mock('../shell/PageHeader', () => ({ PageHeader: () => null }));
vi.mock('./NoProject', () => ({ NoProject: () => null }));
vi.mock('../detections/AiDetectDialog', () => ({ AiDetectDialog: () => null }));
vi.mock('../detections/ContactSheet', () => ({ ContactSheet: () => null }));
vi.mock('../detections/Editor', () => ({
  ReviewEditor: (p: { shapes: { detection: { id: string } }[] }) => {
    h.shapes = p.shapes;
    return null;
  },
}));
vi.mock('../detections/Inspector', () => ({ Inspector: () => null }));
vi.mock('./mediaFindings', () => ({
  findingsIndex: () => new Map(),
  photoKey: () => '',
}));

const { DetectionsScreen } = await import('./Detections');

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  h.dispatch.mockClear();
  h.state = {
    review: reviewReducer(initialReview(), { type: 'load', detections: [draft] }),
    loading: false,
    loadError: null,
    readOnly: false,
    save: { state: 'saved' },
    problem: null,
    issueError: null,
    hidden: 0,
    problems: [],
  };
});
afterEach(() => {
  host.remove();
});

const key = (el: Element, k: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};

describe('Detections screen with a local detector pass', () => {
  it('X on a detector draft rejects it at once, with no reason and no menu', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<DetectionsScreen />);
    });
    expect(host.querySelector('[data-testid="det-vlm-pass"]')).not.toBeNull();
    const zone = host.querySelector('.det-screen');
    expect(zone).not.toBeNull();
    if (zone) key(zone, 'x');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const action = h.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(action).toMatchObject({ type: 'reject', id: 'm1' });
    expect(action).not.toHaveProperty('reason');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    root.unmount();
  });

  it('arrow keys on the pass slider do not step the review', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<DetectionsScreen />);
    });
    const slider = host.querySelector('input[aria-label^="Score bar"]');
    expect(slider).not.toBeNull();
    if (slider) {
      key(slider, 'ArrowRight');
      key(slider, 'j');
      key(slider, 'x');
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    root.unmount();
  });
  it('raising the bar lowers the counts and takes the hidden draft out of the editor', () => {
    const lower = { ...draft, id: 'm2', confidence: 0.7, geom: { ...draft.geom, y: 50 } };
    let review = reviewReducer(initialReview(), { type: 'load', detections: [draft, lower] });
    h.state = { ...h.state, review };
    const root = createRoot(host);
    act(() => {
      root.render(<DetectionsScreen />);
    });
    const counts = () => host.querySelector('[data-testid="det-counts"]')?.textContent ?? '';
    expect(counts()).toBe('2 waiting · 0 accepted · 0 rejected');
    expect(h.shapes.map((x) => x.detection.id)).toEqual(['m1', 'm2']);
    review = reviewReducer(review, { type: 'passThreshold', pass: 'vlm-run-a.json', value: 0.8 });
    h.state = { ...h.state, review };
    act(() => {
      root.render(<DetectionsScreen />);
    });
    expect(counts()).toBe('1 waiting · 0 accepted · 0 rejected · 1 hidden by the bar');
    expect(h.shapes.map((x) => x.detection.id)).toEqual(['m1']);
    root.unmount();
  });
});

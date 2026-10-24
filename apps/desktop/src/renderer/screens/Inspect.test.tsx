// @vitest-environment jsdom
/**
 * The Inspect screen put together: the open photo follows a selection made elsewhere, A accepts
 * the picked AI suggestion so the list shows it as yours, keys typed into a field stay there, and
 * a finding with no photo shows its card. The photo viewer, the photo column, Ask AI and the
 * issue card are stood in for; the review store, the accept path and the findings panel are real.
 */
import { setAnnotateReadOnly } from '@aio/annotate';
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { Issue, ProjectManifest } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Store from '../detections/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the app's bridge binds to window.aio when its module loads: writes succeed, mask assist is off
vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: (channel: string) =>
      Promise.resolve(
        channel === 'detections:maskAssistStatus'
          ? { ok: true, value: { available: false } }
          : { ok: true },
      ),
    on: () => () => undefined,
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe = () => undefined;
    disconnect = () => undefined;
  };
});

vi.mock('../detections/store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  // the test sets the review itself: no read from disk
  loadDetections: vi.fn(() => Promise.resolve()),
}));
vi.mock('../inspect/InspectViewer', () => ({
  InspectViewer: (p: { photo: PhotoPick | null; currentId: string | null }) => (
    <div
      data-testid="viewer"
      data-photo={p.photo ? `${p.photo.layerId}/${p.photo.photoId}` : ''}
      data-current={p.currentId ?? ''}
    />
  ),
}));
vi.mock('../inspect/PhotoColumn', () => ({ PhotoColumn: () => <div data-testid="column" /> }));
vi.mock('../inspect/askAi/AskAiBar', () => ({ AskAiBar: () => null }));
vi.mock('../inspect/askAi/RunStrip', () => ({ RunStrip: () => null }));
vi.mock('../issueCard/IssueCard', () => ({
  IssueCard: (p: { issueId: string }) => <div data-testid="issue-card" data-issue={p.issueId} />,
}));
vi.mock('../workspace/spot/SpotHistoryEntry', () => ({
  SpotHistoryButton: () => null,
  InlineSpotStrip: () => null,
}));
vi.mock('../shell/actions/thermalActions', () => ({
  thermalPhotosOf: () => [],
  thermalPrimed: () => Promise.resolve(),
}));
vi.mock('../shell/PageHeader', () => ({ PageHeader: () => null }));

const { detections, dispatch } = await import('../detections/store');
const { InspectScreen } = await import('./Inspect');

const NOW = '2026-10-24T10:00:00.000Z';
const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [photo('a'), photo('b'), photo('c')],
    },
  ],
  severityModels: [
    {
      id: 'sev3',
      name: 'Three',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'Major', color: '#ff2d2d', criteria: '' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Kit',
      assetType: 'site',
      classes: [{ id: 'corrosion', label: 'Corrosion', color: '#aa5500', severityModel: 'sev3' }],
    },
  ],
};

const issue = (id: string, sightings: unknown[]): Issue =>
  ({
    id,
    code: `F-${id}`,
    classId: 'corrosion',
    severityModelId: 'sev3',
    severity: 2,
    status: 'draft',
    title: `Issue ${id}`,
    note: '',
    author: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    sightings,
    source: 'human',
  }) as Issue;

const ON_B = issue('i-b', [
  { on: 'image', layer: 'photos', photo: 'b', geom: { type: 'box', x: 1, y: 1, w: 5, h: 5 } },
]);
const IN_3D = issue('i-3d', [
  { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 0, 1] } },
]);

const draft = (id: string, on: string): Detection => ({
  id,
  pass: 'ai-r1.json',
  source: { kind: 'photo', layer: 'photos', photo: on },
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'corrosion',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
  createdAt: NOW,
  updatedAt: NOW,
});

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function mount() {
  act(() => {
    root.render(<InspectScreen />);
  });
}

const section = () => {
  const el = host.querySelector<HTMLElement>('section.screen.inspect');
  if (!el) throw new Error('no Inspect screen');
  return el;
};
const viewer = () => host.querySelector<HTMLElement>('[data-testid="viewer"]');
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="inspect-row"]')];
const select = (s: Parameters<ReturnType<typeof workspace.getState>['select']>[0]) => {
  act(() => {
    workspace.getState().select(s);
  });
};
const press = (el: Element, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  setAnnotateReadOnly(false);
  localStorage.clear();
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, [ON_B, IN_3D]);
  detections.setState({
    projectId: 'p1',
    readOnly: false,
    review: reviewReducer(initialReview(), {
      type: 'load',
      detections: [draft('d-a', 'a'), draft('d-c', 'c')],
    }),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview(), readOnly: false });
});

describe('InspectScreen', () => {
  it('opens the photo of an issue selected in Issues with that finding selected', () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    expect(viewer()?.dataset.photo).toBe('photos/a');
    select({ kind: 'issue', id: 'i-b' });
    expect(viewer()?.dataset.photo).toBe('photos/b');
    const you = rows().find((r) => r.dataset.kind === 'you');
    expect(you?.dataset.key).toBe('issue:i-b');
    expect(you?.dataset.selected).toBe('true');
  });

  it('A accepts the selected suggestion and the list shows it as yours', async () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    act(() => {
      dispatch({ type: 'select', id: 'd-a' });
    });
    expect(rows().map((r) => r.dataset.kind)).toEqual(['ai']);
    const head = host.querySelector('[data-testid="inspect-findings"] button');
    if (!head) throw new Error('no findings panel');
    press(head, 'a');
    await flush();
    expect(detections.getState().review.detections.find((d) => d.id === 'd-a')?.status).toBe(
      'accepted',
    );
    expect(workspace.getState().issues).toHaveLength(3);
    expect(rows().map((r) => r.dataset.kind)).toEqual(['you']);
  });

  it('A does nothing on the photo list when no suggestion of the photo is picked', async () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    // the review's current draft is on another photo
    act(() => {
      dispatch({ type: 'select', id: 'd-c' });
    });
    press(section(), 'a');
    await flush();
    expect(workspace.getState().issues).toHaveLength(2);
  });

  it('ignores the keys while typing in a field', async () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    act(() => {
      dispatch({ type: 'select', id: 'd-a' });
    });
    const field = document.createElement('input');
    section().appendChild(field);
    press(field, 'a');
    press(field, 'd');
    press(field, 'j');
    await flush();
    expect(detections.getState().review.detections.find((d) => d.id === 'd-a')?.status).toBe(
      'draft',
    );
    expect(workspace.getState().issues).toHaveLength(2);
    expect(viewer()?.dataset.photo).toBe('photos/a');
  });

  it('decides nothing from the keys in a read-only package, and says why', async () => {
    setAnnotateReadOnly(true);
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    act(() => {
      dispatch({ type: 'select', id: 'd-a' });
    });
    press(section(), 'd');
    press(section(), 'a');
    await flush();
    expect(detections.getState().review.detections.find((d) => d.id === 'd-a')?.status).toBe(
      'draft',
    );
    expect(workspace.getState().issues).toHaveLength(2);
    expect(host.querySelector('[data-testid="inspect-note"]')?.textContent).toBe(
      'This package is read only.',
    );
    // the photo and its suggestion stay in view
    expect(viewer()?.dataset.photo).toBe('photos/a');
    expect(rows().map((r) => r.dataset.kind)).toEqual(['ai']);
  });

  it('D dismisses the selected suggestion', () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    act(() => {
      dispatch({ type: 'select', id: 'd-a' });
    });
    press(section(), 'd');
    expect(detections.getState().review.detections.find((d) => d.id === 'd-a')?.status).toBe(
      'rejected',
    );
    expect(rows()).toHaveLength(0);
  });

  it('shows the issue card for a finding marked only in 3D', () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    select({ kind: 'issue', id: 'i-3d' });
    // the photo stays open; the card stands in for the photo's findings
    expect(viewer()?.dataset.photo).toBe('photos/a');
    const card = host.querySelector<HTMLElement>(
      '[data-testid="inspect-findings"] [data-testid="issue-card"]',
    );
    expect(card?.dataset.issue).toBe('i-3d');
  });

  it('offers the review queue while suggestions wait, and Esc leaves it', () => {
    mount();
    select({ kind: 'photo', id: 'a', layer: 'photos' });
    const review = host.querySelector<HTMLButtonElement>('[data-testid="inspect-review"]');
    expect(review?.textContent).toContain('Review 2 suggestions');
    act(() => {
      review?.click();
    });
    expect(host.querySelector('[data-testid="inspect-queue"]')).not.toBeNull();
    press(section(), 'Escape');
    expect(host.querySelector('[data-testid="inspect-queue"]')).toBeNull();
  });
});

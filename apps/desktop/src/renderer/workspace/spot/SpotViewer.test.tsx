// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, workspace } from '@aio/workspace';
import { act, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../../shell';
import { timeline } from '../timeline';
import { panoAt, photoAt } from './__fixtures__/spotPoses';
import { SpotViewer } from './SpotViewer';
import type { SpotEntry, SpotMatch } from './spotTypes';
import { openSpotHistory, spotViewer } from './spotViewerStore';

let entries: SpotEntry[] = [];
vi.mock('./useSpotEntries', () => ({
  useSpotEntries: () => ({ entries, reading: false }),
}));
vi.mock('./SpotMatchView', () => ({
  SpotMatchView: ({ match }: { match: SpotMatch }) => (
    <i data-testid="spot-view" data-capture={match.capture}>
      <video data-testid="spot-clip" />
    </i>
  ),
}));
vi.mock('./SpotThumb', () => ({ SpotThumb: () => <i /> }));
vi.mock('@aio/video', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // the real slider preventDefaults its keys (F4)
  FramesCompare: (p: {
    a: ReactNode;
    b: ReactNode;
    mode: string;
    amount: number;
    onAmount: (n: number) => void;
  }) => (
    <div
      data-testid="frames-compare"
      data-mode={p.mode}
      // as the real stack: in Swipe a pointer down moves the divider to the pointer (400 px wide)
      onPointerDown={(e) => {
        if (p.mode === 'swipe') p.onAmount(e.clientX / 400);
      }}
    >
      <div data-testid="frames-a">{p.a}</div>
      <div data-testid="frames-b">{p.b}</div>
      {p.mode === 'swipe' && (
        <div
          role="slider"
          tabIndex={0}
          aria-valuenow={Math.round(p.amount * 100)}
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            p.onAmount(p.amount + (e.key === 'ArrowRight' ? 0.05 : -0.05));
          }}
        />
      )}
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photos = (id: string, capture: string | undefined, items: string[]) =>
  ({
    kind: 'photos',
    id,
    name: id,
    visible: true,
    capture,
    items: items.map((p) => ({ id: p, src: { path: `photos/${p}.jpg` } })),
  }) as unknown as Layer;

function manifest(captures = ['d1', 'd2', 'd3']): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32640 },
    origin: [0, 0, 0],
    captures: captures.map((id, i) => ({ id, label: id, date: `2025-0${String(i + 1)}-01` })),
    layers: [
      photos('photos-d1', 'd1', ['a']),
      photos('photos-d2', 'd2', ['b', 'c', 'nogps']),
      photos('photos-u', undefined, ['u']),
    ],
  } as unknown as ProjectManifest;
}
const photoEntries = (): SpotEntry[] => [
  photoAt('a', [0, 1.6, 0], 0, { layer: 'photos-d1', capture: 'd1' }),
  photoAt('b', [1, 1.6, 0], 0),
  photoAt('c', [3, 1.6, 0], 0),
  photoAt('nogps', undefined, null),
];

let host: HTMLDivElement;
let root: Root | undefined;
const open = (m: ProjectManifest) => {
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: m });
  timeline.getState().attach('p', captureIndex(m));
};
const render = () => {
  root ??= createRoot(host);
  act(() => root?.render(<SpotViewer />));
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialog = () => q('spot-viewer');
const head = () => q('spot-head');
const press = (key: string, o: { shiftKey?: boolean; el?: Element | null } = {}) => {
  const el = o.el ?? document.activeElement;
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: o.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el?.dispatchEvent(e);
  });
  /** Whether something took the key (the dialog, or the control itself). */
  return e.defaultPrevented;
};
const click = (el: Element | null) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};
const show = (item: Parameters<typeof openSpotHistory>[0]['item']) => {
  act(() => {
    openSpotHistory({ item });
  });
};
const photoA = { kind: 'photo', layer: 'photos-d1', photo: 'a' } as const;

const box = (el: HTMLElement) => {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      x: 0,
      y: 0,
    }),
  });
  return el;
};
const zoomBox = (side: 'left' | 'right') => {
  const el = q(`spot-zoom-${side}`);
  if (!el) throw new Error(`no zoom box ${side}`);
  return box(el);
};
const wheel = (el: HTMLElement, deltaY = -100) => {
  act(() => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};
const pointer = (el: Element, type: string, x: number, y: number) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => {
    el.dispatchEvent(e);
  });
};
const scales = () => [q('spot-zoom-left'), q('spot-zoom-right')].map((e) => e?.dataset.scale);
const xs = () => [q('spot-zoom-left'), q('spot-zoom-right')].map((e) => e?.dataset.x);
const select = (id: string, value: string) => {
  const el = host.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no select ${id}`);
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const snapshot = () => ({
  selection: workspace.getState().selection,
  hidden: { ...workspace.getState().hidden },
  focus: timeline.getState().focus,
  stage: shell.getState().stageMode,
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  entries = photoEntries();
  host = document.createElement('div');
  document.body.append(host);
  open(manifest());
});
afterEach(() => {
  act(() => {
    spotViewer.getState().close();
  });
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('keys owned by controls inside the viewer', () => {
  const dateOf = (side: 'left' | 'right') =>
    host.querySelector<HTMLSelectElement>(`[data-testid="spot-compare-date-${side}"]`);

  it('an arrow on a date select picks in that select, not the left side', () => {
    render();
    show(photoA);
    press('c');
    const right = dateOf('right');
    act(() => right?.focus());
    expect(press('ArrowDown', { el: right })).toBe(false);
    expect(press('c', { el: right })).toBe(false);
    expect(dateOf('left')?.value).toBe('d1');
    expect(q('spot-compare-view')).not.toBeNull();
    // Esc still reaches the dialog from the select
    press('Escape', { el: right });
    expect(q('spot-compare-view')).toBeNull();
  });

  it('an arrow on a clip seeks it and does not step the date', () => {
    render();
    show(photoA);
    const clip = q('spot-clip');
    expect(press('ArrowRight', { el: clip })).toBe(false);
    expect(head()?.dataset.capture).toBe('d1');
    press('Escape', { el: clip });
    expect(dialog()).toBeNull();
  });

  it('a side with no date says so instead of showing the first date', () => {
    render();
    show(photoA);
    act(() => {
      spotViewer.getState().setCompare({
        mode: 'side',
        left: { capture: 'd1', i: 0 },
        right: null,
        amount: 0.5,
      });
    });
    const right = dateOf('right');
    expect(right?.value).toBe('');
    expect(right?.selectedOptions[0]?.textContent).toBe('No image of this spot on that date');
    expect(dateOf('left')?.querySelector('option[value=""]')).toBeNull();
  });
});

describe('the spot viewer', () => {
  it('steps dates and images, compares, and leaves the main view alone', () => {
    act(() => {
      timeline.getState().focusSurvey('d2');
      workspace.getState().select({ kind: 'layer', id: 'photos-d1' });
      workspace.getState().setLayerVisible('photos-d2', false);
      shell.getState().setStageMode('map');
    });
    const before = snapshot();
    const selectSpy = vi.spyOn(workspace.getState(), 'select');
    render();
    show(photoA);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());
    expect(head()?.dataset.capture).toBe('d1');
    expect(head()?.dataset.item).toBe('a');
    expect(host.querySelectorAll('[data-testid^="spot-slot-"]')).toHaveLength(3);
    expect(q('spot-slot-d3')?.dataset.empty).toBe('true');

    press('ArrowRight');
    expect(head()?.dataset.capture).toBe('d2');
    expect(head()?.dataset.item).toBe('b');
    expect(head()?.dataset.distance).toBe('1.00');
    press('ArrowRight');
    expect(head()?.dataset.capture).toBe('d2');
    press('ArrowDown');
    expect(head()?.dataset.item).toBe('c');
    press('ArrowLeft');
    expect(head()?.dataset.capture).toBe('d1');
    expect(timeline.getState().focus).toBe(before.focus);

    click(q('spot-slot-d2'));
    expect(head()?.dataset.item).toBe('b');
    click(q('spot-slot-d1'));

    press('c');
    expect(q('spot-compare-view')?.dataset.mode).toBe('side');
    const left = host.querySelector<HTMLSelectElement>('[data-testid="spot-compare-date-left"]');
    const right = host.querySelector<HTMLSelectElement>('[data-testid="spot-compare-date-right"]');
    expect(left?.value).toBe('d1');
    expect(right?.value).toBe('d2');
    expect([...(right?.options ?? [])].map((o) => o.value)).toEqual(['d1', 'd2']);
    click(q('spot-mode-swipe'));
    expect(q('spot-compare-view')?.dataset.mode).toBe('swipe');
    press('Escape');
    expect(q('spot-compare-view')).toBeNull();
    expect(dialog()).not.toBeNull();
    press('Escape');
    expect(dialog()).toBeNull();

    expect(snapshot()).toEqual(before);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('Compare resolves a left side whose match is gone', () => {
    render();
    show(photoA);
    act(() => {
      spotViewer.getState().setCompare({
        mode: 'side',
        left: { capture: 'd2', i: 9 },
        right: { capture: 'd1', i: 0 },
        amount: 0.5,
      });
    });
    expect(
      q('frames-a')?.querySelector('[data-testid="spot-view"]')?.getAttribute('data-capture'),
    ).toBe('d2');
    expect(head()?.dataset.item).toBe('b');
  });

  it('leaves Compare when its left side cannot be resolved', () => {
    entries = [photoAt('u', [0, 1.6, 0], 0, { layer: 'photos-u', capture: undefined })];
    render();
    show({ kind: 'photo', layer: 'photos-u', photo: 'u' });
    act(() => {
      spotViewer.getState().setCompare({
        mode: 'side',
        left: { capture: 'd1', i: 0 },
        right: null,
        amount: 0.5,
      });
    });
    expect(q('spot-compare-view')).toBeNull();
    expect(spotViewer.getState().compare).toBeNull();
    expect(head()?.dataset.item).toBe('u');
  });

  it('a strip pick in Compare sets the left side', () => {
    render();
    show(photoA);
    press('c');
    click(q('spot-slot-d2'));
    expect(
      host.querySelector<HTMLSelectElement>('[data-testid="spot-compare-date-left"]')?.value,
    ).toBe('d2');
  });

  it('a photo without a position says so and has no strip', () => {
    render();
    show({ kind: 'photo', layer: 'photos-d2', photo: 'nogps' });
    expect(q('spot-no-position')?.textContent).toBe(
      "This photo has no position, so other dates can't be matched.",
    );
    expect(q('spot-strip')).toBeNull();
    press('Escape');
    expect(dialog()).toBeNull();
  });

  it('an undated item shows itself with no survey date', () => {
    entries = [
      photoAt('u', [0, 1.6, 0], 0, { layer: 'photos-u', capture: undefined }),
      ...photoEntries(),
    ];
    render();
    show({ kind: 'photo', layer: 'photos-u', photo: 'u' });
    expect(head()?.dataset.item).toBe('u');
    expect(head()?.textContent).toContain('No survey date');
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    press('ArrowRight');
    expect(head()?.dataset.capture).toBe('d1');
  });

  it('a project with one survey date shows the image and no strip', () => {
    open(manifest(['d1']));
    render();
    show(photoA);
    expect(q('spot-view')?.dataset.capture).toBe('d1');
    expect(q('spot-strip')).toBeNull();
  });

  it('closes when the project closes', () => {
    render();
    show(photoA);
    expect(dialog()).not.toBeNull();
    act(() => {
      workspace.getState().closeProject();
    });
    expect(dialog()).toBeNull();
    expect(spotViewer.getState().open).toBeNull();
  });

  it('a key on the swipe slider does not step dates; Esc from it keeps focus in the dialog', () => {
    render();
    show(photoA);
    press('c');
    click(q('spot-mode-swipe'));
    const slider = host.querySelector<HTMLElement>('[role="slider"]');
    act(() => slider?.focus());
    press('ArrowRight');
    expect(slider?.getAttribute('aria-valuenow')).toBe('55');
    expect(
      host.querySelector<HTMLSelectElement>('[data-testid="spot-compare-date-left"]')?.value,
    ).toBe('d1');
    press('Escape');
    expect(q('spot-compare-view')).toBeNull();
    expect(document.activeElement).toBe(dialog());
    press('Escape');
    expect(dialog()).toBeNull();
  });

  it('Tab stays inside the dialog', () => {
    render();
    show(photoA);
    const list = [
      ...(dialog()?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    const first = list[0];
    const last = list[list.length - 1];
    expect(list.length).toBeGreaterThan(1);
    act(() => last?.focus());
    press('Tab');
    expect(document.activeElement).toBe(first);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('links zoom and pan of two photos in Compare', () => {
    render();
    show(photoA);
    press('c');
    wheel(zoomBox('left'));
    expect(scales()).toEqual(['1.25', '1.25']);
    const r = zoomBox('right');
    pointer(r, 'pointerdown', 200, 150);
    pointer(r, 'pointermove', 280, 150);
    pointer(r, 'pointerup', 280, 150);
    const [lx, rx] = xs();
    expect(lx).not.toBe('0.000');
    expect(lx).toBe(rx);
    act(() => {
      zoomBox('right').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(scales()).toEqual(['1.00', '1.00']);

    click(q('spot-mode-swipe'));
    wheel(zoomBox('right'));
    expect(scales()).toEqual(['1.25', '1.25']);
    const pics = [...host.querySelectorAll<HTMLElement>('.spot-zoom-pic')];
    expect(pics).toHaveLength(2);
    expect(pics[0]?.style.transform).not.toBe('');
    expect(pics[0]?.style.transform).toBe(pics[1]?.style.transform);

    select('spot-compare-date-right', 'd1');
    expect(scales()).toEqual(['1.25', '1.25']);

    act(() => {
      zoomBox('left').focus();
    });
    press('ArrowRight');
    expect(
      host.querySelector<HTMLSelectElement>('[data-testid="spot-compare-date-left"]')?.value,
    ).toBe('d2');

    act(() => dialog()?.focus());
    press('Escape');
    expect(q('spot-compare-view')).toBeNull();
    press('c');
    expect(scales()).toEqual(['1.00', '1.00']);
  });

  it('a drag at fit is left to the swipe divider, a drag when zoomed pans', () => {
    render();
    show(photoA);
    press('c');
    click(q('spot-mode-swipe'));
    const divider = () => host.querySelector('[role="slider"]')?.getAttribute('aria-valuenow');
    pointer(zoomBox('left'), 'pointerdown', 100, 150);
    pointer(zoomBox('left'), 'pointerup', 100, 150);
    expect(divider()).toBe('25');
    wheel(zoomBox('left'));
    pointer(zoomBox('left'), 'pointerdown', 300, 150);
    pointer(zoomBox('left'), 'pointermove', 340, 150);
    expect(divider()).toBe('25');
    expect(q('spot-zoom-left')?.dataset.x).toBe(q('spot-zoom-right')?.dataset.x);
    expect(q('spot-zoom-left')?.dataset.x).not.toBe('0.000');
  });

  it('keeps the linked look for a 360 pair (no zoom box)', () => {
    entries = [panoAt('p1', [0, 1.6, 0], 'd1'), panoAt('p2', [2, 1.6, 0], 'd2')];
    render();
    show({ kind: 'pano', layer: 'pano-d1', pano: 'p1' });
    press('c');
    expect(q('spot-compare-view')).not.toBeNull();
    expect(host.querySelector('[data-testid^="spot-zoom-"]')).toBeNull();
  });
});

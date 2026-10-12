// @vitest-environment jsdom
import type { PanoLook } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { assetUrl, captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { panoLookLink } from './lookLink';
import { PanoPane } from './PanoPane';
import type { SplitPref } from './splitModel';
import { timeline } from './timeline';

interface FakeView {
  host: HTMLElement;
  images: { url: string | null; heading: number }[];
  looks: PanoLook[];
}
const views: FakeView[] = [];
vi.mock('./panoView', () => ({
  createPanoImageView: (host: HTMLElement, look: PanoLook) => {
    const v: FakeView = { host, images: [], looks: [look] };
    views.push(v);
    return {
      status: 'ready',
      setImage(url: string | null, heading: number) {
        v.images.push({ url, heading });
      },
      setLook(l: PanoLook) {
        v.looks.push(l);
      },
      dispose() {
        v.images.push({ url: 'disposed', heading: 0 });
      },
    };
  },
}));

const pano = (id: string, x: number, z: number, headingDeg = 0) => ({
  id,
  src: { path: `p/${id}.jpg` },
  pos: [x, 0, z] as [number, number, number],
  headingDeg,
});
const layer = (id: string, items: ReturnType<typeof pano>[], capture?: string) =>
  ({ kind: 'panoramas', id, name: id, visible: true, capture, items }) as unknown as Layer;

function manifest(o: { far?: boolean; undated?: boolean } = {}): ProjectManifest {
  const oct = [pano('a', 0, 0), pano('b', 10, 0, 30), pano('c', 20, 0)];
  if (o.far) oct.push(pano('h', 112, 0));
  return {
    ...threeDates,
    layers: [
      layer('p-oct', oct, 'oct'),
      layer('p-nov', [pano('d', 2, 0), pano('e', 11, 1, 200), pano('f', 60, 0)], 'nov'),
      ...(o.undated === false ? [] : [layer('p-any', [pano('g', 100, 100)])]),
    ],
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const open = (m: ProjectManifest) => {
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: m });
  timeline.getState().attach('p', captureIndex(m));
};
beforeEach(() => {
  localStorage.clear();
  views.length = 0;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  panoLookLink.getState().set({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 });
  host = document.createElement('div');
  document.body.append(host);
  open(manifest());
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
});

const sides = (pano?: string): SplitPref => ({
  left: 'pano',
  right: 'pano',
  leftCapture: 'oct',
  rightCapture: 'nov',
  ...(pano ? { pano } : {}),
});
type Props = Parameters<typeof PanoPane>[0];
const left = (p: Partial<Props> = {}): Props => ({
  side: 'left',
  capture: 'oct',
  otherCapture: 'nov',
  sides: sides('p-oct/b'),
  linked: true,
  onPick: () => undefined,
  ...p,
});
const right = (p: Partial<Props> = {}): Props => ({
  ...left(),
  side: 'right',
  capture: 'nov',
  otherCapture: 'oct',
  ...p,
});
const render = (...panes: Props[]) => {
  root ??= createRoot(host);
  act(() =>
    root?.render(
      <>
        {panes.map((p) => (
          <PanoPane key={p.side} {...p} />
        ))}
      </>,
    ),
  );
};
const panes = () => [...host.querySelectorAll<HTMLElement>('[data-testid="pane-pano"]')];
function only<T>(v: T | undefined | null, what = 'element'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}
const viewOf = (pane: HTMLElement) =>
  only(
    views.find((v) => pane.contains(v.host)),
    'view',
  );
const button = (pane: HTMLElement, label: string) =>
  only(pane.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`), label);

describe('PanoPane', () => {
  it('shows the left panorama, its place in the list and its image', () => {
    render(left());
    const pane = only(panes()[0]);
    expect(pane.textContent).toContain('b');
    expect(pane.textContent).toContain('2 of 4');
    expect(viewOf(pane).images.at(-1)).toEqual({
      url: assetUrl('p', { path: 'p/b.jpg' }),
      heading: 30,
    });
  });

  it('steps with the buttons and Page Down on the left', () => {
    const onPick = vi.fn();
    render(left({ onPick }));
    const pane = only(panes()[0]);
    act(() => {
      button(pane, 'Next panorama').click();
    });
    expect(onPick).toHaveBeenLastCalledWith('p-oct/c');
    act(() => {
      button(pane, 'Previous panorama').click();
    });
    expect(onPick).toHaveBeenLastCalledWith('p-oct/a');
    onPick.mockClear();
    const view = only(pane.querySelector<HTMLElement>('[role="img"]'));
    act(() => {
      view.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    });
    expect(onPick).toHaveBeenLastCalledWith('p-oct/c');
  });

  it('pairs the right side by position, without a stepper', () => {
    render(right());
    const pane = only(panes()[0]);
    expect(pane.textContent).toContain('e');
    expect(pane.textContent).toContain('1.4 m away');
    expect(pane.querySelector('button[aria-label="Next panorama"]')).toBeNull();
    expect(pane.dataset.pano).toBe('p-nov/e');
    expect(pane.dataset.capture).toBe('nov');
    expect(pane.dataset.distance).toBe('1.4');
    expect(pane.dataset.yaw).toBeDefined();
  });

  it('offers the nearest panorama when none is within reach', () => {
    open(manifest({ far: true }));
    render(right({ sides: sides('p-oct/h') }));
    const pane = only(panes()[0]);
    expect(pane.textContent).toContain('No panorama of 6 Nov 2024 within 25 m');
    const nearest = only(
      [...pane.querySelectorAll('button')].find((b) => b.textContent === 'Show the nearest (52 m)'),
      'show nearest',
    );
    act(() => {
      nearest.click();
    });
    expect(only(panes()[0]).dataset.pano).toBe('p-nov/f');
    expect(only(panes()[0]).textContent).toContain('52 m away');
  });

  it('says when its date has no panoramas', () => {
    open(manifest({ undated: false }));
    render(left({ capture: 'sep', sides: sides() }));
    expect(only(panes()[0]).textContent).toContain(
      'No panoramas on 4 Sep 2024. Pick another date above.',
    );
  });

  it('never pairs an undated panorama with itself', () => {
    const undated: ProjectManifest = {
      ...threeDates,
      layers: [layer('p-any', [pano('g', 100, 100), pano('k', 0, 0)])],
    };
    open(undated);
    render(left({ sides: sides('p-any/g') }), right({ sides: sides('p-any/g') }));
    const [l, r] = panes();
    expect(only(l).dataset.pano).toBe('p-any/g');
    expect(only(r).dataset.pano).toBe('');
    expect(only(r).textContent).toContain('No panoramas on 6 Nov 2024. Pick another date above.');
  });

  it('pairs an undated left panorama only with panoramas of the right date', () => {
    render(left({ sides: sides('p-any/g') }), right({ sides: sides('p-any/g') }));
    const r = only(panes()[1]);
    expect(r.dataset.pano).toBe('');
    expect(r.textContent).toContain('Show the nearest');
  });

  it('turns both views together when linked', () => {
    const set = vi.spyOn(panoLookLink.getState(), 'set');
    render(left(), right());
    const [l, r] = panes();
    const lv = only(only(l).querySelector<HTMLElement>('[role="img"]'));
    act(() => {
      lv.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      lv.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: -1, clientY: 0 }));
      lv.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(set).toHaveBeenCalled();
    const yaw = only(viewOf(only(l)).looks.at(-1)).yawDeg;
    expect(only(viewOf(only(r)).looks.at(-1)).yawDeg).toBeCloseTo(yaw);
    expect(only(r).dataset.yaw).toBe(only(l).dataset.yaw);
    set.mockRestore();
  });

  it('keeps the right view still when unlinked', () => {
    render(left({ linked: false }), right({ linked: false }));
    const [l, r] = panes();
    const before = only(viewOf(only(r)).looks.at(-1)).yawDeg;
    const lv = only(only(l).querySelector<HTMLElement>('[role="img"]'));
    act(() => {
      lv.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      lv.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: -5, clientY: 0 }));
      lv.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(only(viewOf(only(l)).looks.at(-1)).yawDeg).not.toBeCloseTo(before);
    expect(only(viewOf(only(r)).looks.at(-1)).yawDeg).toBeCloseTo(before);
  });

  it('puts a panorama selected elsewhere on the left', () => {
    const onPick = vi.fn();
    render(left({ onPick }));
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'e', layer: 'p-nov' });
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/e');
  });

  it('leads from the right when it is the only Panoramas pane', () => {
    const onPick = vi.fn();
    const only3d: SplitPref = { left: '3d', right: 'pano', rightCapture: 'nov', pano: 'p-nov/e' };
    render(right({ onPick, sides: only3d }));
    const pane = only(panes()[0]);
    expect(pane.dataset.pano).toBe('p-nov/e');
    expect(pane.textContent).toContain('2 of 4');
    expect(pane.dataset.distance).toBeUndefined();
    act(() => {
      button(pane, 'Next panorama').click();
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/f');
    onPick.mockClear();
    const view = only(pane.querySelector<HTMLElement>('[role="img"]'));
    act(() => {
      view.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/d');
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'f', layer: 'p-nov' });
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/f');
  });

  it('leads from the right when the left date has no panoramas', () => {
    const onPick = vi.fn();
    open(manifest({ undated: false }));
    render(
      left({ capture: 'sep', otherCapture: 'nov', sides: { ...sides(), leftCapture: 'sep' } }),
      right({ onPick, otherCapture: 'sep', sides: { ...sides(), leftCapture: 'sep' } }),
    );
    const r = only(panes()[1]);
    expect(r.dataset.pano).toBe('p-nov/d');
    expect(r.textContent).toContain('1 of 3');
    act(() => {
      button(r, 'Next panorama').click();
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/e');
  });

  it('moves to a panorama of another date selected while the left shows its own', () => {
    const onPick = vi.fn();
    render(left({ onPick }), right());
    expect(only(panes()[0]).dataset.capture).toBe('oct');
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'd', layer: 'p-nov' });
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/d');
  });

  it('ignores a selected panorama that is not in the project', () => {
    const onPick = vi.fn();
    render(left({ onPick }));
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'zz', layer: 'p-nov' });
    });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('ignores a panorama selected before it opened', () => {
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'e', layer: 'p-nov' });
    });
    const onPick = vi.fn();
    render(left({ onPick }));
    expect(onPick).not.toHaveBeenCalled();
    act(() => {
      workspace.getState().select({ kind: 'pano', id: 'd', layer: 'p-nov' });
    });
    expect(onPick).toHaveBeenLastCalledWith('p-nov/d');
  });

  it('keeps the spot when the left date changes', () => {
    const onPick = vi.fn();
    render(left({ onPick }));
    render(left({ onPick, capture: 'nov', otherCapture: 'oct' }));
    expect(onPick).toHaveBeenLastCalledWith('p-nov/e');
  });
});

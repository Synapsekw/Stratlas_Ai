// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { compareNotice } from './compare';
import { useStageCorners, type StageCornersInput } from './Stage';
import { timeline } from './timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const clip = {
  kind: 'video',
  id: 'c1',
  name: 'Clip c1',
  visible: true,
  src: { path: 'video/c1.mp4' },
  flight: { src: { path: 'flights/f1.json' }, startUtcMs: 1_700_000_000_000 },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs: 0,
} as Layer;
const manifest = {
  ...threeDates,
  layers: [...threeDates.layers, clip],
};

let host: HTMLDivElement;
let root: Root | undefined;

function Corners(p: Partial<StageCornersInput>) {
  const { corners, cursorHidden, cursorWide } = useStageCorners({
    engine: null,
    show3d: true,
    showMap: false,
    splitting: false,
    roadMeasure: false,
    video: [],
    cursor: 'br',
    ...p,
  });
  return (
    <div
      className="stage"
      data-cursor-hidden={cursorHidden ? '' : undefined}
      data-cursor-wide={cursorWide ? '' : undefined}
    >
      {corners}
    </div>
  );
}
function render(p: Partial<StageCornersInput> = {}) {
  act(() => {
    root ??= createRoot(host);
    root.render(<Corners {...p} />);
  });
}
/** Each slot and what stands in it. */
const slots = () =>
  [...host.querySelectorAll<HTMLElement>('.stage-slot')].map((s) => ({
    corner: s.dataset.slot,
    what: s.querySelector('[data-testid]')?.getAttribute('data-testid') ?? s.className,
  }));
const slotOf = (testId: string) =>
  host.querySelector(`[data-testid="${testId}"]`)?.closest<HTMLElement>('.stage-slot')?.dataset
    .slot;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest });
  timeline.getState().attach('p3', captureIndex(manifest));
  // every survey date's model on screen: the dates chip shows
  workspace.setState({ hidden: {} });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  compareNotice.getState().clear();
  volumetric.setState({ status: 'idle' });
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
});

describe('the stage corners', () => {
  it('shows no PAUSED or playing chip for the active clip: playback is the island live item', () => {
    workspace.getState().setActiveClip('c1');
    workspace.getState().pause();
    render({ video: ['bl'] });
    expect(host.textContent).not.toMatch(/paused|playing/i);
    act(() => {
      workspace.getState().play();
    });
    render({ video: ['bl'] });
    expect(host.textContent).not.toMatch(/paused|playing/i);
    workspace.getState().pause();
  });

  it('puts each overlay in a corner of its own', () => {
    compareNotice.getState().show('Comparing two dates');
    render({ video: ['bl'] });
    expect(slotOf('compare-notice')).toBe('tl');
    expect(slotOf('scene-map-button')).toBe('tr');
    // the dates find no free corner they want: the video, the notice and the chip took them
    expect(slotOf('dates-on-screen')).toBeUndefined();
    const corners = slots().map((s) => s.corner);
    expect(new Set(corners).size).toBe(corners.length);
  });

  it('gives the dates a corner when one is free, and moves out of the video corner', () => {
    render({ video: [] });
    expect(slotOf('dates-on-screen')).toBe('tl');
    render({ video: ['tl'] });
    expect(slotOf('dates-on-screen')).toBe('bl');
  });

  it('shows one Map menu chip on the stage, the map one while a map shows', () => {
    render({ show3d: true, showMap: true, splitting: true });
    expect(host.querySelectorAll('[data-testid="basemap-button"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="scene-map-button"]')).toHaveLength(0);
    render({ show3d: true, showMap: false });
    expect(host.querySelectorAll('[data-testid="scene-map-button"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="basemap-button"]')).toHaveLength(0);
  });

  it('keeps every corner a wide video window reaches out of the others', () => {
    // a 280 px window on a narrow stage takes both bottom corners
    render({ video: ['bl', 'br'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    expect(slotOf('dates-on-screen')).toBe('tl');
    expect(slotOf('scene-map-button')).toBe('tr');
    expect(slots().map((s) => s.corner)).not.toContain('bl');
  });

  it('lets the coordinates readout run across the foot while the other bottom corner is free', () => {
    render({ video: [] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(true);
    render({ video: ['bl'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(false);
  });

  it('gives the volumes hint a bottom corner of its own, never the readout one', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    render({ video: [] });
    expect(slotOf('vol-hint')).toBe('bl');
    // the readout keeps to its half: the other bottom corner is taken
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(false);
    render({ video: ['bl'] });
    expect(slotOf('vol-hint')).toBe('br');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    // a pile revealed: no hint
    act(() => {
      volumetric.setState({ shown: ['p1'] });
    });
    expect(slotOf('vol-hint')).toBeUndefined();
    // right to left the readout stands at bl: the hint takes br
    act(() => {
      volumetric.setState({ shown: [] });
    });
    render({ video: [], cursor: 'bl' });
    expect(slotOf('vol-hint')).toBe('br');
  });

  it('keeps the top corners free while the open island reaches past the middle', () => {
    render({ video: [], topTaken: true });
    expect(slots().map((s) => s.corner)).not.toContain('tl');
    expect(slots().map((s) => s.corner)).not.toContain('tr');
    // the dates and the Map menu chip go to the foot, the readout gives way
    expect(slotOf('dates-on-screen')).toBe('bl');
    expect(slotOf('scene-map-button')).toBe('br');
  });

  it('puts the Map menu chip at the map side of a split', () => {
    render({ show3d: true, showMap: true, splitting: true, basemapAt: ['tl', 'bl'] });
    expect(slotOf('basemap-button')).toBe('tl');
  });

  it('hides the coordinates readout when the video rests in its corner', () => {
    render({ video: ['br'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    render({ video: ['bl'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
  });
});

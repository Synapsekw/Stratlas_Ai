// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { captureIndex, workspace } from '@aio/workspace';
import { dismissToast, toast } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import type { CoverageGrids } from '../rf/coverageGrids';
import { rfLayer } from '../rf/coverageDisplay';
import { clearCoverage, coverage } from '../rf/coverageStore';
import { resetRf, rfStore } from '../rf/rfStore';
import { useCoverageLegendShown } from '../rf/StageCoverageLegend';
import { antennasFile, unit } from '../rf/__fixtures__/rfData';
import { shell } from '../shell';
import { antennaStore } from '../telecom/antennaStore';
import { compareNotice } from './compare';
import { basemapCorners, readoutCorner, useStageCorners, type StageCornersInput } from './Stage';
import { stagePrefs } from './stagePrefs';
import { timeline } from './timeline';
import { workbench } from './workbench/workbenchStore';

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
    rfLegend: false,
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
  clearCoverage();
  resetRf();
  rfLayer.setState({ visible: true });
  antennaStore.setState({ projectId: null, file: null, status: 'idle' });
  shell.setState({ stageMode: '3d' } as never);
  stagePrefs.setState({ byProject: {} });
});

/** The Coverage layer draws a live preview (the working copy has changes). */
function coverageShown() {
  rfStore.setState({ dirty: true, view: 'rsrp' });
  coverage.setState({
    preview: { key: 'p1', source: 'preview', sectorIds: [] } as unknown as CoverageGrids,
  });
}

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

  it('uses only the fixed slots: nothing at the top left, the Map menu and the dates top right', () => {
    compareNotice.getState().show('Comparing two dates');
    render({ video: [] });
    expect(slotOf('scene-map-button')).toBe('tr');
    expect(slotOf('dates-on-screen')).toBe('tr');
    expect(slotOf('compare-notice')).toBe('bl');
    expect(slots().map((s) => s.corner)).not.toContain('tl');
    // one box per corner, its overlays stacked in it
    const corners = slots().map((s) => s.corner);
    expect(new Set(corners).size).toBe(corners.length);
    const top = host.querySelector('.stage-slot[data-slot="tr"]');
    expect(top?.getAttribute('data-stage-slot')).toBe('top-right');
  });

  it('has no job progress card on the stage', () => {
    render({ video: [] });
    expect(host.querySelector('[data-testid="preparing-card"]')).toBeNull();
  });

  it('keeps the Show control top left only while the Volumes tab is open (board 1)', () => {
    volumetric.setState({ status: 'ready' });
    shell.setState({ rightCollapsed: false } as never);
    workbench.getState().show('selection');
    render();
    expect(slotOf('stage-show')).toBeUndefined();
    act(() => {
      workbench.getState().show('volumes');
    });
    expect(slotOf('stage-show')).toBe('tl');
    expect(slotOf('dates-on-screen')).toBe('tr');
    act(() => {
      shell.setState({ rightCollapsed: true } as never);
    });
    expect(slotOf('stage-show')).toBeUndefined();
    shell.setState({ rightCollapsed: false } as never);
    workbench.getState().show('selection');
  });

  it('shows one Map menu chip on the stage, the map one while a map shows', () => {
    render({ show3d: true, showMap: true, splitting: true });
    expect(host.querySelectorAll('[data-testid="basemap-button"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="scene-map-button"]')).toHaveLength(0);
    render({ show3d: true, showMap: false });
    expect(host.querySelectorAll('[data-testid="scene-map-button"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="basemap-button"]')).toHaveLength(0);
  });

  it('hides what stands in a corner a floating video takes, and nothing moves elsewhere', () => {
    compareNotice.getState().show('Comparing two dates');
    render({ video: ['bl'] });
    expect(slotOf('compare-notice')).toBeUndefined();
    expect(slotOf('dates-on-screen')).toBe('tr');
    render({ video: ['tr'] });
    expect(slotOf('dates-on-screen')).toBeUndefined();
    expect(slotOf('compare-notice')).toBe('bl');
    // a 280 px window on a narrow stage takes both bottom corners
    render({ video: ['bl', 'br'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    expect(slots().map((s) => s.corner)).not.toContain('bl');
  });

  it('lets the coordinates readout run across the foot while the other bottom corner is free', () => {
    render({ video: [] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(true);
    render({ video: ['bl'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(false);
  });

  it('puts the volumes hint at the bottom left, and the readout stays', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    render({ video: [] });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-wide')).toBe(false);
    // a pile revealed: no hint
    act(() => {
      volumetric.setState({ shown: ['p1'] });
    });
    expect(slotOf('vol-hint')).toBeUndefined();
    // right to left the readout stands at bl too: the hint stacks above it
    act(() => {
      volumetric.setState({ shown: [] });
    });
    render({ video: [], cursor: 'bl' });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(
      host.querySelector('.stage-slot[data-slot="bl"]')?.hasAttribute('data-over-readout'),
    ).toBe(true);
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
  });

  it('shows one hint or notice at a time at the bottom left, the newest', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    render({ video: [] });
    expect(slotOf('vol-hint')).toBe('bl');
    act(() => {
      compareNotice.getState().show('Comparing two dates');
    });
    // the notice came later: it shows, the hint waits
    expect(slotOf('compare-notice')).toBe('bl');
    expect(slotOf('vol-hint')).toBeUndefined();
    act(() => {
      compareNotice.getState().clear();
    });
    expect(slotOf('vol-hint')).toBe('bl');
  });

  it('shares the bottom left between a hint and a toast, the newest first', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    render({ video: [] });
    const host0 = () => host.querySelector<HTMLElement>('[data-testid="toast-host-stage"]');
    expect(host0()?.closest<HTMLElement>('.stage-slot')?.dataset.slot).toBe('bl');
    act(() => {
      toast('Saved', { id: 'w10-toast', testId: 'w10-toast' });
    });
    // the toast came later: it shows, the hint waits
    expect(slotOf('w10-toast')).toBe('bl');
    expect(slotOf('vol-hint')).toBeUndefined();
    act(() => {
      dismissToast('w10-toast');
    });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(host0()?.hasAttribute('data-held')).toBe(true);
    // a hint that comes after the toast holds it back; the toast waits, then shows
    act(() => {
      volumetric.setState({ shown: ['p1'] });
      toast('Saved', { id: 'w10-toast', testId: 'w10-toast' });
    });
    expect(slotOf('w10-toast')).toBe('bl');
    act(() => {
      volumetric.setState({ shown: [] });
    });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(host.querySelector('[data-testid="w10-toast"]')).toBeNull();
    act(() => {
      volumetric.setState({ shown: ['p1'] });
    });
    expect(slotOf('w10-toast')).toBe('bl');
    act(() => {
      dismissToast('w10-toast');
    });
  });

  it('keeps the stage toast host out of a corner the floating video takes', () => {
    render({ video: ['bl'] });
    expect(host.querySelector('[data-testid="toast-host-stage"]')).toBeNull();
  });

  it('keeps the top right free while the open island reaches across it', () => {
    render({ video: [], topTaken: ['tl', 'tr'] });
    expect(slots().map((s) => s.corner)).not.toContain('tr');
    expect(slotOf('dates-on-screen')).toBeUndefined();
    render({ video: [], topTaken: ['tl'] });
    expect(slotOf('scene-map-button')).toBe('tr');
    expect(slotOf('dates-on-screen')).toBe('tr');
  });

  it('puts the Map menu chip at the map side of a split', () => {
    render({ show3d: true, showMap: true, splitting: true, basemapAt: ['tl', 'bl'] });
    expect(slotOf('basemap-button')).toBe('tl');
  });

  it('stacks the legends at the bottom right, above the readout, clear of the hint', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    coverageShown();
    render({ video: [], rfLegend: true });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(slotOf('rf-legend')).toBe('br');
    expect(
      host.querySelector('.stage-slot[data-slot="br"]')?.hasAttribute('data-over-readout'),
    ).toBe(true);
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    render({ video: [], rfLegend: false });
    expect(slotOf('rf-legend')).toBeUndefined();
    // a video resting at br hides the legends there with the readout
    render({ video: ['br'], rfLegend: true });
    expect(slotOf('rf-legend')).toBeUndefined();
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
  });

  it('gives the Coverage card the legend slot once antennas exist, before any run (1100 px)', () => {
    function Live() {
      return <Corners rfLegend={useCoverageLegendShown()} />;
    }
    act(() => {
      root ??= createRoot(host);
      root.render(<Live />);
    });
    expect(slotOf('rf-chip')).toBeUndefined();
    act(() => {
      // no floating video on the stage (the fixture's clip would float)
      workspace.getState().setActiveClip(null);
      rfStore.setState({ projectId: 'p3' });
      antennaStore.setState({
        projectId: 'p3',
        status: 'ready',
        file: antennasFile([unit('ant-a', 0), unit('ant-b', 120), unit('ant-c', 240)]),
      });
    });
    expect(host.querySelector('[data-testid="rf-card"] [data-testid="rf-chip"]')).not.toBeNull();
    expect(slotOf('rf-chip')).toBe('br');
    expect(slotOf('dates-on-screen')).toBe('tr');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    // a run drawn: the chip heads the legend in the same slot
    act(() => {
      coverageShown();
    });
    expect(slotOf('rf-legend')).toBe('br');
    expect(host.querySelector('[data-testid="rf-legend"] [data-testid="rf-chip"]')).not.toBeNull();
    // no antennas and nothing drawn: no card
    act(() => {
      antennaStore.setState({ file: null });
      clearCoverage();
      rfStore.setState({ dirty: false });
    });
    expect(slotOf('rf-chip')).toBeUndefined();
    expect(host.querySelector('[data-testid="rf-card"]')).toBeNull();
  });

  it('claims no slot for the Coverage card while two dates are compared', () => {
    function Live(p: Partial<StageCornersInput>) {
      return <Corners {...p} rfLegend={useCoverageLegendShown()} />;
    }
    act(() => {
      workspace.getState().setActiveClip(null);
      rfStore.setState({ projectId: 'p3' });
      antennaStore.setState({
        projectId: 'p3',
        status: 'ready',
        file: antennasFile([unit('ant-a', 0), unit('ant-b', 120), unit('ant-c', 240)]),
      });
    });
    const ids = captureIndex(manifest).captures.map((c) => c.id);
    act(() => {
      stagePrefs.getState().update('p3', {
        split: {
          left: 'map',
          right: 'map',
          leftCapture: ids[0] ?? '',
          rightCapture: ids.at(-1) ?? '',
        },
      });
      shell.setState({ stageMode: 'split' } as never);
    });
    act(() => {
      root ??= createRoot(host);
      root.render(<Live splitting show3d={false} showMap cursor={null} />);
    });
    expect(slotOf('rf-chip')).toBeUndefined();
    act(() => {
      coverageShown();
    });
    expect(host.querySelector('[data-testid="rf-legend"]')).toBeNull();
    act(() => {
      stagePrefs.getState().update('p3', { split: { left: '3d', right: 'map' } });
    });
    expect(slotOf('rf-legend')).toBeDefined();
  });

  it('hides the coordinates readout when the video rests in its corner', () => {
    render({ video: ['br'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    render({ video: ['bl'] });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
  });
});

describe('readoutCorner', () => {
  it('is the foot of the end, or in a split the quarter of the 3D side', () => {
    expect(readoutCorner(true, undefined, false)).toBe('br');
    expect(readoutCorner(true, 'right', false)).toBe('br');
    expect(readoutCorner(true, 'left', false)).toBe('bl');
    // right to left the corners are logical; the panes keep left to right
    expect(readoutCorner(true, undefined, true)).toBe('bl');
    expect(readoutCorner(true, 'left', true)).toBe('br');
    expect(readoutCorner(false, 'left', false)).toBeNull();
  });
});

describe('basemapCorners', () => {
  it('keeps the Map menu chip over the pane whose view it serves, never over a 360 pane', () => {
    // no split: the end of the stage
    expect(basemapCorners('map', undefined, undefined, false, false)).toEqual(['tr', 'br']);
    // the map on the left of a split (a 360 pane on the right)
    expect(basemapCorners('map', 'left', undefined, true, false)).toEqual(['tl', 'bl']);
    // the 3D view on the left, a 360 pane on the right: the scene's chip goes left too
    expect(basemapCorners('scene', undefined, 'left', true, false)).toEqual(['tl', 'bl']);
    expect(basemapCorners('scene', undefined, 'right', true, false)).toEqual(['tr', 'br']);
    // right to left the corners are logical; the panes keep left to right
    expect(basemapCorners('scene', undefined, 'left', true, true)).toEqual(['tr', 'br']);
    // 3D left, map right: the chip is the map's
    expect(basemapCorners('map', 'right', 'left', true, false)).toEqual(['tr', 'br']);
  });
});

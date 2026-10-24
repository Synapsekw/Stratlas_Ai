// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('in a split, gives the volumes hint the foot of the 3D pane, never the other pane', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    // the 3D view on the left, the map on the right: the hint over the 3D pane's foot, and the
    // readout gives way while it shows (the map's foot has its own scale and credits)
    render({ video: [], splitting: true, showMap: true, cursor: 'bl' });
    expect(slotOf('vol-hint')).toBe('bl');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    // the 3D view on the right
    render({ video: [], splitting: true, showMap: true, cursor: 'br' });
    expect(slotOf('vol-hint')).toBe('br');
  });

  it('leaves the readout shown beside the hint when the 3D view is on the left of a wide split', () => {
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    render({ video: [], splitting: true, showMap: true, cursor: 'bl', readoutClear: true });
    // the hint still takes the 3D pane's foot; the readout beside the divider stays
    expect(slotOf('vol-hint')).toBe('bl');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    // the clip resting in that corner still hides it
    render({ video: ['bl'], splitting: true, showMap: true, cursor: 'bl', readoutClear: true });
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
  });

  it('keeps the top corners free while the open island reaches past the middle', () => {
    render({ video: [], topTaken: ['tl', 'tr'] });
    expect(slots().map((s) => s.corner)).not.toContain('tl');
    expect(slots().map((s) => s.corner)).not.toContain('tr');
    // the dates and the Map menu chip go to the foot, the readout gives way
    expect(slotOf('dates-on-screen')).toBe('bl');
    expect(slotOf('scene-map-button')).toBe('br');
  });

  it('keeps only the top corner the open island reaches across', () => {
    render({ video: [], topTaken: ['tl'] });
    expect(slots().map((s) => s.corner)).not.toContain('tl');
    // the Map menu chip keeps its corner; the dates go to the foot
    expect(slotOf('scene-map-button')).toBe('tr');
    expect(slotOf('dates-on-screen')).toBe('bl');
  });

  it('puts the Map menu chip at the map side of a split', () => {
    render({ show3d: true, showMap: true, splitting: true, basemapAt: ['tl', 'bl'] });
    expect(slotOf('basemap-button')).toBe('tl');
  });

  it('gives the coverage legend and the volumes hint bottom corners of their own (1100 px)', () => {
    // the CI window, 1100 px wide: no video, the readout at the foot of the end
    volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
    coverageShown();
    render({ video: [], rfLegend: true });
    // the hint is served first and takes bl, away from the readout; the legend takes br
    expect(slotOf('vol-hint')).toBe('bl');
    expect(slotOf('rf-legend')).toBe('br');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
    // right to left the readout stands at bl: the hint takes br, the legend bl
    render({ video: [], rfLegend: true, cursor: 'bl' });
    expect(slotOf('vol-hint')).toBe('br');
    expect(slotOf('rf-legend')).toBe('bl');
    const corners = slots().map((s) => s.corner);
    expect(new Set(corners).size).toBe(corners.length);
  });

  it('puts the coverage legend at the foot of the start, clear of the readout, and none while off', () => {
    coverageShown();
    render({ video: [], rfLegend: false });
    expect(slotOf('rf-legend')).toBeUndefined();
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    // on: bl, the wider corner at 1100 px, and the readout at br stays shown
    render({ video: [], rfLegend: true });
    expect(slotOf('rf-legend')).toBe('bl');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    // a video resting at bl sends it to br, where the readout gives way
    render({ video: ['bl'], rfLegend: true });
    expect(slotOf('rf-legend')).toBe('br');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(true);
  });

  it('right to left with no volumes hint, gives the legend and the readout different corners', () => {
    coverageShown();
    // the readout stands at bl right to left: the legend takes br and the readout stays shown
    render({ video: [], rfLegend: true, cursor: 'bl' });
    expect(slotOf('rf-legend')).toBe('br');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    // a split with the 3D view on the left puts the readout at bl too: the legend at br
    render({ video: [], rfLegend: true, cursor: 'bl', splitting: true, showMap: true });
    expect(slotOf('rf-legend')).toBe('br');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
  });

  it('gives the Coverage card the legend corner once antennas exist, before any run (1100 px)', () => {
    // the CI window: no run, nothing drawn; the RF side decides the corner, as Stage.tsx asks it
    function Live() {
      return <Corners rfLegend={useCoverageLegendShown()} />;
    }
    const live = () => {
      act(() => {
        root ??= createRoot(host);
        root.render(<Live />);
      });
    };
    live();
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
    // the chip heads a card of its own in the foot corner at the start, clear of the readout at
    // the end (shown), and of the dates and the Map menu chip at the top
    expect(host.querySelector('[data-testid="rf-card"] [data-testid="rf-chip"]')).not.toBeNull();
    expect(slotOf('rf-chip')).toBe('bl');
    expect(slotOf('dates-on-screen')).toBe('tl');
    expect(slotOf('scene-map-button')).toBe('tr');
    expect(host.querySelector('.stage')?.hasAttribute('data-cursor-hidden')).toBe(false);
    const corners = slots().map((x) => x.corner);
    expect(new Set(corners).size).toBe(corners.length);
    // a run drawn: the chip heads the legend in the same corner
    act(() => {
      volumetric.setState({ status: 'idle' });
      coverageShown();
    });
    expect(slotOf('rf-legend')).toBe('bl');
    expect(host.querySelector('[data-testid="rf-legend"] [data-testid="rf-chip"]')).not.toBeNull();
    // no antennas and nothing drawn: no card, no corner
    act(() => {
      antennaStore.setState({ file: null });
      clearCoverage();
      rfStore.setState({ dirty: false });
    });
    expect(slotOf('rf-chip')).toBeUndefined();
    expect(host.querySelector('[data-testid="rf-card"]')).toBeNull();
  });

  describe('the Coverage card before a run (only the chip prompt)', () => {
    function Live(p: Partial<StageCornersInput>) {
      return <Corners {...p} rfLegend={useCoverageLegendShown()} />;
    }
    const live = (p: Partial<StageCornersInput> = {}) => {
      act(() => {
        root ??= createRoot(host);
        root.render(<Live {...p} />);
      });
    };
    const withAntennas = () => {
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
    };
    const cursorHidden = () => host.querySelector('.stage')?.hasAttribute('data-cursor-hidden');

    it('gives way to the dates: a status overlay at tl and the Map menu chip at tr', () => {
      compareNotice.getState().show('Comparing two dates');
      withAntennas();
      live();
      expect(slotOf('compare-notice')).toBe('tl');
      expect(slotOf('scene-map-button')).toBe('tr');
      // the card would take bl, the dates' last free corner: it stays off the stage
      expect(slotOf('dates-on-screen')).toBe('bl');
      expect(slotOf('rf-chip')).toBeUndefined();
    });

    it('gives way to the readout: the 3D view with the volumes hint up', () => {
      volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
      withAntennas();
      live();
      expect(slotOf('vol-hint')).toBe('bl');
      expect(slotOf('rf-chip')).toBeUndefined();
      expect(cursorHidden()).toBe(false);
    });

    it('gives way to a floating video, and shows again once it is docked', () => {
      withAntennas();
      act(() => {
        workspace.getState().setActiveClip('c1');
      });
      live({ video: ['bl'] });
      expect(slotOf('rf-chip')).toBeUndefined();
      expect(cursorHidden()).toBe(false);
      act(() => {
        shell.setState({ videoDocked: true } as never);
      });
      live();
      expect(slotOf('rf-chip')).toBe('bl');
      act(() => {
        shell.setState({ videoDocked: false } as never);
      });
    });

    it('after a run keeps the legend before the dates and the readout', () => {
      withAntennas();
      act(() => {
        coverageShown();
        volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
      });
      live();
      expect(slotOf('vol-hint')).toBe('bl');
      expect(slotOf('rf-legend')).toBe('br');
      expect(cursorHidden()).toBe(true);
      act(() => {
        volumetric.setState({ status: 'idle' });
        compareNotice.getState().show('Comparing two dates');
      });
      expect(slotOf('compare-notice')).toBe('tl');
      expect(slotOf('rf-legend')).toBe('bl');
      expect(slotOf('dates-on-screen')).toBeUndefined();
    });

    it('gives way to the readout in a map|3D split with a status chip up', () => {
      withAntennas();
      act(() => {
        stagePrefs.getState().update('p3', { split: { left: 'map', right: '3d' } });
        shell.setState({ stageMode: 'split' } as never);
        compareNotice.getState().show('Comparing two dates');
      });
      // the map on the start side: the Map menu chip takes the start corners, the status tl
      live({ splitting: true, showMap: true, cursor: 'br', basemapAt: ['tl', 'bl'] });
      expect(slotOf('compare-notice')).toBe('tl');
      expect(slotOf('rf-chip')).toBeUndefined();
      expect(cursorHidden()).toBe(false);
    });

    it('reads the split as the stage draws it: a side it cannot show falls back to 3D', () => {
      volumetric.setState({ status: 'ready', surface: 'photo', selected: null, shown: [] });
      withAntennas();
      act(() => {
        // no report in the project: the stage shows the 3D view on the left instead
        stagePrefs.getState().update('p3', { split: { left: 'report', right: 'map' } });
        shell.setState({ stageMode: 'split' } as never);
      });
      live({ splitting: true, showMap: true, cursor: 'bl' });
      expect(slotOf('rf-chip')).toBeUndefined();
    });

    it('a video shown as a split pane does not float: the card keeps its corner', () => {
      withAntennas();
      act(() => {
        workspace.getState().setActiveClip('c1');
        stagePrefs.getState().update('p3', { split: { left: 'video', right: '3d' } });
        shell.setState({ stageMode: 'split' } as never);
      });
      live({ splitting: true, cursor: 'br' });
      expect(slotOf('rf-chip')).toBe('bl');
      expect(cursorHidden()).toBe(false);
    });

    describe("beside a selected antenna's card (telecom/AntennaCard)", () => {
      /** Where the antenna card stands (viewport px); null: not on the page. */
      let antennaAt: DOMRect | null = null;
      /** The coverage card at the stage's foot, start side (the bl slot of a 1100 x 720 window). */
      const CARD = new DOMRect(12, 560, 190, 120);
      const OVER = new DOMRect(40, 430, 320, 200);
      const AWAY = new DOMRect(500, 80, 320, 200);
      let antennaCard: HTMLElement;
      /** Where the coverage card stands now (a resize may move its corner). */
      let cardAt = CARD;
      const frames = () =>
        act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      beforeEach(() => {
        antennaAt = null;
        cardAt = CARD;
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
          this: Element,
        ) {
          const id = this.getAttribute('data-testid');
          if (id === 'rf-card' || id === 'rf-legend') return cardAt;
          if (id === 'antenna-card' && antennaAt) return antennaAt;
          return new DOMRect(0, 0, 0, 0);
        });
        antennaCard = document.createElement('div');
        antennaCard.dataset.testid = 'antenna-card';
        document.body.append(antennaCard);
        // the inventory drawn in the 3D view on screen: a cloud in the project
        const cloud = {
          kind: 'pointcloud',
          id: 'tower-cloud',
          name: 'Tower cloud',
          visible: true,
          format: 'png-packed',
          src: { path: 'cloud/index.json' },
        } as Layer;
        act(() => {
          workspace.getState().openProject({
            id: 'p3',
            root: '/p3',
            manifest: { ...manifest, layers: [...manifest.layers, cloud] },
          });
          shell.setState({ screen: 'scene', stageMode: '3d', pkg: null } as never);
        });
      });
      afterEach(() => {
        antennaCard.remove();
        antennaStore.setState({ selected: null });
        vi.restoreAllMocks();
      });
      const select = (id: string | null) => {
        act(() => {
          antennaStore.setState({ selected: id });
        });
      };

      it('before a run the prompt gives its corner up while the card is over it', async () => {
        withAntennas();
        live();
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
        // a unit selected, its card clear of the prompt: the prompt stays
        antennaAt = AWAY;
        select('ant-a');
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
        // the card over the prompt: the prompt yields, the dates and the readout keep theirs
        antennaAt = OVER;
        await frames();
        expect(slotOf('rf-chip')).toBeUndefined();
        expect(slotOf('dates-on-screen')).toBe('tl');
        expect(cursorHidden()).toBe(false);
        // the card moves off where the prompt stood: it comes back
        antennaAt = AWAY;
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
        // and when the card closes over it
        antennaAt = OVER;
        await frames();
        expect(slotOf('rf-chip')).toBeUndefined();
        select(null);
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
      });

      it('a resize while the prompt is aside forgets where it stood', async () => {
        withAntennas();
        live();
        await frames();
        antennaAt = OVER;
        select('ant-a');
        await frames();
        expect(slotOf('rf-chip')).toBeUndefined();
        // the window grows: the corner moves clear of the card, the old box would keep it aside
        cardAt = new DOMRect(12, 760, 190, 120);
        await frames();
        expect(slotOf('rf-chip')).toBeUndefined();
        act(() => {
          window.dispatchEvent(new Event('resize'));
        });
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
        await frames();
        expect(slotOf('rf-chip')).toBe('bl');
      });

      it('after a run the legend keeps its corner and steps aside in place under the card', async () => {
        withAntennas();
        act(() => {
          coverageShown();
        });
        live();
        await frames();
        const legend = () => host.querySelector<HTMLElement>('[data-testid="rf-legend"]');
        expect(slotOf('rf-legend')).toBe('bl');
        antennaAt = OVER;
        select('ant-a');
        await frames();
        // the corner is kept (the readout and the dates do not move), the legend hidden in it
        expect(slotOf('rf-legend')).toBe('bl');
        expect(legend()?.hasAttribute('data-covered')).toBe(true);
        expect(legend()?.hasAttribute('inert')).toBe(true);
        antennaAt = AWAY;
        await frames();
        expect(legend()?.hasAttribute('data-covered')).toBe(false);
        expect(legend()?.hasAttribute('inert')).toBe(false);
        antennaAt = OVER;
        await frames();
        expect(legend()?.hasAttribute('data-covered')).toBe(true);
        // in the map the antenna card is not up: the legend shows
        act(() => {
          shell.setState({ stageMode: 'map' } as never);
        });
        await frames();
        expect(legend()?.hasAttribute('data-covered')).toBe(false);
      });
    });

    it('claims no corner while two dates are compared, before or after a run', () => {
      withAntennas();
      const ids = captureIndex(manifest).captures.map((c) => c.id);
      const first = ids[0] ?? '';
      const last = ids.at(-1) ?? '';
      act(() => {
        stagePrefs.getState().update('p3', {
          split: { left: 'map', right: 'map', leftCapture: first, rightCapture: last },
        });
        shell.setState({ stageMode: 'split' } as never);
      });
      live({ splitting: true, show3d: false, showMap: true, cursor: null });
      expect(slotOf('rf-chip')).toBeUndefined();
      act(() => {
        coverageShown();
      });
      expect(slotOf('rf-legend')).toBeUndefined();
      expect(host.querySelector('[data-testid="rf-legend"]')).toBeNull();
      // a split that does not compare dates keeps the legend
      act(() => {
        stagePrefs.getState().update('p3', { split: { left: '3d', right: 'map' } });
      });
      expect(slotOf('rf-legend')).toBeDefined();
    });
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

// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareStore } from '../survey/compareStore';
import { shell } from '../shell';
import { workbench } from './workbench/workbenchStore';
import { threeDates } from './__fixtures__/threeDates';
import { rasterSwap, SHOW_BOX, StageShow, stageShow, useStageShowShown } from './StageShow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const render = (node: React.ReactNode = <StageShow />) => {
  root ??= createRoot(host);
  act(() => root?.render(node));
};
const group = (label: string) =>
  host.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name);
const click = (el: Element | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const raster = (id: string, role: 'ortho' | 'dsm', capture: string): Layer => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  capture,
  role,
  format: 'cog',
  src: { path: `rasters/${id}.tif` },
});

const surveyManifest = {
  ...threeDates,
  layers: [
    ...threeDates.layers,
    raster('ortho-oct', 'ortho', 'oct'),
    raster('dsm-oct', 'dsm', 'oct'),
    raster('ortho-nov', 'ortho', 'nov'),
    raster('dsm-nov', 'dsm', 'nov'),
  ],
} as ProjectManifest;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  stageShow.getState().reset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle', file: null, surface: 'photo', swipe: false, change: null });
  workspace.getState().closeProject();
  compareStore.setState({ heat: { show3d: true, show2d: true, contours: false, item: null } });
});

describe('the Show control (board 1)', () => {
  it('is a group named Show with the captions from the catalogue', () => {
    render();
    const g = group('Show');
    expect(g).not.toBeNull();
    expect(g?.textContent).toContain('Show');
    expect(button('Photo')).toBeDefined();
    expect(button('Elevation')).toBeDefined();
    expect(button('Cut & fill')).toBeDefined();
    expect(button('Outlines')).toBeDefined();
    expect(button('Labels')).toBeDefined();
  });

  it('switches Photo, Elevation and Cut & fill on the stockpile kit', () => {
    volumetric.setState({
      status: 'ready',
      epoch: 'e2',
      surface: 'photo',
      swipe: true,
      change: null,
      changeGrid: null,
      file: {
        captures: [
          { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
          { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
        ],
      } as never,
    });
    render();
    expect(button('Photo')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Elevation'));
    expect(volumetric.getState().surface).toBe('elev');
    // a surface choice ends the swipe
    expect(volumetric.getState().swipe).toBe(false);
    expect(button('Elevation')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Cut & fill'));
    expect(volumetric.getState().surface).toBe('change');
    expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
    click(button('Photo'));
    expect(volumetric.getState().surface).toBe('photo');
  });

  it('keeps Cut & fill off on the kit with one survey date', () => {
    volumetric.setState({
      status: 'ready',
      epoch: 'e1',
      surface: 'photo',
      file: {
        captures: [{ epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' }],
      } as never,
    });
    render();
    expect(button('Cut & fill')?.disabled).toBe(true);
  });

  it('switches the rasters and the heat map in a survey project', () => {
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
    workspace.getState().setLayersVisible(['dsm-oct', 'dsm-nov'], false);
    render();
    click(button('Elevation'));
    const hidden = () => workspace.getState().hidden;
    expect(hidden()['ortho-oct']).toBe(true);
    expect(hidden()['dsm-oct']).toBeUndefined();
    expect(compareStore.getState().heat.show3d).toBe(false);
    expect(button('Elevation')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Cut & fill'));
    expect(compareStore.getState().heat).toMatchObject({ show3d: true, show2d: true });
    expect(button('Cut & fill')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Photo'));
    expect(hidden()['ortho-oct']).toBeUndefined();
    expect(hidden()['dsm-oct']).toBe(true);
    expect(compareStore.getState().heat).toMatchObject({ show3d: false, show2d: false });
  });

  it('keeps Elevation off in a survey project without a surface raster', () => {
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
    render();
    expect(button('Elevation')?.disabled).toBe(true);
  });

  it('toggles Outlines and Labels on their own', () => {
    render();
    expect(button('Outlines')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Labels')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Outlines'));
    expect(stageShow.getState().outlines).toBe(false);
    expect(stageShow.getState().labels).toBe(true);
    click(button('Labels'));
    expect(stageShow.getState().labels).toBe(false);
    expect(button('Labels')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('on the Materials pane reads "Colour piles by" Material, Change, None', () => {
    act(() => {
      stageShow.getState().setPane('materials');
    });
    render();
    expect(group('Show')).toBeNull();
    const g = group('Colour piles by');
    expect(g?.textContent).toContain('Colour piles by');
    expect(button('Material')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Change'));
    expect(stageShow.getState().colourBy).toBe('change');
    click(button('None'));
    expect(stageShow.getState().colourBy).toBe('none');
  });

  it('does not cover the view: it keeps to a corner box at most 260 x 80 px', () => {
    render();
    expect(SHOW_BOX.width).toBeLessThanOrEqual(260);
    expect(SHOW_BOX.height).toBeLessThanOrEqual(80);
    const box = host.querySelector<HTMLElement>('.stage-show');
    expect(box?.style.maxInlineSize).toBe(`${String(SHOW_BOX.width)}px`);
    expect(box?.style.maxBlockSize).toBe(`${String(SHOW_BOX.height)}px`);
  });
});

describe('when the Show control shows', () => {
  function Probe() {
    return <span data-shown={String(useStageShowShown())} />;
  }
  const shown = () => host.querySelector('span')?.getAttribute('data-shown');

  it('only while the Volumes tab is open in front', () => {
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
    volumetric.setState({ status: 'ready' });
    shell.setState({ rightCollapsed: false });
    workbench.getState().show('selection');
    render(<Probe />);
    expect(shown()).toBe('false');
    act(() => {
      workbench.getState().show('volumes');
    });
    expect(shown()).toBe('true');
    act(() => {
      shell.setState({ rightCollapsed: true });
    });
    expect(shown()).toBe('false');
    shell.setState({ rightCollapsed: false });
  });
});

describe('rasterSwap', () => {
  const of = { 'ortho-oct': 'oct', 'dsm-oct': 'oct', 'ortho-nov': 'nov', 'dsm-nov': 'nov' };

  it('swaps each shown ortho for its date surface for Elevation', () => {
    const r = rasterSwap(
      surveyManifest.layers,
      of,
      { 'dsm-oct': true, 'dsm-nov': true, 'ortho-nov': true },
      'elev',
    );
    expect(r).toEqual({ show: ['dsm-oct'], hide: ['ortho-oct'] });
  });

  it('swaps back for Photo, and does nothing with nothing to swap', () => {
    expect(
      rasterSwap(surveyManifest.layers, of, { 'ortho-oct': true, 'ortho-nov': true }, 'photo'),
    ).toEqual({
      show: ['ortho-oct', 'ortho-nov'],
      hide: ['dsm-oct', 'dsm-nov'],
    });
    expect(rasterSwap(threeDates.layers, {}, {}, 'elev')).toEqual({ show: [], hide: [] });
  });
});

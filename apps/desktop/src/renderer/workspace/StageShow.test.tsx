// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareStore } from '../survey/compareStore';
import { shell } from '../shell';
import { workbench } from './workbench/workbenchStore';
import { threeDates } from './__fixtures__/threeDates';
import { stagePrefs } from './stagePrefs';
import { rasterSwap, StageShow, stageShow, useStageShowActive } from './StageShow';

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
  shell.setState({ stageMode: '3d' });
  stagePrefs.getState().update('p', { split: undefined });
  clearToasts();
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

  it('keeps Elevation off in a survey project without a surface raster, and says why', () => {
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
    render();
    // greyed, still focusable to read why (the app's tip and description, never a native title)
    const elevation = button('Elevation');
    expect(elevation?.getAttribute('aria-disabled')).toBe('true');
    expect(elevation?.disabled).toBe(false);
    expect(elevation?.hasAttribute('title')).toBe(false);
    const why = elevation?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(why)?.textContent).toBe(
      'This project has no height map to show',
    );
    // a press does nothing
    click(elevation);
    expect(stageShow.getState().surface).toBe('photo');
    expect(elevation?.getAttribute('aria-pressed')).toBe('false');
    // Photo is on: it has no reason to give
    expect(button('Photo')?.hasAttribute('aria-disabled')).toBe(false);
    expect(button('Photo')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows the reason as the tip of the greyed Elevation on keyboard focus', () => {
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
    render();
    const elevation = button('Elevation');
    vi.useFakeTimers();
    try {
      act(() => {
        elevation?.focus();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'This project has no height map to show',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives Elevation no reason in a survey project that has a surface raster', () => {
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
    render();
    expect(button('Elevation')?.disabled).toBe(false);
    expect(button('Elevation')?.hasAttribute('aria-disabled')).toBe(false);
    expect(button('Elevation')?.hasAttribute('aria-describedby')).toBe(false);
  });

  describe('Elevation on the stockpile kit, whose colours are draped in 3D only', () => {
    const NOTICE = 'Elevation colours show in 3D';
    const notices = () => toastQueue().map((x) => x.message);
    const kit = () => {
      volumetric.setState({
        status: 'ready',
        epoch: 'e1',
        surface: 'photo',
        file: {
          captures: [{ epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' }],
        } as never,
      });
    };

    it('in Map view switches the stage to 3D and says so', () => {
      kit();
      shell.setState({ stageMode: 'map' });
      render();
      click(button('Elevation'));
      expect(volumetric.getState().surface).toBe('elev');
      expect(shell.getState().stageMode).toBe('3d');
      expect(notices()).toEqual([NOTICE]);
    });

    it('in 3D view changes nothing but the surface', () => {
      kit();
      render();
      click(button('Elevation'));
      expect(volumetric.getState().surface).toBe('elev');
      expect(shell.getState().stageMode).toBe('3d');
      expect(notices()).toEqual([]);
    });

    it('in Split with a 3D side keeps the split and says nothing', () => {
      kit();
      workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
      stagePrefs.getState().update('p', { split: { left: '3d', right: 'map' } });
      shell.setState({ stageMode: 'split' });
      render();
      click(button('Elevation'));
      expect(shell.getState().stageMode).toBe('split');
      expect(notices()).toEqual([]);
    });

    it('in Split without a 3D side keeps the split and says where the colours show', () => {
      kit();
      workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
      stagePrefs.getState().update('p', { split: { left: 'map', right: 'raster' } });
      shell.setState({ stageMode: 'split' });
      render();
      click(button('Elevation'));
      expect(volumetric.getState().surface).toBe('elev');
      expect(shell.getState().stageMode).toBe('split');
      expect(notices()).toEqual([NOTICE]);
    });

    it('Photo and Cut & fill in Map view leave the stage where it is', () => {
      kit();
      shell.setState({ stageMode: 'map' });
      render();
      click(button('Photo'));
      expect(shell.getState().stageMode).toBe('map');
      expect(notices()).toEqual([]);
    });

    it('a survey project in Map view swaps its rasters and stays on the map', () => {
      workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
      workspace.getState().setLayersVisible(['dsm-oct', 'dsm-nov'], false);
      shell.setState({ stageMode: 'map' });
      render();
      click(button('Elevation'));
      expect(workspace.getState().hidden['ortho-oct']).toBe(true);
      expect(shell.getState().stageMode).toBe('map');
      expect(notices()).toEqual([]);
    });
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

  it('on the Materials pane adds "Colour piles by" Material, Change, None to the surface', () => {
    act(() => {
      stageShow.getState().setPane('materials');
    });
    render();
    // the surface stays reachable from Layers & display on this pane too
    expect(group('Show')?.contains(button('Photo') ?? null)).toBe(true);
    const g = group('Colour piles by');
    expect(g).not.toBeNull();
    expect(group('Show')?.textContent).toContain('Colour piles by');
    expect(button('Material')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Change'));
    expect(stageShow.getState().colourBy).toBe('change');
    click(button('None'));
    expect(stageShow.getState().colourBy).toBe('none');
  });

  it('offers Outlines and Labels on the Materials pane too', () => {
    act(() => {
      stageShow.getState().setPane('materials');
    });
    render();
    click(button('Outlines'));
    expect(stageShow.getState().outlines).toBe(false);
    click(button('Labels'));
    expect(stageShow.getState().labels).toBe(false);
  });

  it('a project change puts the surface, overlays and colouring back', () => {
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
    act(() => {
      stageShow.getState().setOutlines(false);
      stageShow.getState().setLabels(false);
      stageShow.getState().setColourBy('none');
      stageShow.getState().setSurface('elev');
    });
    workspace.getState().openProject({ id: 'q', root: '/q', manifest: surveyManifest });
    expect(stageShow.getState()).toMatchObject({
      outlines: true,
      labels: true,
      colourBy: 'material',
      surface: 'photo',
    });
  });
});

describe('when the Show control applies', () => {
  function Probe() {
    return <span data-shown={String(useStageShowActive())} />;
  }
  const shown = () => host.querySelector('span')?.getAttribute('data-shown');

  it('while the project has piles, whichever tab is in front or the panel folded', () => {
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: surveyManifest });
    volumetric.setState({ status: 'none' });
    render(<Probe />);
    expect(shown()).toBe('false');
    expect(stageShow.getState().active).toBe(false);
    act(() => {
      volumetric.setState({ status: 'ready' });
    });
    expect(shown()).toBe('true');
    expect(stageShow.getState().active).toBe(true);
    act(() => {
      workbench.getState().show('selection');
      shell.setState({ rightCollapsed: true });
    });
    expect(stageShow.getState().active).toBe(true);
    shell.setState({ rightCollapsed: false });
    act(() => root?.unmount());
    root = undefined;
    expect(stageShow.getState().active).toBe(false);
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

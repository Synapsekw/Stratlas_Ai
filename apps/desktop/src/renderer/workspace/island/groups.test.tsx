// @vitest-environment jsdom
import { pointcloudSettings } from '@aio/pointcloud';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell } from '../../shell';
import { annotateStage } from '../workbench/benches/annotateStage';
import { quickRow, type GroupCtx } from './groups';
import type { GroupId } from './islandModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

const ctx: GroupCtx = {
  stage: null,
  map: false,
  openBench: vi.fn(),
  done: vi.fn(),
  compare: { available: false, twin: false, label: '', open: vi.fn() },
};

const render = (g: GroupId) => {
  root ??= createRoot(host);
  act(() => root?.render(<>{quickRow(g, ctx)}</>));
};
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const choice = (label: string) =>
  host.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
const options = (label: string) =>
  [...(choice(label)?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
const pressed = (label: string) =>
  [...(choice(label)?.querySelectorAll('button') ?? [])].find(
    (b) => b.getAttribute('aria-pressed') === 'true',
  )?.textContent;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  shell.setState({ annotating: false, pkg: null });
  annotateStage.setState({ show3d: false, showMap: false, tool: null, mode: null });
  pointcloudSettings.getState().setColourMode('rgb');
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  annotateStage.getState().clear();
  shell.setState({ annotating: false });
});

describe('the Point cloud quick row (D5)', () => {
  it('has the colour switch RGB / Elevation / Intensity / Flight', () => {
    render('clouds');
    expect(options('Colour')).toEqual(['RGB', 'Elevation', 'Intensity', 'Flight']);
    expect(pressed('Colour')).toBe('RGB');
    act(() => {
      [...(choice('Colour')?.querySelectorAll('button') ?? [])]
        .find((b) => b.textContent === 'Elevation')
        ?.click();
    });
    expect(pointcloudSettings.getState().colourMode).toBe('height');
    expect(pressed('Colour')).toBe('Elevation');
  });

  it('presses none while the cloud is coloured another way (classification)', () => {
    pointcloudSettings.getState().setColourMode('classification');
    render('clouds');
    expect(pressed('Colour')).toBeUndefined();
  });
});

describe('the Annotate quick row (D5)', () => {
  it('has the 3D tiles while the stage shows the model, and starts annotating with one', () => {
    annotateStage.setState({ show3d: true });
    render('annotate');
    for (const name of [
      'Pin on the model',
      'Line on the model',
      'Area on the model',
      'Point on the cloud',
      'Box on the cloud',
    ])
      expect(button(name), name).not.toBeNull();
    expect(button('Point on the map')).toBeNull();
    act(() => button('Line on the model')?.click());
    expect(shell.getState().annotating).toBe(true);
    expect(annotateStage.getState().tool).toBe('polyline');
    expect(button('Line on the model')?.getAttribute('aria-pressed')).toBe('true');
    // again: the tool is put down, the annotation tools stay
    act(() => button('Line on the model')?.click());
    expect(annotateStage.getState().tool).toBeNull();
    expect(shell.getState().annotating).toBe(true);
  });

  it('has the map tiles while the stage shows the map', () => {
    annotateStage.setState({ showMap: true });
    const setMode = vi.fn();
    annotateStage.getState().publish({
      mode: null,
      state: null,
      setMode,
      onClick: vi.fn(),
      finish: vi.fn(),
      undo: vi.fn(),
      cancel: vi.fn(),
    });
    render('annotate');
    expect(button('Pin on the model')).toBeNull();
    for (const name of ['Point on the map', 'Line on the map', 'Area on the map'])
      expect(button(name), name).not.toBeNull();
    act(() => button('Area on the map')?.click());
    expect(shell.getState().annotating).toBe(true);
    expect(setMode).toHaveBeenCalledWith('polygon');
  });

  it('keeps the Annotate tile that opens and closes the tools', () => {
    render('annotate');
    expect(button('Annotate: pins, lines, areas, cloud regions')).not.toBeNull();
  });
});

describe('the Volumes quick row', () => {
  afterEach(() => {
    volumetric.setState({ status: 'idle', file: null, surface: 'photo', change: null });
  });

  it('shows the two surveys Cut / fill compares, and picks them', () => {
    volumetric.setState({
      status: 'ready',
      epoch: 'e2',
      surface: 'photo',
      swipe: false,
      change: null,
      changeGrid: null,
      file: {
        captures: [
          { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
          { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
        ],
      } as never,
    });
    render('volumes');
    expect(host.querySelector('[data-testid="vol-change-from"]')).toBeNull();
    act(() => {
      volumetric.getState().setSurface('change');
    });
    const from = host.querySelector('[data-testid="vol-change-from"]');
    const to = host.querySelector('[data-testid="vol-change-to"]');
    expect(from?.querySelector('[aria-pressed="true"]')?.textContent).toBe('12 Jan');
    expect(to?.querySelector('[aria-pressed="true"]')?.textContent).toBe('9 Feb');
    expect(host.querySelector('[data-testid="vol-change-source"]')?.textContent).toContain(
      '12 Jan to 9 Feb',
    );
  });
});

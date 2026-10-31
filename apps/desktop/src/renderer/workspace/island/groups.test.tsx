// @vitest-environment jsdom
import { pointcloudSettings } from '@aio/pointcloud';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell } from '../../shell';
import { timelinePref } from '../timelinePref';
import { annotateStage } from '../workbench/benches/annotateStage';
import { EMPTY_CTX, type IslandMode, type ToolCtx, type ToolGroup } from '../../tools/registry';
import { GroupControls, ModeRow, type GroupCtx } from './groups';
import { IslandModes } from './IslandTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

const DATA = {
  pointcloud: true,
  model3d: true,
  surface: true,
  video: true,
  photos: false,
  dated: true,
  volumes: true,
  road: false,
  flightlines: false,
};

/** The registry's context: everything shown in 3D unless a test says otherwise. */
const toolCtx = (over: Partial<ToolCtx> = {}): ToolCtx => ({
  ...EMPTY_CTX,
  data: DATA,
  stage3d: true,
  ...over,
});

const ctxOf = (over: Partial<ToolCtx> = {}): GroupCtx => ({
  stage: null,
  tool: toolCtx(over),
  done: vi.fn(),
});

/** A mode's slim row of top tools. */
const render = (m: IslandMode, over: Partial<ToolCtx> = {}) => {
  root ??= createRoot(host);
  act(() => root?.render(<ModeRow mode={m} ctx={ctxOf(over)} />));
};

/** A group's switches, as the Tools tab shows them. */
const renderControls = (g: ToolGroup) => {
  root ??= createRoot(host);
  act(() => root?.render(<GroupControls group={g} stage={null} mode="3d" />));
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

describe('the Point cloud switches (Tools > Point cloud)', () => {
  it('has the colour switch RGB / Elevation / Intensity / Flight', () => {
    renderControls('pointcloud');
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
    renderControls('pointcloud');
    expect(pressed('Colour')).toBeUndefined();
  });
});

describe('the Annotate mode row', () => {
  it('has the 3D tiles while the stage shows the model, and starts annotating with one', () => {
    annotateStage.setState({ show3d: true });
    render('annotate');
    // the top five: the Annotate tile and the tools that work in 3D
    for (const name of [
      'Pin on the model',
      'Line on the model',
      'Area on the model',
      'Point on the cloud',
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
    render('annotate', { mode: 'map', tools: 'map', stage3d: false });
    // the 3D tools step behind, greyed out with their reason
    expect(button('Pin on the model')?.getAttribute('aria-disabled')).toBe('true');
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

describe('the Volumes mode row and switches', () => {
  afterEach(() => {
    volumetric.setState({ status: 'idle', file: null, surface: 'photo', change: null });
  });

  it('without the stockpile kit (a survey project with volumes) leads with the table', () => {
    volumetric.setState({ status: 'idle', file: null });
    render('volumes');
    expect(choice('Survey date')).toBeNull();
    expect(choice('Surface')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Open the volumes table');
    expect(button('Swipe between surveys')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('has no date or Surface choice: Swipe, the bodies and the section line stay', () => {
    volumetric.setState({
      status: 'ready',
      epoch: 'e2',
      surface: 'change',
      swipe: false,
      change: { from: 'e1', to: 'e2' },
      changeGrid: null,
      section: { mode: 'idle', points: [] } as never,
      file: {
        captures: [
          { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
          { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
        ],
      } as never,
    });
    renderControls('volumes');
    expect(choice('Survey date')).toBeNull();
    expect(choice('Surface')).toBeNull();
    expect(options('Bodies')).toEqual(['Lifted', 'In place', 'Hidden']);
    render('volumes', { kit: true, kitDates: 2 });
    const swipe = button('Swipe between surveys');
    expect(swipe?.getAttribute('aria-pressed')).toBe('false');
    act(() => swipe?.click());
    expect(volumetric.getState().swipe).toBe(true);
    // a swipe shows the photos: Cut / fill gives way
    expect(volumetric.getState().surface).toBe('photo');
    const section = button('Section line between the surveys');
    expect(section).not.toBeNull();
    act(() => section?.click());
    expect(volumetric.getState().section.mode).not.toBe('idle');
    volumetric.getState().clearSection();
  });

  it('keeps Swipe off with one survey date', () => {
    volumetric.setState({
      status: 'ready',
      epoch: 'e1',
      surface: 'photo',
      swipe: false,
      file: {
        captures: [{ epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' }],
      } as never,
    });
    render('volumes', { kit: true, kitDates: 1 });
    expect(button('Swipe between surveys')?.getAttribute('aria-disabled')).toBe('true');
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
    renderControls('volumes');
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

describe('the Compare mode row: the Timeline tile', () => {
  const tile = () => host.querySelector<HTMLButtonElement>('[data-testid="timeline-toggle"]');
  // one dated survey and no clips: nothing for a timeline to show
  const oneDate = {
    ...threeDates,
    layers: threeDates.layers.filter((l) => l.kind !== 'video'),
    captures: threeDates.captures.slice(0, 1),
  };
  afterEach(() => {
    timelinePref.setState({ byProject: {} });
  });

  it('waits for a second survey date without video: greyed, with the reason', () => {
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: oneDate });
    timelinePref.getState().set('p3', true);
    render('compare', { data: { ...DATA, video: false, dated: false } });
    const b = tile();
    expect(b?.getAttribute('aria-disabled')).toBe('true');
    // a timeline left open in that state reads as closed
    expect(b?.getAttribute('aria-pressed')).toBe('false');
    const reason = document.getElementById(b?.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('Add a second survey date to see the dates timeline');
    act(() => b?.click());
    expect(timelinePref.getState().byProject.p3).toBe(true);
  });

  it('stays on with video or a second date', () => {
    render('compare');
    expect(tile()?.getAttribute('aria-disabled')).toBeNull();
    expect(tile()?.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('the stage view switch', () => {
  const renderModes = (over: Partial<ToolCtx> = {}) => {
    root ??= createRoot(host);
    act(() => root?.render(<IslandModes mode="3d" ctx={toolCtx(over)} />));
  };

  it('Map and Split are greyed with a reason in a local space', () => {
    shell.setState({ stageMode: '3d' });
    renderModes({ mapAvailable: false });
    const map = button('Map');
    const split = button('Split');
    expect(map?.getAttribute('aria-disabled')).toBe('true');
    expect(split?.getAttribute('aria-disabled')).toBe('true');
    expect(button('3D')?.getAttribute('aria-disabled')).toBeNull();
    act(() => map?.click());
    act(() => split?.click());
    expect(shell.getState().stageMode).toBe('3d');
    const reason = document.getElementById(map?.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('No map: this space has its own frame');
  });

  it('keeps Map and Split in a georeferenced project', () => {
    shell.setState({ stageMode: '3d' });
    renderModes({ mapAvailable: true });
    expect(button('Map')?.getAttribute('aria-disabled')).toBeNull();
    act(() => button('Split')?.click());
    expect(shell.getState().stageMode).toBe('split');
    shell.setState({ stageMode: '3d' });
  });
});

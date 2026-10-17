// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../../../shell';
import { threeDates } from '../../__fixtures__/threeDates';
import { stagePrefs } from '../../stagePrefs';
import { sectionStore } from '../sectionState';
import { VideoBench } from './VideoBench';

// the clip lengths the app reads from the files' metadata, here said outright
vi.mock('../../../media', () => ({
  useMedia: () => ({
    projectId: 'p',
    durations: { c1: 60_000, c2: 30_000 },
    flights: {},
  }),
  getMedia: () => ({ projectId: 'p', durations: { c1: 60_000, c2: 30_000 }, flights: {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const START = 1_700_000_000_000;
const clip = (id: string, offsetMs: number, poster: boolean): Layer =>
  ({
    kind: 'video',
    id,
    name: `Clip ${id}`,
    visible: true,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: 'flights/f1.json' }, startUtcMs: START },
    lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
    offsetMs,
    ...(poster ? { poster: { path: `posters/${id}.jpg` } } : {}),
  }) as unknown as Layer;

const manifest = {
  ...threeDates,
  captures: [],
  layers: [clip('c1', 0, true), clip('c2', 120_000, false)],
} as unknown as ProjectManifest;

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<VideoBench />));
};
const scrubber = () => host.querySelector<HTMLInputElement>('input[type="range"]');
const named = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === name,
  );

/** Drag the range input the way the browser reports it: a new value, then an input event. */
function drag(input: HTMLInputElement, value: number) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      String(value),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  stagePrefs.setState({ byProject: {} });
  shell.getState().setVideoHidden(false);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('VideoBench', () => {
  it('heads the bench Video and camera', () => {
    render();
    expect(host.querySelector('h2')?.textContent).toBe('Video and camera');
  });

  it('dragging the scrubber moves the one clock, by the clip start plus the drag', () => {
    render();
    const input = scrubber();
    if (!input) throw new Error('no scrubber');
    expect(input.max).toBe('60000');
    const setTime = vi.spyOn(workspace.getState(), 'setTime');
    drag(input, 25_000);
    expect(setTime).toHaveBeenCalledWith(START + 25_000);
    expect(workspace.getState().nowMs).toBe(START + 25_000);
    expect(input.value).toBe('25000');
  });

  it('renders no video element: the floating window is the only decoder', () => {
    render();
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('img.vb-poster')?.getAttribute('src')).toContain('posters/c1.jpg');
  });

  it('plays and pauses the clock', () => {
    render();
    act(() => named('Play')?.click());
    expect(workspace.getState().playing).toBe(true);
    act(() => named('Pause')?.click());
    expect(workspace.getState().playing).toBe(false);
  });

  it('shows and hides the video window', () => {
    render();
    act(() => named('Hide the video window')?.click());
    expect(shell.getState().videoHidden).toBe(true);
    expect(named('Show the video window')).toBeDefined();
  });

  it('lists the clips and makes the picked one the active clip, at its start', () => {
    render();
    const rows = host.querySelectorAll<HTMLElement>('[data-clip]');
    expect([...rows].map((r) => r.dataset.clip)).toEqual(['c1', 'c2']);
    act(() => host.querySelector<HTMLElement>('[data-clip="c2"]')?.click());
    expect(workspace.getState().activeClip).toBe('c2');
    expect(host.querySelector('[data-clip="c2"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the flight path panel and its test id, and sets the mode', () => {
    render();
    const panel = host.querySelector('[data-testid="path-panel"]');
    expect(panel).not.toBeNull();
    const off = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Off');
    act(() => off?.click());
    expect(off?.getAttribute('aria-pressed')).toBe('true');
  });

  it('turns the drone telemetry off and on', () => {
    render();
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    act(() => sw?.click());
    expect(sw?.getAttribute('aria-checked')).toBe('false');
  });

  it('asks for a clip when none is active', () => {
    act(() => {
      workspace.getState().setActiveClip(null);
    });
    render();
    expect(scrubber()).toBeNull();
    expect(host.textContent).toContain('Pick a clip');
  });
});

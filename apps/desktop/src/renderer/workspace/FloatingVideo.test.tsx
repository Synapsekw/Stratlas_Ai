// @vitest-environment jsdom
import { splitPrefs } from '@aio/ui';
import type { Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { stagePrefs } from './stagePrefs';
import { DOCK_SIDE_MIN, VIDEO_DOCK_ID, VideoDock } from './FloatingVideo';

// the frame and the annotator draw nothing here: the dock's layout is under test
vi.mock('@aio/video', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  VideoWindow: ({ children }: { children?: ReactNode }) => <div data-video-window>{children}</div>,
}));
vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  VideoAnnotator: () => null,
}));

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
const manifest = { ...threeDates, layers: [clip] };

let host: HTMLDivElement;
let root: Root | undefined;
const stageRef = createRef<HTMLDivElement>();

function render(docked: boolean) {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <VideoDock video={docked ? { layerId: 'c1', stageRef } : null}>
        <div className="views-under-test">views</div>
      </VideoDock>,
    );
  });
}
const separator = () => host.querySelector<HTMLElement>('[role="separator"]');
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name,
  );

/** The stage's size as the layout reads it (jsdom lays nothing out). */
function stageSize(width: number, height = 600) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, width, height),
  );
}

beforeEach(() => {
  stageSize(1000);
  localStorage.clear();
  splitPrefs.setState({ byId: {} });
  stagePrefs.setState({ byProject: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('VideoDock', () => {
  it('docked, the video sits beside the views with a divider between them', () => {
    render(true);
    const handle = separator();
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute('aria-label')).toBe('Resize the video dock');
    expect(handle?.getAttribute('aria-orientation')).toBe('vertical');
    const body = host.querySelector<HTMLElement>('.stage-body');
    expect(body?.classList.contains('split')).toBe(true);
    expect(body?.dataset.dock).toBe('side');
    // the divider resizes the dock: the pane after it holds the docked window
    const pane = host.querySelector<HTMLElement>(
      `#${CSS.escape(handle?.getAttribute('aria-controls') ?? '')}`,
    );
    expect(pane?.querySelector('[data-testid="video-window"]')).not.toBeNull();
  });

  it('floating, there is no divider and the views take the whole stage', () => {
    render(false);
    expect(separator()).toBeNull();
    const body = host.querySelector<HTMLElement>('.stage-body');
    expect(body?.classList.contains('split')).toBe(false);
    expect(host.querySelector('.views-under-test')).not.toBeNull();
  });

  it('keeps the views mounted as the video docks and floats again', () => {
    render(false);
    const views = host.querySelector('.views-under-test');
    render(true);
    expect(host.querySelector('.views-under-test')).toBe(views);
    render(false);
    expect(host.querySelector('.views-under-test')).toBe(views);
  });

  it('docks at the bottom too, remembered for the project, with the divider across', () => {
    render(true);
    const toBottom = button('Dock the video at the bottom');
    expect(toBottom).toBeDefined();
    act(() => toBottom?.click());
    expect(host.querySelector<HTMLElement>('.stage-body')?.dataset.dock).toBe('bottom');
    expect(separator()?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(stagePrefs.getState().byProject.p?.videoDock).toBe('bottom');
    act(() => button('Dock the video at the side')?.click());
    expect(host.querySelector<HTMLElement>('.stage-body')?.dataset.dock).toBe('side');
  });

  it('docks under the views on a stage too narrow to keep them beside it', () => {
    stageSize(DOCK_SIDE_MIN - 1);
    render(true);
    expect(host.querySelector<HTMLElement>('.stage-body')?.dataset.dock).toBe('bottom');
    expect(separator()?.getAttribute('aria-orientation')).toBe('horizontal');
    // the way back to the side says why it is not there
    const toSide = button('Dock the video at the side');
    expect(toSide?.getAttribute('aria-disabled')).toBe('true');
    act(() => toSide?.click());
    expect(stagePrefs.getState().byProject.p?.videoDock).toBeUndefined();
  });

  it('saves its size under the scene.video split', () => {
    render(true);
    const handle = separator();
    // the arrow away from the dock widens it
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(VIDEO_DOCK_ID).toBe('scene.video');
    expect(splitPrefs.getState().byId['scene.video']?.size).toBeGreaterThan(0.36);
  });
});

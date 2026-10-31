// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { FloatingVideo } from './FloatingVideo';
import { VideoStripStart } from './video/VideoTile';
import { videoDock, dockClipOf } from './video/videoDockStore';
import { useVideoDockBridge } from './video/videoDockBridge';
import { useStageKeys } from './stageKeys';
import { shell, useShell } from '../shell';

// the frame and the annotator draw nothing here: the tile and the window's controls are under test
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

function render(ui: ReactNode) {
  act(() => {
    root ??= createRoot(host);
    root.render(ui);
  });
}
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name,
  );
const mode = () => videoDock.getState().byProject.p;

beforeEach(() => {
  localStorage.clear();
  videoDock.setState({ byProject: {}, rect: null, beforeClose: {}, focus: null });
  shell.setState({ videoHidden: false, videoDocked: true });
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

describe('the docked tile in the bottom strip', () => {
  it('shows the project video with Play, Pop out and Close', () => {
    render(<VideoStripStart />);
    const tile = host.querySelector('[data-testid="video-tile"]');
    expect(tile?.getAttribute('aria-label')).toBe('Video Clip c1');
    expect(tile?.querySelector('[data-video-window]')).not.toBeNull();
    expect(button('Play the video')).toBeDefined();
    act(() => button('Pop out the video')?.click());
    expect(mode()).toBe('floating');
    expect(host.querySelector('[data-testid="video-tile"]')).toBeNull();
  });

  it('closed, a Show button brings the tile back', () => {
    render(<VideoStripStart />);
    act(() => button('Close the video')?.click());
    expect(mode()).toBe('closed');
    expect(host.querySelector('[data-testid="video-tile"]')).toBeNull();
    act(() => button('Show the video')?.click());
    expect(mode()).toBe('docked');
    expect(host.querySelector('[data-testid="video-tile"]')).not.toBeNull();
  });

  it('has nothing to show without video', () => {
    workspace
      .getState()
      .openProject({ id: 'p', root: '/p', manifest: { ...manifest, layers: [] } });
    render(<VideoStripStart />);
    expect(host.innerHTML).toBe('');
  });
});

describe('the popped-out window', () => {
  it('pops in to the strip and closes', () => {
    videoDock.getState().popOut('p');
    render(<FloatingVideo layerId="c1" stageRef={stageRef} />);
    expect(host.querySelector('[data-testid="video-window"]')).not.toBeNull();
    expect(host.querySelectorAll('.vwin-rs')).toHaveLength(8);
    act(() => button('Pop in to the bottom strip')?.click());
    expect(mode()).toBe('docked');
    act(() => button('Close the video')?.click());
    expect(mode()).toBe('closed');
  });
});

describe('a project with no active clip', () => {
  function Scene() {
    useVideoDockBridge();
    useStageKeys(null);
    const hidden = useShell((s) => s.videoHidden);
    // as the Scene's strip does: closed shows the Show button, hidden otherwise
    return <VideoStripStart hidden={hidden && videoDock.getState().byProject.p !== 'closed'} />;
  }
  const pressW = () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true }));
    });
  };

  it('shows the tile, W hides and shows it, and the island tile reads the same clip', () => {
    act(() => {
      workspace.getState().setActiveClip(null);
    });
    expect(workspace.getState().activeClip).toBeNull();
    // the island's Video tile and the W key read this: a clip to show, though none is active
    expect(dockClipOf(workspace.getState())).toBe('c1');
    render(<Scene />);
    expect(host.querySelector('[data-testid="video-tile"]')).not.toBeNull();
    pressW();
    expect(shell.getState().videoHidden).toBe(true);
    expect(mode()).toBe('closed');
    expect(host.querySelector('[data-testid="video-tile"]')).toBeNull();
    expect(host.querySelector('[data-testid="video-show"]')).not.toBeNull();
    pressW();
    expect(shell.getState().videoHidden).toBe(false);
    expect(host.querySelector('[data-testid="video-tile"]')).not.toBeNull();
  });
});

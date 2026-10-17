// @vitest-environment jsdom
import { emptyMeasurements, type SitePoint } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magicStore, useMagicController } from './MagicPolygon';
import { drawEvent, measureStore, startTool, stopTool } from './measureStore';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  jobs: { getState: () => ({}) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the stage mounts (MeasureLayer); the Measure bench and its buttons are not there. */
function StageOnly() {
  useMagicController();
  return null;
}

const env = { view: '3d' as const, clampZ: () => 0, snap: () => null };
const click = (raw: SitePoint) => {
  drawEvent({ type: 'click', raw, screen: { x: 1, y: 1 }, shift: false }, env);
};
const draft = {
  layer: {} as never,
  click: [1, 2, 0] as SitePoint,
  window: { x0: 0, y1: 10, res: 1, size: 10 } as never,
  key: 'k',
};

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  measureStore.setState({
    file: emptyMeasurements(),
    savedText: JSON.stringify(emptyMeasurements()),
    projectId: 'test',
    status: 'ready',
    readOnly: false,
    tool: null,
    draw: null,
    editing: null,
  });
  magicStore.setState(magicStore.getInitialState());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<StageOnly />));
  act(() => {
    startTool('area');
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  act(() => {
    stopTool();
  });
});

describe('Suggest boundaries lives with the drawing, not the Measure tab', () => {
  it('takes the clicks on the model with no bench mounted', () => {
    act(() => {
      magicStore.setState({ on: true });
      click([3, 4, 0]);
    });
    // the click asked for an outline instead of adding a vertex
    expect(measureStore.getState().draw?.points).toHaveLength(0);
  });

  it('draws plainly when it is off', () => {
    act(() => {
      click([3, 4, 0]);
    });
    expect(measureStore.getState().draw?.points).toHaveLength(1);
  });

  it('keeps its buffer keys with no bench mounted', () => {
    act(() => {
      magicStore.setState({ on: true, last: draft });
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', cancelable: true }));
    });
    expect(magicStore.getState().bufferPx).toBe(2);
  });

  it('clears the draft and its mode when the area ends while the tab is away', () => {
    act(() => {
      magicStore.setState({ on: true, last: draft, mode: 'add', bufferPx: 4 });
    });
    act(() => {
      stopTool();
    });
    const s = magicStore.getState();
    expect(s.last).toBeNull();
    expect(s.mode).toBe('new');
    expect(s.bufferPx).toBe(0);
    expect(s.on).toBe(false);
  });

  it('lets go of the drawing when the stage goes', () => {
    act(() => root?.unmount());
    root = undefined;
    act(() => {
      magicStore.setState({ on: true });
      click([3, 4, 0]);
    });
    expect(measureStore.getState().draw?.points).toHaveLength(1);
  });
});

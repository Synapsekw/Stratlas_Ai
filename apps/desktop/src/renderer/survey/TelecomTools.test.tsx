// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { spaceIsPlayPause } from '../keys';
import { TelecomTools } from './TelecomTools';
import { measureStore, startTool } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./DetectAntennas', () => ({ DetectAntennas: () => null }));

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: <T,>(selector: (state: { stageMode: '3d'; pkg: null }) => T) =>
    selector({ stageMode: '3d', pkg: null }),
  shell: { getState: () => ({ setAnnotating: () => undefined }) },
}));

it('reserves Space for telecom control activation instead of global playback', () => {
  measureStore.setState({
    readOnly: false,
    status: 'ready',
    focus: null,
    tool: null,
    draw: null,
    editing: null,
  });
  startTool('azimuth');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let plays = 0;
  // App's global Space policy deliberately includes ordinary focused buttons.
  const globalKey = (event: KeyboardEvent) => {
    if (event.key === ' ' && spaceIsPlayPause(event.target)) {
      event.preventDefault();
      plays++;
    }
  };
  window.addEventListener('keydown', globalKey);
  try {
    act(() => {
      root.render(<TelecomTools />);
    });
    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      cancel?.focus();
      cancel?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(plays).toBe(0);
    // Outside telecom controls, the existing global playback shortcut still applies.
    const outside = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(plays).toBe(1);
  } finally {
    window.removeEventListener('keydown', globalKey);
    act(() => {
      root.unmount();
    });
    host.remove();
    measureStore.setState({ tool: null, draw: null });
  }
});

it('Measurements reveals the picked measurement in the tree', () => {
  measureStore.setState({
    readOnly: false,
    status: 'ready',
    focus: 'az1',
    tool: null,
    draw: null,
    editing: null,
    reveal: null,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => {
      root.render(<TelecomTools />);
    });
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Measurements',
    );
    act(() => {
      button?.click();
    });
    expect(measureStore.getState().reveal).toMatchObject({ id: 'az1', openSidebar: true });
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
});

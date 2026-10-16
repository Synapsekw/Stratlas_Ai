// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { spaceIsPlayPause } from '../keys';
import { MeasurementList } from './MeasurementList';
import { isDirty, measureStore } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

it('keeps bulk view controls usable in read-only mode and reserves their native Space activation', () => {
  const measurement: SurveyMeasurement = {
    id: 'distance',
    family: 'line',
    tool: 'distance',
    label: 'Distance',
    points: [
      [0, 0, 1],
      [3, 0, 5],
    ],
    items: [],
    results: [],
    scope: { kind: 'site' },
    createdAt: '2026-10-16T00:00:00Z',
  };
  const file = { schema: 'aio.measurements/1' as const, measurements: [measurement] };
  measureStore.setState({
    file,
    savedText: JSON.stringify(file),
    readOnly: true,
    status: 'ready',
    selected: [],
    focus: null,
    editing: null,
    measurementsVisible: true,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let plays = 0;
  const globalKey = (event: KeyboardEvent) => {
    if (event.key === ' ' && spaceIsPlayPause(event.target)) {
      event.preventDefault();
      plays++;
    }
  };
  window.addEventListener('keydown', globalKey);
  try {
    act(() => {
      root.render(<MeasurementList stage={null} />);
    });
    const hide = host.querySelector<HTMLButtonElement>('[data-testid="survey-hide-all"]');
    const show = host.querySelector<HTMLButtonElement>('[data-testid="survey-show-all"]');
    expect(hide).not.toBeNull();
    expect(hide?.disabled).toBe(false);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    hide?.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(plays).toBe(0);
    act(() => {
      hide?.click();
    });
    expect(measureStore.getState().measurementsVisible).toBe(false);
    expect(host.querySelectorAll('[data-testid="survey-item"]')).toHaveLength(1);
    expect(show?.disabled).toBe(false);
    act(() => {
      show?.click();
    });
    expect(measureStore.getState().measurementsVisible).toBe(true);
    expect(measureStore.getState().file).toBe(file);
    expect(isDirty(measureStore.getState())).toBe(false);
  } finally {
    window.removeEventListener('keydown', globalKey);
    act(() => {
      root.unmount();
    });
    host.remove();
    measureStore.setState({ readOnly: false, measurementsVisible: true });
  }
});

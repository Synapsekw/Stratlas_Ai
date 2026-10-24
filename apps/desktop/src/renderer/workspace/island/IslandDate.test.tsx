// @vitest-environment jsdom
import type { CaptureIndex } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datesPlayer } from '../dates/datesPlayer';
import { IslandDate, type IslandDates } from './IslandDate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const T0 = Date.parse('2020-12-31T00:00:00Z');
const T1 = Date.parse('2021-01-10T00:00:00Z');

const index: CaptureIndex = {
  captures: [
    { id: 'a', date: '2020-12-31' },
    { id: 'b', date: '2021-01-10' },
  ] as CaptureIndex['captures'],
  layers: {},
  of: {},
  epochs: {},
  slot: {},
};
const dates: IslandDates = {
  index,
  order: ['a', 'b'],
  focus: 'a',
  pick: vi.fn(),
  step: vi.fn(),
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<IslandDate dates={dates} steps onOpen={vi.fn()} />);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  datesPlayer.setState({ playing: false, frame: null, t: null });
});

describe('IslandDate', () => {
  it('shows the survey with its arrows when not playing', () => {
    const el = render();
    expect(el.querySelector('.isl-day')?.textContent).toBe('31 Dec');
    expect(el.querySelector('[data-testid="date-bar-prev"]')).not.toBeNull();
  });

  it('the notch reads Playing · 5 Jan 2021 and has no arrows', () => {
    const t = T0 + 5 * DAY + 7 * 3600_000;
    datesPlayer.setState({
      playing: true,
      t,
      frame: { t, passed: T0, next: T1, f: 0.53, ended: false },
    });
    const el = render();
    expect(el.querySelector('.isl-day')?.textContent).toBe('Playing · 5 Jan 2021');
    expect(el.querySelector('[data-testid="date-bar-prev"]')).toBeNull();
    expect(el.querySelector('[data-testid="date-bar-next"]')).toBeNull();
    expect(el.querySelector('[data-testid="date-bar-count"]')).toBeNull();
  });
});

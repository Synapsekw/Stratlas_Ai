// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTrackValue, TrackHistory } from './TrackHistory';
import { linkTracks, type TrackObservation } from './tracks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = host = null;
});

const CAPTURES = [
  { id: 'c1', date: '2026-02-01' },
  { id: 'c2', date: '2026-06-01' },
];
const o = (capture: string, ref: string, az: number, draft = false): TrackObservation => ({
  capture,
  date: capture,
  ref,
  key: 'K',
  at: [0, 0, 0],
  draft,
  values: { azimuthDeg: az, downtiltDeg: 4 },
  class: 'panel',
  radiusM: 0.3,
});

function render(el: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(el);
  });
  return host;
}

describe('TrackHistory', () => {
  it('lists one row per date with the change since the date before', () => {
    const [track] = linkTracks('antenna', [o('c1', 'a', 358), o('c2', 'b', 5, true)], CAPTURES);
    const el = render(
      <TrackHistory track={track} current="b" dateLabel={(c) => `Survey ${c}`} testId="t" />,
    );
    const rows = [...el.querySelectorAll('[data-testid="t-row"]')];
    expect(rows.map((r) => r.getAttribute('data-capture'))).toEqual(['c1', 'c2']);
    expect(rows[1]?.textContent).toContain('Survey c2 (draft)');
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    expect(el.querySelector('[data-testid="t-change"]')?.textContent).toContain('+7.0°');
    expect(el.textContent).toContain('seen on 2 dates');
  });

  it('shows nothing for an object seen on one date', () => {
    const [track] = linkTracks('antenna', [o('c1', 'a', 1)], CAPTURES);
    const el = render(<TrackHistory track={track} dateLabel={(c) => c} />);
    expect(el.innerHTML).toBe('');
  });

  it('formats values with their units', () => {
    expect(formatTrackValue('peakC', 61.25)).toBe('61.3 °C');
    expect(formatTrackValue('areaM2', -3, true)).toBe('-3.0 m²');
  });
});

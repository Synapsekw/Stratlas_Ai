// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkedHover } from '../survey/linkedHover';
import { VolumeSection } from './VolumeSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;
let before: ReturnType<typeof volumetric.getState>;

beforeEach(() => {
  before = volumetric.getState();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState(before, true);
  linkedHover.setState({ hover: null, pin: null, fly: null });
});

describe('the kit section line panel', () => {
  it('the kit section panel registers its line', () => {
    act(() => {
      volumetric.setState({
        status: 'ready',
        file: {
          ...(before.file ?? {}),
          captures: [
            { epoch: 'e1', date: '2026-01-01', label: 'Jan' },
            { epoch: 'e2', date: '2026-02-01', label: 'Feb' },
          ],
        } as unknown as NonNullable<typeof before.file>,
        section: {
          mode: 'done',
          points: [
            [100, 200],
            [110, 200],
          ],
          profile: { lengthM: 10, s: [0, 5, 10], z1: [1, 1, 1], z2: [2, 2, 2] },
          busy: false,
          pair: { from: 'e1', to: 'e2' },
        } as unknown as ReturnType<typeof volumetric.getState>['section'],
      });
    });
    root = createRoot(host);
    act(() => root?.render(<VolumeSection />));
    const line = linkedHover.getState().lines.get('kit-section');
    expect(line?.polyline).toEqual([
      [100, 200],
      [110, 200],
    ]);
    expect(line?.series.map((s) => s.key)).toEqual(['from', 'to']);
    act(() => {
      linkedHover.getState().setHover({ key: 'kit-section', chainageM: 5, source: '3d' });
    });
    expect(host.querySelector('[data-testid="chart-crosshair"]')).not.toBeNull();
    // the line goes when the section is cleared
    act(() => {
      volumetric.getState().clearSection();
    });
    expect(linkedHover.getState().lines.has('kit-section')).toBe(false);
  });
});

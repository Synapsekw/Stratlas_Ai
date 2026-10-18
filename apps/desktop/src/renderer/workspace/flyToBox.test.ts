import { beforeEach, describe, expect, it, vi } from 'vitest';

const flyTo = vi.fn();
vi.mock('@aio/workspace', () => ({ workspace: { getState: () => ({ flyTo }) } }));

import { boxOfPoints, flyToLocalBox } from './flyToBox';

describe('flyToBox', () => {
  beforeEach(() => flyTo.mockClear());

  it('pads the box around the points', () => {
    expect(
      boxOfPoints(
        [
          [0, 0, 0],
          [2, 4, 6],
        ],
        0.5,
      ),
    ).toEqual({ min: [-0.5, -0.5, -0.5], max: [2.5, 4.5, 6.5] });
  });

  it('flies to the box', () => {
    flyToLocalBox([[1, 1, 1]], 1);
    expect(flyTo).toHaveBeenCalledWith({ kind: 'box', min: [0, 0, 0], max: [2, 2, 2] });
  });

  it('does nothing without points', () => {
    flyToLocalBox([]);
    expect(flyTo).not.toHaveBeenCalled();
  });
});

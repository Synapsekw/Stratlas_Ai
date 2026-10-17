import { describe, expect, it } from 'vitest';
import { cloudFrameOrigin } from './cloudFrame';

describe('cloudFrameOrigin', () => {
  it('lowers the frame origin by the offset', () => {
    expect(cloudFrameOrigin([500000, 3200000, 10], { heightOffsetM: -30.81 })).toEqual([
      500000, 3200000, 40.81,
    ]);
  });
  it('leaves the origin alone without an offset', () => {
    expect(cloudFrameOrigin([1, 2, 3], {})).toEqual([1, 2, 3]);
  });
  it('moves the frame origin against the date shift', () => {
    expect(
      cloudFrameOrigin([500000, 3200000, 10], { heightOffsetM: -30.81 }, { eastM: 2, northM: -1 }),
    ).toEqual([499998, 3200001, 40.81]);
  });
});

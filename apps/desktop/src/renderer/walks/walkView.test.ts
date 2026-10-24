import { shiftLocal, type DateShift } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BEAM_FADE,
  BEAM_PX,
  beamFanPath,
  along,
  beamHalfRad,
  clearWalkView,
  headingFromBearingDeg,
  shiftBearingDeg,
  shiftHeadingRad,
  horizontalFov,
  linkedFov,
  linkedFovRange,
  verticalFov,
  viewAspect,
  setWalkView,
  walkViewPublisher,
  walkViews,
  type WalkViewNow,
} from './walkView';

const view = (over: Partial<WalkViewNow> = {}): WalkViewNow => ({
  t: 1,
  lookDeg: 90,
  pitchDeg: 0,
  fovDeg: 75,
  hfovDeg: 100,
  ...over,
});

/** A frame clock the test steps by hand. */
function frames() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    clock: {
      request: (cb: () => void) => {
        const id = next++;
        queued.set(id, cb);
        return id;
      },
      cancel: (id: number) => {
        queued.delete(id);
      },
    },
    pending: () => queued.size,
    step: () => {
      const run = [...queued.values()];
      queued.clear();
      for (const cb of run) cb();
    },
  };
}

afterEach(() => {
  walkViews.setState({}, true);
});

describe('walk views', () => {
  it('keeps one view per walk layer: two walks play at once', () => {
    setWalkView('walk-a', view({ t: 2 }));
    setWalkView('walk-b', view({ t: 7, lookDeg: 10 }));
    expect(walkViews.getState()['walk-a']?.t).toBe(2);
    expect(walkViews.getState()['walk-b']?.lookDeg).toBe(10);
    clearWalkView('walk-a');
    expect(Object.keys(walkViews.getState())).toEqual(['walk-b']);
  });

  it('an unchanged view writes nothing; the other walk keeps its object', () => {
    setWalkView('walk-a', view());
    setWalkView('walk-b', view());
    const b = walkViews.getState()['walk-b'];
    const before = walkViews.getState();
    setWalkView('walk-a', view());
    expect(walkViews.getState()).toBe(before);
    setWalkView('walk-a', view({ t: 3 }));
    expect(walkViews.getState()['walk-b']).toBe(b);
  });

  it('the publisher writes at most once a frame, the last view of it', () => {
    const f = frames();
    const pub = walkViewPublisher('walk-a', f.clock);
    pub.publish(view({ lookDeg: 10 }));
    pub.publish(view({ lookDeg: 20 }));
    pub.publish(view({ lookDeg: 30 }));
    expect(f.pending()).toBe(1);
    expect(walkViews.getState()['walk-a']).toBeUndefined();
    f.step();
    expect(walkViews.getState()['walk-a']?.lookDeg).toBe(30);
    expect(f.pending()).toBe(0);
    pub.publish(view({ lookDeg: 40 }));
    f.step();
    expect(walkViews.getState()['walk-a']?.lookDeg).toBe(40);
  });

  it('stopping the publisher drops its frame and clears only its own walk', () => {
    const f = frames();
    setWalkView('walk-b', view());
    const pub = walkViewPublisher('walk-a', f.clock);
    pub.publish(view());
    f.step();
    pub.publish(view({ t: 9 }));
    pub.stop();
    expect(f.pending()).toBe(0);
    f.step();
    expect(walkViews.getState()['walk-a']).toBeUndefined();
    expect(walkViews.getState()['walk-b']).toBeDefined();
  });

  it('a wide pane sees wider than its vertical field of view', () => {
    expect(horizontalFov(90, 200, 100)).toBeCloseTo(126.87, 1);
    expect(horizontalFov(60, 100, 100)).toBeCloseTo(60, 6);
    expect(horizontalFov(60, 0, 100)).toBe(60);
  });

  it('turns a horizontal field of view back into the vertical one for a pane', () => {
    expect(verticalFov(horizontalFov(70, 640, 655), 640, 655)).toBeCloseTo(70, 9);
    expect(verticalFov(126.87, 200, 100)).toBeCloseTo(90, 1);
    expect(verticalFov(60, 0, 100)).toBe(60);
  });

  it("reads a published view's width over height from its two fields of view", () => {
    expect(viewAspect({ fovDeg: 90, hfovDeg: horizontalFov(90, 200, 100) })).toBeCloseTo(2, 9);
    expect(viewAspect({ fovDeg: 0, hfovDeg: 0 })).toBeNull();
    expect(viewAspect({ fovDeg: 60, hfovDeg: 179 })).toBeNull();
  });

  it('links the zoom by the horizontal field of view, so a shorter pane sees as wide', () => {
    const lim = { min: 20, max: 100 };
    const range = linkedFovRange(640 / 655, 640 / 685, lim);
    // the driver 640 x 685 at 70 degrees; the follower 640 x 655 sees the same width
    const h = horizontalFov(70, 640, 685);
    const v = linkedFov(h, 640, 655, range);
    expect(horizontalFov(v, 640, 655)).toBeCloseTo(h, 9);
    expect(v).toBeLessThan(70);
  });

  it('stops both panes at the same zoom: the shared range of horizontal fields of view', () => {
    const lim = { min: 20, max: 100 };
    const wide = 2;
    const narrow = 1;
    const rw = linkedFovRange(wide, narrow, lim);
    const rn = linkedFovRange(narrow, wide, lim);
    // all the way out: the narrow pane's widest (100 degrees) bounds the wide pane
    expect(rn.max).toBeCloseTo(100, 9);
    expect(horizontalFov(rw.max, wide, 1)).toBeCloseTo(horizontalFov(100, narrow, 1), 9);
    expect(rw.max).toBeLessThan(100);
    // all the way in: the wide pane's narrowest (20 degrees) bounds the narrow pane
    expect(rw.min).toBeCloseTo(20, 9);
    expect(horizontalFov(rn.min, narrow, 1)).toBeCloseTo(horizontalFov(20, wide, 1), 9);
    // the follower is held inside its range
    expect(linkedFov(170, narrow, 1, rn)).toBe(rn.max);
    expect(linkedFov(1, narrow, 1, rn)).toBe(rn.min);
    // two panes of one size, or no other pane: the viewer's own limits
    expect(linkedFovRange(1.3, 1.3, lim)).toEqual({ min: 20, max: 100 });
    expect(linkedFovRange(1.3, null, lim)).toEqual({ min: 20, max: 100 });
  });
});

describe('the Beam cone', () => {
  it('is as wide as the horizontal field of view, kept between 5 and 170 degrees', () => {
    expect(beamHalfRad(90)).toBeCloseTo(Math.PI / 4, 9);
    expect(beamHalfRad(1)).toBeCloseTo((2.5 * Math.PI) / 180, 9);
    expect(beamHalfRad(400)).toBeCloseTo((85 * Math.PI) / 180, 9);
  });

  it('draws as a wedge from its apex along +x, its edges the half angle either side', () => {
    expect(beamFanPath(10, Math.PI / 4)).toBe('M0 0L7.071 -7.071A10 10 0 0 1 7.071 7.071Z');
    // past a half circle the arc takes the long way round
    expect(beamFanPath(10, (100 * Math.PI) / 180)).toContain('A10 10 0 1 1');
  });

  it('reads on a busy ortho: about 70 px out, strong at the dot, fading to nothing', () => {
    expect(BEAM_PX.reach).toBeGreaterThanOrEqual(64);
    expect(BEAM_PX.reach).toBeLessThanOrEqual(72);
    expect(BEAM_FADE[0]).toEqual([0, 0.7]);
    expect(BEAM_FADE.at(-1)).toEqual([1, 0]);
    // the fade falls all the way: half way out it is still clearly there
    for (let i = 1; i < BEAM_FADE.length; i++)
      expect(BEAM_FADE[i]?.[1]).toBeLessThan(BEAM_FADE[i - 1]?.[1] ?? 0);
    const mid = BEAM_FADE.find(([at]) => at >= 0.5);
    expect(mid?.[1]).toBeGreaterThanOrEqual(0.3);
  });
});

describe('a heading on a turned date', () => {
  const turned: DateShift = {
    eastM: 4,
    northM: -2,
    turn: { rotationDeg: 30, scale: 1.01, pivotE: 10, pivotN: -5, pivotX: 10, pivotZ: 5 },
  };

  it('turns with the points the date moves', () => {
    for (const h of [0, 1, -2.5]) {
      const a = shiftLocal([3, 0, 7], turned);
      const tipXZ = along([3, 7], h, 10);
      const b = shiftLocal([tipXZ[0], 0, tipXZ[1]], turned);
      const t = shiftHeadingRad(h, turned);
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const len = Math.hypot(dx, dz);
      expect(dx / len).toBeCloseTo(-Math.sin(t), 9);
      expect(dz / len).toBeCloseTo(-Math.cos(t), 9);
    }
  });

  it('as a bearing, and unchanged without a turn', () => {
    expect(headingFromBearingDeg(shiftBearingDeg(100, turned))).toBeCloseTo(
      shiftHeadingRad(headingFromBearingDeg(100), turned),
      9,
    );
    expect(shiftBearingDeg(10, turned)).toBeCloseTo(340, 9);
    expect(shiftHeadingRad(1.2, { eastM: 4, northM: 1 })).toBe(1.2);
    expect(shiftBearingDeg(45, null)).toBe(45);
  });
});

import { describe, expect, it } from 'vitest';
import { createStagePrefStore } from './stagePrefs';
import {
  clampVideoRect,
  defaultVideoRect,
  maxVideoWidth,
  moveVideoRect,
  parseVideoRect,
  resizeVideoRect,
  VIDEO_MARGIN,
  VIDEO_TOP,
  VIDEO_MIN_W,
  videoHeight,
  type VideoRect,
} from './videoWindow';

const stage = { width: 1000, height: 700 };
const start: VideoRect = { left: 100, bottom: 100, width: 400 };

/** Right and top edges of a rect, in stage pixels from the left and the bottom. */
const right = (r: VideoRect) => r.left + r.width;
const top = (r: VideoRect) => r.bottom + videoHeight(r.width);

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('floating video window geometry', () => {
  it('moves by the pointer and stays inside the stage', () => {
    expect(moveVideoRect(start, 50, -20, stage)).toEqual({ left: 150, bottom: 120, width: 400 });
    const far = moveVideoRect(start, 5000, -5000, stage);
    expect(right(far)).toBe(stage.width - VIDEO_MARGIN);
    expect(top(far)).toBe(stage.height - VIDEO_TOP);
    expect(moveVideoRect(start, -5000, 5000, stage)).toMatchObject({
      left: VIDEO_MARGIN,
      bottom: VIDEO_MARGIN,
    });
  });

  it('resizes from the east edge with the west edge fixed, keeping the aspect ratio', () => {
    const r = resizeVideoRect(start, 'e', 80, 0, stage);
    expect(r).toEqual({ left: 100, bottom: 100, width: 480 });
    expect(videoHeight(r.width) - videoHeight(start.width)).toBe(45);
  });

  it('resizes from the west edge with the east edge fixed', () => {
    const r = resizeVideoRect(start, 'w', -60, 0, stage);
    expect(r.width).toBe(460);
    expect(right(r)).toBe(right(start));
  });

  it('the north edge grows the window up, the south edge grows it down', () => {
    const n = resizeVideoRect(start, 'n', 0, -45, stage);
    expect(n.width).toBe(480);
    expect(n.bottom).toBe(start.bottom);
    const s = resizeVideoRect(start, 's', 0, 45, stage);
    expect(s.width).toBe(480);
    expect(top(s)).toBe(top(start));
  });

  it('a corner follows the larger pull', () => {
    const high = { ...start, bottom: 200 };
    const r = resizeVideoRect(high, 'se', 10, 90, stage);
    expect(r.width).toBe(560);
    expect(top(r)).toBe(top(high));
    expect(r.left).toBe(high.left);
  });

  it('keeps between the minimum and the largest size the stage allows', () => {
    expect(resizeVideoRect(start, 'e', -1000, 0, stage).width).toBe(VIDEO_MIN_W);
    const big = resizeVideoRect(start, 'ne', 5000, -5000, stage);
    expect(big.width).toBe(maxVideoWidth(stage));
    expect(top(big)).toBeLessThanOrEqual(stage.height - VIDEO_TOP);
    expect(right(big)).toBeLessThanOrEqual(stage.width - VIDEO_MARGIN);
  });

  it('clamps a remembered window into a smaller stage', () => {
    const small = { width: 500, height: 360 };
    const r = clampVideoRect({ left: 900, bottom: 600, width: 900 }, small);
    expect(r.width).toBe(maxVideoWidth(small));
    expect(r.left).toBeGreaterThanOrEqual(VIDEO_MARGIN);
    expect(right(r)).toBeLessThanOrEqual(small.width - VIDEO_MARGIN);
    expect(top(r)).toBeLessThanOrEqual(small.height - VIDEO_TOP);
  });

  it('starts at the bottom left with a share of the stage', () => {
    expect(defaultVideoRect({ width: 600, height: 500 })).toEqual({
      left: VIDEO_MARGIN,
      bottom: VIDEO_MARGIN,
      width: 280,
    });
    expect(defaultVideoRect({ width: 2000, height: 900 }).width).toBe(400);
  });

  it('reads back only well-formed rects', () => {
    expect(parseVideoRect({ left: 1, bottom: 2, width: 300 })).toEqual({
      left: 1,
      bottom: 2,
      width: 300,
    });
    expect(parseVideoRect({ left: '1', bottom: 2, width: 300 })).toBeNull();
    expect(parseVideoRect(null)).toBeNull();
  });
});

describe('stage preferences per project', () => {
  it('remembers the video window per project and forgets it on reset', () => {
    const storage = memoryStorage();
    const a = createStagePrefStore(storage);
    a.getState().update('hcl', { video: start });
    a.getState().update('alzour', { video: { left: 20, bottom: 30, width: 500 } });
    const b = createStagePrefStore(storage);
    expect(b.getState().byProject.hcl?.video).toEqual(start);
    expect(b.getState().byProject.alzour?.video?.width).toBe(500);
    b.getState().update('hcl', { video: undefined });
    expect(createStagePrefStore(storage).getState().byProject.hcl?.video).toBeUndefined();
  });

  it('ignores broken storage', () => {
    const storage = memoryStorage();
    storage.setItem('stratlas.stagePrefs', '{not json');
    expect(createStagePrefStore(storage).getState().byProject).toEqual({});
    expect(createStagePrefStore(null).getState().byProject).toEqual({});
  });
});

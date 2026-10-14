import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  buildLaneModel,
  ghostAt,
  laneClipAt,
  laneNeighbour,
  laneTodOf,
  siteMidnightUtc,
  todOf,
  utcAt,
  type LaneIndex,
} from './lanes';
import type { ClipBar, IssueMark, TimelineModel } from './model';

const H = 3_600_000;
const MIN = 60_000;
const OFF = 180; // UTC+3
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const NONE = { earlier: false, later: false };

/** UTC ms of a site clock time on a date. */
const at = (date: string, h: number, m = 0) => siteMidnightUtc(date, OFF) + (h * 60 + m) * MIN;
const clip = (layerId: string, startMs: number, lenMs: number): ClipBar => ({
  layerId,
  name: layerId,
  startMs,
  endMs: startMs + lenMs,
  estimated: false,
  group: layerId,
});
const tm = (p: Partial<TimelineModel>): TimelineModel => ({
  clips: [],
  groups: [],
  issues: [],
  photos: [],
  captures: [],
  range: null,
  ...p,
});
const index = (dates: readonly string[], of: Record<string, string> = {}): LaneIndex => ({
  captures: dates.map((d, i) => ({ id: `d${String(i + 1)}`, label: `Survey ${d}`, date: d })),
  of,
});
const issue = (issueId: string, tMs: number): IssueMark => ({
  issueId,
  code: issueId,
  tMs,
  color: undefined,
  severity: 1,
});
const ids = (xs: readonly { captureId: string }[]) => xs.map((x) => x.captureId);

describe('time of day', () => {
  it('reads site time with positive, negative and zero offsets', () => {
    const t = Date.UTC(2026, 8, 12, 22, 0);
    expect(todOf(t, 180)).toBe(1 * H);
    expect(todOf(t, -300)).toBe(17 * H);
    expect(todOf(t, 0)).toBe(22 * H);
  });
  it('finds the UTC time of a site midnight', () => {
    expect(siteMidnightUtc('2026-09-12', 180)).toBe(Date.UTC(2026, 8, 11, 21, 0));
    expect(todOf(siteMidnightUtc('2026-09-12', -300) + 5 * H, -300)).toBe(5 * H);
  });
});

describe('buildLaneModel', () => {
  it('puts each clip in its capture lane, oldest date first', () => {
    const m = buildLaneModel(
      tm({
        clips: [clip('a', at(DATES[0] ?? '', 9), 10 * MIN), clip('b', at(DATES[2] ?? '', 10), MIN)],
      }),
      index(DATES.slice(0, 3), { a: 'd1', b: 'd3' }),
      'd3',
      OFF,
    );
    expect(ids(m.lanes)).toEqual(['d1', 'd2', 'd3']);
    expect(m.lanes.map((l) => l.clips.map((c) => c.layerId))).toEqual([['a'], [], ['b']]);
    expect(m.lanes[0]?.clips[0]?.startTod).toBe(9 * H);
  });

  it('files a clip without a capture under its site day, not its UTC day', () => {
    // 01:00 on 12 Sep at the site is 22:00 on 11 Sep in UTC
    const m = buildLaneModel(
      tm({ clips: [clip('x', at('2026-09-12', 1), MIN)] }),
      index(['2026-09-11', '2026-09-12']),
      null,
      OFF,
    );
    expect(m.lanes[1]?.clips.map((c) => c.layerId)).toEqual(['x']);
  });

  it('files a clip of another day under its own capture at its own time of day', () => {
    const m = buildLaneModel(
      tm({ clips: [clip('x', at('2026-09-12', 9), MIN)] }),
      index(['2026-09-05'], { x: 'd1' }),
      'd1',
      OFF,
    );
    const c = m.lanes[0]?.clips[0];
    expect(c?.startTod).toBe(9 * H);
    expect(m.range[1]).toBeLessThan(DAY_MS);
  });

  it('stacks overlapping clips into sub-rows', () => {
    const d = DATES[0] ?? '';
    const m = buildLaneModel(
      tm({
        clips: [
          clip('a', at(d, 9, 0), 10 * MIN),
          clip('b', at(d, 9, 5), 10 * MIN),
          clip('c', at(d, 9, 12), 8 * MIN),
        ],
      }),
      index([d], { a: 'd1', b: 'd1', c: 'd1' }),
      'd1',
      OFF,
    );
    const lane = m.lanes[0];
    expect(lane?.clips.map((c) => [c.layerId, c.row])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
    expect(lane?.rows).toBe(2);
  });

  it('keeps a flight that crosses midnight in the lane it started in', () => {
    const d = DATES[0] ?? '';
    const start = at(d, 23, 30);
    const m = buildLaneModel(
      tm({ clips: [clip('n', start, H)] }),
      index(DATES.slice(0, 2), { n: 'd1' }),
      'd1',
      OFF,
    );
    const lane = m.lanes[0];
    expect(lane?.clips[0]?.startTod).toBe(23.5 * H);
    expect(lane?.clips[0]?.endTod).toBe(24.5 * H);
    expect(m.range[1]).toBeGreaterThan(DAY_MS);
    // the playhead 40 minutes in is at 24:10 on this lane, not 00:10
    expect(laneTodOf(lane ?? { clips: [] }, start + 40 * MIN, OFF)).toBe(24 * H + 10 * MIN);
  });

  it('gives a date with no video a lane with its photos and issues', () => {
    const d2 = DATES[1] ?? '';
    const m = buildLaneModel(
      tm({
        clips: [clip('a', at(DATES[0] ?? '', 9), MIN)],
        photos: [{ layerId: 'ph', photoId: 'p1', tMs: at(d2, 8) }],
        issues: [issue('i1', at(d2, 8, 5))],
      }),
      index(DATES.slice(0, 2), { a: 'd1', ph: 'd2' }),
      'd2',
      OFF,
    );
    const lane = m.lanes[1];
    expect(lane?.clips).toEqual([]);
    expect(lane?.rows).toBe(0);
    expect(lane?.photos.map((p) => p.tod)).toEqual([8 * H]);
    expect(lane?.issues.map((i) => i.tod)).toEqual([8 * H + 5 * MIN]);
  });

  it("puts an issue seen in a clip on that clip's lane", () => {
    const d1 = DATES[0] ?? '';
    // the clip is filed under d2 although it was recorded on d1's day
    const m = buildLaneModel(
      tm({ clips: [clip('a', at(d1, 9), 10 * MIN)], issues: [issue('i1', at(d1, 9, 2))] }),
      index(DATES.slice(0, 2), { a: 'd2' }),
      'd2',
      OFF,
    );
    expect(m.lanes[1]?.issues.map((i) => i.issueId)).toEqual(['i1']);
    expect(m.lanes[0]?.issues).toEqual([]);
  });

  it('focuses the latest date when the focus is unknown', () => {
    expect(buildLaneModel(tm({}), index(DATES), 'nope', OFF).focus).toBe('d6');
    expect(buildLaneModel(tm({}), index(DATES), null, OFF).focus).toBe('d6');
    expect(buildLaneModel(tm({}), index([]), null, OFF).focus).toBeNull();
  });

  it('folds the dates beyond two on each side of the focus', () => {
    const six = index(DATES);
    const v = (focus: string, expand = NONE) => {
      const m = buildLaneModel(tm({}), six, focus, OFF, expand);
      return [ids(m.visible), m.folds];
    };
    expect(v('d4')).toEqual([['d2', 'd3', 'd4', 'd5', 'd6'], { earlier: 1, later: 0 }]);
    expect(v('d1')).toEqual([['d1', 'd2', 'd3'], { earlier: 0, later: 3 }]);
    expect(v('d6')).toEqual([['d4', 'd5', 'd6'], { earlier: 3, later: 0 }]);
    expect(v('d6', { earlier: true, later: false })).toEqual([
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
      { earlier: 0, later: 0 },
    ]);
    const three = buildLaneModel(tm({}), index(DATES.slice(0, 3)), 'd2', OFF);
    expect(three.folds).toEqual({ earlier: 0, later: 0 });
  });

  it('fits the range to the visible lanes with 2% padding', () => {
    const m = buildLaneModel(
      tm({
        clips: [
          clip('early', at(DATES[0] ?? '', 6), MIN), // folded away when d6 is focused
          clip('a', at(DATES[4] ?? '', 9), H),
          clip('b', at(DATES[5] ?? '', 9, 30), 1.5 * H),
        ],
      }),
      index(DATES, { early: 'd1', a: 'd5', b: 'd6' }),
      'd6',
      OFF,
    );
    const pad = 2 * H * 0.02;
    expect(m.range[0]).toBeCloseTo(9 * H - pad);
    expect(m.range[1]).toBeCloseTo(11 * H + pad);
  });

  it('spans the whole day when no visible lane carries time', () => {
    expect(buildLaneModel(tm({}), index(DATES.slice(0, 2)), 'd1', OFF).range).toEqual([0, DAY_MS]);
  });
});

describe('ghostAt and utcAt', () => {
  const d = DATES[0] ?? '';
  const m = buildLaneModel(
    tm({ clips: [clip('c', at(d, 9), 10 * MIN)] }),
    index([d], { c: 'd1' }),
    'd1',
    OFF,
  );
  const lane = m.lanes[0] ?? { clips: [], date: d };
  it('finds the clip and its media time inside a clip', () => {
    const g = ghostAt(lane, 9 * H + 2 * MIN);
    expect(g?.clip.layerId).toBe('c');
    expect(g?.mediaMs).toBe(2 * MIN);
    expect(g?.utcMs).toBe(at(d, 9, 2));
  });
  it('finds nothing in a gap or past the end', () => {
    expect(ghostAt(lane, 8 * H)).toBeUndefined();
    expect(ghostAt(lane, 9 * H + 11 * MIN)).toBeUndefined();
  });
  it('maps a time of day back to UTC on the lane date', () => {
    expect(utcAt(lane, 9 * H + 2 * MIN, OFF)).toBe(at(d, 9, 2));
    expect(utcAt(lane, 8 * H, OFF)).toBe(at(d, 8));
  });
  it('returns the clip at a time of day, or nothing in a gap', () => {
    expect(laneClipAt(lane, 9 * H + MIN)?.layerId).toBe('c');
    expect(laneClipAt(lane, 8 * H)).toBeUndefined();
  });
});

describe('laneNeighbour', () => {
  const [d1, d2] = [DATES[0] ?? '', DATES[1] ?? ''];
  const m = buildLaneModel(
    tm({
      clips: [
        clip('a1', at(d1, 9), MIN),
        clip('a2', at(d1, 9, 30), MIN),
        clip('b1', at(d2, 9), MIN),
      ],
    }),
    index([d1, d2], { a1: 'd1', a2: 'd1', b1: 'd2' }),
    'd1',
    OFF,
  );
  const lane = m.lanes[0] ?? { clips: [] };
  it('steps within the lane and stops at its ends', () => {
    expect(laneNeighbour(lane, 'a1', 1)?.layerId).toBe('a2');
    expect(laneNeighbour(lane, 'a2', 1)).toBeUndefined();
    expect(laneNeighbour(lane, 'a1', -1)).toBeUndefined();
  });
  it('starts at the first or last clip when the active clip is elsewhere', () => {
    expect(laneNeighbour(lane, null, 1)?.layerId).toBe('a1');
    expect(laneNeighbour(lane, 'b1', -1)?.layerId).toBe('a2');
  });
});

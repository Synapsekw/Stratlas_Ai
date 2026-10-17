import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACK_MS,
  createBackOnline,
  liveItems,
  liveJobs,
  livePairKey,
  liveTool,
  playbackClock,
  playbackTelemetry,
  toolLabel,
  type LiveInput,
} from './useIslandLive';

// the hook's stores need a window; the pure parts under test do not
vi.mock('../../shell', () => ({ bridge: {}, useJobs: vi.fn(), useShell: vi.fn() }));
vi.mock('../../shell/connection', () => ({ useNetworkUp: vi.fn() }));
vi.mock('../../survey/measureStore', () => ({ measureStore: {}, useMeasure: vi.fn() }));
vi.mock('../../media', () => ({ useMedia: vi.fn() }));
vi.mock('../StageTools', () => ({ useEngineStage: vi.fn() }));

const none: LiveInput = { tool: null, clip: null, jobs: [], connection: null };

describe('liveTool', () => {
  const quiet = { measure: null, road: null, annotating: false };

  it('reads nothing while no tool is live', () => {
    expect(liveTool(quiet)).toBeNull();
  });

  it("reads the road's measure, and the annotation tools, each with its own tab", () => {
    expect(liveTool({ ...quiet, road: { reading: '42.00 m' } })).toEqual({
      label: 'Measure on the map',
      reading: '42.00 m',
      source: 'road',
    });
    expect(liveTool({ ...quiet, annotating: true })).toEqual({
      label: 'Annotate',
      reading: null,
      source: 'annotate',
    });
  });

  it('a survey tool drawing comes first, then the road, then annotating', () => {
    const measure = { label: 'Distance', reading: '1 m' };
    expect(liveTool({ measure, road: { reading: null }, annotating: true })?.source).toBe(
      'measure',
    );
    expect(liveTool({ ...quiet, road: { reading: null }, annotating: true })?.source).toBe('road');
  });
});

describe('liveItems', () => {
  it('a running survey tool with a reading', () => {
    expect(liveItems({ ...none, tool: { label: 'Distance', reading: '12.40 m' } })).toEqual([
      { kind: 'tool', label: 'Distance', reading: '12.40 m' },
    ]);
  });

  it('a playing clip at 30 percent', () => {
    const items = liveItems({
      ...none,
      clip: { name: 'Flight 1', progress: 0.3, telemetry: 'ALT 31 m · SPD 3.2 m/s' },
    });
    expect(items).toEqual([
      { kind: 'playback', clip: 'Flight 1', progress: 0.3, telemetry: 'ALT 31 m · SPD 3.2 m/s' },
    ]);
  });

  it('two running jobs come out in start order, the newest last', () => {
    const items = liveItems({
      ...none,
      jobs: [
        { id: 'b', label: 'B', progress: 0.5, startedMs: 200 },
        { id: 'a', label: 'A', progress: 0.1, startedMs: 100 },
      ],
    });
    expect(items.map((i) => (i.kind === 'job' ? i.id : i.kind))).toEqual(['a', 'b']);
  });

  it('network down is offline', () => {
    expect(liveItems({ ...none, connection: 'offline' })).toEqual([
      { kind: 'connection', state: 'offline' },
    ]);
  });

  it('clamps progress into 0..1', () => {
    const [p] = liveItems({ ...none, clip: { name: 'x', progress: 3, telemetry: null } });
    expect(p).toMatchObject({ progress: 1 });
  });
});

describe('playbackClock', () => {
  // the island follows the playhead in steps, not on every frame
  it('steps the playhead to a quarter of a second', () => {
    expect(playbackClock(0)).toBe(0);
    expect(playbackClock(249)).toBe(0);
    expect(playbackClock(250)).toBe(250);
    expect(playbackClock(1010)).toBe(1000);
  });
});

describe('playbackTelemetry', () => {
  it('formats altitude and speed', () => {
    expect(playbackTelemetry(31.2, 3.24)).toBe('ALT 31 m · SPD 3.2 m/s');
  });
});

describe('livePairKey', () => {
  it('is stable for the same pair and changes when the pair does', () => {
    const tool = { ...none, tool: { label: 'Distance', reading: '1 m' } };
    const a = livePairKey(liveItems(tool));
    expect(livePairKey(liveItems({ ...tool, tool: { label: 'Distance', reading: '2 m' } }))).toBe(
      a,
    );
    expect(livePairKey(liveItems({ ...tool, connection: 'offline' }))).not.toBe(a);
    expect(livePairKey(liveItems(none))).not.toBe(a);
  });
});

describe('createBackOnline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('offline, then back for 2000 ms, then nothing', () => {
    const b = createBackOnline();
    const seen = vi.fn();
    b.subscribe(seen);
    b.update(true);
    expect(b.get()).toBeNull();
    b.update(false);
    expect(b.get()).toBe('offline');
    b.update(true);
    expect(b.get()).toBe('back');
    vi.advanceTimersByTime(BACK_MS - 1);
    expect(b.get()).toBe('back');
    vi.advanceTimersByTime(1);
    expect(b.get()).toBeNull();
    expect(seen).toHaveBeenCalled();
  });

  it('going offline again cancels the pending back', () => {
    const b = createBackOnline();
    b.update(false);
    b.update(true);
    b.update(false);
    vi.advanceTimersByTime(BACK_MS);
    expect(b.get()).toBe('offline');
  });

  it('turning offline only on while the network is down shows nothing, not Back online', () => {
    const b = createBackOnline();
    b.update(false);
    b.update(false, true);
    expect(b.get()).toBeNull();
    b.update(true, true);
    expect(b.get()).toBeNull();
    b.update(true, false);
    expect(b.get()).toBeNull();
  });

  it('offline only off while the network is still down shows offline', () => {
    const b = createBackOnline();
    b.update(false, true);
    b.update(false, false);
    expect(b.get()).toBe('offline');
  });
});

describe('toolLabel', () => {
  it('names a real tool, not its id', () => {
    expect(toolLabel('elevation-difference', null)).toBe('Elevation difference');
    expect(toolLabel('distance', { name: 'Haul road' })).toBe('Haul road');
  });
});

describe('liveJobs', () => {
  const job = (id: string, over: object = {}) =>
    ({
      id,
      pipeline: 'photogrammetry.process',
      project: '/p',
      params: {},
      status: 'running',
      progress: 0.5,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-16T08:00:00Z',
      updatedAt: '2026-10-16T08:00:00Z',
      ...over,
    }) as never;

  it("the project's running jobs, not the ones that ended or run elsewhere", () => {
    const jobs = [job('a'), job('b', { status: 'done' }), job('c', { project: '/other' })];
    expect(liveJobs(jobs, '/p', false).map((j) => j.id)).toEqual(['a']);
  });

  it('leaves quiet jobs (background work) out of the live line', () => {
    const jobs = [job('a'), job('q', { quiet: true })];
    expect(liveJobs(jobs, '/p', false).map((j) => j.id)).toEqual(['a']);
  });

  it('none in a package', () => {
    expect(liveJobs([job('a')], '/p', true)).toEqual([]);
  });
});

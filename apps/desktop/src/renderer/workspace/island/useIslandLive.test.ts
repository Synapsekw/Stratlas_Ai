import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACK_MS,
  createBackOnline,
  liveItems,
  livePairKey,
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

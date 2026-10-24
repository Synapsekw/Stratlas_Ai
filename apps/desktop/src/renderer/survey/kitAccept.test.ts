import type { ComparisonResult, MeasurementsFile, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { SurfaceState } from './surfaceStates';

vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  jobs: { getState: () => ({ jobs: [] }) },
}));
vi.mock('../author', () => ({ authorName: () => '' }));
vi.mock('./measureStore', () => ({
  measureStore: { getState: () => ({}) },
  repairKitHeightsNow: vi.fn(() => Promise.resolve([])),
}));
vi.mock('./compareStore', () => ({
  compareStore: { getState: () => ({}) },
  acceptCarriedQuietly: vi.fn(() => Promise.resolve([])),
}));

const { connectKitReady, kitPilesToAccept } = await import('./kitAccept');

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const row = (epoch: string | null, toCapture?: string): ComparisonResult =>
  ({
    item: 'a',
    status: 'ok',
    netM3: 60,
    totalM3: 64,
    ...(toCapture ? { toCapture } : {}),
    fingerprint: epoch ? `kit:P01:${epoch}:plane` : 'engine',
    ...(epoch ? { carried: { from: 'kit', base: 'plane', pile: 'P01', epoch } } : {}),
  }) as ComparisonResult;

const pile = (
  id: string,
  results: ComparisonResult[],
  series: ComparisonResult[] = [],
): SurveyMeasurement =>
  ({
    id,
    family: 'polygon',
    tool: 'volume',
    label: id,
    origin: { kind: 'kit-pile', pile: id },
    points: [],
    items: [],
    results,
    ...(series.length ? { series } : {}),
  }) as unknown as SurveyMeasurement;

const fileOf = (...measurements: SurveyMeasurement[]): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements,
});

const epochs: Record<string, string> = { e1: 'd1', e2: 'd2' };
const captureOfEpoch = (e: string) => epochs[e] ?? null;

const states = (s: Record<string, SurfaceState>): ReadonlyMap<string, SurfaceState> =>
  new Map(Object.entries(s));
const ready: SurfaceState = { kind: 'ready' };

describe('kitPilesToAccept', () => {
  it('piles whose dates are all ready are accepted', () => {
    const file = fileOf(pile('p1', [row('e2')], [row('e1')]), pile('p2', [row('e1')]));
    expect(kitPilesToAccept(file, states({ d1: ready, d2: ready }), captureOfEpoch)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('a pile with a preparing date waits', () => {
    const file = fileOf(pile('p1', [row('e2')], [row('e1')]), pile('p2', [row('e1')]));
    const s = states({ d1: ready, d2: { kind: 'preparing', pct: 40 } });
    expect(kitPilesToAccept(file, s, captureOfEpoch)).toEqual(['p2']);
    expect(kitPilesToAccept(file, states({ d1: { kind: 'missing' } }), captureOfEpoch)).toEqual([]);
  });

  it('an accepted pile (no carried result) is not picked again', () => {
    const file = fileOf(pile('p1', [row(null)]), pile('p2', [row(null)], [row('e1')]));
    expect(kitPilesToAccept(file, states({ d1: ready, d2: ready }), captureOfEpoch)).toEqual([]);
  });

  it('a pile whose dates cannot be told waits', () => {
    const file = fileOf(pile('p1', [row('e9')]));
    expect(kitPilesToAccept(file, states({ d1: ready }), captureOfEpoch)).toEqual([]);
    // the row's own capture tells it when the kit's epoch does not
    const told = fileOf(pile('p1', [row('e9', 'd1')]));
    expect(kitPilesToAccept(told, states({ d1: ready }), captureOfEpoch)).toEqual(['p1']);
  });
});

describe('connectKitReady', () => {
  const setup = (writable: boolean, file = fileOf(pile('p1', [row('e1')]))) => {
    const opens: ((id: string) => void)[] = [];
    const ends: ((id: string) => void)[] = [];
    const order: string[] = [];
    const repair = vi.fn((id: string) => {
      order.push(`repair ${id}`);
      return Promise.resolve([] as string[]);
    });
    const accept = vi.fn((ids: readonly string[]) => {
      order.push(`accept ${ids.join(',')}`);
      return Promise.resolve([] as string[]);
    });
    let s = states({ d1: { kind: 'preparing', pct: 10 } });
    const look = vi.fn(() => Promise.resolve({ file, states: s, captureOfEpoch }));
    const stop = connectKitReady({
      onProjectOpen: (cb) => {
        opens.push(cb);
        return () => undefined;
      },
      onJobEnded: (cb) => {
        ends.push(cb);
        return () => undefined;
      },
      writable: () => writable,
      repair,
      accept,
      look,
    });
    return {
      open: (id: string) => {
        opens.forEach((cb) => {
          cb(id);
        });
      },
      ended: (id: string) => {
        ends.forEach((cb) => {
          cb(id);
        });
      },
      setStates: (n: ReadonlyMap<string, SurfaceState>) => {
        s = n;
      },
      repair,
      accept,
      order,
      stop,
    };
  };

  it('on open it repairs heights, and once a prepare ends accepts the ready piles', async () => {
    const k = setup(true);
    k.open('proj');
    await flush();
    expect(k.repair).toHaveBeenCalledWith('proj');
    expect(k.accept).not.toHaveBeenCalled();
    k.setStates(states({ d1: ready }));
    k.ended('proj');
    await flush();
    expect(k.order).toEqual(['repair proj', 'repair proj', 'accept p1']);
  });

  it('a read-only project accepts nothing (the repair stays in memory)', async () => {
    const k = setup(false);
    k.setStates(states({ d1: ready }));
    k.open('proj');
    k.ended('proj');
    await flush();
    expect(k.repair).toHaveBeenCalled();
    expect(k.accept).not.toHaveBeenCalled();
  });

  it('each pile is accepted once per open, even when the engine could not', async () => {
    const k = setup(true);
    k.setStates(states({ d1: ready }));
    k.accept.mockResolvedValueOnce(['The survey engine is starting.']);
    k.open('proj');
    await flush();
    k.ended('proj');
    await flush();
    expect(k.accept).toHaveBeenCalledTimes(1);
    // opened again: tried again
    k.open('proj');
    await flush();
    expect(k.accept).toHaveBeenCalledTimes(2);
  });

  it('acceptance keeps the kit figure as was: it goes through acceptCarriedQuietly', async () => {
    // acceptCarriedQuietly keeps the carried figure in previousResults ("was") and writes it on
    // the saved file, not as an edit: compareStore.test.ts, "acceptCarriedQuietly writes ..."
    const { acceptCarriedQuietly } = await import('./compareStore');
    const opens: ((id: string) => void)[] = [];
    connectKitReady({
      onProjectOpen: (cb) => {
        opens.push(cb);
        return () => undefined;
      },
      onJobEnded: () => () => undefined,
      writable: () => true,
      repair: () => Promise.resolve([]),
      look: () =>
        Promise.resolve({
          file: fileOf(pile('p1', [row('e1')])),
          states: states({ d1: ready }),
          captureOfEpoch,
        }),
    });
    opens.forEach((cb) => {
      cb('proj');
    });
    await flush();
    expect(acceptCarriedQuietly).toHaveBeenCalledWith(['p1']);
  });

  it('nothing runs after stop', async () => {
    const k = setup(true);
    k.stop();
    k.open('proj');
    await flush();
    expect(k.repair).not.toHaveBeenCalled();
  });
});

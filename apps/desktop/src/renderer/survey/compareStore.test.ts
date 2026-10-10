import type { HeightTiles, MeasurementsFile, SurveyMeasurement } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn((channel: string) =>
  Promise.resolve(
    channel === 'survey:writeMeasurements'
      ? { ok: true, value: { ok: true } }
      : { ok: false, error: 'not in this test' },
  ),
);
vi.mock('../shell', () => ({ bridge: { call } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const { compareStore, compute, engineClient, scheduleCheck, setEnginePort } =
  await import('./compareStore');
const { isDirty, measureStore, patchMeasurement, revertMeasurements, saveMeasurements } =
  await import('./measureStore');
const { serveEngine } = await import('./engineServe');

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);
const cone = JSON.parse(
  readFileSync(join(DIR, 'tiles', 'cone', 'tiles.json'), 'utf8'),
) as HeightTiles;

const ring = Array.from({ length: 24 }, (_, k): [number, number, number] => [
  302010 + 8 * Math.cos((2 * Math.PI * k) / 24),
  2574010 + 8 * Math.sin((2 * Math.PI * k) / 24),
  0,
]);
const UPDATED = '2026-10-01T00:00:00.000Z';
const pit: SurveyMeasurement = {
  id: 'm1',
  family: 'polygon',
  tool: 'volume',
  label: 'Pit',
  scope: { kind: 'site' },
  points: ring,
  items: [
    {
      id: 'a',
      from: { kind: 'reference', mode: 'level', levelM: 100 },
      to: { kind: 'current' },
      useDeadband: false,
    },
  ],
  results: [],
  createdAt: UPDATED,
  updatedAt: UPDATED,
};

let ports: MessageChannel | null = null;

beforeEach(() => {
  call.mockClear();
  ports = new MessageChannel();
  serveEngine(ports.port2, (url) => {
    const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
    return Promise.resolve(
      m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null,
    );
  });
  setEnginePort(ports.port1);
  engineClient().setContext({
    base: 'aio://project/p1/',
    surfaces: [{ ...cone, capture: 'c2' }],
    captures: ['c1', 'c2'],
    designs: [],
    site: { verticalDatum: { kind: 'project' } },
  });
  compareStore.setState({ projectId: 'p1', status: 'ready', current: {}, computed: {} });
  const file: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [pit] };
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    resultsUnwritten: false,
    // autosave on: a derived result must still not write the file
    autosave: true,
    message: null,
  });
});

afterEach(() => {
  setEnginePort(null);
  ports?.port1.close();
  ports?.port2.close();
  ports = null;
});

const stored = () => measureStore.getState().file.measurements.find((m) => m.id === 'm1');
const writes = () => call.mock.calls.filter(([c]) => c === 'survey:writeMeasurements').length;

describe('results the app computes on its own', () => {
  it('are shown and kept for the next save, but are not a person edit', async () => {
    const r = await compute('m1', { auto: true });
    expect(r?.results[0]?.status).toBe('ok');
    const m = stored();
    expect(m?.results).toHaveLength(1);
    expect(m?.results[0]?.fingerprint).toBe(r?.results[0]?.fingerprint);
    expect(m?.updatedAt).toBe(UPDATED);
    const s = measureStore.getState();
    expect(isDirty(s)).toBe(false);
    expect(s.resultsUnwritten).toBe(true);
    expect(writes()).toBe(0);
    // the current fingerprint matches: not stale
    expect(compareStore.getState().current.m1).toEqual([r?.results[0]?.fingerprint]);

    // the next save writes them
    expect(await saveMeasurements()).toBe(true);
    expect(writes()).toBe(1);
    expect(measureStore.getState().resultsUnwritten).toBe(false);
  });

  it('leave a person edit unsaved, and revert keeps the derived results', async () => {
    measureStore.setState({ autosave: false });
    patchMeasurement('m1', { label: 'Pit north' });
    expect(isDirty(measureStore.getState())).toBe(true);
    await compute('m1', { auto: true });
    expect(isDirty(measureStore.getState())).toBe(true);
    expect(writes()).toBe(0);
    revertMeasurements();
    expect(stored()?.label).toBe('Pit');
    expect(stored()?.results).toHaveLength(1);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('a person Recompute is an edit (autosave writes it)', async () => {
    await compute('m1');
    expect(stored()?.results).toHaveLength(1);
    expect(stored()?.updatedAt).not.toBe(UPDATED);
    expect(writes()).toBe(1);
  });
});

describe('a run the measurement outgrew', () => {
  it('stores nothing when an item changed while it ran: the change is computed next', async () => {
    const running = compute('m1', { auto: true });
    // the person sets another level while the first run is still out (the Set of the base editor)
    const file = measureStore.getState().file;
    measureStore.setState({
      file: {
        ...file,
        measurements: file.measurements.map((m) =>
          m.id === 'm1'
            ? {
                ...m,
                items: m.items.map((it) => ({
                  ...it,
                  from: { kind: 'reference' as const, mode: 'level' as const, levelM: 90 },
                })),
              }
            : m,
        ),
      },
    });
    const r = await running;
    expect(r?.results[0]?.status).toBe('ok');
    // the answer was for level 100: not stored for level 90, and not taken as current
    expect(stored()?.results).toEqual([]);
    expect(compareStore.getState().current.m1).toBeUndefined();
    expect(compareStore.getState().running.m1).toBe(false);
    // the next run is for level 90
    const next = await compute('m1', { auto: true });
    expect(stored()?.results[0]?.fingerprint).toBe(next?.results[0]?.fingerprint);
    expect(next?.results[0]?.fingerprint).not.toBe(r?.results[0]?.fingerprint);
  });
});

describe('the check after a change', () => {
  it('lets a run in flight finish instead of replacing it: a person Recompute stays an edit', async () => {
    // an engine that reads its tiles only when let: the run is still out when the check fires
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setEnginePort(null);
    ports?.port1.close();
    ports?.port2.close();
    ports = new MessageChannel();
    serveEngine(ports.port2, async (url) => {
      await gate;
      const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
      return m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null;
    });
    setEnginePort(ports.port1);
    engineClient().setContext({
      base: 'aio://project/p1/',
      surfaces: [{ ...cone, capture: 'c2' }],
      captures: ['c1', 'c2'],
      designs: [],
      site: { verticalDatum: { kind: 'project' } },
    });
    measureStore.setState({ focus: 'm1' });

    // a person's Recompute, then the check a change schedules, while the run is still out
    const person = compute('m1');
    scheduleCheck(0);
    const early = await Promise.race([
      person,
      new Promise<'still out'>((resolve) => {
        setTimeout(() => {
          resolve('still out');
        }, 150);
      }),
    ]);
    // the check did not start a run of its own over the person's (that cancelled it: null)
    expect(early).toBe('still out');
    release();
    const r = await person;
    expect(r?.results[0]?.status).toBe('ok');
    // stored as the person's edit, once
    expect(stored()?.results).toHaveLength(1);
    expect(stored()?.updatedAt).not.toBe(UPDATED);
    await vi.waitFor(() => {
      expect(compareStore.getState().running.m1).toBe(false);
    });
    expect(writes()).toBe(1);
  });
});

import {
  emptyMeasurements,
  type ComparisonResult,
  type MeasurementsFile,
  type ProjectManifest,
  type SurveyMeasurement,
  type SurveyQa,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDirty, measureStore, stampQaFlags } from '../survey/measureStore';
import { qaStore } from '../survey/qaStore';
import { connectQaFlags } from './qaFlagsWatch';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in this test' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

const result = (toCapture: string, netM3 = 10): ComparisonResult => ({
  item: 'vol',
  status: 'ok',
  cutM3: 0,
  fillM3: netM3,
  netM3,
  totalM3: netM3,
  areaM2: 1,
  areaCutM2: 0,
  areaFillM2: 1,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Base',
  toLabel: toCapture,
  toCapture,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: `fp-${toCapture}`,
  computedAt: '2026-10-01T00:00:00.000Z',
});

const pile = (id: string): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  items: [],
  results: [result('m2')],
  series: [result('m1'), result('m2')],
  createdAt: '2026-07-01T00:00:00.000Z',
});

const manifest = {
  // a working copy: the project's id is not its manifest's
  id: 'p1-manifest',
  captures: [
    { id: 'm1', label: 'July', date: '2026-07-01' },
    { id: 'm2', label: 'August', date: '2026-08-01' },
  ],
} as unknown as ProjectManifest;

const qa = (capture: string, status: SurveyQa['status']): SurveyQa => ({
  schema: 'aio.survey-qa/1',
  capture,
  level: 'moderate',
  status,
  checkedAt: '2026-10-01T00:00:00.000Z',
});

function load(file: MeasurementsFile): void {
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    resultsUnwritten: false,
  });
}

const fileWith = (...ms: SurveyMeasurement[]): MeasurementsFile => ({
  ...emptyMeasurements(),
  measurements: ms,
});

const flagsOf = (id: string) => {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  return {
    results: m?.results.map((r) => r.qaFlags ?? null),
    series: m?.series?.map((r) => r.qaFlags ?? null),
  };
};

let stop: (() => void) | null = null;

beforeEach(() => {
  workspace.setState({ project: { id: 'p1', root: 'C:/p1', manifest } } as never);
  qaStore.setState({ projectId: 'p1', qa: {}, loadedFor: null });
  load(fileWith(pile('a')));
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe('stampQaFlags', () => {
  it('puts flags on results and series rows as derived data, not an edit', () => {
    stampQaFlags((r) => (r.toCapture === 'm2' ? { ...r, qaFlags: ['qa-hold'] } : r));
    expect(flagsOf('a')).toEqual({ results: [['qa-hold']], series: [null, ['qa-hold']] });
    const s = measureStore.getState();
    expect(isDirty(s)).toBe(false);
    expect(s.resultsUnwritten).toBe(true);
  });

  it('changes nothing when every row is already right', () => {
    const before = measureStore.getState().file;
    stampQaFlags((r) => r);
    expect(measureStore.getState().file).toBe(before);
    expect(measureStore.getState().resultsUnwritten).toBe(false);
  });

  it('never stamps a read-only project', () => {
    measureStore.setState({ readOnly: true });
    stampQaFlags((r) => ({ ...r, qaFlags: ['qa-hold'] }));
    expect(flagsOf('a').results).toEqual([null]);
  });
});

describe('connectQaFlags', () => {
  it('waits for the QA files, then keeps the flags in step with them', () => {
    stop = connectQaFlags();
    // QA not read yet: nothing is stamped "unchecked"
    expect(flagsOf('a').results).toEqual([null]);
    qaStore.setState({ loadedFor: 'p1', qa: {} });
    expect(flagsOf('a')).toEqual({ results: [['qa-unchecked']], series: [null, ['qa-unchecked']] });
    qaStore.setState({ qa: { m2: qa('m2', 'hold') } });
    expect(flagsOf('a').results).toEqual([['qa-hold', 'no-checkpoints']]);
    // a released hold, checked with good checkpoints
    qaStore.setState({
      qa: {
        m2: {
          ...qa('m2', 'released'),
          checkpoints: { count: 3, rmseM: 0.02, meanM: 0, maxAbsM: 0.03, points: [] },
        },
      },
    });
    expect(flagsOf('a').results).toEqual([['qa-released']]);
    // a measurement added later is stamped too
    load(fileWith(pile('a'), pile('b')));
    expect(flagsOf('b').results).toEqual([['qa-released']]);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('leaves the measurements of another project alone', () => {
    qaStore.setState({ loadedFor: 'other', qa: {} });
    stop = connectQaFlags();
    expect(flagsOf('a').results).toEqual([null]);
  });
});

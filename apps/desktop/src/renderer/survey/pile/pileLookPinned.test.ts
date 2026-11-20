// @vitest-environment jsdom
import type { Layer, ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { captureIndex, createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { MeasureState } from '../measureStore';
import { pileLookState } from './pileLookState';
import { lookTarget, outlineOn } from './pileLookTarget';

// the rule reads the measure store's types and helpers only; main is never called
vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({}) },
}));

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  ...(capture ? { capture } : {}),
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
  layers: [mesh('site'), mesh('model-jan', 'jan'), mesh('model-jun', 'jun')],
  severityModels: [],
  classCatalogues: [],
};

/** The same project with the January survey lined up 2 m east and 1 m south. */
const shifted: ProjectManifest = {
  ...manifest,
  captures: [
    {
      id: 'jan',
      label: 'January',
      date: '2026-01-01',
      lineUp: { eastM: 2, northM: -1, with: 'jun', at: '2026-06-02T00:00:00Z' },
    },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
};

const JAN_RING: SitePoint[] = [
  [0, 0, 100],
  [10, 0, 100],
  [10, 10, 100],
  [0, 10, 100],
];
const JUN_RING: SitePoint[] = [
  [0, 0, 101],
  [14, 0, 101],
  [14, 12, 101],
  [0, 12, 101],
];

const measurement = (
  id: string,
  scope: SurveyMeasurement['scope'],
  over: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id,
  scope,
  points: JAN_RING,
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
  ...over,
});

const measurements = [
  // a pile filed under the earlier date, with its own outline on each date
  measurement(
    'pile-jan',
    { kind: 'survey', capture: 'jan' },
    {
      points: JUN_RING,
      outlines: [
        { capture: 'jan', points: JAN_RING },
        { capture: 'jun', points: JUN_RING },
      ],
    },
  ),
  measurement('pile-jun', { kind: 'survey', capture: 'jun' }),
  measurement('pile-site', { kind: 'site' }),
  measurement('line', { kind: 'site' }, { family: 'line', tool: 'distance' }),
];

type Measure = Parameters<typeof lookTarget>[0];
const state = (over: Partial<Measure> = {}): Measure => ({
  file: { schema: 'aio.measurements/1', measurements },
  editing: null,
  draw: null,
  focus: null,
  ...over,
});
const EDITING = {} as NonNullable<MeasureState['editing']>;
const DRAWING = {} as NonNullable<MeasureState['draw']>;

// as the app opens a project with dates: the latest survey shows, the earlier one is hidden
const ws = createWorkspace();
ws.getState().openProject({ id: 'two-dates', root: 'E:/t', manifest });
ws.getState().setLayerVisible('model-jan', false);
ws.getState().setDates(captureIndex(manifest));
const screen = ws.getState();

describe('lookTarget with nothing pinned (the opened pile, as before)', () => {
  it('is the focused pile on screen, on the date in focus, in the mode the person chose', () => {
    const t = lookTarget(state({ focus: 'pile-jun' }), screen, 'jun', manifest, null, 'height');
    expect(t?.m.id).toBe('pile-jun');
    expect(t?.capture).toBe('jun');
    expect(t?.ring).toEqual(JAN_RING);
    expect(t?.mode).toBe('height');
    expect(t?.pinned).toBe(false);
    const solid = lookTarget(state({ focus: 'pile-jun' }), screen, 'jun', manifest, null, 'solid');
    expect(solid?.mode).toBe('solid');
  });

  it('reads the outline of the date in focus', () => {
    const t = lookTarget(state({ focus: 'pile-site' }), screen, 'jan', manifest, null, 'solid');
    expect(t?.capture).toBe('jan');
    const own = lookTarget(
      state({ focus: 'pile-jan' }),
      { ...screen, hidden: {} },
      'jan',
      manifest,
      null,
      'solid',
    );
    // with January's layers shown, the pile filed under it is on screen: that date's outline
    expect(own?.ring).toEqual(JAN_RING);
  });

  it('takes the latest date with no date in focus, and the own date without a project', () => {
    const t = lookTarget(state({ focus: 'pile-site' }), screen, null, manifest, null, 'solid');
    expect(t?.capture).toBe('jun');
    const bare = lookTarget(state({ focus: 'pile-jun' }), screen, null, null, null, 'solid');
    expect(bare?.capture).toBe('jun');
  });

  it('is nothing without a focus, for a line, or for a pile whose date is off screen', () => {
    expect(lookTarget(state(), screen, 'jun', manifest, null, 'solid')).toBeNull();
    expect(lookTarget(state({ focus: 'line' }), screen, 'jun', manifest, null, 'solid')).toBeNull();
    expect(
      lookTarget(state({ focus: 'pile-jan' }), screen, 'jun', manifest, null, 'solid'),
    ).toBeNull();
    expect(lookTarget(state({ focus: 'gone' }), screen, 'jun', manifest, null, 'solid')).toBeNull();
  });

  it('is nothing for a pile hidden by its own eye', () => {
    const s = state({ focus: 'pile-jun', hiddenMeasurements: ['pile-jun'] });
    expect(lookTarget(s, screen, 'jun', manifest, null, 'solid')).toBeNull();
  });

  it('is nothing while a boundary is edited or a measurement is drawn', () => {
    const editing = state({ focus: 'pile-jun', editing: EDITING });
    expect(lookTarget(editing, screen, 'jun', manifest, null, 'solid')).toBeNull();
    const drawing = state({ focus: 'pile-jun', draw: DRAWING });
    expect(lookTarget(drawing, screen, 'jun', manifest, null, 'solid')).toBeNull();
  });
});

describe('lookTarget with a pile pinned to a survey date (the report)', () => {
  const pin = { id: 'pile-jan', capture: 'jun' };

  it('is that pile on that date with that date’s outline, Solid, off screen and unfocused', () => {
    // the pile is filed under January, whose layers are hidden, and nothing is focused
    const t = lookTarget(state(), screen, 'jan', manifest, pin, 'height');
    expect(t?.m.id).toBe('pile-jan');
    expect(t?.capture).toBe('jun');
    expect(t?.ring).toEqual(JUN_RING);
    expect(t?.mode).toBe('solid');
    expect(t?.pinned).toBe(true);
  });

  it('reads the pinned date’s outline, not the one of the date in focus', () => {
    const jan = lookTarget(state(), screen, 'jun', manifest, { ...pin, capture: 'jan' }, 'solid');
    expect(jan?.capture).toBe('jan');
    expect(jan?.ring).toEqual(JAN_RING);
  });

  it('wins over the focused pile, also while something is drawn', () => {
    const s = state({ focus: 'pile-jun', draw: DRAWING });
    expect(lookTarget(s, screen, 'jun', manifest, pin, 'solid')?.m.id).toBe('pile-jan');
  });

  it('is shown although its own eye hides it', () => {
    const s = state({ hiddenMeasurements: ['pile-jan'] });
    expect(lookTarget(s, screen, 'jun', manifest, pin, 'solid')?.m.id).toBe('pile-jan');
  });

  it('is never a pile under edit', () => {
    const s = state({ focus: 'pile-jan', editing: EDITING });
    expect(lookTarget(s, screen, 'jun', manifest, pin, 'solid')).toBeNull();
  });

  it('is nothing for an id that is not a pile, and never falls back to the focused pile', () => {
    const s = state({ focus: 'pile-jun' });
    expect(lookTarget(s, screen, 'jun', manifest, { id: 'line', capture: 'jun' }, 'solid')).toBe(
      null,
    );
    expect(lookTarget(s, screen, 'jun', manifest, { id: 'gone', capture: 'jun' }, 'solid')).toBe(
      null,
    );
  });

  it('keeps the pile’s own scope shift on another date (a shifted survey date)', () => {
    const t = lookTarget(state(), screen, 'jun', shifted, pin, 'solid');
    expect(t?.capture).toBe('jun');
    // June's outline, moved by the line-up of January, the date the pile is filed under
    expect(t?.ring).toEqual(JUN_RING.map((p) => [p[0] + 2, p[1] - 1, p[2]]));
    // a pile filed under the unshifted date does not move
    const other = lookTarget(
      state(),
      screen,
      'jan',
      shifted,
      { id: 'pile-jun', capture: 'jan' },
      'solid',
    );
    expect(other?.ring).toEqual(JAN_RING);
  });
});

describe('outlineOn', () => {
  it('is the date’s own outline, else the stored points, where they are drawn', () => {
    const m = measurements[0];
    if (!m) throw new Error('fixture');
    expect(outlineOn(m, 'jan', manifest)).toEqual(JAN_RING);
    expect(outlineOn(m, null, manifest)).toEqual(JUN_RING);
    expect(outlineOn(m, 'jan', shifted)).toEqual(JAN_RING.map((p) => [p[0] + 2, p[1] - 1, p[2]]));
  });
});

describe('pileLookState', () => {
  it('starts with nothing pinned and no date shown', () => {
    const s = pileLookState.getState();
    expect(s.pinned).toBeNull();
    expect(s.shownOn).toBeNull();
    expect(s.shown).toBeNull();
  });
});

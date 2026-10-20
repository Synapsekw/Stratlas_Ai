import type { ProjectManifest } from '@aio/schema';
import type { Pin } from '@aio/survey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectionResult } from './sectionEngine';
import type { SectionChoice } from './sectionStore';

const engine = vi.hoisted(() => ({
  section: vi.fn(),
  pin: vi.fn(),
  setSources: vi.fn(() => Promise.resolve()),
}));
vi.mock('./sectionEngine', () => ({ sectionEngine: () => engine }));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));

const {
  addSurface,
  currentKey,
  openSection,
  removeSurface,
  sectionSeries,
  sectionStore,
  setShadeVs,
  toggleShown,
} = await import('./sectionStore');

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

// listed earlier survey last, the design first, so order alone gives the wrong kinds
const CHOICES: SectionChoice[] = [
  {
    key: 'design:d/pad',
    ref: { kind: 'design', design: 'd', layer: 'pad' },
    label: 'Design, pad',
    kind: 'design',
  },
  {
    key: 'survey:jun-dsm',
    ref: { kind: 'survey', surface: 'jun-dsm' },
    label: 'June DSM',
    kind: 'survey',
    capture: 'jun',
    date: '2026-06-01',
  },
  {
    key: 'survey:jan-dsm',
    ref: { kind: 'survey', surface: 'jan-dsm' },
    label: 'January DSM',
    kind: 'survey',
    capture: 'jan',
    date: '2026-01-01',
  },
];

const profile = (surface: string, z: number) => ({
  surface,
  label: surface,
  chainage: [0, 10],
  z: [z, z + 1],
});

const result = (keys: string[]): SectionResult => ({
  stepM: 10,
  length: 10,
  chainage: [0, 10],
  e: [0, 10],
  n: [0, 0],
  profiles: keys.map((k, i) => profile(k, i)),
  missing: [],
});

const pinOf = (reference: number): Pin => ({
  chainage: 5,
  e: 5,
  n: 0,
  reference,
  values: [],
});

beforeEach(() => {
  engine.section.mockImplementation((r: { refs: unknown[] }) =>
    Promise.resolve(result(r.refs.map((_, i) => String(i)))),
  );
  engine.pin.mockImplementation((r: { reference: number }) => Promise.resolve(pinOf(r.reference)));
});

afterEach(() => {
  sectionStore.setState({
    choices: [],
    selected: [],
    hidden: [],
    shadeVs: null,
    source: null,
    line: null,
    result: null,
    pins: [],
  });
  vi.clearAllMocks();
});

describe('section store on the profile chart', () => {
  it('series kinds come from the surface, not the order', () => {
    const s = {
      ...sectionStore.getState(),
      choices: CHOICES,
      selected: ['design:d/pad', 'survey:jan-dsm', 'survey:jun-dsm'],
      source: { kind: 'measurement' as const, id: 'm', label: 'M' },
      result: result(['survey:jan-dsm', 'design:d/pad', 'survey:jun-dsm']),
    };
    const series = sectionSeries(s, manifest);
    const kinds = Object.fromEntries(series.map((x) => [x.key, x.kind]));
    // a site-wide section is viewed on the latest survey
    expect(kinds).toEqual({
      'design:d/pad': 'design',
      'survey:jan-dsm': 'earlier',
      'survey:jun-dsm': 'current',
    });
    expect(series.find((x) => x.key === 'survey:jan-dsm')?.date).toBe('2026-01-01');
    // a section on the January survey is viewed on January: June is then the other survey
    const onJan = sectionSeries(
      { ...s, source: { kind: 'measurement', id: 'm', label: 'M', capture: 'jan' } },
      manifest,
    );
    expect(onJan.find((x) => x.kind === 'current')?.key).toBe('survey:jan-dsm');
  });

  it('removing the shade target clears shadeVs', () => {
    sectionStore.setState({
      choices: CHOICES,
      selected: ['survey:jun-dsm', 'survey:jan-dsm', 'design:d/pad'],
      hidden: [],
      shadeVs: 'survey:jan-dsm',
    });
    removeSurface('survey:jan-dsm');
    expect(sectionStore.getState().shadeVs).toBeNull();
    expect(sectionStore.getState().selected).toEqual(['survey:jun-dsm', 'design:d/pad']);

    // switching the target's chip off clears it too, and back on does not bring it back
    setShadeVs('design:d/pad');
    toggleShown('design:d/pad');
    expect(sectionStore.getState().hidden).toEqual(['design:d/pad']);
    expect(sectionStore.getState().shadeVs).toBeNull();
    toggleShown('design:d/pad');
    expect(sectionStore.getState().hidden).toEqual([]);
    expect(sectionStore.getState().shadeVs).toBeNull();

    // added back, it joins in the order the surfaces are listed
    addSurface({ kind: 'survey', surface: 'jan-dsm' });
    expect(sectionStore.getState().selected).toEqual([
      'design:d/pad',
      'survey:jun-dsm',
      'survey:jan-dsm',
    ]);
  });

  it('the current survey is shown by default', () => {
    expect(currentKey(CHOICES, null, manifest)).toBe('survey:jun-dsm');
    expect(
      currentKey(CHOICES, { kind: 'measurement', id: 'm', label: 'M', capture: 'jan' }, manifest),
    ).toBe('survey:jan-dsm');
    // nothing is on the chart yet: opening a section puts the current survey on it, alone
    sectionStore.setState({ choices: CHOICES, selected: [], hidden: [] });
    openSection(
      [
        [0, 0],
        [10, 0],
      ],
      { kind: 'measurement', id: 'm', label: 'M', capture: 'jan' },
      manifest,
    );
    expect(sectionStore.getState().selected).toEqual(['survey:jan-dsm']);
  });

  it('pins take their deltas from the shade target', async () => {
    sectionStore.setState({
      choices: CHOICES,
      selected: ['survey:jun-dsm', 'survey:jan-dsm'],
      hidden: [],
      shadeVs: null,
      source: { kind: 'measurement', id: 'm', label: 'M' },
      line: [
        [0, 0],
        [10, 0],
      ],
      pins: [pinOf(0)],
    });
    setShadeVs('survey:jan-dsm');
    await vi.waitFor(() => {
      expect(sectionStore.getState().pins[0]?.reference).toBe(1);
    });
  });
});

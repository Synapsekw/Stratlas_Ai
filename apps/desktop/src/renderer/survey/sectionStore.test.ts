import type { HeightTiles, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
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
const call = vi.hoisted(() => vi.fn());
vi.mock('../shell', () => ({ bridge: { call } }));

const {
  addSurface,
  currentKey,
  exportSection,
  isDismissed,
  kindOf,
  loadSectionSources,
  openSection,
  openSectionWindow,
  removeSurface,
  sectionSeries,
  sectionStore,
  setShadeVs,
  setWindow,
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
  it('another surface of the current survey is same-date, and the DSM is current', () => {
    const jun = (id: string, surface: 'dsm' | 'dtm' | 'cloud', edited = false): SectionChoice => ({
      key: `survey:${id}`,
      ref: { kind: 'survey', surface: id },
      label: id,
      kind: 'survey',
      capture: 'jun',
      date: '2026-06-01',
      surface,
      ...(edited ? { edited } : {}),
    });
    // listed cloud, DTM, edited DSM, DSM: the DSM is current whatever the order
    const list = [jun('cl', 'cloud'), jun('t', 'dtm'), jun('ed', 'dsm', true), jun('s', 'dsm')];
    expect(currentKey(list, null, manifest)).toBe('survey:s');
    expect(currentKey(list.slice(0, 3), null, manifest)).toBe('survey:ed');
    expect(currentKey(list.slice(0, 2), null, manifest)).toBe('survey:t');
    const current = list[3] ?? null;
    expect(list.map((c) => kindOf(c, current))).toEqual([
      'same-date',
      'same-date',
      'same-date',
      'current',
    ]);
    const jan = CHOICES[2];
    const design = CHOICES[0];
    if (!jan || !design) throw new Error('fixture');
    expect(kindOf(jan, current)).toBe('earlier');
    expect(kindOf(design, current)).toBe('design');
  });

  it('switching the current chip off clears shadeVs', () => {
    sectionStore.setState({
      choices: CHOICES,
      selected: ['survey:jun-dsm', 'survey:jan-dsm'],
      hidden: [],
      shadeVs: 'survey:jan-dsm',
      source: { kind: 'measurement', id: 'm', label: 'M' },
    });
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
    toggleShown('survey:jun-dsm');
    expect(sectionStore.getState().shadeVs).toBeNull();
    expect(sectionStore.getState().hidden).toEqual(['survey:jun-dsm']);
  });

  it('on first load only the current survey is on the chart', async () => {
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
    const tiles = (id: string, capture: string, kind: 'dsm' | 'dtm') =>
      ({ id, name: id, capture, source: { kind, layer: id } }) as unknown as HeightTiles;
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'survey:surfaces'
          ? {
              ok: true,
              value: {
                ok: true,
                surfaces: [
                  tiles('jun-dtm', 'jun', 'dtm'),
                  tiles('jan-dsm', 'jan', 'dsm'),
                  tiles('jun-dsm', 'jun', 'dsm'),
                ],
              },
            }
          : { ok: true, value: { ok: true, file: { designs: [] } } },
      ),
    );
    sectionStore.setState({ projectId: null });
    await loadSectionSources('p');
    const s = sectionStore.getState();
    expect(s.choices.map((c) => c.key)).toEqual([
      'survey:jun-dtm',
      'survey:jan-dsm',
      'survey:jun-dsm',
    ]);
    expect(s.selected).toEqual(['survey:jun-dsm']);
    expect(s.hidden).toEqual([]);
    // two surfaces on one date say which they are
    expect(s.choices[0]?.label).toMatch(/DTM$/);
  });

  it('the DXF holds only the surfaces drawn', async () => {
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
    sectionStore.setState({
      choices: CHOICES,
      selected: ['design:d/pad', 'survey:jun-dsm', 'survey:jan-dsm'],
      hidden: ['survey:jan-dsm'],
      source: { kind: 'measurement', id: 'm', label: 'Section (a)' },
      line: [
        [0, 0],
        [10, 0],
      ],
    });
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'dialog:savePath'
          ? { ok: true, value: { path: 'C:/out/x.dxf' } }
          : { ok: false, error: 'stop here' },
      ),
    );
    await exportSection('dxf-2d-xz');
    const save = call.mock.calls.find((c) => c[0] === 'dialog:savePath') as
      [string, { defaultName: string }] | undefined;
    expect(save?.[1].defaultName).toBe('Section-(a)-dxf-2d-xz.dxf');
    const start = call.mock.calls.find((c) => c[0] === 'jobs:start') as
      [string, { params: { surfaces: unknown[] } }] | undefined;
    expect(start?.[1].params.surfaces).toEqual([
      { kind: 'design', design: 'd', layer: 'pad' },
      { kind: 'survey', surface: 'jun-dsm' },
    ]);
  });
});

describe('the larger window', () => {
  const pile = { kind: 'measurement' as const, id: 'sp1', label: 'SP1' };
  const line: [number, number][] = [
    [0, 0],
    [10, 0],
  ];
  const shown = () => {
    const s = sectionStore.getState();
    return { dock: s.line !== null && !isDismissed(s) && !s.window, window: s.window };
  };
  afterEach(() => {
    sectionStore.setState({ window: false, windowAlone: false, dismissed: null });
  });

  it('opened on its own (a pile, a card) it closes with the section: no dock is left', () => {
    openSectionWindow(line, pile);
    expect(shown()).toEqual({ dock: false, window: true });
    setWindow(false);
    expect(shown()).toEqual({ dock: false, window: false });
  });

  it('popped out of the dock it returns to the dock', () => {
    openSection(line, pile);
    setWindow(true);
    expect(shown()).toEqual({ dock: false, window: true });
    setWindow(false);
    expect(shown()).toEqual({ dock: true, window: false });
  });

  it('opened for the section the dock shows, it returns to the dock', () => {
    openSection(line, pile);
    openSectionWindow(line, pile);
    setWindow(false);
    expect(shown()).toEqual({ dock: true, window: false });
  });

  it('opened on its own again after closing, it still opens alone', () => {
    openSectionWindow(line, pile);
    setWindow(false);
    openSectionWindow(line, pile);
    expect(shown()).toEqual({ dock: false, window: true });
    setWindow(false);
    expect(shown()).toEqual({ dock: false, window: false });
  });
});

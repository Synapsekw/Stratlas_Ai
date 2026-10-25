// @vitest-environment jsdom
// The volumetric report's run on the hidden house page: the editor's model kind publishes the
// model and lays nothing out; the PDF kind lays out the pages the text file turns on, one per
// printed page of the plan, with the person's edits read from `report/volumetric.json` (a `user`
// part as written, a `template` part generated again from the figures); without pictures the
// exports refuse and the model kind carries on.
import { pagePlan, type VolumetricModel } from '@aio/project/export';
import type {
  ProjectManifest,
  ReportTextFile,
  ReportViewsFrame,
  SiteMaterial,
  SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { describe, expect, it, vi } from 'vitest';
import type { ReportSurveyData, SurveyFiles, SurveyReader } from '../house/surveyData';
import { isVolumetricKind, runVolumetric, volumetricInputOf, type VolumetricRun } from './run';

const square = (e: number, side = 10): [number, number][] => [
  [e, 0],
  [e + side, 0],
  [e + side, side],
  [e, side],
];

const CAPTURES = [
  { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
  { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
];

const sand: SiteMaterial = {
  id: 'sand',
  name: 'Sand',
  densityTPerM3: 1.6,
  densityHistory: [
    { fromCapture: 'c1', tPerM3: 1.5 },
    { fromCapture: 'c2', tPerM3: 1.6 },
  ],
};

const measurement = (i: number): SurveyMeasurement => ({
  id: `m${String(i)}`,
  family: 'polygon',
  tool: 'volume',
  label: `P${String(i + 1)}`,
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-16T00:00:00Z',
});

const PILES = 3;

function files(): SurveyFiles {
  return {
    manifest: {
      name: 'Demo yard',
      customer: 'A customer',
      captures: CAPTURES,
      crs: { epsg: 32632 },
    } as unknown as ProjectManifest,
    measurements: Array.from({ length: PILES }, (_, i) => measurement(i)),
    surfaces: [{ id: 's2', capture: 'c2', cellM: 0.25, source: { kind: 'dsm' } }],
    settings: { materials: [sand] },
    kit: { densityTPerM3: 1.8, names: {} },
  } as unknown as SurveyFiles;
}

function survey(): ReportSurveyData {
  return {
    basis: { crs: 'EPSG:32632' },
    captures: CAPTURES,
    volumes: {
      inventory: [],
      piles: Array.from({ length: PILES }, (_, i) => ({
        id: `m${String(i)}`,
        ref: `M${String(i + 1)}`,
        label: `P${String(i + 1)}`,
        folder: null,
        // the first pile is the kit's, carrying its site-wide density
        material: i === 0 ? { id: 'kit', name: 'Stockpile', densityTPerM3: 1.8 } : sand,
        base: 'Lowest point on the outline',
        carried: null,
        rows: CAPTURES.map((c, k) => ({
          capture: c.id,
          date: c.date,
          label: c.label,
          valueM3: 100 * (i + 1) + k * 10,
          changeM3: null,
          tonnes: null,
          status: 'ok',
          stale: false,
          latest: k === 1,
        })),
        outline: square(20 * i, 12),
        // the first date has its own (smaller) outline
        outlines: { c1: square(20 * i, 10), c2: square(20 * i, 12) },
      })),
    },
  } as unknown as ReportSurveyData;
}

const FRAME: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [0, 0, 100, 100],
  widthPx: 1000,
  heightPx: 1000,
  mPerPx: 0.1,
  views: [
    { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' },
    { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
  ],
  markers3d: {},
  fingerprint: 'f',
};

const TEXT: ReportTextFile = {
  schema: 'aio.report-text/1',
  report: 'volumetric',
  parts: {
    summary: {
      versions: [{ text: 'Our own words.', source: 'user', createdAt: '2026-10-20T00:00:00Z' }],
    },
    method: {
      versions: [
        { text: 'A stale method note.', source: 'template', createdAt: '2026-10-20T00:00:00Z' },
      ],
    },
  },
  pileNotes: {
    m2: {
      versions: [{ text: 'Being loaded out.', source: 'user', createdAt: '2026-10-20T00:00:00Z' }],
    },
  },
  pages: { change: false },
};

function reader(over: { text?: unknown; frame?: unknown } = {}): SurveyReader {
  const store: Record<string, unknown> = {
    'report/volumetric.json': 'text' in over ? over.text : TEXT,
    'report/views/volumetric/frame.json': 'frame' in over ? over.frame : FRAME,
  };
  return {
    json: (path) => Promise.resolve(store[path] ?? null),
    text: () => Promise.resolve(null),
    bytes: () => Promise.resolve(null),
  };
}

type Published = Record<string, unknown>;

function harness(kind: VolumetricRun['kind'], over: Partial<VolumetricRun> = {}) {
  let state: Published = {};
  const root = document.createElement('div');
  const build = vi.fn(() => Promise.resolve(survey()));
  const run: VolumetricRun = {
    kind,
    read: reader(),
    files: files(),
    build,
    compare: null,
    companyName: 'Our company',
    pictureUrl: (path) => `aio://p/${path}`,
    root,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    settle: () => Promise.resolve(),
    ...over,
  };
  return { run, root, build, state: () => state };
}

describe('the volumetric report kinds', () => {
  it('knows its three kinds and nothing else', () => {
    expect(isVolumetricKind('volumetric-pdf')).toBe(true);
    expect(isVolumetricKind('volumetric-html')).toBe(true);
    expect(isVolumetricKind('volumetric-model')).toBe(true);
    expect(isVolumetricKind('survey')).toBe(false);
    expect(isVolumetricKind(null)).toBe(false);
  });
});

describe("the model's input from the app's figures", () => {
  it('takes each date on its own outline, with its density on that date', () => {
    const input = volumetricInputOf(files(), survey(), { compareWith: null, frame: null });
    expect(input.piles).toHaveLength(PILES);
    const [kit, own] = input.piles;
    expect(kit?.material).toEqual({ id: 'kit', name: 'Stockpile' });
    // the kit's site-wide density on every date
    expect(kit?.dates.map((d) => d.densityTPerM3)).toEqual([1.8, 1.8]);
    // the material's density on each date (`densityOn`: its history by date)
    expect(own?.dates.map((d) => d.densityTPerM3)).toEqual([1.5, 1.6]);
    expect(own?.dates.map((d) => d.outline)).toEqual([square(20, 10), square(20, 12)]);
    expect(own?.dates.map((d) => d.areaM2)).toEqual([100, 144]);
    expect(own?.dates.map((d) => d.volumeM3)).toEqual([200, 210]);
    expect(input.method).toEqual({ cellM: 0.25, gsdCm: null, siteDensityTPerM3: 1.8 });
    expect(input.project).toEqual({
      name: 'Demo yard',
      customer: 'A customer',
      site: null,
      crs: 'EPSG:32632',
    });
  });

  it('leaves out a stale date', () => {
    const s = survey();
    const row = s.volumes.piles[1]?.rows[0];
    if (row) row.stale = true;
    const input = volumetricInputOf(files(), s, { compareWith: null, frame: null });
    expect(input.piles[1]?.dates[0]?.volumeM3).toBeNull();
  });

  it("carries each date's peak height, none on a stale date or a date without one", () => {
    const s = survey();
    const pile = s.volumes.piles[1];
    if (pile) pile.peaks = { c1: 3.25, c2: 4.5 };
    const row = s.volumes.piles[1]?.rows[0];
    if (row) row.stale = true;
    const input = volumetricInputOf(files(), s, { compareWith: null, frame: null });
    expect(input.piles[1]?.dates.map((d) => d.peakM)).toEqual([null, 4.5]);
    expect(input.piles[0]?.dates.map((d) => d.peakM)).toEqual([null, null]);
  });
});

describe('the volumetric run', () => {
  it('publishes the model for the editor and lays nothing out', async () => {
    const h = harness('volumetric-model', { compare: 'c1' });
    await runVolumetric(h.run);
    const s = h.state();
    expect(s.state).toBe('ready');
    const model = s.model as VolumetricModel;
    expect(model.piles).toHaveLength(PILES);
    expect(model.compared?.id).toBe('c1');
    expect(model.frame).toEqual(FRAME);
    expect(h.root.innerHTML).toBe('');
    expect(h.build).toHaveBeenCalledOnce();
    // JSON safe: main reads it through JSON.stringify
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it('gives the editor its model without pictures (the preview shows placeholders)', async () => {
    const h = harness('volumetric-model', { read: reader({ frame: null }) });
    await runVolumetric(h.run);
    expect(h.state().state).toBe('ready');
    expect((h.state().model as VolumetricModel).frame).toBeNull();
  });

  it('lays out the pages the text file turns on, one per printed page', async () => {
    const h = harness('volumetric-pdf');
    await runVolumetric(h.run);
    const s = h.state();
    expect(s.state).toBe('ready');
    const pages = h.root.querySelectorAll('.vr-page');
    expect(pages.length).toBeGreaterThan(0);
    expect(s.pages).toBe(pages.length);
    // page C is off in the text file
    const model = (await (async () => {
      const m = harness('volumetric-model');
      await runVolumetric(m.run);
      return m.state().model as VolumetricModel;
    })()) satisfies VolumetricModel;
    const plan = pagePlan(model, { cover: true, piles: true, change: false });
    expect(s.pages).toBe(plan.length);
    expect(h.root.innerHTML).toContain('aio://p/report/views/volumetric/photo-c2.jpg');
  });

  it("prints the person's edits and regenerates the parts that follow the figures", async () => {
    const h = harness('volumetric-pdf');
    await runVolumetric(h.run);
    const html = h.root.innerHTML;
    expect(html).toContain('Our own words.');
    expect(html).not.toContain('A stale method note.');
    expect(html).toContain('Being loaded out.');
  });

  it('compares with the date the text file names, not the query, for the exports', async () => {
    const two = survey();
    const h = harness('volumetric-pdf', {
      read: reader({ text: { ...TEXT, compareWith: 'c1' } }),
      build: () => Promise.resolve(two),
    });
    await runVolumetric(h.run);
    expect(h.state().state).toBe('ready');
  });

  it('refuses the exports without pictures', async () => {
    for (const kind of ['volumetric-pdf', 'volumetric-html'] as const) {
      const h = harness(kind, { read: reader({ frame: null }) });
      await expect(runVolumetric(h.run)).rejects.toThrow(t('vreport.error.noPictures'));
      expect(h.root.innerHTML).toBe('');
    }
  });

  it('refuses a project with no stockpile volumes', async () => {
    const h = harness('volumetric-pdf', { files: null });
    await expect(runVolumetric(h.run)).rejects.toThrow(t('vreport.error.notOffered'));
  });

  it('reads an unreadable text file as no edits', async () => {
    const h = harness('volumetric-pdf', { read: reader({ text: { schema: 'nope' } }) });
    await runVolumetric(h.run);
    expect(h.state().state).toBe('ready');
    expect(h.root.innerHTML).not.toContain('Our own words.');
  });
});

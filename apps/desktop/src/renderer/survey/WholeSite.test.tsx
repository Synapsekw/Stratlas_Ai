// @vitest-environment jsdom
import { defaultSurveySettings, type ComparisonResult } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(
  (): { compare: Record<string, unknown>; measure: Record<string, unknown> } => ({
    compare: {},
    measure: {},
  }),
);
const tick = (el: Element | null) => {
  if (!(el instanceof HTMLInputElement)) throw new Error('no checkbox');
  act(() => {
    el.click();
  });
};

vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: [], layers: [] } } }),
  workspace: { getState: () => ({ dates: {} }) },
  assetUrl: (id: string, ref: { path: string }) => `aio://project/${id}/${ref.path}`,
}));
vi.mock('../author', () => ({ authorName: () => '' }));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));
vi.mock('../workspace/timeline', () => ({ timeline: { getState: () => ({ focus: null }) } }));
vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  compareStore: { getState: () => s.compare },
  engineClient: vi.fn(),
  openCompareDialog: vi.fn(),
  patchSite: vi.fn(),
  setSite: vi.fn(),
}));
vi.mock('./MagicPolygon', () => ({
  magicStatus: vi.fn(),
  projectOutline: () => null,
  unavailableText: () => '',
}));
vi.mock('./dateSurfaces', () => ({ storedFromPrepared: (p: unknown) => p }));
vi.mock('./measureSource', () => ({ creationDating: () => ({ scope: { kind: 'site' } }) }));
vi.mock('./measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  measureStore: { getState: () => ({ surface: null }) },
  addMeasurement: vi.fn(),
  newMeasurementId: () => 'm-new',
}));
vi.mock('./snapRegions', () => ({ snapRegion: vi.fn() }));

const { WholeSite } = await import('./WholeSite');

const result: ComparisonResult = {
  item: 'site',
  status: 'partial',
  reason: 'the north edge',
  cutM3: 120,
  fillM3: 80,
  netM3: -40,
  totalM3: 200,
  areaM2: 1000,
  areaCutM2: 600,
  areaFillM2: 400,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'a',
  toLabel: 'b',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-11-18T00:00:00Z',
};

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root = createRoot(host);
  act(() => {
    root?.render(<WholeSite />);
  });
};
const dialog = () => document.querySelector('[data-testid="survey-site"]');
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  s.compare = { surfaces: [], designs: [], captures: [], root: 'C:/p', site: null };
  s.measure = { settings: defaultSurveySettings(), readOnly: false };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('the Find cut and fill regions dialog', () => {
  it('is named for what only it does, and says where the totals are', () => {
    render();
    expect(dialog()?.textContent).toContain('Find cut and fill regions');
    expect(dialog()?.textContent).not.toContain('Whole site cut and fill');
    expect(q('survey-site-totals-hint')?.textContent).toBe(
      'The totals between two surveys are in Project > Volumes > Cut & fill.',
    );
    // the same words as before, from the catalogue
    expect(dialog()?.textContent).toContain(
      'Compares two surfaces over their overlap in a background job, then suggests cut and fill regions you can keep as measurements.',
    );
    expect(dialog()?.textContent).toContain('Prepare the survey surfaces first (in a comparison).');
    expect(q('survey-site-from')?.closest('label')?.textContent).toContain('From');
    expect(q('survey-site-to')?.closest('label')?.textContent).toContain('To');
    expect(q('survey-site-run')?.textContent).toBe('Compare');
  });

  it('shows the result, the drafts and their buttons in the words it had', () => {
    s.compare.site = {
      job: null,
      progress: 1,
      out: 'survey/compare/site-x',
      from: { kind: 'previous' },
      to: { kind: 'current' },
      deadbandM: null,
      result,
      tiles: null,
      error: null,
      drafts: [
        { kind: 'cut', ring: [], volumeM3: 12, areaM2: 30 },
        { kind: 'fill', ring: [], volumeM3: 8, areaM2: 20 },
      ],
    };
    render();
    const rows = [...(q('survey-site-result')?.querySelectorAll('th') ?? [])].map(
      (th) => th.textContent,
    );
    expect(rows).toEqual(['Cut', 'Fill', 'Net', 'Total']);
    expect(dialog()?.textContent).toContain('Partly outside the survey: the north edge');
    const drafts = q('survey-site-drafts');
    expect(drafts?.querySelector('legend')?.textContent).toBe('Suggested regions (drafts)');
    const lines = [...(drafts?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(lines[0]).toMatch(/^Cut region 1: about 12(\.0+)? m³ over 30(\.0+)? m²$/);
    expect(lines[1]).toMatch(/^Fill region 2: about 8(\.0+)? m³ over 20(\.0+)? m²$/);
    expect(q('survey-site-accept')?.textContent).toBe('Keep as volume measurements');
    expect(q('survey-site-snap')?.textContent).toBe('Snap to ortho edges');
    // ticked: the button counts them
    tick(q('survey-site-draft'));
    expect(q('survey-site-accept')?.textContent).toBe('Keep 1 as volume measurements');
  });

  it('while the job runs the button says how far it is', () => {
    s.compare.site = {
      job: 'j1',
      progress: 0.42,
      out: 'x',
      from: { kind: 'previous' },
      to: { kind: 'current' },
      deadbandM: null,
      result: null,
      tiles: null,
      error: null,
      drafts: [],
    };
    render();
    expect(q('survey-site-run')?.textContent).toBe('Comparing… 42%');
  });
});

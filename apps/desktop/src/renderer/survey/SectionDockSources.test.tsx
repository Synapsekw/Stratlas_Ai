// @vitest-environment jsdom
/**
 * The section's sources follow the site's surfaces: a project opened before its surfaces were
 * prepared (they are prepared in the background) draws its section chart once they are.
 */
import {
  emptyMeasurements,
  type HeightTiles,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectionResult } from './sectionEngine';

const engine = vi.hoisted(() => ({
  section: vi.fn(),
  pin: vi.fn(),
  setSources: vi.fn(() => Promise.resolve()),
}));
vi.mock('./sectionEngine', () => ({ sectionEngine: () => engine }));
const call = vi.hoisted(() => vi.fn());
vi.mock('../shell', () => ({
  bridge: { call },
  useShell: <T,>(pick: (s: { pkg: null }) => T) => pick({ pkg: null }),
}));
vi.mock('../shell/actions/measureActions', () => ({ measureEditBlocked: () => false }));
vi.mock('../report/templateStore', () => ({ addToReport: vi.fn() }));

const { SectionDock } = await import('./SectionDock');
const { sectionStore } = await import('./sectionStore');
const { measureStore } = await import('./measureStore');
const { compareStore } = await import('./compareStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [{ id: 'jun', label: 'June', date: '2026-06-01' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const section: SurveyMeasurement = {
  id: 's1',
  family: 'line',
  tool: 'section',
  label: 'Section 1',
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-20T00:00:00Z',
};

const tiles = { id: 'jun-dsm', name: 'jun-dsm', capture: 'jun', source: { kind: 'dsm' } };
const surface = tiles as unknown as HeightTiles;

const result = (keys: string[]): SectionResult => ({
  stepM: 5,
  length: 10,
  chainage: [0, 5, 10],
  e: [0, 5, 10],
  n: [0, 0, 0],
  profiles: keys.map((k) => ({ surface: k, label: k, chainage: [0, 5, 10], z: [1, 2, 1] })),
  missing: [],
});

let prepared: HeightTiles[] = [];
let root: Root | undefined;
let host: HTMLDivElement;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(() => Promise.resolve());
};
const surfaceReads = () => call.mock.calls.filter(([c]) => c === 'survey:surfaces').length;

beforeEach(() => {
  prepared = [];
  call.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === 'survey:surfaces'
        ? { ok: true, value: { ok: true, surfaces: prepared } }
        : { ok: false, error: 'no designs' },
    ),
  );
  engine.section.mockImplementation((req: { refs: { surface?: string }[] }) =>
    Promise.resolve(result(req.refs.map((r) => `survey:${r.surface ?? ''}`))),
  );
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  measureStore.setState({ file: emptyMeasurements(), focus: null });
  sectionStore.setState({ line: null, source: null, dismissed: null, window: false });
  compareStore.setState({ surfaces: [] });
  workspace.getState().closeProject();
  call.mockReset();
  engine.section.mockReset();
});

describe('the section dock and the surfaces prepared after the project opened', () => {
  it('reads the sources again when the surfaces change and draws the chart', async () => {
    root = createRoot(host);
    act(() => root?.render(<SectionDock stage={null} />));
    await flush();
    act(() => {
      measureStore.setState({
        file: { ...emptyMeasurements(), measurements: [section] },
        focus: 's1',
      });
    });
    await flush();
    // nothing prepared yet: no surface on the chart, the empty placeholder shows
    expect(sectionStore.getState().selected).toEqual([]);
    expect(sectionStore.getState().result).toBeNull();
    expect(host.querySelector('[data-testid="section-chart"]')).toBeNull();
    expect(host.querySelector('.sec-empty')).not.toBeNull();
    const before = surfaceReads();

    // the background prepare ends: the compare store reads the new surfaces
    prepared = [surface];
    act(() => {
      compareStore.setState({ surfaces: [surface] });
    });
    await flush();
    expect(surfaceReads()).toBeGreaterThan(before);
    expect(sectionStore.getState().selected).toContain('survey:jun-dsm');
    expect(host.querySelector('[data-testid="section-chart"]')).not.toBeNull();
    expect(host.querySelector('.sec-empty')).toBeNull();
  });
});

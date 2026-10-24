// @vitest-environment jsdom
import { emptyMeasurements, type ProjectManifest, type SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./SectionBody', () => ({ SectionBody: () => <div data-testid="section-body" /> }));
vi.mock('./sectionEngine', () => ({
  sectionEngine: () => ({
    section: vi.fn(() => new Promise(() => undefined)),
    pin: vi.fn(),
    setSources: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('./sectionStore', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSectionSources: () => Promise.resolve(),
}));

const { SectionDock } = await import('./SectionDock');
const { sectionStore } = await import('./sectionStore');
const { measureStore } = await import('./measureStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const section = (id: string): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'section',
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-20T00:00:00Z',
});
const distance = (id: string): SurveyMeasurement => ({ ...section(id), tool: 'distance' });

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  host = document.createElement('div');
  document.body.append(host);
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [section('s1'), distance('d1')] },
    focus: 's1',
  });
  root = createRoot(host);
  act(() => root?.render(<SectionDock stage={null} />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  measureStore.setState({ file: emptyMeasurements(), focus: null });
  sectionStore.setState({ line: null, source: null, dismissed: null, window: false });
  workspace.getState().closeProject();
});

const dock = () => host.querySelector('[data-testid="section-dock"]');

describe('the section dock', () => {
  it('the dock closes when its measurement is deleted and has a close button', () => {
    expect(dock()).not.toBeNull();
    act(() => {
      measureStore.setState({
        file: { ...emptyMeasurements(), measurements: [distance('d1')] },
        focus: null,
      });
    });
    expect(dock()).toBeNull();
  });

  it('closes when its measurement is no longer focused, opens again on focus', () => {
    act(() => {
      measureStore.setState({ focus: 'd1' });
    });
    expect(dock()).toBeNull();
    act(() => {
      measureStore.setState({ focus: 's1' });
    });
    expect(dock()).not.toBeNull();
  });

  it('a visible close button closes it', () => {
    const close = host.querySelector<HTMLButtonElement>('[data-testid="section-close"]');
    expect(close?.getAttribute('aria-label')).toBe('Close the section');
    act(() => close?.click());
    expect(dock()).toBeNull();
  });

  it("the larger window takes the dock's place while it is open", () => {
    act(() => {
      sectionStore.setState({ window: true });
    });
    expect(dock()).toBeNull();
    expect(host.querySelector('[data-testid="section-window"]')).not.toBeNull();
    act(() => {
      sectionStore.setState({ window: false });
    });
    expect(dock()).not.toBeNull();
  });

  it('another change to the file leaves the focused section open', () => {
    act(() => {
      measureStore.setState({
        file: {
          ...emptyMeasurements(),
          measurements: [section('s1'), distance('d1'), distance('d2')],
        },
      });
    });
    expect(dock()).not.toBeNull();
  });
});

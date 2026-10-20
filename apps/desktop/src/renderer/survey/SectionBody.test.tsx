// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sectionEngine', () => ({
  sectionEngine: () => ({
    section: vi.fn(),
    pin: vi.fn(),
    setSources: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  useShell: <T,>(pick: (s: { pkg: null }) => T) => pick({ pkg: null }),
}));
vi.mock('../shell/actions/measureActions', () => ({ measureEditBlocked: () => false }));
vi.mock('./card/exportMeasurement', () => ({ exportMeasurement: vi.fn() }));
const report = vi.hoisted(() => ({ addToReport: vi.fn(() => Promise.resolve('added')) }));
vi.mock('../report/templateStore', () => report);

const { SectionBody } = await import('./SectionBody');
const { sectionStore } = await import('./sectionStore');
const { measureStore } = await import('./measureStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;

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

beforeEach(() => {
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  host = document.createElement('div');
  document.body.append(host);
  sectionStore.setState({
    choices: [
      {
        key: 'survey:a',
        ref: { kind: 'survey', surface: 'a' },
        label: 'Survey A',
        kind: 'survey',
      },
    ],
    selected: ['survey:a'],
    hidden: [],
    shadeVs: null,
    source: { kind: 'measurement', id: 'm1', label: 'Section 1' },
    line: [
      [0, 0],
      [10, 0],
    ],
    result: {
      stepM: 5,
      length: 10,
      chainage: [0, 5, 10],
      e: [0, 5, 10],
      n: [0, 0, 0],
      profiles: [{ surface: 'survey:a', label: 'Survey A', chainage: [0, 5, 10], z: [1, 2, 3] }],
      missing: [],
    },
    pins: [],
    exaggeration: 5,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

function mount() {
  root = createRoot(host);
  act(() => root?.render(<SectionBody />));
}

const actionLabels = () =>
  Array.from(host.querySelectorAll('.pc-actions button')).map((b) => b.textContent.trim());

describe('the section body on the profile chart', () => {
  it('toolbar has PNG, DXF, CSV and Add to report only', () => {
    mount();
    expect(actionLabels()).toEqual(['PNG', 'DXF…', 'CSV', 'Add to report']);
    // the five DXF buttons and the format select are gone
    expect(host.querySelector('[data-testid="section-format"]')).toBeNull();
    // the chart carries the measurement, so the registry's PNG export finds it
    expect(host.querySelector('[data-measure-id="m1"] svg.pc-svg')).not.toBeNull();
  });

  it('DXF opens the dialog with five variants', () => {
    mount();
    const dxf = Array.from(host.querySelectorAll<HTMLButtonElement>('.pc-actions button')).find(
      (b) => b.textContent.trim() === 'DXF…',
    );
    act(() => dxf?.click());
    const dialog = document.querySelector('[data-testid="export-format-dialog"]');
    expect(dialog).not.toBeNull();
    const radios = dialog?.querySelectorAll('input[type="radio"]') ?? [];
    expect(radios.length).toBe(5);
    expect(dialog?.textContent).not.toContain('CSV');
  });

  it('exaggeration slider still 1 to 20', () => {
    mount();
    const slider = host.querySelector<HTMLInputElement>('[data-testid="section-exaggeration"]');
    expect(slider?.min).toBe('1');
    expect(slider?.max).toBe('20');
    expect(slider?.value).toBe('5');
  });

  it('Add to report adds the section measurement', async () => {
    mount();
    const add = Array.from(host.querySelectorAll<HTMLButtonElement>('.pc-actions button')).find(
      (b) => b.textContent.trim() === 'Add to report',
    );
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    expect(report.addToReport).toHaveBeenCalledWith('m1');
  });

  it('pin deltas follow the site units, in feet', () => {
    const settings = measureStore.getState().settings;
    measureStore.setState({
      settings: { ...settings, units: { ...settings.units, distance: 'ft' } },
    });
    sectionStore.setState({
      choices: [
        {
          key: 'survey:a',
          ref: { kind: 'survey', surface: 'a' },
          label: 'Survey A',
          kind: 'survey',
        },
        {
          key: 'design:d/p',
          ref: { kind: 'design', design: 'd', layer: 'p' },
          label: 'Pad',
          kind: 'design',
        },
      ],
      selected: ['survey:a', 'design:d/p'],
      shadeVs: 'design:d/p',
      pins: [
        {
          chainage: 5,
          e: 5,
          n: 0,
          reference: 1,
          values: [
            { key: 'survey:a', label: 'Survey A', z: 2, delta: 0.3048, grade: null },
            { key: 'design:d/p', label: 'Pad', z: 1.6952, delta: 0, grade: null },
          ],
        },
      ],
    });
    try {
      mount();
      const deltas = Array.from(host.querySelectorAll('[data-testid="section-pin-delta"]')).map(
        (x) => x.textContent,
      );
      // 0.3048 m is one foot, in the site distance precision
      expect(deltas[0]).toBe('Δ +1.000 ft');
      // the shade target's own row has no delta
      expect(deltas[1]).toBe('');
    } finally {
      measureStore.setState({ settings });
    }
  });
});

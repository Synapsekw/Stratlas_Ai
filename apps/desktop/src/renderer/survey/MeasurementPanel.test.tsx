// @vitest-environment jsdom
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const look = vi.hoisted(() => ({ only: false }));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => look.only,
}));

const history = vi.hoisted(() => ({
  rows: [] as { capture: string; label: string; date: string; z: number | null }[],
  asked: [] as [number, number][],
}));
vi.mock('./card/pointHistory', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pointHistory: (_dated: unknown, e: number, n: number) => {
    history.asked.push([e, n]);
    return Promise.resolve(history.rows);
  },
}));

import type { HeightTiles } from '@aio/schema';
import { MeasurementPanel } from './MeasurementPanel';
import { measureStore } from './measureStore';
import { qaStore } from './qaStore';

const tiles = (id: string, capture: string) =>
  ({
    schema: 'aio.height-tiles/1',
    id,
    name: id,
    source: { kind: 'dsm', layer: 'dsm' },
    capture,
    crs: { epsg: 32640 },
    cellM: 1,
    tileSize: 256,
    originE: 0,
    originN: 0,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [0, 0, 0, 256, 256, 10],
    tiles: [],
    fingerprint: id,
    preparedAt: '2026-10-20T00:00:00Z',
  }) as HeightTiles;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The second date is lined up 2 m east and 1 m south. */
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    {
      id: 'jun',
      label: 'June',
      date: '2026-06-01',
      lineUp: { eastM: 2, northM: -1, with: 'jan', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const spot: SurveyMeasurement = {
  id: 'spot',
  family: 'point',
  tool: 'elevation-difference',
  label: 'Spot',
  scope: { kind: 'survey', capture: 'jun' },
  points: [[100, 200, 5]],
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
};

let host: HTMLDivElement;
let root: Root | undefined;
let sampled: [number, number][] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  sampled = [];
  workspace.getState().openProject({ id: 'two-dates', root: 'E:/p', manifest });
  measureStore.setState({
    editing: null,
    focus: 'spot',
    selected: ['spot'],
    readOnly: false,
    file: { schema: 'aio.measurements/1', measurements: [spot] },
    surface: {
      heightAt: (e, n) => {
        sampled.push([e, n]);
        return 3;
      },
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  look.only = false;
  measureStore.setState({ focus: null, selected: [], surface: null });
  qaStore.setState({ surfaces: [] });
  history.asked = [];
  workspace.getState().closeProject();
});

/** A row of the card's full readout ("More"), by its label. */
const cell = (label: string) => {
  const more = host.querySelector<HTMLButtonElement>('[data-testid="card-more"]');
  if (more?.getAttribute('aria-expanded') === 'false')
    act(() => {
      more.click();
    });
  const row = [...host.querySelectorAll('[data-testid="card-readout"] tr')].find(
    (r) => r.querySelector('th')?.textContent === label,
  );
  return row?.querySelector('td')?.textContent ?? '';
};

describe('the measurement panel on a lined-up date', () => {
  it('reads out and samples the measurement where it is drawn', () => {
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    // stored at E 100, N 200; drawn 2 m east and 1 m south: the surface there is 3, the point 5
    expect(cell('Surface elevation')).toContain('3.00');
    // the terrain is sampled under the point the person sees, not the stored one
    expect(sampled).toContainEqual([102, 199]);
    expect(sampled).not.toContainEqual([100, 200]);
    // the vertex fields show the drawn position too (an edit there is in the drawn frame)
    const east = host.querySelector<HTMLInputElement>('input[aria-label="Vertex 1 E"]');
    expect(east?.value).toBe('102.000');
  });

  it('shows the easting and northing of the drawn point', () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [{ ...spot, tool: 'elevation' }] },
    });
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    expect(cell('Easting')).toContain('102');
    expect(cell('Northing')).toContain('199');
  });
});

describe('the measurement panel for a look-only reviewer', () => {
  it('shows the measurement and offers no edits, as the tree and the 3D menu do', () => {
    look.only = true;
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    const card = host.querySelector('[data-testid="survey-panel"]');
    expect(card).not.toBeNull();
    // the shared card in its detail variant, its name a heading, not a field
    expect(card?.getAttribute('data-variant')).toBe('detail');
    expect(card?.getAttribute('data-measure-id')).toBe('spot');
    expect(host.querySelector('[data-testid="card-name"]')?.tagName).toBe('H3');
    expect(host.textContent).not.toContain('Delete measurement');
  });
});

describe('the point card', () => {
  it('point card shows elevation over time and Survey QA has no history panel', async () => {
    measureStore.setState({
      file: {
        schema: 'aio.measurements/1',
        measurements: [{ ...spot, tool: 'elevation-history' }],
      },
    });
    qaStore.setState({ surfaces: [tiles('sjan', 'jan'), tiles('sjun', 'jun')] });
    history.rows = [
      { capture: 'jan', label: 'January', date: '2026-01-01', z: 4.5 },
      { capture: 'jun', label: 'June', date: '2026-06-01', z: 5 },
    ];
    await act(async () => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
      await Promise.resolve();
    });
    const card = host.querySelector('[data-testid="survey-panel"]');
    // a real time chart: the dates on a time axis, the elevation in the site's units
    const chart = card?.querySelector('[data-testid="elevation-time"]');
    expect(chart).not.toBeNull();
    // the point comes from the measurement (where it is drawn), not typed in
    expect(history.asked).toEqual([[102, 199]]);
    expect(card?.querySelector('[data-testid="history-e"]')).toBeNull();
    expect(card?.querySelectorAll('input[inputmode="decimal"]').length).toBe(0);
  });
});

// @vitest-environment jsdom
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeasurementPanel } from './MeasurementPanel';
import { measureStore } from './measureStore';

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
  measureStore.setState({ focus: null, selected: [], surface: null });
  workspace.getState().closeProject();
});

const cell = (key: string) =>
  host.querySelector(`[data-testid="survey-readout"] tr[data-key="${key}"] td`)?.textContent ?? '';

describe('the measurement panel on a lined-up date', () => {
  it('reads out and samples the measurement where it is drawn', () => {
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    // stored at E 100, N 200; drawn 2 m east and 1 m south: the surface there is 3, the point 5
    expect(cell('surface-z')).toContain('3.00');
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
    expect(cell('e')).toContain('102');
    expect(cell('n')).toContain('199');
  });
});

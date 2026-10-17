// @vitest-environment jsdom
import type { RoadModel } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roadStore, setRoad } from '../../../road/store';
import { shell } from '../../../shell';
import { sectionStore } from '../sectionState';
import { RoadBench } from './RoadBench';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const road = {
  schema: 'aio.road/1',
  name: 'Test',
  centreline: { points: [], chainageKm: [], lengthKm: 1 },
  pci: {
    standard: 'ASTM D6433',
    headline: 'medium',
    network: { low: 80, medium: 70, high: 60 },
    units: [],
    ratings: [
      { min: 86, label: 'Good', color: '#1f9d55' },
      { min: 41, label: 'Poor', color: '#f2994a' },
      { min: 0, label: 'Failed', color: '#6d6d6d' },
    ],
  },
  density: {
    gridOrigin: [0, 0, 0],
    sizes: { '20': [{ i: 0, j: 0, pavementM2: 400, defects: 3, defectM2: 8, coverPct: 2 }] },
  },
  overlays: {},
} as unknown as RoadModel;

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<RoadBench />);
  });
};
const button = (name: string) =>
  // a button that is off for a reason carries it as hidden text after its name
  [...host.querySelectorAll('button')].find((b) => b.textContent.startsWith(name));
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const section = (id: string) => host.querySelector(`[data-testid="wb-section-${id}"]`);

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  roadStore.setState(roadStore.getInitialState());
  setRoad({ road, status: 'ready' });
  shell.getState().setStageMode('map');
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  roadStore.setState(roadStore.getInitialState());
  shell.getState().setStageMode('3d');
});

describe('RoadBench', () => {
  it('has the road sections: overlay, close-up, layers and measure', () => {
    render();
    const heads = [...host.querySelectorAll('.wb-section-head')].map((h) => h.textContent);
    expect(heads).toEqual(['Overlay', 'Close-up', 'Layers', 'Measure']);
    // the overlay section is open to start with, the rest folded
    expect(section('overlay')?.getAttribute('data-open')).toBe('true');
    expect(section('layers')?.getAttribute('data-open')).toBe('false');
  });

  it('renders the road layers: orthomosaic, centreline and what the defects are coloured by', () => {
    render();
    click(section('layers')?.querySelector('.wb-section-head'));
    const layers = section('layers');
    expect(layers?.textContent).toContain('Orthomosaic');
    expect(layers?.textContent).toContain('Centreline and chainage');
    expect(layers?.querySelector('[aria-label="Colour defects by"]')).not.toBeNull();
    // the centreline switch is the store's
    const box = layers?.querySelectorAll('input[type="checkbox"]')[1];
    expect(roadStore.getState().centreline).toBe(true);
    click(box);
    expect(roadStore.getState().centreline).toBe(false);
  });

  it('picks the area overlay and shows its legend under it', () => {
    render();
    expect(host.querySelector('[data-testid="road-legend"]')).toBeNull();
    click(button('PCI grid'));
    expect(roadStore.getState().overlay).toBe('pci');
    const legend = host.querySelector('[data-testid="road-legend"]');
    expect(legend?.textContent).toContain('PCI · ASTM D6433');
    expect(legend?.textContent).toContain('Good');
    click(button('Density'));
    expect(host.querySelector('[data-testid="road-legend"]')?.textContent).toContain(
      'Defect density · 20 m cells',
    );
    // the map's own legend carries the label; the bench shows no second one
    expect(host.querySelector('[aria-label="Density legend"]')).toBeNull();
  });

  it('toggles the close-up and the measure on the map', () => {
    render();
    expect(roadStore.getState().closeup).toBe(true);
    click(button('Close-up of the selected defect'));
    expect(roadStore.getState().closeup).toBe(false);
    click(button('Measure on the map'));
    expect(roadStore.getState().measure.mode).toBe('line');
    click(button('Measure on the map'));
    expect(roadStore.getState().measure.mode).toBeNull();
  });

  it('leaves the close-up and the measure to the map: not in the 3D view', () => {
    shell.getState().setStageMode('3d');
    render();
    const measure = button('Measure on the map');
    expect(measure?.getAttribute('aria-disabled')).toBe('true');
    click(measure);
    expect(roadStore.getState().measure.mode).toBeNull();
    expect(button('Close-up of the selected defect')?.getAttribute('aria-disabled')).toBe('true');
  });
});

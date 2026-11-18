// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sectionDef, type SectionDef } from '../tabsModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  measure: { file: { measurements: [] as SurveyMeasurement[] } },
}));
vi.mock('../../../survey/measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(m.measure),
}));
// the bodies have their own tests: here only a section's header
vi.mock('../FrontBody', () => ({ FrontBody: () => null }));
vi.mock('../project/ProjectList', () => ({ ProjectList: () => null }));
vi.mock('../../StageShow', () => ({ StageShow: () => null }));
vi.mock('../../../facts/ProjectSearch', () => ({ ProjectSearch: () => null }));
vi.mock('../../../flyability/FlightlineSection', () => ({ FlightlineSection: () => null }));
vi.mock('../../../insights/SiteDigest', () => ({ SiteDigest: () => null }));
vi.mock('../../../road/useRoadMap', () => ({ useIsRoad: () => false }));
vi.mock('../../../layout/useApplyPreset', () => ({ useLayout: () => null }));
vi.mock('../panelData', () => ({ usePanelData: () => ({}) }));

const { PanelSection } = await import('./PanelSections');

const measurement = (id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-11-18T00:00:00Z',
  ...over,
});

const def = (id: SectionDef['id']): SectionDef => {
  const d = sectionDef(id);
  if (!d) throw new Error(`no section ${id}`);
  return d;
};

let host: HTMLDivElement;
let root: Root | undefined;
const render = (id: SectionDef['id']) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<PanelSection def={def(id)} />);
  });
};
const count = () => host.querySelector('.wb-section-count')?.textContent ?? null;

beforeEach(() => {
  m.measure = { file: { measurements: [] } };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ piles: [] });
});

describe('the number beside Project > Volumes', () => {
  it("counts the inventory's piles, not the kit's", () => {
    // an older project: the kit found five piles, the inventory lists the two that are measured
    volumetric.setState({ piles: [{}, {}, {}, {}, {}] as never });
    m.measure = {
      file: {
        measurements: [
          measurement('p1'),
          measurement('p2'),
          // a distance is no pile
          measurement('d1', { family: 'line', tool: 'distance' }),
        ],
      },
    };
    render('project.volumes');
    expect(count()).toBe('2');
  });

  it('shows no number without a pile in the inventory, whatever the kit holds', () => {
    volumetric.setState({ piles: [{}, {}, {}] as never });
    render('project.volumes');
    expect(count()).toBeNull();
  });

  it('counts piles drawn by hand in a project without the kit', () => {
    m.measure = { file: { measurements: [measurement('p1')] } };
    render('project.volumes');
    expect(count()).toBe('1');
  });

  it('gives no pile count to another section', () => {
    m.measure = { file: { measurements: [measurement('p1')] } };
    render('project.changes');
    expect(count()).toBeNull();
  });
});

// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { emptyMeasurements, type PackageInfo, type SitePoint } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../../../shell';
import { drawEvent, measureStore, startTool, stopTool } from '../../../survey/measureStore';
import { useStageKeys } from '../../stageKeys';
import { sectionStore } from '../sectionState';
import { createWorkbenchStore } from '../workbenchStore';
import { followMeasureTool, followRecent } from '../measureFollow';
import { createFavouritesStore } from '../../../survey/measureCatalogue';
import { MeasureBench } from './MeasureBench';

// the site data tools are their own screens: here only that the bench lists them
vi.mock('../../../survey/Designs', () => ({
  DesignsTool: () => <button type="button">Designs</button>,
}));
vi.mock('../../../survey/HaulRoad', () => ({ HaulRoadTool: () => null }));
vi.mock('../../../survey/ExportDialog', () => ({ ExportTool: () => null }));
vi.mock('../../../survey/MagicPolygon', () => ({ MagicPolygon: () => null }));
vi.mock('../../../survey/MeasurementPanel', () => ({ MeasurementPanel: () => <p>panel</p> }));
vi.mock('../../../survey/BulkTotals', () => ({ BulkTotals: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

/** The stage keys on a 3D view, as the Scene mounts them. */
const stage = { tool: 'select', setTool: vi.fn() } as unknown as EngineStage;
function Scene() {
  useStageKeys(stage);
  return <MeasureBench />;
}

const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<Scene />);
  });
};
const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};
const env = { view: '3d' as const, clampZ: () => null, snap: () => null };
const click = (raw: SitePoint) => {
  act(() => {
    drawEvent({ type: 'click', raw, screen: { x: 1, y: 1 }, shift: false }, env);
  });
};
/** Type into a React-controlled input (its value setter, then an input event). */
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const shownSections = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="survey-tools"] .wb-section')].map((s) =>
    (s.dataset.testid ?? '').replace('wb-section-', ''),
  );

const existing = {
  ...emptyMeasurements(),
  measurements: [
    {
      id: 'm1',
      family: 'line' as const,
      tool: 'distance' as const,
      label: 'Kerb',
      scope: { kind: 'site' as const },
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ] as SitePoint[],
      items: [],
      results: [],
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  shell.setState({ pkg: null, stageMode: '3d' });
  measureStore.setState({
    projectId: 'p',
    status: 'ready',
    readOnly: false,
    file: existing,
    savedText: JSON.stringify(existing),
    tool: null,
    draw: null,
    editing: null,
    selected: [],
    focus: null,
    listOpen: false,
    message: null,
    measurementsVisible: true,
    hiddenMeasurements: [],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  stopTool();
});

describe('the Measure workbench', () => {
  it('read-only package measures without saving', () => {
    shell.setState({ pkg: {} as unknown as PackageInfo });
    render();
    press('m');
    expect(measureStore.getState().tool).toMatchObject({ tool: 'distance', transient: true });
    click([0, 0, 0]);
    click([0, 10, 0]);
    expect(q('measure-reading')?.textContent).toMatch(/^10(\.0+)? m$/);
    expect(q('survey-finish')).toBeNull();
    const live = q('survey-drawbar');
    expect(live?.textContent).toContain('Measuring without saving');
    expect([...(live?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).not.toContain(
      expect.stringMatching(/^Save/),
    );
    act(() => {
      drawEvent({ type: 'key', key: 'Enter' }, env);
    });
    expect(measureStore.getState().file).toBe(existing);
  });

  it('M in a normal project starts Distance and Enter saves to "Saved in this project"', () => {
    render();
    press('m');
    expect(measureStore.getState().tool).toMatchObject({ tool: 'distance' });
    expect(measureStore.getState().tool?.transient).toBeFalsy();
    click([0, 0, 0]);
    click([3, 4, 0]);
    expect(q('measure-reading')?.textContent).toMatch(/^5(\.0+)? m$/);
    const save = q('survey-finish');
    expect(save?.textContent).toContain('Save');
    expect(save?.getAttribute('aria-keyshortcuts')).toBe('Enter');
    act(() => {
      drawEvent({ type: 'key', key: 'Enter' }, env);
    });
    const saved = q('wb-section-measurements');
    expect(saved?.querySelector('.wb-section-title')?.textContent).toBe('Saved in this project');
    expect(saved?.getAttribute('data-open')).toBe('true');
    const items = [...(saved?.querySelectorAll('[data-testid="survey-item"]') ?? [])];
    expect(items.map((li) => li.querySelector('.sv-item-label')?.textContent)).toEqual([
      'Distance 1',
      'Kerb',
    ]);
    // M again puts the tool away
    press('m');
    expect(measureStore.getState().tool).toBeNull();
  });

  it('search "slope" leaves only Line with Grade and slope', () => {
    render();
    expect(shownSections()).toEqual(
      expect.arrayContaining(['favourites', 'point', 'line', 'polygon', 'telecom', 'markup']),
    );
    const search = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('no search');
    type(search, 'slope');
    expect(shownSections()).toEqual(['line']);
    const line = q('wb-section-line');
    expect(line?.getAttribute('data-open')).toBe('true');
    expect([...(line?.querySelectorAll('.meb-name') ?? [])].map((n) => n.textContent)).toEqual([
      'Grade and slope',
    ]);
    type(search, 'nothing like this');
    expect(shownSections()).toEqual([]);
    expect(host.querySelector('.empty-state')).not.toBeNull();
  });

  it('the live strip shows text labels', () => {
    render();
    act(() => {
      startTool('grade');
    });
    expect(q('survey-tools')).toBeNull();
    const strip = host.querySelector('.meb-strip');
    const buttons = [...(strip?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Distance', 'Grade and slope', 'Area', 'Antenna azimuth']),
    );
    for (const b of buttons) expect(b.textContent.trim().length).toBeGreaterThan(0);
    expect(
      buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent),
    ).toEqual(['Grade and slope']);
    // a strip button switches the tool without leaving
    act(() => {
      buttons.find((b) => b.textContent === 'Area')?.click();
    });
    expect(measureStore.getState().tool?.tool).toBe('area');
  });
});

describe('the Measure tab follows the tool', () => {
  it('stopping a tool that opened the tab returns the front to Selection', () => {
    const wb = createWorkbenchStore(null);
    const off = followMeasureTool(measureStore, wb);
    try {
      startTool('distance');
      expect(wb.getState().front).toBe('measure');
      expect(wb.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(true);
      stopTool();
      expect(wb.getState().front).toBe('selection');
      expect(wb.getState().tabs.some((t) => t.id === 'measure')).toBe(false);

      // opened by the person, the bench stays (back to the full catalogue)
      wb.getState().open('measure');
      startTool('area');
      stopTool();
      expect(wb.getState().front).toBe('measure');
      expect(wb.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(false);
    } finally {
      off();
    }
  });

  it('a drawing for another panel leaves that panel in front', () => {
    const wb = createWorkbenchStore(null);
    const off = followMeasureTool(measureStore, wb);
    try {
      wb.getState().open('qa');
      startTool('area');
      expect(wb.getState().front).toBe('qa');
      stopTool();
      expect(wb.getState().front).toBe('qa');
    } finally {
      off();
    }
  });
});

describe('recent tools', () => {
  it('count every tool start: M, an island tile or the bench, not a drawing for another panel', () => {
    const favs = createFavouritesStore(null);
    const off = followRecent(measureStore, favs);
    try {
      render();
      press('m');
      act(() => {
        startTool('grade');
      });
      act(() => {
        startTool('area', { forOther: { prompt: 'x', then: () => undefined } });
      });
      expect(favs.getState().recent).toEqual(['grade', 'distance']);
    } finally {
      off();
    }
  });
});

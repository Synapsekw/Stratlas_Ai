// @vitest-environment jsdom
import { TIP_DELAY_MS } from '@aio/ui';
import type { EngineStage } from '@aio/engine';
import { emptyMeasurements, type PackageInfo, type SitePoint } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginIssueEdit } from '../../../issueCard/state';
import { shell } from '../../../shell';
import { drawEvent, measureStore, startTool, stopTool } from '../../../survey/measureStore';
import { useStageKeys } from '../../stageKeys';
import { sectionStore } from '../sectionState';
import { createWorkbenchStore } from '../workbenchStore';
import { followMeasureTool, followRecent } from '../measureFollow';
import { createFavouritesStore } from '../../../survey/measureCatalogue';
import { MeasureBench } from './MeasureBench';
import { UnsavedBar } from '../../../survey/MeasureToolbar';

// the site data tools are their own screens: here only that the bench lists them
vi.mock('../../../survey/Designs', () => ({
  DesignsTool: () => <button type="button">Designs</button>,
}));
vi.mock('../../../survey/HaulRoad', () => ({ HaulRoadTool: () => null }));
vi.mock('../../../survey/ExportDialog', () => ({
  ExportTool: () => <button type="button">Export survey data</button>,
  ExportDialogMount: () => null,
}));
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

  it('M in a normal project starts Distance and Enter puts it in the tree, unsaved', () => {
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
    expect(q('wb-section-measurements')).toBeNull();
    expect(q('survey-saved')?.textContent).toContain('Unsaved changes');
    expect(measureStore.getState().reveal).toMatchObject({
      id: measureStore.getState().focus,
      openSidebar: false,
    });
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

  it('a tool started while an issue is edited waits behind the card, with a dot', () => {
    const wb = createWorkbenchStore(null);
    const off = followMeasureTool(measureStore, wb);
    const done = beginIssueEdit('card');
    try {
      startTool('distance');
      expect(wb.getState().front).toBe('selection');
      expect(wb.getState().attention).toBe('measure');
      expect(wb.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(true);
      stopTool();
    } finally {
      done();
      off();
    }
  });

  it('closing the live Measure tab with its X stops the drawing', () => {
    const wb = createWorkbenchStore(null);
    const off = followMeasureTool(measureStore, wb);
    try {
      startTool('distance');
      expect(wb.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(true);
      wb.getState().close('measure');
      expect(measureStore.getState().tool).toBeNull();
      expect(measureStore.getState().draw).toBeNull();
      expect(wb.getState().front).toBe('selection');
      // the next tool opens its tab again
      startTool('area');
      expect(wb.getState().front).toBe('measure');
      stopTool();
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

describe('search reaches every section (D16)', () => {
  const search = () => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('no search');
    return input;
  };

  it('Collapse all during a search ends it, and the sections fold', () => {
    render();
    type(search(), 'slope');
    expect(q('wb-section-line')?.getAttribute('data-open')).toBe('true');
    act(() => {
      sectionStore.getState().setAll('measure', false);
    });
    expect(search().value).toBe('');
    expect(q('wb-section-line')?.getAttribute('data-open')).toBe('false');
    expect(q('survey-saved')).not.toBeNull();
  });

  it('finds the Site data entries by name, and the save controls step aside', () => {
    render();
    expect(q('survey-saved')).not.toBeNull();
    for (const [query, button] of [
      ['Hydrology', 'Hydrology'],
      ['designs', 'Designs'],
      ['Export', 'Export survey data'],
    ] as const) {
      type(search(), query);
      // "designs" also finds the Drawing aids (Snap to Designs)
      expect(shownSections()).toEqual(query === 'designs' ? ['siteData', 'aids'] : ['siteData']);
      const site = q('wb-section-siteData');
      expect(site?.getAttribute('data-open')).toBe('true');
      const names = [...(site?.querySelectorAll('button') ?? [])]
        .map((b) => b.getAttribute('aria-label') ?? b.textContent)
        .filter((n) => n !== 'Site data');
      expect(names).toContain(button);
      expect(host.querySelector('.empty-state')).toBeNull();
      expect(q('survey-saved')).toBeNull();
    }
    type(search(), '');
    expect(q('survey-saved')).not.toBeNull();
    // a section's own title shows all of it; the drawing aids by a control's name
    type(search(), 'snap');
    expect(shownSections()).toEqual(['aids']);
    type(search(), 'templates');
    expect(shownSections()).toEqual(['templates']);
  });

  it('clearing the search restores the sections as the person left them', () => {
    render();
    const head = (id: string) =>
      q(`wb-section-${id}`)?.querySelector<HTMLButtonElement>('.wb-section-head');
    act(() => {
      head('point')?.click();
    });
    expect(q('wb-section-point')?.getAttribute('data-open')).toBe('true');
    expect(q('wb-section-line')?.getAttribute('data-open')).toBe('false');
    type(search(), 'grade');
    expect(q('wb-section-line')?.getAttribute('data-open')).toBe('true');
    type(search(), '');
    expect(q('wb-section-point')?.getAttribute('data-open')).toBe('true');
    expect(q('wb-section-line')?.getAttribute('data-open')).toBe('false');
    expect(q('wb-section-favourites')?.getAttribute('data-open')).toBe('true');
    expect(q('survey-saved')).not.toBeNull();
  });
});

describe('the Saved footer', () => {
  it('keeps Autosave, Revert, Save, the read-only notice and the load error', async () => {
    render();
    const autosave = host.querySelector<HTMLElement>('[data-testid="survey-autosave"]');
    expect(autosave).not.toBeNull();
    act(() => {
      autosave?.focus();
    });
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, TIP_DELAY_MS + 100));
    });
    const tipId = autosave?.getAttribute('aria-describedby');
    expect(tipId).toBeTruthy();
    expect(document.getElementById(tipId ?? '')?.textContent).toBe(
      'Off by default: save when you are ready',
    );
    expect(q('survey-list-save')?.hasAttribute('disabled')).toBe(true);
    act(() => {
      measureStore.setState({ file: { ...existing, measurements: [] } });
    });
    expect(q('survey-list-save')?.hasAttribute('disabled')).toBe(false);
    expect(host.textContent).toContain('Revert');
    act(() => {
      measureStore.setState({ readOnly: true });
    });
    expect(q('survey-list-readonly')).not.toBeNull();
    expect(q('survey-list-save')).toBeNull();
    act(() => {
      measureStore.setState({ readOnly: false, status: 'error', error: 'Bad file' });
    });
    expect(q('survey-saved-error')?.getAttribute('role')).toBe('alert');
  });
});

describe('a picked measurement', () => {
  it('a read-only package shows a saved telecom measurement and its reading', () => {
    shell.setState({ pkg: {} as unknown as PackageInfo });
    const azimuth = {
      family: 'line' as const,
      scope: { kind: 'site' as const },
      items: [],
      results: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      id: 'm-az',
      tool: 'azimuth' as const,
      label: 'Sector A',
      points: [
        [0, 0, 0],
        [0, 0, 2],
        [2, 0, 0],
      ] as SitePoint[],
    };
    const file = { ...existing, measurements: [azimuth] };
    measureStore.setState({ readOnly: true, file, savedText: JSON.stringify(file), focus: 'm-az' });
    render();
    // no telecom tools in a package, so the reading is in the picked measurement's card
    expect(q('wb-section-telecom')).toBeNull();
    const card = q('wb-section-selected');
    expect(card?.querySelector('[data-testid="telecom-tools"]')).not.toBeNull();
    const readout = card?.querySelector('[data-testid="telecom-readout"]');
    expect(readout?.querySelector('[data-key="azimuth"] dd')?.textContent).toMatch(/\d/);
    expect(card?.querySelector('[data-testid="telecom-save"]')).toBeNull();
  });
});

describe('unsaved changes (D18)', () => {
  const dirty = () => {
    measureStore.setState({ savedText: JSON.stringify(emptyMeasurements()) });
  };

  it('the bench holds the unsaved state and its Save, on top and in the live card', () => {
    dirty();
    render();
    expect(q('survey-save')?.textContent).toBe('Save measurements');
    act(() => {
      startTool('distance');
    });
    expect(q('survey-drawbar')?.querySelector('[data-testid="survey-save"]')).not.toBeNull();
  });

  it('a read-only project shows no empty card while a measurement is in edit', () => {
    measureStore.setState({ readOnly: true, editing: { points: [] } as never });
    try {
      render();
      expect(host.querySelector('.meb-live')).toBeNull();
      expect(q('survey-save')).toBeNull();
    } finally {
      measureStore.setState({ readOnly: false, editing: null });
    }
  });

  it('the stage shows it only while the right sidebar is folded away', () => {
    dirty();
    shell.setState({ rightCollapsed: false });
    root ??= createRoot(host);
    act(() => {
      root?.render(<UnsavedBar />);
    });
    expect(q('survey-save-stage')).toBeNull();
    act(() => {
      shell.setState({ rightCollapsed: true });
    });
    expect(q('survey-save-stage')?.textContent).toBe('Save measurements');
    act(() => {
      shell.setState({ rightCollapsed: false });
    });
  });
});

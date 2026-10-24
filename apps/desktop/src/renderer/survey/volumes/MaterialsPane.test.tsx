// @vitest-environment jsdom
import {
  defaultSurveySettings,
  type ComparisonResult,
  type SiteMaterial,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  measure: {} as {
    settings: SurveySettings;
    readOnly: boolean;
    file: { measurements: SurveyMeasurement[] };
  },
  focus: 'd2',
  counted: null as null | ((pile: string, capture: string) => boolean),
}));
const calls = vi.hoisted(() => ({
  bridge: vi.fn(() => Promise.resolve({ ok: true, value: { path: 'C:/x/site-materials.csv' } })),
}));

vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  measureStore: { getState: () => s.measure },
  saveSiteSettings: vi.fn(),
  replaceMeasurements: vi.fn(),
  updateMeasurement: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../workspace/timeline', () => ({
  useTimeline: (sel: (x: unknown) => unknown) => sel({ focus: s.focus }),
  timeline: { getState: () => ({ focus: s.focus }) },
}));
vi.mock('../useInventory', () => ({
  useCounted: () => s.counted ?? (() => true),
}));
vi.mock('@aio/workspace', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: CAPTURES, layers: [] } } }),
}));
vi.mock('../../shell', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  bridge: { call: calls.bridge },
}));

const CAPTURES = [
  { id: 'd1', label: 'First', date: '2020-12-31' },
  { id: 'd2', label: 'Second', date: '2021-01-10' },
];

const { MaterialsPane } = await import('./MaterialsPane');
const { createMaterialsDraft } = await import('./materialsDraft');

const result = (to: string, net: number): ComparisonResult => ({
  item: 'pile',
  status: 'ok',
  cutM3: 0,
  fillM3: net,
  netM3: net,
  totalM3: net,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'base',
  toLabel: to,
  toCapture: to,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-10-09T00:00:00Z',
});

const pile = (id: string, d1: number, d2: number, material?: string): SurveyMeasurement => ({
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
  items: [{ id: 'pile', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [result('d2', d2)],
  series: [result('d1', d1)],
  ...(material !== undefined ? { material } : {}),
  createdAt: '2026-10-09T00:00:00Z',
});

const AGG: SiteMaterial = { id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.6 };
const SAND: SiteMaterial = {
  id: 'sand',
  name: 'Washed sand',
  densityTPerM3: 1.5,
  swell: { loose: 1.2, compacted: 0.9 },
};

let host: HTMLDivElement;
let root: Root | undefined;
let save: ReturnType<
  typeof vi.fn<(m: SiteMaterial[], a: Record<string, string | null>) => Promise<string | null>>
>;
let draft: ReturnType<typeof createMaterialsDraft>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  s.focus = 'd2';
  s.counted = null;
  s.measure = {
    settings: { ...defaultSurveySettings(), materials: [AGG, SAND] },
    readOnly: false,
    file: {
      measurements: [
        pile('Pile 01', 1000, 2000, 'agg'),
        pile('Pile 02', 100, 100, 'sand'),
        pile('Pile 03', 10, 10),
      ],
    },
  };
  save = vi.fn<(m: SiteMaterial[], a: Record<string, string | null>) => Promise<string | null>>(
    () => Promise.resolve(null),
  );
  draft = createMaterialsDraft({
    base: () => s.measure.settings.materials,
    captures: () => CAPTURES,
    readOnly: () => s.measure.readOnly,
    save,
  });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<MaterialsPane draft={draft} />);
  });
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const row = (id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="survey-mat-row"][data-id="${id}"]`);
const cells = (tr: HTMLElement | null) =>
  [...(tr?.children ?? [])].map((c) => {
    const input = c.querySelector('input');
    return input ? input.value : c.textContent;
  });
const type = (input: HTMLInputElement | null, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = (el: Element | null | undefined) => {
  act(() => {
    (el as HTMLElement | null)?.click();
  });
};
const open = (id: string) => {
  click(row(id)?.querySelector('button'));
};

describe('the Materials pane', () => {
  it('the table shows density, swell, piles, m³ and tonnes per material and All materials', () => {
    render();
    expect(q('materials-pane')?.textContent).toContain('Materials and density');
    expect(cells(row('agg'))).toEqual(['Aggregate 20 mm', '1.60', '', '1', '2 000.0', '3 200']);
    expect(cells(row('sand'))).toEqual(['Washed sand', '1.50', '1.20', '1', '100.0', '150']);
    expect(cells(q('survey-mat-total'))).toEqual([
      'All materials',
      '',
      '',
      '2',
      '2 100.0',
      '3 350',
    ]);
  });

  it('follows the date in focus', () => {
    s.focus = 'd1';
    render();
    expect(cells(row('agg')).slice(3)).toEqual(['1', '1 000.0', '1 600']);
  });

  it('editing density from 10 Jan shows the impact line and leaves 31 Dec tonnes as they were', () => {
    render();
    open('agg');
    expect(q('materials-editor')).not.toBeNull();
    expect(q('materials-unsaved')).toBeNull();
    type(host.querySelector<HTMLInputElement>('[data-testid="materials-new-density"]'), '1.62');
    expect(q('materials-unsaved')?.textContent).toBe('Unsaved change');
    expect(q('materials-editor')?.textContent).toContain('Density 1.60 →');
    expect(q('materials-impact')?.textContent).toBe(
      'Tonnes on 10 Jan go from 3 200 to 3 240 t. 31 Dec stays at 1 600 t. Volumes do not change.',
    );
    expect(qa('materials-history').map((h) => h.textContent)).toEqual([
      'Historyfrom 10 Jan 2021 · 1.62 t/m³ · newfrom 31 Dec 2020 · 1.60 t/m³ · kept for 31 Dec',
    ]);
    // the table follows the draft on the date in focus
    expect(cells(row('agg')).slice(5)).toEqual(['3 240']);
  });

  it('the from date moves the edit to another survey', () => {
    render();
    open('agg');
    type(host.querySelector<HTMLInputElement>('[data-testid="materials-new-density"]'), '2');
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="materials-from"]');
    act(() => {
      if (sel) sel.value = 'd1';
      sel?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const agg = draft.getState().draft?.find((m) => m.id === 'agg');
    expect(agg?.densityHistory).toEqual([{ fromCapture: 'd1', tPerM3: 2 }]);
    expect(agg?.densityTPerM3).toBe(2);
  });

  it('the table counts piles by the inventory rule (review finding 4)', () => {
    s.counted = (pile) => pile !== 'Pile 01';
    render();
    expect(cells(row('agg')).slice(3)).toEqual(['1', '0.0', '0']);
    expect(cells(q('survey-mat-total')).slice(3)).toEqual(['2', '100.0', '150']);
  });

  it('changing the from date alone writes nothing until a value is typed (finding 16)', () => {
    s.measure.settings = {
      ...s.measure.settings,
      materials: [
        {
          ...AGG,
          densityTPerM3: 1.7,
          densityHistory: [
            { fromCapture: 'd1', tPerM3: 1.6 },
            { fromCapture: 'd2', tPerM3: 1.7 },
          ],
        },
        SAND,
      ],
    };
    render();
    open('agg');
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="materials-from"]');
    act(() => {
      if (sel) sel.value = 'd1';
      sel?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(draft.getState().draft).toBeNull();
    expect(sel?.value).toBe('d1');
    type(host.querySelector<HTMLInputElement>('[data-testid="materials-new-density"]'), '1.65');
    const agg = draft.getState().draft?.find((m) => m.id === 'agg');
    expect(agg?.densityHistory).toEqual([
      { fromCapture: 'd1', tPerM3: 1.65 },
      { fromCapture: 'd2', tPerM3: 1.7 },
    ]);
  });

  it('the colour previews while dragged and is written once the pick ends', () => {
    render();
    open('agg');
    const input = host.querySelector<HTMLInputElement>('.mp-colour input[type="color"]');
    type(input, '#ff0000');
    expect(draft.getState().draft).toBeNull();
    const swatchEl = host.querySelector<HTMLElement>('.mp-ed-head .mp-swatch');
    expect(swatchEl?.style.background).toMatch(/255, 0, 0|#ff0000/);
    act(() => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(draft.getState().draft?.find((m) => m.id === 'agg')?.colour).toBe('#ff0000');
  });

  it('Save writes densityHistory and densityTPerM3 equal to the newest entry', async () => {
    render();
    open('agg');
    type(host.querySelector<HTMLInputElement>('[data-testid="materials-new-density"]'), '1.62');
    await act(async () => {
      q('survey-mat-save')?.click();
      await Promise.resolve();
    });
    const materials = save.mock.calls[0]?.[0] ?? [];
    const agg = materials.find((m) => m.id === 'agg');
    expect(agg?.densityHistory).toEqual([
      { fromCapture: 'd1', tPerM3: 1.6 },
      { fromCapture: 'd2', tPerM3: 1.62 },
    ]);
    expect(agg?.densityTPerM3).toBe(1.62);
    expect(draft.getState().draft).toBeNull();
  });

  it('Cancel drops the draft', () => {
    render();
    open('agg');
    type(host.querySelector<HTMLInputElement>('[data-testid="materials-new-density"]'), '1.62');
    click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    expect(draft.getState().draft).toBeNull();
    expect(q('materials-unsaved')).toBeNull();
    expect(cells(row('agg'))[1]).toBe('1.60');
  });

  it('Assign piles moves a pile from another material', () => {
    render();
    open('sand');
    expect(qa('materials-pile').map((c) => c.dataset.id)).toEqual(['Pile 02']);
    click(q('materials-assign'));
    const box = [...host.querySelectorAll('[data-testid="materials-checklist"] label')].find((l) =>
      l.textContent.includes('Pile 01'),
    );
    click(box?.querySelector('input'));
    expect(draft.getState().assignments).toEqual({ 'Pile 01': 'sand' });
    expect(qa('materials-pile').map((c) => c.dataset.id)).toEqual(['Pile 01', 'Pile 02']);
    expect(cells(row('agg')).slice(3)).toEqual(['0', '0.0', '0']);
    // × leaves a pile with no material
    click(host.querySelector('[aria-label="Remove Pile 02 from this material"]'));
    expect(draft.getState().assignments).toEqual({ 'Pile 01': 'sand', 'Pile 02': null });
  });

  it('CSV import and export still work', async () => {
    render();
    const csv =
      'id,name,code,density_t_per_m3,swell_loose,swell_compacted\r\n' +
      'agg,Aggregate 20 mm,A20,1.7,,\r\n' +
      'cover,Daily cover soil,DC,1.7,1.25,0.9\r\n' +
      'bad,Bad row,,heavy,,\r\n';
    const input = host.querySelector<HTMLInputElement>('[data-testid="survey-mat-import"]');
    const file = new File([csv], 'materials.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(qa('survey-mat-row')).toHaveLength(3);
    expect(q('survey-mat-note')?.textContent).toContain('2 materials read');
    expect(q('survey-mat-error')?.textContent).toContain('Line 4');
    await act(async () => {
      q('survey-mat-export')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const [channel, req] = calls.bridge.mock.calls[0] as unknown as [string, { data: string }];
    expect(channel).toBe('dialog:saveFile');
    expect(req.data).toContain('cover,Daily cover soil,DC,1.7,1.25,0.9');
    expect(q('survey-mat-note')?.textContent).toBe('Exported to C:/x/site-materials.csv.');
  });

  it('+ Material adds a row and opens its editor', () => {
    render();
    click(q('survey-mat-add'));
    expect(qa('survey-mat-row')).toHaveLength(3);
    expect(q('materials-editor')?.dataset.id).toBe('material-3');
  });

  it('a read-only project shows the table without Add, Save or Assign', () => {
    s.measure.readOnly = true;
    render();
    open('agg');
    expect(q('survey-mat-add')).toBeNull();
    expect(q('survey-mat-save')).toBeNull();
    expect(q('materials-assign')).toBeNull();
    expect(q('survey-mat-import')).toBeNull();
  });

  it('no materials shows the empty state', () => {
    s.measure.settings = { ...s.measure.settings, materials: [] };
    render();
    expect(q('materials-pane')?.textContent).toContain('No materials yet');
  });
});

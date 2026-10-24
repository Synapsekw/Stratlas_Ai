// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIDE_TAB_PX, workbench } from '../workbenchStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  measure: { file: { measurements: [] as SurveyMeasurement[] }, focus: null as string | null },
  openPile: vi.fn(),
}));
vi.mock('../../../survey/measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(m.measure),
}));
vi.mock('../../../survey/pile/openPile', () => ({ openPile: m.openPile }));
// each pane has its own tests: here only which one shows, and what it is given
vi.mock('../../../survey/volumes/InventoryPane', () => ({
  useSeriesRun: () => undefined,
  useInventoryModel: () => null,
  inventoryOrder: (_m: unknown, piles: readonly SurveyMeasurement[]) => piles.map((p) => p.id),
  VolumesEmpty: () => <p data-testid="volumes-empty" />,
  InventoryPane: ({ onPile }: { onPile: (id: string) => void }) => (
    <button
      type="button"
      data-testid="inventory-pane"
      onClick={() => {
        onPile('p1');
      }}
    />
  ),
}));
vi.mock('../../../survey/volumes/VolumesHeader', () => ({
  VolumesHeader: () => <header data-testid="volumes-header" />,
}));
vi.mock('../../../survey/volumes/CutFillPane', () => ({
  CutFillPane: ({ onPile }: { onPile?: (id: string) => void }) => (
    <button
      type="button"
      data-testid="cutfill-pane"
      onClick={() => {
        onPile?.('p2');
      }}
    />
  ),
}));
vi.mock('../../../survey/volumes/MaterialsPane', () => ({
  MaterialsPane: () => <div data-testid="materials-pane" />,
}));
vi.mock('../../../survey/pile/PilePanel', () => ({
  PilePanel: ({ id, order }: { id: string; order?: readonly string[] }) => (
    <div data-testid="pile-panel" data-id={id} data-order={(order ?? []).join(',')} />
  ),
}));

const { VolumesBench } = await import('./VolumesBench');
const { volumesPane } = await import('../../../survey/volumes/volumesPane');
const { stageShow } = await import('../../StageShow');

const pile = (id: string): SurveyMeasurement => ({
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
  createdAt: '2026-10-09T00:00:00Z',
});

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<VolumesBench />);
  });
};
const q = (sel: string) => host.querySelector(sel);
const segment = (name: string) =>
  [...host.querySelectorAll('[data-testid="volumes-segment"]')].find((b) => b.textContent === name);
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  m.measure = { file: { measurements: [pile('p1'), pile('p2')] }, focus: null };
  m.openPile.mockClear();
  volumesPane.setState({ pane: 'inventory' });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  stageShow.getState().reset();
});

describe('VolumesBench', () => {
  it('Inventory: the header, the segments, then the inventory', () => {
    render();
    const header = q('[data-testid="volumes-header"]');
    const seg = q('[role="group"][aria-label="Volumes"]');
    const pane = q('[data-testid="inventory-pane"]');
    expect(header?.compareDocumentPosition(seg as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(seg?.compareDocumentPosition(pane as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(segment('Inventory')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('the segment switches to Cut & fill and Materials, and the Show control follows', () => {
    render();
    click(segment('Cut & fill'));
    expect(q('[data-testid="cutfill-pane"]')).not.toBeNull();
    // the header is Inventory's
    expect(q('[data-testid="volumes-header"]')).toBeNull();
    expect(stageShow.getState().pane).toBe('cutFill');
    click(segment('Materials'));
    expect(q('[data-testid="materials-pane"]')).not.toBeNull();
    expect(segment('Materials')?.getAttribute('aria-pressed')).toBe('true');
    expect(stageShow.getState().pane).toBe('materials');
    click(segment('Inventory'));
    expect(q('[data-testid="inventory-pane"]')).not.toBeNull();
  });

  it('follows the pane set elsewhere (openMaterialsPane, the Show control)', () => {
    render();
    act(() => {
      stageShow.getState().setPane('materials');
    });
    expect(q('[data-testid="materials-pane"]')).not.toBeNull();
  });

  it('a row opens the pile panel, from Inventory and from Cut & fill', () => {
    render();
    click(q('[data-testid="inventory-pane"]'));
    expect(m.openPile).toHaveBeenLastCalledWith('p1');
    click(segment('Cut & fill'));
    click(q('[data-testid="cutfill-pane"]'));
    expect(m.openPile).toHaveBeenLastCalledWith('p2');
  });

  it('a focused pile opens the pile panel in place of everything; ‹ Inventory comes back', () => {
    m.measure.focus = 'p2';
    render();
    expect(q('[data-testid="pile-panel"]')?.getAttribute('data-id')).toBe('p2');
    expect(q('[data-testid="pile-panel"]')?.getAttribute('data-order')).toBe('p1,p2');
    expect(q('[data-testid="volumes-segment"]')).toBeNull();
    expect(q('[data-testid="volumes-header"]')).toBeNull();
    // the panel's back link clears the focus
    m.measure.focus = null;
    render();
    expect(q('[data-testid="pile-panel"]')).toBeNull();
    expect(q('[data-testid="inventory-pane"]')).not.toBeNull();
  });

  it('no pile: Inventory says so, the header waits, the segments stay', () => {
    m.measure.file.measurements = [];
    render();
    expect(q('[data-testid="volumes-empty"]')).not.toBeNull();
    expect(q('[data-testid="volumes-header"]')).toBeNull();
    expect(segment('Materials')).toBeDefined();
  });

  it('no kit controls above the inventory', () => {
    render();
    expect(q('.vol-bench-controls')).toBeNull();
    expect(q('[role="group"][aria-label="Survey date"]')).toBeNull();
    expect(q('[role="group"][aria-label="Surface colours"]')).toBeNull();
    expect(q('[role="group"][aria-label="Volume bodies"]')).toBeNull();
  });

  it('is the fixed Volumes tab, which opens at least 470 px wide', () => {
    const tab = workbench.getState().tabs.find((t) => t.id === 'volumes');
    expect(tab).toMatchObject({ fixed: true, minWidth: 470 });
    expect(WIDE_TAB_PX).toBe(470);
  });
});

// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaInventory, type AntennaInventoryProps } from './AntennaInventory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'unexpected' })) },
  };
});
vi.mock('./antennaScene', () => ({
  KIND_COLOURS: { panel: '#111', short: '#222', dish: '#333', other: '#444' },
}));
vi.mock('../builder/photoOpen', () => ({ openPhoto: () => undefined }));

const val = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured' },
});
function mk(id: string, kind: AntennaUnit['kind'], over: Partial<AntennaUnit> = {}): AntennaUnit {
  const dir = kind === 'panel' || kind === 'short';
  return {
    id,
    name: id.replace('ant-', 'A'),
    kind,
    kindBasis: 'geometry',
    status: 'draft',
    box: {
      centre: [1, 2, 30],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.3, 1.2, 0.15],
    },
    support: 100,
    ...(dir ? { azimuthGridDeg: val(123.4), downtiltDeg: val(4) } : {}),
    widthM: val(0.3),
    heightM: val(1.2),
    depthM: val(0.15),
    convergenceDeg: null,
    photos: [],
    user: {},
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const fileOf = (units: AntennaUnit[]): AntennasFile =>
  ({ schema: 'aio.antennas/1', run: {}, units }) as unknown as AntennasFile;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});
const handlers = () => ({
  onSelect: vi.fn(),
  onTick: vi.fn(),
  onFilter: vi.fn(),
});
function show(p: Partial<AntennaInventoryProps> & { file: AntennasFile | null }) {
  const h = handlers();
  const ui: ReactElement = (
    <AntennaInventory
      selected={null}
      ticked={{}}
      hidden={{}}
      solo={null}
      filter="all"
      readOnly={false}
      {...h}
      {...p}
    />
  );
  act(() => {
    root.render(ui);
  });
  return h;
}
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="antenna-row"]')];
const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('AntennaInventory', () => {
  it('lists flat rows in the filter’s order under a column header', () => {
    show({
      file: fileOf([mk('ant-3', 'other'), mk('ant-2', 'dish'), mk('ant-1', 'panel')]),
    });
    // no kind headings: one list, panels first as the review walk steps
    expect(host.querySelectorAll('h4')).toHaveLength(0);
    expect(rows().map((r) => r.textContent.slice(0, 2))).toEqual(['A1', 'A2', 'A3']);
    const list = host.querySelector('ul[role="tree"]')!;
    expect(list.classList.contains('pl-rows')).toBe(true);
    expect(list.hasAttribute('data-antenna-tree')).toBe(true);
    expect(host.querySelector('[data-testid="antenna-cols"]')?.textContent).toBe(
      'IDKindAz °Tilt °H mStatus',
    );
  });

  it('shows the no-run and nothing-found empty states', () => {
    show({ file: null });
    expect(host.textContent).toContain('No antenna run yet');
    show({ file: fileOf([]) });
    expect(host.textContent).toContain('Nothing found');
    expect(rows()).toHaveLength(0);
  });

  it('calls back on select and tick, with no per-row eye', () => {
    const h = show({ file: fileOf([mk('ant-1', 'panel')]) });
    click(rows()[0]!);
    expect(h.onSelect).toHaveBeenCalledWith('ant-1');
    click(host.querySelector('input[type="checkbox"]')!);
    expect(h.onTick).toHaveBeenCalledWith('ant-1');
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(host.querySelector('button[aria-label="Hide A1 in 3D"]')).toBeNull();
  });

  it('shows filter tabs with counts and reports a click', () => {
    const file = fileOf([
      mk('ant-1', 'panel'),
      mk('ant-2', 'panel'),
      mk('ant-3', 'dish', { status: 'accepted' }),
    ]);
    const h = show({ file, filter: 'draft' });
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((x) => x.textContent)).toEqual([
      'To review 2',
      'Accepted 1',
      'Rejected 0',
      'All 3',
    ]);
    expect(tabs.map((x) => x.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(rows()).toHaveLength(2);
    click(tabs[1]!);
    expect(h.onFilter).toHaveBeenCalledWith('accepted');
  });

  it('keeps tabs free of aria-pressed and moves between them with the keyboard', () => {
    const file = fileOf([mk('ant-1', 'panel'), mk('ant-2', 'dish', { status: 'accepted' })]);
    const h = show({ file, filter: 'draft' });
    const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs().some((x) => x.hasAttribute('aria-pressed'))).toBe(false);
    expect(tabs().map((x) => x.tabIndex)).toEqual([0, -1, -1, -1]);
    const key = (el: Element, k: string) => {
      act(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };
    key(tabs()[0]!, 'ArrowRight');
    expect(h.onFilter).toHaveBeenLastCalledWith('accepted');
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[0]!, 'End');
    expect(h.onFilter).toHaveBeenLastCalledWith('all');
    key(tabs()[0]!, 'ArrowLeft');
    expect(h.onFilter).toHaveBeenLastCalledWith('all');
    key(tabs()[3]!, 'Home');
    expect(h.onFilter).toHaveBeenLastCalledWith('draft');
  });

  it('says when nothing is left in the filter', () => {
    const file = fileOf([mk('ant-1', 'panel'), mk('ant-3', 'dish', { status: 'accepted' })]);
    show({ file, filter: 'rejected' });
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('Nothing here. Every antenna in this filter is done.');
  });

  it('dims a row whose unit is not drawn', () => {
    show({
      file: fileOf([mk('ant-1', 'panel'), mk('ant-2', 'dish')]),
      solo: 'panel',
      selected: 'ant-1',
    });
    expect(rows()[0]!.style.opacity).toBe('');
    expect(rows()[1]!.style.opacity).toBe('0.45');
  });

  it('shows each row’s azimuth and downtilt in its fields, in the north it reads', () => {
    show({
      file: fileOf([
        mk('ant-1', 'panel'),
        mk('ant-2', 'panel', { convergenceDeg: 1.5 }),
        mk('ant-3', 'other'),
      ]),
    });
    const az = [...host.querySelectorAll<HTMLInputElement>('[data-testid="antenna-row-az"]')];
    expect(az.map((x) => x.value)).toEqual(['123.4', '124.9', '']);
    expect(az[1]!.getAttribute('aria-label')).toBe('Azimuth, true north (°)');
    const tilt = [...host.querySelectorAll<HTMLInputElement>('[data-testid="antenna-row-tilt"]')];
    expect(tilt[0]!.value).toBe('4');
  });

  it('names the north of the azimuth column when every unit reads the same one', () => {
    vi.useFakeTimers();
    show({ file: fileOf([mk('ant-1', 'panel', { convergenceDeg: 1.5 })]) });
    const az = host.querySelector<HTMLElement>('[data-testid="antenna-col-az"]')!;
    act(() => {
      az.focus();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('True north azimuths');
  });

  it('marks status with text, not colour alone', () => {
    show({
      file: fileOf([
        mk('ant-1', 'panel'),
        mk('ant-2', 'panel', { status: 'accepted' }),
        mk('ant-3', 'panel', { status: 'rejected' }),
      ]),
      selected: 'ant-2',
    });
    const r = rows();
    expect(r.map((x) => x.dataset.status)).toEqual(['draft', 'accepted', 'rejected']);
    expect(r.map((x) => x.querySelector('.chip-status')?.textContent)).toEqual([
      'Draft',
      'Accepted',
      'Rejected',
    ]);
    expect(r[1]!.hasAttribute('data-selected')).toBe(true);
    expect(r[0]!.hasAttribute('data-selected')).toBe(false);
  });

  it('selects a row from the keyboard without hijacking its controls', () => {
    const h = show({ file: fileOf([mk('ant-1', 'panel')]) });
    const row = rows()[0]!;
    expect(row.tabIndex).toBe(0);
    const key = (el: Element, k: string) => {
      act(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };
    key(row, 'Enter');
    key(row, ' ');
    expect(h.onSelect).toHaveBeenCalledTimes(2);
    key(row, 'a');
    key(host.querySelector('[data-testid="antenna-row-az"]')!, 'Enter');
    key(host.querySelector('[data-testid="antenna-row-delete"]')!, 'Enter');
    expect(h.onSelect).toHaveBeenCalledTimes(2);
  });

  it('shows the note under the tabs', () => {
    show({ file: fileOf([mk('ant-1', 'panel')]), note: 'All reviewed' });
    expect(host.querySelector('[data-testid="antenna-note"]')?.textContent).toBe('All reviewed');
  });
});

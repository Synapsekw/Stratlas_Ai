// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaInventory, type AntennaInventoryProps } from './AntennaInventory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});
const handlers = () => ({
  onSelect: vi.fn(),
  onToggleVisible: vi.fn(),
  onSetStatus: vi.fn(),
  onOpenDetails: vi.fn(),
});
function show(p: Partial<AntennaInventoryProps> & { file: AntennasFile | null }) {
  const h = handlers();
  const ui: ReactElement = (
    <AntennaInventory selected={null} hidden={{}} readOnly={false} {...h} {...p} />
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
  it('groups rows by kind in order with a summary line', () => {
    show({
      file: fileOf([mk('ant-3', 'other'), mk('ant-2', 'dish'), mk('ant-1', 'panel')]),
    });
    const heads = [...host.querySelectorAll('h4')].map((h) => h.textContent);
    expect(heads).toEqual(['Panel antennas', 'Microwave dishes', 'Other equipment']);
    expect([...host.querySelectorAll('h4[aria-hidden="true"]')]).toHaveLength(3);
    expect(rows().map((r) => r.textContent.slice(0, 2))).toEqual(['A1', 'A2', 'A3']);
    const two = fileOf([mk('ant-1', 'panel'), mk('ant-2', 'short'), mk('ant-3', 'other')]);
    show({ file: two });
    expect(host.querySelector('[data-testid="antenna-summary"]')?.textContent).toBe(
      '2 antennas · 1 other equipment · 3 need review · Project north azimuths',
    );
  });

  it('shows the no-run and nothing-found empty states', () => {
    show({ file: null });
    expect(host.textContent).toContain('No antenna run yet');
    show({ file: fileOf([]) });
    expect(host.textContent).toContain('Nothing found');
    expect(rows()).toHaveLength(0);
  });

  it('calls back on select, eye and menu accept', () => {
    const h = show({ file: fileOf([mk('ant-1', 'panel')]) });
    click(rows()[0]!);
    expect(h.onSelect).toHaveBeenCalledWith('ant-1');
    click(host.querySelector('button[aria-label="Hide A1 in 3D"]')!);
    expect(h.onToggleVisible).toHaveBeenCalledWith('ant-1');
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    click(host.querySelector('button[aria-label="More for A1"]')!);
    const accept = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent === 'Accept',
    );
    expect(accept).toBeTruthy();
    click(accept!);
    expect(h.onSetStatus).toHaveBeenCalledWith('ant-1', 'accepted');
  });

  it('offers Show for a hidden unit', () => {
    show({ file: fileOf([mk('ant-1', 'panel')]), hidden: { 'ant-1': true } });
    expect(host.querySelector('button[aria-label="Show A1 in 3D"]')).not.toBeNull();
  });

  it('gives other equipment no azimuth or downtilt', () => {
    show({ file: fileOf([mk('ant-1', 'other'), mk('ant-2', 'panel')]) });
    const [panel, other] = [rows()[0]!, rows()[1]!];
    expect(other.textContent).not.toContain('north');
    expect(other.textContent).not.toContain('°');
    expect(panel.textContent).toContain('123.4°');
    expect(panel.textContent).toContain('4.0°');
  });

  it('names the north once in the summary and keeps rows to degrees', () => {
    show({ file: fileOf([mk('ant-1', 'panel'), mk('ant-2', 'short')]) });
    const summary = () => host.querySelector('[data-testid="antenna-summary"]')?.textContent;
    expect(summary()).toContain('Project north azimuths');
    expect(rows().map((r) => r.textContent)).toEqual(['A1123.4°4.0°Draft', 'A2123.4°4.0°Draft']);
    show({
      file: fileOf([
        mk('ant-1', 'panel', { convergenceDeg: 1.5 }),
        mk('ant-2', 'panel', { convergenceDeg: 1.5 }),
      ]),
    });
    expect(summary()).toContain('True north azimuths');
    expect(rows()[0]!.textContent).toContain('124.9°');
    expect(rows()[0]!.textContent).not.toContain('123.4°');
    expect(rows()[0]!.textContent).not.toContain('north');
  });

  it('keeps the north on each row when the units mix them', () => {
    show({
      file: fileOf([mk('ant-1', 'panel'), mk('ant-2', 'panel', { convergenceDeg: 1.5 })]),
    });
    expect(host.querySelector('[data-testid="antenna-summary"]')?.textContent).not.toContain(
      'north',
    );
    expect(rows()[0]!.textContent).toContain('Project north 123.4°');
    expect(rows()[1]!.textContent).toContain('True 124.9°');
  });

  it('marks status with text, not colour alone', () => {
    show({
      file: fileOf([
        mk('ant-1', 'panel'),
        mk('ant-2', 'panel', { status: 'accepted' }),
        mk('ant-3', 'panel', { status: 'rejected', notFoundInLatest: true }),
      ]),
      selected: 'ant-2',
    });
    const r = rows();
    expect(r.map((x) => x.dataset.status)).toEqual(['draft', 'accepted', 'rejected']);
    expect(r[0]!.querySelector('.chip-status')?.textContent).toBe('Draft');
    expect(r[1]!.querySelector('.chip-status')?.textContent).toBe('Accepted');
    expect(r[2]!.textContent).toContain('Rejected');
    expect(r[2]!.textContent).toContain('Not found in latest run');
    expect(r[1]!.hasAttribute('data-selected')).toBe(true);
    expect(r[0]!.hasAttribute('data-selected')).toBe(false);
    expect(new Set(r.map((x) => x.style.outline)).size).toBe(3);
  });

  it('selects a row from the keyboard without hijacking the buttons', () => {
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
    expect(h.onSelect).toHaveBeenCalledWith('ant-1');
    key(row, 'a');
    key(host.querySelector('button[aria-label="Hide A1 in 3D"]')!, 'Enter');
    expect(h.onSelect).toHaveBeenCalledTimes(2);
  });
});

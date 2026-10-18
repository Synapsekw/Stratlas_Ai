// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AAU_ENTRY,
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  antennasFile,
  sectorsFile,
  unit,
} from './__fixtures__/rfData';
import { CsvImport } from './CsvImport';
import { resetRf, rfStore } from './rfStore';

vi.mock('../shell', () => ({ bridge: { call: vi.fn() }, jobs: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const byTest = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const CSV = [
  'Antenna,Sector,Band,Bandwidth_MHz,Power_dBm,Etilt_deg,Antenna_model,Radio_model',
  'A1,North,B3,20,43,4,Maker P1,Maker R1',
  'a2,East,n78,100,,6,,A1',
  'Z9,West,B3,20,40,2,,',
].join('\n');

const render = async (text: string) => {
  const onClose = vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <CsvImport opener={null} onClose={onClose} readFile={() => Promise.resolve(text)} />,
    ),
  );
  const input = byTest('rf-csv-file') as HTMLInputElement | null;
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([text], 'cells.csv', { type: 'text/csv' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await act(() => Promise.resolve());
  return { onClose };
};

beforeEach(() => {
  resetRf();
  rfStore.setState({
    status: 'ready',
    projectId: 'p3',
    antennas: antennasFile([unit('ant-a1', 10), unit('ant-a2', 130)]),
    sectors: sectorsFile([], []),
    catalogue: [ANTENNA_ENTRY, RADIO_ENTRY, AAU_ENTRY].map((entry) => ({
      origin: 'builtin' as const,
      entry,
    })),
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('CsvImport', () => {
  it('matches rows to units by name and lists the rows that match none', async () => {
    await render(CSV);
    expect(byTest('rf-csv-summary')?.textContent).toBe(
      '2 rows match an antenna; 1 match none and are left out.',
    );
    const a1 = byTest('rf-csv-row-2');
    expect(a1?.getAttribute('data-matched')).toBe('true');
    expect(a1?.textContent).toContain('A1');
    expect(a1?.textContent).toContain('Maker R1, Maker P1');
    // the unit name matches whatever the case
    expect(byTest('rf-csv-row-3')?.getAttribute('data-matched')).toBe('true');
    const z9 = byTest('rf-csv-row-4');
    expect(z9?.getAttribute('data-matched')).toBe('false');
    expect(z9?.textContent).toContain('No match');
    expect(z9?.textContent).toContain('No antenna has this name.');
    expect(z9?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(byTest('rf-csv-apply')?.textContent).toContain('Apply 2 rows');
  });

  it('writes nothing until Apply, then puts the chosen rows in the working copy', async () => {
    const { onClose } = await render(CSV);
    expect(rfStore.getState().sectors.antennas).toEqual([]);
    // leave the second row out
    act(() => byTest('rf-csv-row-3')?.querySelector<HTMLInputElement>('input')?.click());
    act(() => byTest('rf-csv-apply')?.click());
    expect(onClose).toHaveBeenCalled();
    const s = rfStore.getState();
    expect(s.dirty).toBe(true);
    expect(s.sectors.antennas).toEqual([
      {
        antennaId: 'ant-a1',
        active: true,
        equipment: { kind: 'separate', antenna: 'ant-x', radio: 'rru-x' },
        etiltDeg: 4,
        origins: {
          etiltDeg: { by: 'export', confidence: 'high' },
          equipment: { by: 'export', confidence: 'high' },
        },
        carriers: [
          {
            id: 'c1',
            tech: 'lte',
            band: 'B3',
            bandwidthMhz: 20,
            powerDbmPerPort: 43,
            feederLossDb: 0,
            origin: { by: 'export', confidence: 'high' },
          },
        ],
      },
    ]);
    expect(s.sectors.sectors).toEqual([{ id: 'sec-north', name: 'North', antennaIds: ['ant-a1'] }]);
  });

  it('says so when the file has no antenna column', async () => {
    await render('band,power\nB3,40\n');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'no antenna column',
    );
    expect(byTest('rf-csv-apply')?.getAttribute('aria-disabled')).toBe('true');
  });
});

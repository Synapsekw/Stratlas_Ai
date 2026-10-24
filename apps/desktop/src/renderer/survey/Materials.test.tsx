// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  openDialog: vi.fn(),
  openPane: vi.fn(),
  importCsv: vi.fn(() => ({ read: 2, problems: ['Line 4: a number column holds text.'] })),
}));
vi.mock('./compareStore', () => ({ openCompareDialog: calls.openDialog }));
vi.mock('./volumes/materialsDraft', () => ({
  openMaterialsPane: calls.openPane,
  materialsDraft: { getState: () => ({ importCsv: calls.importCsv }) },
}));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));

const { Materials, exportMaterialsCsv, importMaterialsCsv } = await import('./Materials');

describe('the retired materials dialog', () => {
  it('closes itself and opens the Materials pane', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => {
      root.render(<Materials />);
    });
    expect(calls.openDialog).toHaveBeenCalledWith(null);
    expect(calls.openPane).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).toBe('');
    act(() => {
      root.unmount();
    });
  });
});

describe('materials CSV', () => {
  it('import reports what was read and the rows left out', async () => {
    const r = await importMaterialsCsv({ name: 'm.csv', text: () => Promise.resolve('x') });
    expect(calls.importCsv).toHaveBeenCalledWith('x');
    expect(r).toEqual({
      note: '2 materials read from m.csv, 1 rows left out. Save to keep them.',
      error: 'Line 4: a number column holds text.',
    });
  });

  it('export writes the CSV through the save dialog and passes its errors on', async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true, value: { path: 'C:/m.csv' } }));
    const r = await exportMaterialsCsv(
      [{ id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 }],
      call as never,
    );
    expect(r).toEqual({ note: 'Exported to C:/m.csv.', error: null });
    expect(call).toHaveBeenCalledWith('dialog:saveFile', {
      defaultName: 'site-materials.csv',
      data: 'id,name,code,density_t_per_m3,swell_loose,swell_compacted\r\nagg,Aggregate,,1.6,,\r\n',
      title: 'Export the site materials',
    });
    const fail = vi.fn(() => Promise.resolve({ ok: false, error: 'no' }));
    expect(await exportMaterialsCsv([], fail as never)).toEqual({ note: null, error: 'no' });
  });
});

// @vitest-environment jsdom
import type { InspectorMission, InspectorScan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ importFiles: vi.fn(() => Promise.resolve()) }));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ importFiles: h.importFiles }) },
}));
vi.mock('@aio/workspace', () => ({ workspace: { getState: () => ({ project: null }) } }));

import { InspectorPickerHost } from './InspectorPicker';
import { flatScan, initialChoice } from './pickerModel';
import { closeInspectorPicker, picker } from './pickerStore';

const many = (n: number) =>
  Array.from({ length: n }, (_, k) => ({
    id: `f${k}`,
    name: `Flight ${k + 1}`,
    cloud: true,
    path: true,
    aligned: 'relocalised' as const,
  }));
const scan: InspectorScan = {
  root: '/exp',
  generation: '2024-bag',
  asset: 'Chamber',
  inspections: [
    {
      id: 'a',
      name: 'First',
      mergedCloud: true,
      findings: 95,
      photos: 99,
      importedAs: null,
      flights: many(6),
    },
    {
      id: 'b',
      name: 'Second',
      mergedCloud: false,
      findings: 1,
      photos: 1,
      importedAs: 's-b',
      flights: [{ id: 'g0', name: 'Solo', cloud: true, path: false, aligned: 'reference' }],
    },
  ],
};

const second = scan.inspections.find((i) => i.id === 'b');
if (!second) throw new Error('fixture');

let root: Root;
let host: HTMLElement;
const byId = (id: string) => host.ownerDocument.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const open = () => {
  act(() => {
    picker.setState({ path: '/exp', scan, choice: initialChoice(scan) });
  });
};

beforeEach(() => {
  h.importFiles.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => {
    root.render(<InspectorPickerHost />);
  });
});
afterEach(() => {
  act(() => {
    closeInspectorPicker();
    root.unmount();
  });
  host.remove();
});

describe('inspector picker', () => {
  it('shows nothing while closed', () => {
    expect(byId('inspector-picker')).toBeNull();
  });

  it('lists inspections with flights, merged cloud and findings', () => {
    open();
    expect(byId('inspector-row-a')?.textContent).toContain('Merged model');
    expect(byId('inspector-row-a')?.textContent).toContain('95 findings');
    expect(byId('inspector-row-b')?.textContent).toContain('No merged model');
    expect(byId('inspector-row-b')?.textContent).toContain('1 finding');
    expect(byId('inspector-flight-f5')).not.toBeNull();
    expect(byId('inspector-imported-a')).toBeNull();
    expect(byId('inspector-imported-b')?.textContent).toBe('Already imported, will merge');
    expect(byId('inspector-list')).not.toBeNull();
    expect((byId('inspector-tick-b') as HTMLInputElement).checked).toBe(false);
    // the flight with a cloud only still ticks
    expect((byId('inspector-flight-g0') as HTMLInputElement).disabled).toBe(false);
  });

  it('says why a flight cannot be ticked, and ties the merge note to its tick', () => {
    picker.setState({
      path: '/exp',
      scan: {
        ...scan,
        inspections: [
          {
            ...second,
            flights: [{ id: 'g0', name: 'Empty', cloud: false, path: false, aligned: 'transform' }],
          },
        ],
      },
      choice: initialChoice(scan),
    });
    act(() => {
      root.render(<InspectorPickerHost />);
    });
    expect((byId('inspector-flight-g0') as HTMLInputElement).disabled).toBe(true);
    expect(byId('inspector-note-g0')?.textContent).toBe('No point cloud or path');
    // the reason is tied to its checkbox for screen readers
    expect(byId('inspector-flight-g0')?.getAttribute('aria-describedby')).toBe('inspector-note-g0');
    expect(byId('inspector-tick-b')?.getAttribute('aria-describedby')).toBe('inspector-merge-b');
    expect(document.getElementById('inspector-merge-b')?.textContent).toBe(
      'Already imported, will merge',
    );
  });

  it('Import is off with nothing ticked, and sends the choice when on', () => {
    open();
    const imp = byId('inspector-import') as HTMLButtonElement;
    expect(imp.disabled).toBe(false);
    act(() => {
      byId('inspector-tick-a')?.click();
    });
    expect((byId('inspector-import') as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      byId('inspector-flight-f2')?.click();
    });
    expect((byId('inspector-import') as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      byId('inspector-import')?.click();
    });
    expect(h.importFiles).toHaveBeenCalledWith(['/exp'], undefined, {
      inspector: { inspections: [{ id: 'a', flights: ['f2'] }] },
    });
    expect(byId('inspector-picker')).toBeNull();
  });

  it('Escape closes without importing', () => {
    open();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byId('inspector-picker')).toBeNull();
    expect(h.importFiles).not.toHaveBeenCalled();
  });

  const mission: InspectorMission = {
    root: '/m',
    exports: [
      {
        path: '/m/x/Chamber A',
        name: 'Chamber A',
        scan: { ...scan, inspections: scan.inspections.slice(0, 1) },
      },
      { path: '/m/x/Chamber B', name: 'Chamber B', scan: { ...scan, inspections: [second] } },
    ],
    skipped: { folders: ['Raw drone data', 'Reports'], files: 3 },
    capped: false,
  };
  const openMission = (m: InspectorMission) => {
    act(() => {
      picker.setState({
        path: m.root,
        mission: m,
        scan: flatScan(m),
        choice: initialChoice(flatScan(m)),
      });
    });
  };

  it('lists a mission folder as chambers with counts, the summary and what was skipped', () => {
    openMission(mission);
    // 6 flight clouds + merged in A, one in B: 8
    expect(byId('inspector-summary')?.textContent).toBe('2 chambers, 100 photos, 8 point clouds');
    expect(byId('inspector-skipped')?.textContent).toContain(
      'Skipped 2 other folders, Skipped 3 loose files',
    );
    expect(byId('inspector-skipped')?.textContent).toContain('Raw drone data');
    expect(byId('inspector-chamber-0')?.textContent).toContain('Chamber A');
    expect(byId('inspector-chamber-0')?.textContent).toContain(
      '1 inspection · 6 flights · 95 findings · 99 photos · 7 point clouds',
    );
    expect((byId('inspector-chamber-tick-0') as HTMLInputElement).checked).toBe(true);
    // B is already imported: unticked, and says it will merge
    expect((byId('inspector-chamber-tick-1') as HTMLInputElement).checked).toBe(false);
    expect(byId('inspector-imported-b')).not.toBeNull();
    act(() => {
      byId('inspector-chamber-tick-1')?.click();
    });
    act(() => {
      byId('inspector-import')?.click();
    });
    expect(h.importFiles).toHaveBeenCalledWith(['/m/x/Chamber A', '/m/x/Chamber B'], undefined, {
      inspector: { inspections: [{ id: 'a', space: 'Chamber A' }, { id: 'b' }] },
    });
  });

  it('a folder with no export says so, with a hint, and cannot import', () => {
    openMission({ ...mission, exports: [] });
    expect(byId('inspector-none-found')?.textContent).toContain(
      'No Inspector export found in this folder',
    );
    expect(byId('inspector-list')).toBeNull();
    expect((byId('inspector-import') as HTMLButtonElement).disabled).toBe(true);
  });
});

// @vitest-environment jsdom
import type { InspectorScan } from '@aio/schema';
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
import { initialChoice } from './pickerModel';
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
    { id: 'a', name: 'First', mergedCloud: true, findings: 95, importedAs: null, flights: many(6) },
    {
      id: 'b',
      name: 'Second',
      mergedCloud: false,
      findings: 1,
      importedAs: 's-b',
      flights: [{ id: 'g0', name: 'Solo', cloud: true, path: false, aligned: 'reference' }],
    },
  ],
};

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
});

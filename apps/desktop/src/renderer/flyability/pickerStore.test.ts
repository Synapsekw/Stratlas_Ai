import type { InspectorScan } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  call: vi.fn(),
  importFiles: vi.fn(() => Promise.resolve()),
}));
vi.mock('../shell', () => ({ bridge: { call: h.call } }));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ importFiles: h.importFiles }) },
}));
vi.mock('@aio/workspace', () => ({
  workspace: { getState: () => ({ project: { id: 'p1' } }) },
}));

import {
  closeInspectorPicker,
  confirmInspectorPicker,
  openInspectorPicker,
  picker,
  toggleFlightTick,
} from './pickerStore';

const scan: InspectorScan = {
  root: '/exp',
  generation: '2024-bag',
  asset: 'Chamber',
  inspections: [
    {
      id: 'a',
      name: 'A',
      mergedCloud: true,
      findings: 4,
      importedAs: null,
      flights: [
        { id: 'a1', name: 'a1', cloud: true, path: true, aligned: 'reference' },
        { id: 'a2', name: 'a2', cloud: true, path: true, aligned: 'transform' },
      ],
    },
  ],
};

beforeEach(() => {
  h.call.mockReset();
  h.importFiles.mockClear();
  clearToasts();
  closeInspectorPicker();
});
afterEach(() => {
  closeInspectorPicker();
});

describe('inspector picker store', () => {
  it('a failed scan shows an error toast and no dialog', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: false, error: 'bad' } });
    await openInspectorPicker('/exp');
    expect(picker.getState().path).toBeNull();
    expect(toastQueue().map((x) => [x.tone, x.message])).toEqual([
      ['error', 'Could not open this folder as a Flyability Inspector export.'],
    ]);
  });

  it('scans with the open project id and opens on the result', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true, scan } });
    await openInspectorPicker('/exp');
    expect(h.call).toHaveBeenCalledWith('builder:inspectorScan', { projectId: 'p1', path: '/exp' });
    expect(picker.getState().path).toBe('/exp');
  });

  it('import sends the choice with the path', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true, scan } });
    await openInspectorPicker('/exp');
    toggleFlightTick('a', 'a2');
    await confirmInspectorPicker();
    expect(h.importFiles).toHaveBeenCalledWith(['/exp'], undefined, {
      inspector: { inspections: [{ id: 'a', flights: ['a1'] }] },
    });
    expect(picker.getState().path).toBeNull();
  });

  it('an import that throws shows an error toast', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true, scan } });
    h.importFiles.mockRejectedValueOnce(new Error('disk gone'));
    await openInspectorPicker('/exp');
    await confirmInspectorPicker();
    expect(toastQueue().map((x) => [x.tone, x.message, x.detail])).toEqual([
      ['error', 'Could not start the import.', 'disk gone'],
    ]);
  });

  it('a scan that comes back after a close opens nothing', async () => {
    let done: (v: unknown) => void = () => undefined;
    h.call.mockReturnValue(new Promise((r) => (done = r)));
    const p = openInspectorPicker('/exp');
    closeInspectorPicker();
    done({ ok: true, value: { ok: true, scan } });
    await p;
    expect(picker.getState().path).toBeNull();
  });

  it('an export with no inspections says so', async () => {
    h.call.mockResolvedValue({
      ok: true,
      value: { ok: true, scan: { ...scan, inspections: [] } },
    });
    await openInspectorPicker('/exp');
    expect(picker.getState().path).toBeNull();
    expect(toastQueue()).toHaveLength(1);
  });
});

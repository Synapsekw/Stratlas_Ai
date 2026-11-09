import type { InspectorMission, InspectorScan } from '@aio/schema';
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
  toggleChamberTick,
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
      photos: 6,
      importedAs: null,
      flights: [
        { id: 'a1', name: 'a1', cloud: true, path: true, aligned: 'reference' },
        { id: 'a2', name: 'a2', cloud: true, path: true, aligned: 'transform' },
      ],
    },
  ],
};

const one = (sc: InspectorScan): InspectorMission => ({
  root: '/exp',
  exports: [{ path: '/exp', name: 'A', scan: sc }],
  skipped: { folders: [], files: 0 },
  capped: false,
});

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
    h.call.mockResolvedValue({ ok: true, value: { ok: true, mission: one(scan) } });
    await openInspectorPicker('/exp');
    expect(h.call).toHaveBeenCalledWith('builder:inspectorScan', { projectId: 'p1', path: '/exp' });
    expect(picker.getState().path).toBe('/exp');
  });

  it('import sends the choice with the path', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true, mission: one(scan) } });
    await openInspectorPicker('/exp');
    toggleFlightTick('a', 'a2');
    await confirmInspectorPicker();
    expect(h.importFiles).toHaveBeenCalledWith(['/exp'], undefined, {
      inspector: { inspections: [{ id: 'a', flights: ['a1'] }] },
    });
    expect(picker.getState().path).toBeNull();
  });

  it('an import that throws shows an error toast', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true, mission: one(scan) } });
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
    done({ ok: true, value: { ok: true, mission: one(scan) } });
    await p;
    expect(picker.getState().path).toBeNull();
  });

  it('an export with no inspections says so', async () => {
    h.call.mockResolvedValue({
      ok: true,
      value: { ok: true, mission: one({ ...scan, inspections: [] }) },
    });
    await openInspectorPicker('/exp');
    expect(picker.getState().path).toBeNull();
    expect(toastQueue()).toHaveLength(1);
  });

  it('a mission folder imports each ticked chamber from its own folder', async () => {
    const b = { ...scan, inspections: [{ ...scan.inspections[0], id: 'b' }] } as InspectorScan;
    const mission: InspectorMission = {
      root: '/m',
      exports: [
        { path: '/m/x/Chamber A', name: 'Chamber A', scan },
        { path: '/m/x/Chamber B', name: 'Chamber B', scan: b },
      ],
      skipped: { folders: ['Raw'], files: 0 },
      capped: false,
    };
    h.call.mockResolvedValue({ ok: true, value: { ok: true, mission } });
    await openInspectorPicker('/m');
    toggleChamberTick('/m/x/Chamber A');
    await confirmInspectorPicker();
    expect(h.importFiles).toHaveBeenCalledWith(['/m/x/Chamber B'], undefined, {
      inspector: { inspections: [{ id: 'b', space: 'Chamber B' }] },
    });
  });

  it('a folder with no export opens the picker on its empty state', async () => {
    h.call.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        mission: { root: '/x', exports: [], skipped: { folders: ['a'], files: 0 }, capped: false },
      },
    });
    await openInspectorPicker('/x');
    expect(picker.getState().path).toBe('/x');
    expect(picker.getState().mission?.exports).toEqual([]);
    expect(toastQueue()).toHaveLength(0);
  });
});

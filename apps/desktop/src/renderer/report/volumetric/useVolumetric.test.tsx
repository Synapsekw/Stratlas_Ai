// @vitest-environment jsdom
import { volumetricModel, type VolumetricInput } from '@aio/project/export';
import type { ReportTextFile } from '@aio/schema';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editText } from './editorModel';
import { useVolumetric, type VolumetricEditor, type VolumetricOptions } from './useVolumetric';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../shell', () => ({ bridge: { call } }));
vi.mock('../../author', () => ({ authorName: () => 'Surveyor' }));
const { reportIfChangedOnDisk } = vi.hoisted(() => ({ reportIfChangedOnDisk: vi.fn() }));
vi.mock('../../diskChanged', () => ({
  reportIfChangedOnDisk,
  useDiskChanged: (pick: (s: { reloads: number }) => unknown) => pick({ reloads: 0 }),
}));

const pileDate = (capture: string, volumeM3: number) => ({
  capture,
  volumeM3,
  densityTPerM3: 1.6,
  areaM2: 100,
  peakM: 4,
  plusMinusM3: null,
  outline: [
    [0, 0],
    [10, 0],
    [10, 10],
  ] as [number, number][],
});
const input: VolumetricInput = {
  captures: [
    { id: 'c1', label: 'May', date: '2026-05-01' },
    { id: 'c2', label: 'June', date: '2026-06-01' },
    { id: 'c3', label: 'July', date: '2026-07-01' },
  ],
  piles: [
    {
      id: 'm1',
      label: 'SP1',
      material: null,
      base: 'Lowest point',
      dates: [pileDate('c1', 900), pileDate('c2', 1000), pileDate('c3', 1200)],
    },
  ],
  project: { name: 'Demo yard', customer: 'Yard owner', site: null, crs: 'EPSG:32639' },
  method: { cellM: 0.1, gsdCm: 3, siteDensityTPerM3: null },
  frame: null,
};
const model = volumetricModel(input);

let saved: ReportTextFile | null = null;
let readOnly = false;
const writes: ReportTextFile[] = [];
const modelCalls: { compareWith?: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  saved = null;
  readOnly = false;
  writes.length = 0;
  modelCalls.length = 0;
  call.mockReset();
  call.mockImplementation((channel: string, req: Record<string, unknown>) => {
    if (channel === 'report:readText')
      return Promise.resolve({ ok: true, value: { ok: true, file: saved, readOnly } });
    if (channel === 'report:writeText') {
      writes.push(req.file as ReportTextFile);
      return Promise.resolve({ ok: true, value: { ok: true } });
    }
    if (channel === 'report:volumetricModel') {
      modelCalls.push({ ...(req.compareWith ? { compareWith: req.compareWith as string } : {}) });
      return Promise.resolve({ ok: true, value: { ok: true, model } });
    }
    return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
  });
});

let root: Root | undefined;
let ed: VolumetricEditor;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

function Probe(props: VolumetricOptions) {
  const editor = useVolumetric(props);
  useEffect(() => {
    ed = editor;
  });
  return null;
}
const opts: VolumetricOptions = {
  projectId: 'p1',
  dataKey: 'd1',
  customer: 'Yard owner',
  companyName: 'Survey firm',
};
async function mount(o: VolumetricOptions = opts) {
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () => {
    root?.render(<Probe {...o} />);
    await vi.runOnlyPendingTimersAsync();
  });
}
const rerender = async (o: VolumetricOptions) =>
  act(async () => {
    root?.render(<Probe {...o} />);
    await vi.runOnlyPendingTimersAsync();
  });
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe('useVolumetric', () => {
  it('loads the saved edits and the model, and resolves the defaults', async () => {
    saved = editText(null, 'title', 'Monthly yard report', {}, new Date('2026-10-01T00:00:00Z'));
    await mount();
    expect(ed.ready).toBe(true);
    expect(ed.texts.title).toEqual({ text: 'Monthly yard report', generated: false });
    expect(ed.texts.preparedFor.text).toBe('Yard owner');
    expect(ed.texts.preparedBy.text).toBe('Survey firm');
    expect(ed.texts.summary.generated).toBe(true);
    expect(ed.preview?.text.title).toBe('Monthly yard report');
  });

  it('saves an edit as a user version after 600 ms, once', async () => {
    await mount();
    act(() => {
      ed.setText('summary', 'Edited summary.');
    });
    act(() => {
      ed.setText('summary', 'Edited summary for the yard.');
    });
    expect(ed.texts.summary).toEqual({ text: 'Edited summary for the yard.', generated: false });
    expect(ed.preview?.text.summary).toBe('Edited summary for the yard.');
    await act(() => vi.advanceTimersByTimeAsync(599));
    expect(writes).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.parts.summary?.versions.at(-1)).toMatchObject({
      source: 'user',
      author: 'Surveyor',
      text: 'Edited summary for the yard.',
    });
    expect(ed.saveState).toBe('saved');
  });

  it('Reset to generated adds a template version with the generated text', async () => {
    await mount();
    act(() => {
      ed.setText('summary', 'Mine.');
    });
    act(() => {
      ed.reset('summary');
    });
    expect(ed.texts.summary.generated).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(600));
    const last = writes.at(-1)?.parts.summary?.versions.at(-1);
    expect(last).toMatchObject({ source: 'template', text: ed.generated.summary });
  });

  it('caps pile notes and keeps one page on', async () => {
    await mount();
    act(() => {
      ed.setPileNote('m1', 'y'.repeat(300));
    });
    expect(ed.pileNotes.m1).toHaveLength(280);
    act(() => {
      ed.setPage('cover', false);
    });
    act(() => {
      ed.setPage('piles', false);
    });
    act(() => {
      ed.setPage('change', false);
    });
    expect(ed.pages).toEqual({ cover: false, piles: false, change: true });
  });

  it('flushes a pending save on unmount', async () => {
    await mount();
    act(() => {
      ed.setText('intro', 'Scope of the survey.');
    });
    expect(writes).toHaveLength(0);
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.parts.intro?.versions.at(-1)?.text).toBe('Scope of the survey.');
  });

  it('never writes in a read-only package', async () => {
    readOnly = true;
    await mount();
    expect(ed.readOnly).toBe(true);
    act(() => {
      ed.setText('summary', 'Edited.');
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(writes).toHaveLength(0);
  });

  it('fetches the model once per compared date and data fingerprint', async () => {
    await mount();
    expect(modelCalls).toEqual([{}]);
    await rerender({ ...opts });
    expect(modelCalls).toHaveLength(1);
    await act(async () => {
      ed.setCompareWith('c1');
      await vi.runOnlyPendingTimersAsync();
    });
    expect(modelCalls).toEqual([{}, { compareWith: 'c1' }]);
    await rerender({ ...opts, dataKey: 'd2' });
    expect(modelCalls).toEqual([{}, { compareWith: 'c1' }, { compareWith: 'c1' }]);
    await act(async () => {
      ed.setCompareWith(null);
      await vi.runOnlyPendingTimersAsync();
    });
    await rerender({ ...opts, dataKey: 'd1' });
    // back to a pair already fetched: served from the cache
    expect(modelCalls).toHaveLength(4);
  });

  it('shows a failed model fetch', async () => {
    call.mockImplementation((channel: string) =>
      channel === 'report:volumetricModel'
        ? Promise.resolve({ ok: true, value: { ok: false, error: 'no figures' } })
        : Promise.resolve({ ok: true, value: { ok: true, file: null, readOnly: false } }),
    );
    await mount();
    expect(ed.ready).toBe(false);
    expect(ed.error).toBe('no figures');
  });
});

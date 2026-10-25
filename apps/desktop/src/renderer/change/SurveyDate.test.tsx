// @vitest-environment jsdom
import type { Capture, Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { call, readOnly } = vi.hoisted(() => ({
  call: vi.fn(),
  readOnly: { on: false },
}));
vi.mock('../shell', () => ({ bridge: { call } }));
vi.mock('@aio/annotate', () => ({ isAnnotateReadOnly: () => readOnly.on }));

import {
  newSurveyDate,
  removeEmptyCapture,
  setLayersCapture,
  SurveyDateSelect,
} from './SurveyDate';

const cap = (date: string): Capture => ({ id: `capture-${date}`, label: 'Survey', date });
const layer = (id: string, capture?: string): Layer =>
  ({
    id,
    kind: 'ortho',
    name: id,
    src: `layers/${id}.tif`,
    visible: true,
    ...(capture ? { capture } : {}),
  }) as unknown as Layer;

const manifest = (captures: Capture[], layers: Layer[]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures,
  layers,
  severityModels: [],
  classCatalogues: [],
});

/** Main as far as these channels go: it keeps the manifest and answers like the real handlers. */
let disk: ProjectManifest;
function fakeMain() {
  call.mockImplementation((channel: string, req: Record<string, unknown>) => {
    if (channel === 'builder:ensureCapture') {
      const date = req.date as string;
      const found = disk.captures.find((c) => c.date === date);
      if (found)
        return Promise.resolve({
          ok: true,
          value: { ok: true, manifest: disk, captureId: found.id, created: false },
        });
      disk = { ...disk, captures: [...disk.captures, cap(date)] };
      return Promise.resolve({
        ok: true,
        value: { ok: true, manifest: disk, captureId: `capture-${date}`, created: true },
      });
    }
    if (channel === 'builder:updateLayers') {
      const ids = req.layerIds as string[];
      const { capture } = req.patch as { capture: string | null };
      disk = {
        ...disk,
        layers: disk.layers.map((l) => {
          if (!ids.includes(l.id)) return l;
          const next: Layer = { ...l };
          delete next.capture;
          if (capture) next.capture = capture;
          return next;
        }),
      };
      return Promise.resolve({ ok: true, value: { ok: true, manifest: disk } });
    }
    if (channel === 'builder:removeCapture') {
      disk = { ...disk, captures: disk.captures.filter((c) => c.id !== req.captureId) };
      return Promise.resolve({ ok: true, value: { ok: true, manifest: disk, backup: 'b.json' } });
    }
    throw new Error(`unexpected channel ${channel}`);
  });
}

function open(m: ProjectManifest) {
  disk = m;
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: m });
}

const calls = (channel: string) => call.mock.calls.filter((c) => c[0] === channel);

let host: HTMLDivElement;
let root: Root | undefined;

type Props = Parameters<typeof SurveyDateSelect>[0];
function show(over: Partial<Props> = {}) {
  act(() => {
    root = createRoot(host);
    root.render(
      <SurveyDateSelect
        layerIds={['a']}
        label="Survey date"
        noneLabel="Not dated"
        testId="sd"
        {...over}
      />,
    );
  });
}

const select = () => host.querySelector<HTMLSelectElement>('[data-testid="sd"] select');
const options = () => [...(select()?.options ?? [])].map((o) => [o.value, o.textContent]);
async function pick(value: string) {
  const s = select() ?? expect.fail('no select');
  await act(async () => {
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}
async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
}
const byTestId = (id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? expect.fail(`no ${id}`);
const dayInput = () =>
  host.querySelector<HTMLInputElement>('[data-testid="sd-new"]') ?? expect.fail('no day field');
/** Type a day into the New survey date field the way a typed change arrives (React tracks it). */
function typeDay(value: string) {
  act(() => {
    const input = dayInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** New survey date..., type the day, Add. */
async function addDay(day: string) {
  await pick('new');
  typeDay(day);
  await act(async () => {
    byTestId('sd-add').click();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  call.mockReset();
  readOnly.on = false;
  host = document.createElement('div');
  document.body.append(host);
  fakeMain();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('newSurveyDate', () => {
  it('asks main for the date of the day and takes the new manifest', async () => {
    open(manifest([], [layer('a')]));
    await expect(newSurveyDate('2024-11-06')).resolves.toEqual({
      captureId: 'capture-2024-11-06',
      created: true,
    });
    // a day that already has a date gives that date
    await expect(newSurveyDate('2024-11-06')).resolves.toEqual({
      captureId: 'capture-2024-11-06',
      created: false,
    });
    expect(calls('builder:ensureCapture')[0]).toEqual([
      'builder:ensureCapture',
      { projectId: 'p', date: '2024-11-06' },
    ]);
    expect(workspace.getState().project?.manifest.captures.map((c) => c.id)).toEqual([
      'capture-2024-11-06',
    ]);
  });

  it('says what went wrong', async () => {
    open(manifest([], []));
    call.mockResolvedValueOnce({ ok: true, value: { ok: false, error: 'Disk full.' } });
    await expect(newSurveyDate('2024-11-06')).resolves.toEqual({ error: 'Disk full.' });
    call.mockResolvedValueOnce({ ok: false, error: 'Bridge gone.' });
    await expect(newSurveyDate('2024-11-06')).resolves.toEqual({ error: 'Bridge gone.' });
  });

  it('needs an open project', async () => {
    const r = await newSurveyDate('2024-11-06');
    expect('error' in r).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('removeEmptyCapture', () => {
  it('removes a date no layer names', async () => {
    open(manifest([cap('2024-11-06')], [layer('a')]));
    await expect(removeEmptyCapture('capture-2024-11-06')).resolves.toBeNull();
    expect(calls('builder:removeCapture')).toEqual([
      ['builder:removeCapture', { projectId: 'p', captureId: 'capture-2024-11-06' }],
    ]);
    expect(workspace.getState().project?.manifest.captures).toEqual([]);
  });

  it('leaves a date a layer still names', async () => {
    open(manifest([cap('2024-11-06')], [layer('a', 'capture-2024-11-06')]));
    await expect(removeEmptyCapture('capture-2024-11-06')).resolves.toBeNull();
    expect(calls('builder:removeCapture')).toEqual([]);
  });

  it('does nothing for a date that is not there', async () => {
    open(manifest([], [layer('a')]));
    await expect(removeEmptyCapture('capture-2024-11-06')).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('says what went wrong', async () => {
    open(manifest([cap('2024-11-06')], [layer('a')]));
    call.mockResolvedValueOnce({ ok: true, value: { ok: false, error: 'Locked.' } });
    await expect(removeEmptyCapture('capture-2024-11-06')).resolves.toBe('Locked.');
  });
});

describe('SurveyDateSelect', () => {
  it('shows with no date and offers Not dated and New survey date', () => {
    open(manifest([], [layer('a')]));
    show();
    expect(options()).toEqual([
      ['', 'Not dated'],
      ['new', 'New survey date...'],
    ]);
  });

  it('shows with one date', () => {
    open(manifest([cap('2024-11-06')], [layer('a', 'capture-2024-11-06')]));
    show();
    expect(options()).toHaveLength(3);
    expect(select()?.value).toBe('capture-2024-11-06');
  });

  it('lists the dates oldest first, tags the ones the import created and says where the date came from', () => {
    open(manifest([cap('2025-02-01'), cap('2024-11-06')], [layer('a')]));
    show({ createdHere: ['capture-2025-02-01'], source: 'both' });
    expect(options().map((o) => o[0])).toEqual([
      '',
      'capture-2024-11-06',
      'capture-2025-02-01',
      'new',
    ]);
    expect(options()[2]?.[1]).toContain('(new)');
    expect(options()[1]?.[1]).not.toContain('(new)');
    expect(host.querySelector('[data-testid="sd"] .faint.small')?.textContent).toBe(
      'Read from the photos and video.',
    );
  });

  it('is left out without layers', () => {
    open(manifest([cap('2024-11-06')], []));
    show({ layerIds: [] });
    expect(select()).toBeNull();
  });

  it('files the layers under a new survey date of the typed day', async () => {
    open(manifest([], [layer('a')]));
    show({ suggestedDay: '2024-11-06' });
    await pick('new');
    const day = dayInput();
    expect(day.value).toBe('2024-11-06');
    typeDay('2024-12-01');
    await act(async () => {
      byTestId('sd-add').click();
      await Promise.resolve();
    });
    await settle();
    expect(calls('builder:ensureCapture')).toEqual([
      ['builder:ensureCapture', { projectId: 'p', date: '2024-12-01' }],
    ]);
    expect(calls('builder:updateLayers')).toEqual([
      [
        'builder:updateLayers',
        { projectId: 'p', layerIds: ['a'], patch: { capture: 'capture-2024-12-01' } },
      ],
    ]);
    expect(host.querySelector('[data-testid="sd-new"]')).toBeNull();
    expect(select()?.value).toBe('capture-2024-12-01');
  });

  it('prefills today without a suggested day, and Cancel goes back to the select', async () => {
    open(manifest([], [layer('a')]));
    show();
    await pick('new');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(dayInput().value).toBe(today);
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    act(() => cancel?.click());
    expect(host.querySelector('[data-testid="sd-new"]')).toBeNull();
    expect(select()).not.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('removes the date the import created once the layers leave it empty', async () => {
    open(manifest([cap('2024-11-06'), cap('2025-02-01')], [layer('a', 'capture-2025-02-01')]));
    show({ createdHere: ['capture-2025-02-01'] });
    await pick('capture-2024-11-06');
    expect(calls('builder:removeCapture')).toEqual([
      ['builder:removeCapture', { projectId: 'p', captureId: 'capture-2025-02-01' }],
    ]);
    expect(workspace.getState().project?.manifest.captures.map((c) => c.id)).toEqual([
      'capture-2024-11-06',
    ]);
  });

  it('never removes a date that was there before the import', async () => {
    open(manifest([cap('2024-11-06'), cap('2025-02-01')], [layer('a', 'capture-2025-02-01')]));
    show({ createdHere: [] });
    await pick('capture-2024-11-06');
    await pick('');
    expect(calls('builder:updateLayers')).toHaveLength(2);
    expect(calls('builder:removeCapture')).toEqual([]);
  });

  it('keeps a date the import created while another layer still names it', async () => {
    open(
      manifest(
        [cap('2024-11-06'), cap('2025-02-01')],
        [layer('a', 'capture-2025-02-01'), layer('b', 'capture-2025-02-01')],
      ),
    );
    show({ createdHere: ['capture-2025-02-01'] });
    await pick('capture-2024-11-06');
    expect(calls('builder:removeCapture')).toEqual([]);
  });

  it('re-dated twice: a date made here goes only when empty, an earlier one never', async () => {
    open(
      manifest(
        [cap('2024-11-06'), cap('2025-02-01')],
        [layer('a', 'capture-2025-02-01'), layer('old', 'capture-2024-11-06')],
      ),
    );
    show({ createdHere: ['capture-2025-02-01'], suggestedDay: '2025-02-01' });
    // to a new date: the import's date is empty now and goes
    await addDay('2025-03-03');
    expect(
      calls('builder:removeCapture').map((c) => (c[1] as { captureId: string }).captureId),
    ).toEqual(['capture-2025-02-01']);
    // back to the metadata date: made again, and the date made in between goes
    await addDay('2025-02-01');
    expect(
      calls('builder:removeCapture').map((c) => (c[1] as { captureId: string }).captureId),
    ).toEqual(['capture-2025-02-01', 'capture-2025-03-03']);
    // to a date that was there before, and off it again: that one is never removed
    await pick('capture-2024-11-06');
    await pick('');
    const removed = calls('builder:removeCapture').map(
      (c) => (c[1] as { captureId: string }).captureId,
    );
    expect(removed).not.toContain('capture-2024-11-06');
    expect(workspace.getState().project?.manifest.captures.map((c) => c.id)).toEqual([
      'capture-2024-11-06',
    ]);
  });

  it('tidies nothing without createdHere (the Selection card)', async () => {
    open(manifest([cap('2025-02-01')], [layer('a', 'capture-2025-02-01')]));
    show();
    await addDay('2025-03-03');
    await pick('');
    expect(calls('builder:updateLayers')).toHaveLength(2);
    expect(calls('builder:removeCapture')).toEqual([]);
  });

  it('is disabled when read-only', () => {
    readOnly.on = true;
    open(manifest([cap('2024-11-06')], [layer('a')]));
    show();
    expect(select()?.disabled).toBe(true);
  });
});

describe('LayerDatePicker moves announce themselves', () => {
  it('a re-file from the Selection card is announced with the date it left', async () => {
    open(manifest([cap('2024-11-06'), cap('2024-11-07')], [layer('a', 'capture-2024-11-06')]));
    fakeMain();
    const seen: unknown[] = [];
    const { moveAnnounce } = await import('../shell/dateMoveNote');
    const off = moveAnnounce.subscribe((s) => seen.push(s.last));
    show();
    await pick('capture-2024-11-07');
    off();
    expect(seen).toEqual([
      expect.objectContaining({
        moved: [{ id: 'a', capture: 'capture-2024-11-06' }],
        target: 'capture-2024-11-07',
      }),
    ]);
  });

  it('the import card (dates made there) announces nothing', async () => {
    open(manifest([cap('2024-11-06'), cap('2024-11-07')], [layer('a', 'capture-2024-11-06')]));
    fakeMain();
    const { moveAnnounce } = await import('../shell/dateMoveNote');
    const before = moveAnnounce.getState().last;
    show({ createdHere: [] });
    await pick('capture-2024-11-07');
    expect(moveAnnounce.getState().last).toBe(before);
  });
});

describe('LayerDatePicker: Undo of a move to a new survey date', () => {
  it('names the date it made, and Undo removes that date once it is left empty', async () => {
    open(manifest([cap('2024-11-06')], [layer('a', 'capture-2024-11-06')]));
    fakeMain();
    const { moveAnnounce } = await import('../shell/dateMoveNote');
    show();
    await addDay('2024-11-08');
    const last = moveAnnounce.getState().last ?? expect.fail('no announcement');
    expect(last).toMatchObject({
      moved: [{ id: 'a', capture: 'capture-2024-11-06' }],
      target: 'capture-2024-11-08',
      made: 'capture-2024-11-08',
    });
    const { undoDateMove } = await import('../shell/dateFolders');
    await act(async () => {
      await expect(undoDateMove(last.moved, last.target, last.made)).resolves.toBeNull();
    });
    expect(disk.layers.find((l) => l.id === 'a')?.capture).toBe('capture-2024-11-06');
    expect(disk.captures.map((c) => c.id)).toEqual(['capture-2024-11-06']);
  });

  it('keeps the date it made when something else was filed there since', async () => {
    open(
      manifest(
        [cap('2024-11-06')],
        [layer('a', 'capture-2024-11-06'), layer('b', 'capture-2024-11-06')],
      ),
    );
    fakeMain();
    const { moveAnnounce } = await import('../shell/dateMoveNote');
    show();
    await addDay('2024-11-08');
    const last = moveAnnounce.getState().last ?? expect.fail('no announcement');
    await act(async () => {
      await setLayersCapture(['b'], 'capture-2024-11-08');
    });
    const { undoDateMove } = await import('../shell/dateFolders');
    await act(async () => {
      await expect(undoDateMove(last.moved, last.target, last.made)).resolves.toBeNull();
    });
    expect(disk.captures.map((c) => c.id)).toContain('capture-2024-11-08');
  });

  it('a date that was there before is not named', async () => {
    open(manifest([cap('2024-11-06'), cap('2024-11-08')], [layer('a', 'capture-2024-11-06')]));
    fakeMain();
    const { moveAnnounce } = await import('../shell/dateMoveNote');
    show();
    await addDay('2024-11-08');
    expect(moveAnnounce.getState().last?.made).toBeUndefined();
  });
});

import type { AltitudePlan } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const replaceManifest = vi.fn();

vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  shell: { getState: () => ({ loadLibrary: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', () => ({
  workspace: {
    getState: () => ({ project: { id: 'p1', manifest: { origin: [0, 0, 30] } }, replaceManifest }),
  },
}));
vi.mock('./pick', () => ({ terrainHeightAt: () => null }));
// drawing the pages of a PDF needs the app window; the store only has to wait for it
const finishStaged = vi.fn();
vi.mock('../drawings/importFlow', () => ({
  finishStagedDrawings: (...a: unknown[]) => finishStaged(...a) as unknown,
}));
// the store listens for progress on the preload bridge, which a test does not have
vi.stubGlobal('window', {});

import { builder } from './state';

const plan = (over: Partial<AltitudePlan> = {}): AltitudePlan => ({
  files: 0,
  absolute: 0,
  relative: 0,
  datum: null,
  recommended: 'absolute',
  takeoff: null,
  takeoffAbsAlt: null,
  ...over,
});
/** A plan that asks for the take-off height before the import runs. */
const asks = plan({ files: 2, relative: 2, recommended: 'relative' });
const planned = (p: AltitudePlan) => ({ ok: true, value: { ok: true, plan: p } });
const imported = { ok: true, value: { ok: true, manifest: { layers: [] }, items: [] } };

/** A reply the test gives when it chooses to. */
function later<T>() {
  let give: (v: T) => void = () => undefined;
  const reply = new Promise<T>((resolve) => {
    give = resolve;
  });
  return { reply, give };
}

const calls = (channel: string) => call.mock.calls.filter((c) => c[0] === channel);
const b = () => builder.getState();

beforeEach(() => {
  call.mockReset();
  replaceManifest.mockReset();
  finishStaged.mockReset();
  builder.setState({ importing: null, importResult: null, heightsPrompt: null });
});

describe('importFiles, one import at a time', () => {
  it('starts one import when files are dropped again while the first drop is being prepared', async () => {
    const reading = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:altitudePlan' ? reading.reply : Promise.resolve(imported),
    );
    const first = b().importFiles(['a.jpg', 'b.jpg']);
    // nothing shows yet: the heights of the files are still being read
    expect(b().importing).toBeNull();
    const second = b().importFiles(['a.jpg', 'b.jpg']);
    reading.give(planned(plan()));
    await Promise.all([first, second]);
    expect(calls('builder:altitudePlan')).toHaveLength(1);
    expect(calls('builder:import')).toEqual([
      ['builder:import', { projectId: 'p1', paths: ['a.jpg', 'b.jpg'] }],
    ]);
    expect(b().importing).toBeNull();
    expect(b().importResult).toEqual({ items: [], error: null });
    expect(replaceManifest).toHaveBeenCalledTimes(1);
  });

  it('takes the next drop once the heights prompt is open, as before', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:altitudePlan' ? planned(asks) : imported),
    );
    await b().importFiles(['a.jpg']);
    expect(b().heightsPrompt?.paths).toEqual(['a.jpg']);
    // the prompt is not an import: the panel does not say "importing" while it is open
    expect(b().importing).toBeNull();
    await b().importFiles(['b.jpg']);
    expect(calls('builder:altitudePlan')).toHaveLength(2);
    expect(b().heightsPrompt?.paths).toEqual(['b.jpg']);
    expect(calls('builder:import')).toHaveLength(0);
  });

  it('takes the next drop after the heights could not be read', async () => {
    call.mockImplementation((channel: string) =>
      channel === 'builder:altitudePlan'
        ? Promise.reject(new Error('bridge gone'))
        : Promise.resolve(imported),
    );
    await expect(b().importFiles(['a.jpg'])).rejects.toThrow('bridge gone');
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:altitudePlan' ? planned(plan()) : imported),
    );
    await b().importFiles(['b.jpg']);
    expect(calls('builder:import')).toEqual([
      ['builder:import', { projectId: 'p1', paths: ['b.jpg'] }],
    ]);
  });

  it('runs the import confirmed in the heights prompt, not the drop prepared behind it', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:altitudePlan' ? planned(asks) : imported),
    );
    await b().importFiles(['a.jpg']);
    // a second drop is being prepared while the prompt of the first is still open
    const reading = later<unknown>();
    const running = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:altitudePlan' ? reading.reply : running.reply,
    );
    const second = b().importFiles(['b.jpg']);
    const confirmed = b().confirmHeights({ source: 'auto', takeoffH: 31, takeoffFrom: 'typed' });
    expect(b().importing).toEqual({ done: 0, total: 1, file: '' });
    // the second drop's heights arrive while the confirmed import runs: it starts no import
    reading.give(planned(plan()));
    await second;
    expect(b().heightsPrompt).toBeNull();
    running.give(imported);
    await confirmed;
    expect(calls('builder:import')).toEqual([
      [
        'builder:import',
        {
          projectId: 'p1',
          paths: ['a.jpg'],
          altitude: { source: 'auto', takeoffH: 31, takeoffFrom: 'typed' },
        },
      ],
    ]);
    expect(b().importing).toBeNull();
  });
});

describe('importFiles with drawings whose pages are drawn in the window', () => {
  const pdf = {
    file: 'a.pdf',
    kind: 'drawing',
    status: 'queued',
    drawing: { stem: 'a', src: 'drawings/a.pdf', name: 'a.pdf' },
  };
  const staged = { ok: true, value: { ok: true, manifest: { layers: [] }, items: [pdf] } };
  interface Io {
    items(): { status: string }[];
    setItem(index: number, patch: Record<string, unknown>): void;
  }

  it('stays busy until the pages are in, so a second import does nothing meanwhile', async () => {
    const drawing = later<undefined>();
    finishStaged.mockImplementation(() => drawing.reply);
    call.mockImplementation(() => Promise.resolve(staged));
    const first = b().importFiles(['a.pdf'], undefined, { drawings: true });
    await vi.waitFor(() => {
      expect(finishStaged).toHaveBeenCalledTimes(1);
    });
    // the page question may be open now: the import is still running
    expect(b().importing).toEqual({ done: 0, total: 1, file: '' });
    await b().importFiles(['b.pdf'], undefined, { drawings: true });
    await b().importFiles(['c.jpg']);
    expect(calls('builder:import')).toHaveLength(1);
    expect(calls('builder:altitudePlan')).toHaveLength(0);
    drawing.give(undefined);
    await first;
    expect(b().importing).toBeNull();
    // and the next one runs
    finishStaged.mockImplementation(() => Promise.resolve());
    await b().importFiles(['b.pdf'], undefined, { drawings: true });
    expect(calls('builder:import')).toHaveLength(2);
  });

  it('is free again when drawing the pages failed', async () => {
    finishStaged.mockImplementation(() => Promise.reject(new Error('window gone')));
    call.mockImplementation(() => Promise.resolve(staged));
    await expect(b().importFiles(['a.pdf'], undefined, { drawings: true })).rejects.toThrow(
      'window gone',
    );
    expect(b().importing).toBeNull();
  });

  it('changes rows only in the result it started with', async () => {
    const drawing = later<undefined>();
    finishStaged.mockImplementation(() => drawing.reply);
    call.mockImplementation(() => Promise.resolve(staged));
    const first = b().importFiles(['a.pdf'], undefined, { drawings: true });
    await vi.waitFor(() => {
      expect(finishStaged).toHaveBeenCalledTimes(1);
    });
    const io = finishStaged.mock.calls[0]?.[1] as Io;
    io.setItem(0, { status: 'imported', layerId: 'sheet-a' });
    expect(b().importResult?.items[0]).toMatchObject({ file: 'a.pdf', status: 'imported' });
    // another result is on show (the panel was closed and something else reported): left alone
    const other = {
      items: [{ file: 'x.jpg', kind: 'photo' as const, status: 'imported' as const }],
      error: null,
    };
    builder.setState({ importResult: other });
    io.setItem(0, { status: 'error', message: 'late' });
    expect(b().importResult).toBe(other);
    // the import still knows its own rows
    expect(io.items()[0]?.status).toBe('error');
    drawing.give(undefined);
    await first;
  });
});

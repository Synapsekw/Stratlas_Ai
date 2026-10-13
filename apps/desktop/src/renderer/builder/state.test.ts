import type { AltitudePlan } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const replaceManifest = vi.fn();
/** The open project as the store reads it; a test may give it survey dates. */
let openProject: {
  id: string;
  manifest: { origin: number[]; captures: { id: string }[]; layers: { id: string }[] };
} = {
  id: 'p1',
  manifest: { origin: [0, 0, 30], captures: [], layers: [] },
};

vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  shell: {
    getState: () => ({ loadLibrary: () => Promise.resolve(), setPalette: () => undefined }),
  },
}));
vi.mock('@aio/workspace', () => ({
  workspace: {
    getState: () => ({ project: openProject, replaceManifest }),
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
const imported = {
  ok: true,
  value: { ok: true, manifest: { layers: [], captures: [] }, items: [] },
};

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
    expect(b().importResult).toEqual({
      items: [],
      error: null,
      newDates: [],
      dateSource: null,
      paths: ['a.jpg', 'b.jpg'],
    });
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

  it('runs the import confirmed in the heights prompt first, then the drop prepared behind it', async () => {
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
    // the second drop's heights arrive while the confirmed import runs: it waits its turn
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
      ['builder:import', { projectId: 'p1', paths: ['b.jpg'] }],
    ]);
    expect(b().importing).toBeNull();
  });

  it('queues a drop made while an import runs, says so, and imports it next', async () => {
    const running = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:altitudePlan' ? Promise.resolve(planned(plan())) : running.reply,
    );
    const first = b().importFiles(['a.jpg']);
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(b().importing).not.toBeNull();
    });
    await b().importFiles(['b.mp4']);
    expect(b().queued).toBe(1);
    expect(b().importNotice).toBe(
      'An import is running. These files are imported when it finishes.',
    );
    // the same files again are not queued twice
    await b().importFiles(['b.mp4']);
    expect(b().queued).toBe(1);
    running.give(imported);
    await first;
    expect(calls('builder:import').map((c) => (c[1] as { paths: string[] }).paths)).toEqual([
      ['a.jpg'],
      ['b.mp4'],
    ]);
    expect(b().queued).toBe(0);
    expect(b().importNotice).toBeNull();
  });

  it('queues a drop of other files made while the first is being prepared', async () => {
    const reading = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:altitudePlan' ? reading.reply : Promise.resolve(imported),
    );
    const first = b().importFiles(['a.jpg']);
    await b().importFiles(['c.jpg']);
    expect(b().queued).toBe(1);
    reading.give(planned(plan()));
    await first;
    expect(calls('builder:import').map((c) => (c[1] as { paths: string[] }).paths)).toEqual([
      ['a.jpg'],
      ['c.jpg'],
    ]);
  });
});

describe('importFiles, the paths in the result', () => {
  it('keeps the paths it gave main, so a walk it added can be processed from its original', async () => {
    call.mockImplementation(() => Promise.resolve(imported));
    await b().importFiles(['D:/cam/VID_1.insv'], undefined, { as360: true });
    expect(b().importResult?.paths).toEqual(['D:/cam/VID_1.insv']);
  });

  it('a folder import keeps the files main found in it, so its walks get their original', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:import'
          ? {
              ok: true,
              value: {
                ok: true,
                manifest: { layers: [], captures: [] },
                items: [{ file: 'VID_1.insv', kind: 'video', status: 'imported' }],
                files: ['D:/flight/VID_1.insv'],
              },
            }
          : planned(plan()),
      ),
    );
    await b().importFiles(['D:/flight']);
    expect(b().importResult?.paths).toEqual(['D:/flight/VID_1.insv', 'D:/flight']);
  });

  it('keeps them when main refused the import with rows', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:import'
          ? { ok: true, value: { ok: false, error: 'no', items: [] } }
          : planned(plan()),
      ),
    );
    await b().importFiles(['a.mp4']);
    expect(b().importResult).toEqual({ items: [], error: 'no', paths: ['a.mp4'] });
  });
});

describe('importFiles with drawings whose pages are drawn in the window', () => {
  const pdf = {
    file: 'a.pdf',
    kind: 'drawing',
    status: 'queued',
    drawing: { stem: 'a', src: 'drawings/a.pdf', name: 'a.pdf' },
  };
  const staged = {
    ok: true,
    value: { ok: true, manifest: { layers: [], captures: [] }, items: [pdf] },
  };
  interface Io {
    items(): { status: string }[];
    setItem(index: number, patch: Record<string, unknown>): void;
  }

  it('stays busy until the pages are in, so a second import waits its turn', async () => {
    const drawing = later<undefined>();
    finishStaged.mockImplementation(() => drawing.reply);
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:altitudePlan' ? planned(plan()) : staged),
    );
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
    expect(b().queued).toBe(2);
    // the pages are in: the waiting drops run in the order they came
    finishStaged.mockImplementation(() => Promise.resolve());
    drawing.give(undefined);
    await first;
    expect(b().importing).toBeNull();
    expect(calls('builder:import').map((c) => (c[1] as { paths: string[] }).paths)).toEqual([
      ['a.pdf'],
      ['b.pdf'],
      ['c.jpg'],
    ]);
    expect(b().queued).toBe(0);
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

describe('importFiles, the survey dates an import made', () => {
  const row = (file: string, kind: 'photo' | 'video' | 'mesh', layerId: string) => ({
    file,
    kind,
    status: 'imported' as const,
    layerId,
  });
  const reply = (
    items: ReturnType<typeof row>[],
    layers: { id: string; capture?: string }[],
    captures: { id: string }[],
    createdCaptures?: string[],
  ) => ({
    ok: true,
    value: {
      ok: true,
      manifest: { layers, captures },
      items,
      ...(createdCaptures ? { createdCaptures } : {}),
    },
  });

  beforeEach(() => {
    openProject = {
      id: 'p1',
      manifest: { origin: [0, 0, 30], captures: [{ id: 'capture-a' }], layers: [] },
    };
  });

  it('lists the dates the import created and where the date was read from', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:altitudePlan'
          ? planned(plan())
          : reply(
              [row('a.jpg', 'photo', 'photos-b'), row('b.mp4', 'video', 'clip-b')],
              [
                { id: 'photos-b', capture: 'capture-b' },
                { id: 'clip-b', capture: 'capture-b' },
              ],
              // capture-c was added by another save during the import: not the import's
              [{ id: 'capture-a' }, { id: 'capture-b' }, { id: 'capture-c' }],
              ['capture-b'],
            ),
      ),
    );
    await b().importFiles(['flight']);
    expect(b().importResult?.newDates).toEqual(['capture-b']);
    expect(b().importResult?.dateSource).toBe('both');
  });

  it('reads the source from the photos alone, and no new date for a day that had one', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:altitudePlan'
          ? planned(plan())
          : reply(
              [row('a.jpg', 'photo', 'photos-a')],
              [{ id: 'photos-a', capture: 'capture-a' }],
              [{ id: 'capture-a' }],
            ),
      ),
    );
    await b().importFiles(['a.jpg']);
    expect(b().importResult?.newDates).toEqual([]);
    expect(b().importResult?.dateSource).toBe('photos');
  });

  it('lists no date when main names none, also when the project has dates it did not have before', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:altitudePlan'
          ? planned(plan())
          : reply(
              [row('b.mp4', 'video', 'clip-b')],
              [{ id: 'clip-b', capture: 'capture-a' }],
              [{ id: 'capture-a' }, { id: 'capture-elsewhere' }],
            ),
      ),
    );
    await b().importFiles(['flight']);
    expect(b().importResult?.newDates).toEqual([]);
  });

  it('has no source when the import dated nothing', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:altitudePlan'
          ? planned(plan())
          : reply([row('m.glb', 'mesh', 'mesh')], [{ id: 'mesh' }], [{ id: 'capture-a' }]),
      ),
    );
    await b().importFiles(['m.glb']);
    expect(b().importResult?.newDates).toEqual([]);
    expect(b().importResult?.dateSource).toBeNull();
  });
});

describe('pickAndImportFolder', () => {
  beforeEach(() => {
    openProject = { id: 'p1', manifest: { origin: [0, 0, 30], captures: [], layers: [] } };
  });

  it('imports the picked folder', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'dialog:openFolder'
          ? { ok: true, value: { path: 'D:/flight' } }
          : channel === 'builder:altitudePlan'
            ? planned(plan())
            : imported,
      ),
    );
    await b().pickAndImportFolder();
    expect(calls('dialog:openFolder')).toEqual([
      ['dialog:openFolder', { title: 'Import a flight folder' }],
    ]);
    expect(calls('builder:import')).toEqual([
      ['builder:import', { projectId: 'p1', paths: ['D:/flight'] }],
    ]);
  });

  it('does nothing when the pick is cancelled', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'dialog:openFolder' ? { ok: true, value: { path: null } } : imported,
      ),
    );
    await b().pickAndImportFolder();
    expect(calls('builder:altitudePlan')).toHaveLength(0);
    expect(calls('builder:import')).toHaveLength(0);
  });
});

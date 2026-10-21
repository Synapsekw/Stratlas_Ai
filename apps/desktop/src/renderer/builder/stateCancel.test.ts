import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Cancel for a running import, and "Add 360 video" through the same import store. */

const call = vi.fn();
const replaceManifest = vi.fn();
let progress: ((e: unknown) => void) | undefined;

vi.mock('../shell', () => ({
  bridge: {
    // an import scans for drone spheres first; these tests have none, and do not count the scan
    call: (channel: string, ...a: unknown[]) =>
      channel === 'panos:scan'
        ? Promise.resolve({
            ok: true,
            value: {
              ok: true,
              scan: { scanId: 's', spheres: [], ready: [], skipped: [], files: 0 },
            },
          })
        : (call(channel, ...a) as unknown),
  },
  shell: {
    getState: () => ({ loadLibrary: () => Promise.resolve(), setPalette: () => undefined }),
  },
}));
vi.mock('@aio/workspace', () => ({
  workspace: {
    getState: () => ({
      project: { id: 'p1', manifest: { origin: [0, 0, 30], captures: [], layers: [] } },
      replaceManifest,
    }),
  },
}));
vi.mock('../panos/panos', () => ({
  openPanoScan: vi.fn(),
  panoImport: { setState: vi.fn(), subscribe: vi.fn(() => () => undefined) },
}));
vi.mock('./pick', () => ({ terrainHeightAt: () => null }));
vi.mock('./orientationFile', () => ({ loadOrientation: () => Promise.resolve() }));
// drawing the pages of a PDF needs the app window; the store only has to wait for it
const finishStaged = vi.fn();
vi.mock('../drawings/importFlow', () => ({
  finishStagedDrawings: (...a: unknown[]) => finishStaged(...a) as unknown,
}));
// the store listens for progress on the preload bridge
vi.stubGlobal('window', {
  aio: {
    on: (_name: string, cb: (e: unknown) => void) => {
      progress = cb;
      return () => {
        progress = undefined;
      };
    },
  },
});

import { builder } from './state';

/** A reply the test gives when it chooses to. */
function later<T>() {
  let give: (v: T) => void = () => undefined;
  const reply = new Promise<T>((resolve) => {
    give = resolve;
  });
  return { reply, give };
}

const imported = (items: unknown[] = []) => ({
  ok: true,
  value: { ok: true, manifest: { layers: [], captures: [] }, items },
});
const calls = (channel: string) => call.mock.calls.filter((c) => c[0] === channel);
const b = () => builder.getState();

beforeEach(() => {
  call.mockReset();
  replaceManifest.mockReset();
  finishStaged.mockReset();
  finishStaged.mockImplementation(() => Promise.resolve());
  builder.setState({
    importing: null,
    cancellable: false,
    cancelling: false,
    importResult: null,
    heightsPrompt: null,
  });
});

describe('cancelImport', () => {
  it('asks main to cancel the import of the project it runs in, once', async () => {
    const running = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:import'
        ? running.reply
        : Promise.resolve({ ok: true, value: { ok: true } }),
    );
    const done = b().importFiles(['a.insv'], undefined, { as360: true });
    await vi.waitFor(() => {
      expect(b().importing).not.toBeNull();
    });
    expect(b().cancellable).toBe(true);
    await b().cancelImport();
    await b().cancelImport();
    expect(calls('builder:cancelImport')).toEqual([['builder:cancelImport', { projectId: 'p1' }]]);
    expect(b().cancelling).toBe(true);
    // progress that still arrives does not put the panel back to "importing"
    progress?.({
      projectId: 'p1',
      done: 0,
      total: 1,
      file: 'a.insv, playback copy 40 %',
      part: 0.4,
    });
    expect(b().importing).toMatchObject({ part: 0.4 });
    expect(b().cancelling).toBe(true);
    // main answers the import with its rows; the panel shows them and the store is free again
    running.give(
      imported([{ file: 'a.insv', kind: 'video', status: 'skipped', message: 'cancelled' }]),
    );
    await done;
    expect(b().importing).toBeNull();
    expect(b().cancellable).toBe(false);
    expect(b().cancelling).toBe(false);
    expect(b().importResult?.items).toHaveLength(1);
  });

  it('does nothing when no import is running', async () => {
    await b().cancelImport();
    expect(call).not.toHaveBeenCalled();
  });

  it('lets the person try again when main could not cancel', async () => {
    const running = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:import' ? running.reply : Promise.resolve({ ok: false, error: 'busy' }),
    );
    const done = b().importFiles(['a.insv'], undefined, { as360: true });
    await vi.waitFor(() => {
      expect(b().importing).not.toBeNull();
    });
    await b().cancelImport();
    expect(b().cancelling).toBe(false);
    running.give(imported());
    await done;
  });
});

describe('cancel and the drawings an import staged', () => {
  const staged = {
    file: 'plan.pdf',
    kind: 'drawing',
    status: 'queued',
    drawing: { stem: 'plan', src: 'drawings/plan.pdf', name: 'plan' },
  };

  it('Cancel can act only while main imports: not while staged drawings are finished', async () => {
    const drawing = later<undefined>();
    finishStaged.mockImplementation(() => drawing.reply);
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:import' ? imported([staged]) : { ok: true, value: {} }),
    );
    const done = b().importFiles(['plan.pdf']);
    await vi.waitFor(() => {
      expect(finishStaged).toHaveBeenCalledTimes(1);
    });
    // the import is still busy (a page question may be open), but main has answered
    expect(b().importing).not.toBeNull();
    expect(b().cancellable).toBe(false);
    await b().cancelImport();
    expect(calls('builder:cancelImport')).toEqual([]);
    drawing.give(undefined);
    await done;
    expect(b().importing).toBeNull();
  });

  it('after a cancelled import its staged drawings are not asked about or drawn, and are removed', async () => {
    const running = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'builder:import'
        ? running.reply
        : Promise.resolve({ ok: true, value: { ok: true, removed: true } }),
    );
    const done = b().importFiles(['plan.pdf', 'a.insv'], undefined, { as360: true });
    await vi.waitFor(() => {
      expect(b().cancellable).toBe(true);
    });
    await b().cancelImport();
    running.give(
      imported([
        staged,
        { file: 'a.insv', kind: 'video', status: 'skipped', message: 'cancelled' },
      ]),
    );
    await done;
    expect(finishStaged).not.toHaveBeenCalled();
    expect(calls('builder:closeDrawing')).toEqual([
      ['builder:closeDrawing', { projectId: 'p1', stem: 'plan' }],
    ]);
    const rows = b().importResult?.items ?? [];
    expect(rows[0]).toMatchObject({ file: 'plan.pdf', status: 'skipped' });
    expect(rows[0]?.message).toContain('cancelled');
    expect(rows[0]?.drawing).toBeUndefined();
    expect(b().importing).toBeNull();
  });
});

describe('importFiles as 360 video', () => {
  it('sends as360 and does not ask for camera heights first', async () => {
    call.mockResolvedValue(imported());
    await b().importFiles(['tour.mp4'], undefined, { as360: true });
    expect(calls('builder:altitudePlan')).toEqual([]);
    expect(calls('builder:import')).toEqual([
      ['builder:import', { projectId: 'p1', paths: ['tour.mp4'], as360: true }],
    ]);
  });
});

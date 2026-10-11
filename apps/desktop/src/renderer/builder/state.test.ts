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

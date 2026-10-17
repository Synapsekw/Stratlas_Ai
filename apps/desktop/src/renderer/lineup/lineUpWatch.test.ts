import type { LineUpMeasure, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Box } from '../shell/layerBounds';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore } from './lineUpStore';
import { watchLineUps } from './lineUpWatch';
import { lineUpManifest, measureOf, ortho } from './testing';

const BOX: Box = { min: [0, 0, 0], max: [100, 10, 100] };
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(
  opts: { measure?: LineUpMeasure | { error: string }; python?: boolean; open?: boolean } = {},
) {
  const workspace = createWorkspace();
  const memory = createLineUpMemory(null);
  const measure = vi.fn(() => Promise.resolve(opts.measure ?? measureOf()));
  const store = createLineUpStore({
    workspace,
    measure,
    saveCapture: () => Promise.resolve(null),
    pinCaptures: () => Promise.resolve(null),
    hints: () => ({}),
    issues: () => [],
    measurements: () => [],
    memory,
    now: () => '2026-10-17T10:00:00.000Z',
  });
  const extents = vi.fn((): Promise<Record<string, Box>> => {
    const ids = workspace.getState().project?.manifest.layers.map((l) => l.id) ?? [];
    return Promise.resolve(Object.fromEntries(ids.map((id) => [id, BOX])));
  });
  const stop = watchLineUps({
    store,
    workspace,
    extents,
    measure,
    memory,
    hasPython: () => opts.python ?? true,
  });
  const open = (manifest: ProjectManifest = lineUpManifest()) => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  };
  return { store, workspace, memory, measure, extents, stop, open };
}

describe('watchLineUps', () => {
  it('offers a line-up once for a new ortho', async () => {
    const { store, open, measure, stop } = setup();
    open(lineUpManifest({ layers: [ortho('o1', 'd1')] }));
    await flush();
    expect(measure).not.toHaveBeenCalled();
    expect(store.getState().offer).toBeNull();
    // the later date gets its ortho
    const m = lineUpManifest();
    open(m);
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('d1', 'd2');
    expect(store.getState().offer?.text).toBe(
      "Survey 13 April 2026 doesn't line up with Survey 2 March 2026. Its ortho sits 2.00 m away.",
    );
    stop();
  });

  it('measures a pair once', async () => {
    const { workspace, open, measure, memory, stop } = setup();
    open();
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(memory.measured('p').has('o1|o2')).toBe(true);
    const m = workspace.getState().project?.manifest;
    if (m) workspace.getState().replaceManifest({ ...m, name: 'Renamed' });
    await flush();
    open();
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    stop();
  });

  it('measures the pair again once the kept date moved', async () => {
    const { workspace, open, measure, stop } = setup({
      measure: measureOf({ verdict: 'aligned' }),
    });
    open();
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    const m = workspace.getState().project?.manifest;
    if (m)
      workspace.getState().replaceManifest({
        ...m,
        captures: m.captures.map((c) =>
          c.id === 'd1'
            ? { ...c, lineUp: { eastM: 3, northM: 0, with: 'd2', at: '2026-10-17T10:00:00.000Z' } }
            : c,
        ),
      });
    await flush();
    expect(measure).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stays quiet after Not now', async () => {
    const { store, open, memory, stop } = setup();
    open();
    await flush();
    store.getState().notNow();
    expect(store.getState().offer).toBeNull();
    expect(memory.isNotNow('p', 'o1|o2')).toBe(true);
    // measured again later (another build forgot the measured list): still no offer
    const again = setup();
    again.memory.notNow('p', 'o1|o2');
    again.open();
    await flush();
    expect(again.measure).toHaveBeenCalledTimes(1);
    expect(again.store.getState().offer).toBeNull();
    stop();
    again.stop();
  });

  it('does nothing without the pipeline Python', async () => {
    const { store, open, measure, extents, stop } = setup({ python: false });
    open();
    await flush();
    expect(extents).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(store.getState().offer).toBeNull();
    stop();
  });

  it('does not offer for an aligned or refused pair', async () => {
    for (const measure of [
      measureOf({ verdict: 'aligned' }),
      measureOf({ verdict: 'disagree' }),
      { error: 'Unknown pipeline: change.lineup' },
    ]) {
      const s = setup({ measure });
      s.open();
      await flush();
      expect(s.measure).toHaveBeenCalledTimes(1);
      expect(s.store.getState().offer).toBeNull();
      // marked measured all the same, so it is not asked again and again
      expect(s.memory.measured('p').has('o1|o2')).toBe(true);
      s.stop();
    }
  });
});

// @vitest-environment jsdom
import { emptyRemovalPlan, type RemovalPlan } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => vi.fn());
vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    bridge: { call },
    shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
    jobs: createStore(() => ({ jobs: [] as unknown[], refresh: vi.fn() })),
  };
});
vi.mock('../builder/state', async () => {
  const { createStore } = await import('zustand/vanilla');
  return { builder: createStore(() => ({ cancellable: false, importResult: null })) };
});

import { photoUi } from '../photogrammetry/store';
import { refreshAfterRemoval, removal } from './removal';

const PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  layers: [{ id: 'clip-1', name: 'Clip 1', kind: 'video', why: 'asked' }],
  runs: [{ id: 'run-2', status: 'failed', why: 'asked' }],
};

afterEach(() => {
  vi.clearAllMocks();
  photoUi.getState().close();
  workspace.setState({ hidden: {}, selection: null });
});

describe('refreshAfterRemoval', () => {
  it('closes an open run view whose run was removed and bumps the panels', () => {
    photoUi.getState().openRun('run-2');
    const before = photoUi.getState().version;
    refreshAfterRemoval(PLAN);
    expect(photoUi.getState().view).toBeNull();
    expect(photoUi.getState().version).toBe(before + 1);
  });

  it('leaves the view of another run open', () => {
    photoUi.getState().openRun('run-9');
    refreshAfterRemoval(PLAN);
    expect(photoUi.getState().view).toEqual({ kind: 'run', run: 'run-9', tab: 'progress' });
  });
});

describe('removal.release', () => {
  it('hides and deselects before the move, and shows the layers again when main refuses', async () => {
    workspace.setState({ hidden: { other: true } });
    workspace.getState().select({ kind: 'layer', id: 'clip-1' });
    call.mockImplementation((channel: string) => {
      if (channel === 'builder:removePlan')
        return Promise.resolve({ ok: true, value: { ok: true, plan: PLAN } });
      if (channel === 'builder:remove') {
        // while main is asked, the layer is hidden and nothing is selected
        expect(workspace.getState().hidden['clip-1']).toBe(true);
        expect(workspace.getState().selection).toBeNull();
        return Promise.resolve({ ok: true, value: { ok: false, error: 'held open' } });
      }
      if (channel === 'walks:list')
        return Promise.resolve({ ok: true, value: { walks: [], processed: {} } });
      return Promise.resolve({ ok: true, value: { bytes: 0, entries: 0 } });
    });
    await removal.getState().ask([{ layer: 'clip-1' }]);
    expect(await removal.getState().confirm()).toBe(false);
    // visible again, the layer that was hidden before stays hidden
    expect(workspace.getState().hidden).toEqual({ other: true });
    expect(call.mock.calls.some(([c]) => c === 'walks:list')).toBe(false);
    removal.getState().cancel();
  });
});

// @vitest-environment jsdom
import type { ChangeSet } from '@aio/schema';
import { t } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type OnRerun = (producer: string, set?: ChangeSet) => Promise<string | null>;

const h = vi.hoisted(() => ({
  onRerun: null as OnRerun | null,
  rerunScoped: vi.fn(),
  rerunProducer: vi.fn(),
  pair: { from: 'd1', to: 'd2' },
}));

vi.mock('@aio/change', () => ({
  changeStore: { getState: () => ({ pair: h.pair, misaligned: null, setError: vi.fn() }) },
  layersOf: () => [],
  ChangePanel: (props: { onRerun: OnRerun }) => {
    h.onRerun = props.onRerun;
    return null;
  },
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (s: unknown) => unknown) =>
    sel({ project: { id: 'p', root: 'C:/projects/p', manifest: { layers: [], captures: [] } } }),
}));
vi.mock('../workspace/compare', () => ({
  useCaptureIndex: () => ({ captures: [] }),
}));
vi.mock('../workspace/SplitPanes', () => ({ useSplit: () => null }));
vi.mock('../lineup/lineUpActions', () => ({ openLineUp: vi.fn() }));
vi.mock('./actions', () => ({ createChangeActions: () => ({}) }));
vi.mock('./useChangeOverlays', () => ({
  useChangeProject: () => undefined,
  useComparedPair: () => null,
}));
vi.mock('./rerun', () => ({ rerunScoped: h.rerunScoped, rerunProducer: h.rerunProducer }));

import { ChangesTab } from './ChangesTab';

const set = (over: Partial<ChangeSet>): ChangeSet =>
  ({
    id: 'd1-d2-raster-area-a',
    producer: 'change.raster',
    from: 'd1',
    to: 'd2',
    items: [],
    ...over,
  }) as unknown as ChangeSet;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.onRerun = null;
  h.rerunScoped.mockReset().mockResolvedValue(null);
  h.rerunProducer.mockReset().mockResolvedValue(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<ChangesTab />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

function onRerun(): OnRerun {
  if (!h.onRerun) throw new Error('the panel got no onRerun');
  return h.onRerun;
}

describe('ChangesTab Run again', () => {
  it('replays an area set with the params it ran with', async () => {
    const params = { from: 'd1', to: 'd2', scope: { id: 'a', name: 'A' }, mask: { ring: [] } };
    const s = set({ scope: { id: 'a', name: 'A' }, run: { params } });
    expect(await onRerun()('change.raster', s)).toBeNull();
    expect(h.rerunScoped).toHaveBeenCalledWith('change.raster', params);
    expect(h.rerunProducer).not.toHaveBeenCalled();
  });

  it('refuses an area set without stored params, never running the whole map', async () => {
    const s = set({ scope: { id: 'a', name: 'A' } });
    expect(await onRerun()('change.raster', s)).toBe(t('lineUp.rerun.unavailable'));
    expect(h.rerunScoped).not.toHaveBeenCalled();
    expect(h.rerunProducer).not.toHaveBeenCalled();
  });

  it('runs the whole map again for a set without a scope', async () => {
    expect(await onRerun()('change.raster', set({}))).toBeNull();
    expect(h.rerunProducer).toHaveBeenCalledWith(
      'change.raster',
      expect.objectContaining({ projectId: 'p', from: 'd1', to: 'd2' }),
    );
    expect(h.rerunScoped).not.toHaveBeenCalled();
  });
});

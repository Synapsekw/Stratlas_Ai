/**
 * The open project's fact index status (M1), as main reports it (`facts:status`, `facts:changed`).
 * The agent offers `query_facts` and `history_of` only while it is `ready`; the Project tab search
 * reads the index through `facts:query` and `facts:history`.
 */
import type { AioBridge, FactIndexStatus } from '@aio/schema';
import { createStore, useStore } from 'zustand';

export interface FactIndexView {
  projectId: string | null;
  status: FactIndexStatus | null;
}

export const factIndex = createStore<FactIndexView>()(() => ({ projectId: null, status: null }));

export const useFactIndex = <T>(pick: (s: FactIndexView) => T): T => useStore(factIndex, pick);

/** True when the open project's index can be queried. */
export const factIndexReady = (projectId: string | undefined): boolean => {
  const s = factIndex.getState();
  return !!projectId && s.projectId === projectId && s.status?.state === 'ready';
};

/**
 * Follow the open project: read its status when it changes, take `facts:changed` for it. Returns
 * the disconnect.
 */
export function connectFactIndex(
  aio: Pick<AioBridge, 'invoke' | 'on'> | undefined,
  openProject: () => string | null,
  onProjectChange: (listener: () => void) => () => void,
): () => void {
  if (!aio) return () => undefined;
  let current: string | null = null;
  const sync = () => {
    const id = openProject();
    if (id === current) return;
    current = id;
    factIndex.setState({ projectId: id, status: null });
    if (!id) return;
    void aio
      .invoke('facts:status', { projectId: id })
      .then((r) => {
        if (r.ok && factIndex.getState().projectId === id) factIndex.setState({ status: r.status });
      })
      .catch(() => undefined);
  };
  const offEvent = aio.on('facts:changed', (e) => {
    if (e.projectId === factIndex.getState().projectId) factIndex.setState({ status: e.status });
  });
  const offProject = onProjectChange(sync);
  sync();
  return () => {
    offEvent();
    offProject();
  };
}

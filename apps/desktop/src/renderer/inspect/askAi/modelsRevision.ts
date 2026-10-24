/**
 * Counts changes to the local models (an import, a removal in Settings, AI providers), so every
 * reader of `inference:models` (the Ask AI settings, the Ask AI bar) reads the list again.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const revision = createStore<{ n: number }>(() => ({ n: 0 }));

/** The local models changed: whoever lists them reads the list again. */
export function modelsChanged(): void {
  revision.setState((s) => ({ n: s.n + 1 }));
}

/** A number that changes whenever the local models do: a `useCall` key. */
export function useModelsRevision(): number {
  return useStore(revision, (s) => s.n);
}

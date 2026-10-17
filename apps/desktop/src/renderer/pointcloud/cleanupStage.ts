/**
 * The 3D view the Clean up tab works on. The Stage owns the engine and binds the tools
 * (CleanupHost); the panel is a tab in the sidebar, so it reads the engine from here.
 */
import type { EngineStage } from '@aio/engine';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const store = createStore<{ stage: EngineStage | null }>()(() => ({ stage: null }));

export function setCleanupStage(stage: EngineStage | null): void {
  store.setState({ stage });
}

export function useCleanupStage(): EngineStage | null {
  return useStore(store, (s) => s.stage);
}

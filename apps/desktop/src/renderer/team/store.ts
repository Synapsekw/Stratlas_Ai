import type { TeamStatus } from '@aio/schema';
import { createStore, useStore } from 'zustand';

/** Which team dialog is open (one at a time), and the open project's sharing status. */
export interface TeamUi {
  dialog: null | 'team' | 'export' | 'import';
  /** The exchange file picked for import (preview first). */
  importPath: string | null;
  status: TeamStatus | null;
  /** A sync is running for the open project. */
  syncing: boolean;
  /** The last sync problem ("cannot be reached"), cleared by the next good sync. */
  syncError: string | null;
  open(dialog: TeamUi['dialog'], importPath?: string | null): void;
  close(): void;
  setStatus(status: TeamStatus | null): void;
  setSyncing(syncing: boolean, error?: string | null): void;
}

export const teamUi = createStore<TeamUi>()((set) => ({
  dialog: null,
  importPath: null,
  status: null,
  syncing: false,
  syncError: null,
  open: (dialog, importPath = null) => {
    set({ dialog, importPath });
  },
  close: () => {
    set({ dialog: null, importPath: null });
  },
  setStatus: (status) => {
    set({ status });
  },
  setSyncing: (syncing, error) => {
    set(error === undefined ? { syncing } : { syncing, syncError: error });
  },
}));

export function useTeamUi<T>(selector: (s: TeamUi) => T): T {
  return useStore(teamUi, selector);
}

/** "2 min ago", "just now": when the last sync was, for the chip. */
export function agoMinutes(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
}

import type {
  AioBridge,
  CollabState,
  Conflict,
  QuarantineEntry,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  Role,
} from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';

/** A person as the panels show them. */
export interface Person {
  actor: string;
  name: string;
  initials: string;
  role?: Role;
}

export interface CollabStoreState {
  projectId: string | null;
  state: CollabState;
  /** This person (identity:get); null until T2's identity answers. */
  me: Person | null;
  /** The project's members (members:list); empty when the project is not shared. */
  members: Person[];
  loaded: boolean;
  error: string | null;
  /** The Issues "Mine" filter. */
  mine: boolean;
  /** M9 integration: open conflicts and quarantined changes (T4 inbox), for My work. */
  conflicts: Conflict[];
  quarantined: QuarantineEntry[];
  /** Opens the Team dialog with the Conflicts inbox (the desktop sets it). */
  openConflicts: (() => void) | null;
}

const EMPTY: CollabState = { comments: [], assignments: [], approvals: [], policy: null };

export const collabStore = createStore<CollabStoreState>()(() => ({
  projectId: null,
  state: EMPTY,
  me: null,
  members: [],
  loaded: false,
  error: null,
  mine: false,
  conflicts: [],
  quarantined: [],
  openConflicts: null,
}));

export function useCollabStore<T>(selector: (s: CollabStoreState) => T): T {
  return useStore(collabStore, selector);
}

export function bridge(): AioBridge | null {
  return (globalThis as { aio?: AioBridge }).aio ?? null;
}

const inflight = new Map<string, Promise<void>>();
let listening = false;

/** Read the collaboration state, this person and the members of a project. */
export function loadCollab(projectId: string): Promise<void> {
  const running = inflight.get(projectId);
  if (running) return running;
  const run = (async () => {
    const aio = bridge();
    if (!aio) return;
    if (!listening) {
      listening = true;
      // merges, imports and other windows' writes: read again
      aio.on('journal:changed', (e) => {
        if (e.projectId === collabStore.getState().projectId) void loadCollab(e.projectId);
      });
    }
    const [read, who, members, conflicts, quarantined] = await Promise.all([
      aio.invoke('collab:read', { projectId }),
      aio.invoke('identity:get', {}).catch(() => null),
      aio.invoke('members:list', { projectId }).catch(() => null),
      aio.invoke('sync:conflicts', { projectId }).catch(() => null),
      aio.invoke('sync:quarantine', { projectId }).catch(() => null),
    ]);
    const list: Person[] = members?.ok
      ? members.members.map((m) => ({
          actor: m.actor,
          name: m.name,
          initials: m.initials,
          role: m.role,
        }))
      : [];
    const me: Person | null = who?.ok
      ? {
          actor: who.identity.actor,
          name: who.identity.name,
          initials: who.identity.initials,
          ...(members?.ok && members.me ? { role: members.me } : {}),
        }
      : null;
    collabStore.setState((s) => ({
      projectId,
      state: read.ok ? read.state : EMPTY,
      error: read.ok ? null : read.code === 'not-implemented' ? null : read.error,
      me,
      members: list,
      loaded: true,
      mine: s.projectId === projectId ? s.mine : false,
      conflicts: conflicts?.ok ? conflicts.conflicts : [],
      quarantined: quarantined?.ok ? quarantined.entries : [],
    }));
  })().finally(() => inflight.delete(projectId));
  inflight.set(projectId, run);
  return run;
}

/** Keep the store on the open project (any mounted panel calls this). */
export function useCollab(): CollabStoreState {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const st = useCollabStore((s) => s);
  useEffect(() => {
    if (projectId && (st.projectId !== projectId || !st.loaded)) void loadCollab(projectId);
  }, [projectId, st.projectId, st.loaded]);
  return st.projectId === projectId ? st : { ...st, state: EMPTY, loaded: false };
}

/** A write through main, then a fresh read. Main's refusal comes back as `error`. */
export async function collabWrite<C extends IpcChannel>(
  channel: C,
  req: IpcRequest<C>,
): Promise<IpcResponse<C> | { ok: false; error: string }> {
  const aio = bridge();
  if (!aio) return { ok: false, error: 'Not running in the desktop app.' };
  const res = await aio.invoke(channel, req);
  const pid = (req as { projectId?: string }).projectId;
  if (pid) await loadCollab(pid);
  return res;
}

/** Name and initials of an actor, from the members, this person, or a placeholder. */
export function personOf(s: Pick<CollabStoreState, 'members' | 'me'>, actor: string): Person {
  return (
    s.members.find((m) => m.actor === actor) ??
    (s.me?.actor === actor ? s.me : null) ?? {
      actor,
      name: 'Unknown person',
      initials: '?',
    }
  );
}

/** Test helper: back to an empty store. */
export function resetCollabStore(): void {
  inflight.clear();
  collabStore.setState({
    projectId: null,
    state: EMPTY,
    me: null,
    members: [],
    loaded: false,
    error: null,
    mine: false,
    conflicts: [],
    quarantined: [],
  });
}

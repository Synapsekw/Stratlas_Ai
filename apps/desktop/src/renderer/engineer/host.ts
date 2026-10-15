import { addAssembly, newAssembly, type UserOverrides } from '@aio/modelling';
import type { Assembly, AssemblyKind, PartStatus, ProcModel, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { setEngineerSession } from '../modeller/engineerTools';
import { bridge, shell } from '../shell';
import { createRunStore, ipcRunIpc, type RunIpc, type RunState } from './runStore';
import { domDecode, domViewCanvas, renderDraftViews, silhouetteScores } from './views';

/**
 * The engineering model's run for the open project: one run store (Task 35) made when a folder
 * project opens and dropped when it closes, with the review's view state, the person's overrides,
 * the store's local helpers (generated views and silhouette overlap from `views.ts`) and the
 * agent's session over it. A read-only package gets no run.
 */

type Store = StoreApi<RunState>;

export interface HostState {
  projectId: string | null;
  store: Store | null;
  ipc: RunIpc | null;
  /** Review view state (Model builder, Components). */
  selected: string | null;
  hidden: string[];
  sourceVisible: boolean;
  modelVisible: boolean;
  stale: boolean;
  thumbnails: Record<string, string>;
  /** Why the last host action failed (accept refused, a write failed), or null. */
  error: string | null;
}

const initial = (): HostState => ({
  projectId: null,
  store: null,
  ipc: null,
  selected: null,
  hidden: [],
  sourceVisible: true,
  modelVisible: true,
  stale: false,
  thumbnails: {},
  error: null,
});

export const engineerHost = createStore<HostState>(initial);

/** Status, additions and hiding are model edits, written and drawn again (not a rebuild). */
async function writeModel(model: ProcModel): Promise<ProcModel | { error: string }> {
  const { store, ipc } = engineerHost.getState();
  if (!store || !ipc) return { error: 'No engineering model is open.' };
  try {
    await ipc.modelWrite(model);
    store.setState({ model });
    const built = await ipc.modelBuild(model.id, true);
    store.setState({ draftLayer: built.layer, build: built.report ?? null });
    return model;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    engineerHost.setState({ error });
    return { error };
  }
}

/**
 * Accept, reject or make draft: the run store writes the model (so the status survives a
 * reopen), then the draft is drawn again.
 */
export async function setStatus(
  ids: readonly string[] | 'all',
  status: PartStatus,
): Promise<ProcModel | { error: string }> {
  const { store, ipc } = engineerHost.getState();
  const model = store?.getState().model;
  if (!store || !ipc || !model) return { error: 'No engineering model is open.' };
  const all = ids === 'all' ? model.assemblies.map((a) => a.id) : [...ids];
  const r = await store.getState().setStatus(all, status);
  if ('error' in r) {
    engineerHost.setState({ error: r.error });
    return r;
  }
  try {
    const built = await ipc.modelBuild(r.id, true);
    store.setState({ draftLayer: built.layer, build: built.report ?? null });
  } catch (e) {
    engineerHost.setState({ error: e instanceof Error ? e.message : String(e) });
  }
  return r;
}

export function addComponent(kind: AssemblyKind): Promise<ProcModel | { error: string }> {
  const model = engineerHost.getState().store?.getState().model;
  if (!model) return Promise.resolve({ error: 'No engineering model is open.' });
  return writeModel(addAssembly(model, newAssembly(model, kind), new Date().toISOString()));
}

/** Assemble again with the person's values on top; ids and accepted components stay. */
export async function rebuildWith(user: UserOverrides): Promise<void> {
  const { store } = engineerHost.getState();
  if (!store) return;
  engineerHost.setState({ stale: false, error: null });
  await store.getState().rebuild(user);
}

/** Accept the draft: refused until the person accepted at least one component. */
export async function acceptRun(): Promise<void> {
  const { store } = engineerHost.getState();
  if (!store) return;
  try {
    engineerHost.setState({ error: null });
    await store.getState().accept();
  } catch (e) {
    engineerHost.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Components the person accepted in the review (accept needs at least one). */
export const acceptedCount = (model: ProcModel | null): number =>
  model?.assemblies.filter((a: Assembly) => a.status === 'accepted').length ?? 0;

/** Make the run for an open folder project (none for a package), or drop it. */
export function openRun(
  project: { id: string; root: string; manifest: ProjectManifest } | null,
  readOnly: boolean,
): void {
  const s = engineerHost.getState();
  if (
    s.projectId === (project?.id ?? null) &&
    (s.store !== null) === (project !== null && !readOnly)
  )
    return;
  void s.store?.getState().cancel();
  setEngineerSession(null);
  engineerHost.setState(initial());
  if (!project || readOnly) return;
  const ipc = ipcRunIpc(bridge, project.id, project.root);
  const store: Store = createRunStore({
    ipc,
    project: { crs: project.manifest.crs, origin: project.manifest.origin },
    now: () => new Date().toISOString(),
    online: () => shell.getState().settings.offlineOnly !== true,
    renderViews: (model, views) => Promise.resolve(renderDraftViews(model, views, domViewCanvas)),
    silhouette: (model, evidence) => {
      const runId = store.getState().run?.id;
      return runId
        ? silhouetteScores(model, evidence, (id) => ipc.evidenceImage(runId, id), domDecode)
        : Promise.resolve({});
    },
  });
  engineerHost.setState({ projectId: project.id, store, ipc });
  // the store's own session: corrections are saved with the run and survive a reopen
  setEngineerSession(store.getState().session());
}

/** Follow the open project (call once; returns the unsubscribe). */
export function followProject(): () => void {
  const sync = () => {
    const p = workspace.getState().project;
    openRun(
      p ? { id: p.id, root: p.root, manifest: p.manifest } : null,
      shell.getState().pkg !== null,
    );
  };
  sync();
  const a = workspace.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id || s.project?.root !== prev.project?.root) sync();
  });
  const b = shell.subscribe((s, prev) => {
    if (s.pkg !== prev.pkg) sync();
  });
  return () => {
    a();
    b();
  };
}

const NO_STORE = createStore<RunState | null>(() => null);

/** The run state of the open project, or null without a run (hooks). */
export function useRun<T>(select: (s: RunState) => T, fallback: T): T {
  const store = useStore(engineerHost, (s) => s.store);
  const picked = useStore(store ?? NO_STORE, (s: RunState | null) => (s ? select(s) : fallback));
  return store ? picked : fallback;
}

export const useHost = <T>(select: (s: HostState) => T): T => useStore(engineerHost, select);

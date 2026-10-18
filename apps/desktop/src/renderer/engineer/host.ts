import { addAssembly, newAssembly, type UserOverrides } from '@aio/modelling';
import type {
  Assembly,
  AssemblyKind,
  PartStatus,
  ProcModel,
  ProjectManifest,
  EngineerRun,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { setEngineerSession } from '../modeller/engineerTools';
import { bridge, shell } from '../shell';
import { createRunStore, ipcRunIpc, type RunIpc, type RunState } from './runStore';
import { domDecode, domViewCanvas, renderDraftViews, silhouetteScores } from './views';
import { createCorrectionSession } from './correctionSession';
import { setCorrectionSession } from './correctionTools';

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
  history: Pick<EngineerRun, 'id' | 'modelId' | 'createdAt'>[];
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
  history: [],
});

export const engineerHost = createStore<HostState>(initial);

export const modelCorrections = createCorrectionSession(() => {
  const { store, projectId } = engineerHost.getState();
  const state = store?.getState();
  if (!state?.model || !state.run || !projectId || shell.getState().pkg) return null;
  if (state.recoveryRequired) return null;
  return {
    projectId,
    model: state.model,
    run: state.run,
    busy: state.busy,
    save: (requests, model, expected) => state.saveCorrections(requests, model, expected),
  };
});

/** Status, additions and hiding are model edits, written and drawn again (not a rebuild). */
async function writeModel(model: ProcModel): Promise<ProcModel | { error: string }> {
  const { store, ipc } = engineerHost.getState();
  if (!store || !ipc) return { error: 'No engineering model is open.' };
  if (store.getState().recoveryRequired)
    return { error: 'Reopen the project to recover the saved model before editing.' };
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
  setCorrectionSession(null);
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
  const session = store.getState().session();
  const pendingReview = () =>
    store.getState().run?.corrections?.some((r) => r.status === 'open' || r.status === 'proposed');
  const reviewRequired = {
    error:
      'There are pending correction requests. Use propose_model_correction so the person can compare Before and After.',
  };
  setEngineerSession({
    ...session,
    current: () => (pendingReview() ? null : session.current()),
    rebuild: (user) => (pendingReview() ? Promise.resolve(reviewRequired) : session.rebuild(user)),
    setStatus: (ids, status) =>
      pendingReview() ? Promise.resolve(reviewRequired) : session.setStatus(ids, status),
  });
  setCorrectionSession({
    session: modelCorrections,
    cloudRoute: async () => {
      const r = await bridge.call('ai:status', { projectId: project.id, task: 'build' });
      return !r.ok || r.value.cloud;
    },
    permissions: () => {
      const p = workspace.getState().project?.manifest;
      return {
        photos: p?.aiCloudPhotos === true,
        scans: p?.aiCloudScans === true,
        drawings: p?.aiCloudDrawings === true,
      };
    },
    readEvidence: (id) => {
      const s = store.getState();
      if (!s.run || !s.evidence?.images.some((i) => i.id === id))
        throw new Error('That image is not in this run’s prepared evidence.');
      return ipc.evidenceImage(s.run.id, id);
    },
  });
  void refreshRunHistory(true);
}

/** Restore controls and the saved scene layer only; continuing work is always explicit. */
export async function restoreRun(runId: string): Promise<void> {
  const { store, projectId } = engineerHost.getState();
  if (!store || store.getState().busy) return;
  const saved = engineerHost.getState().history.find((r) => r.id === runId);
  if (!saved) return;
  const layers = workspace.getState().project?.manifest.layers ?? [];
  const accepted = `model-${saved.modelId}`,
    draft = `model-draft-${saved.modelId}`;
  try {
    await store.getState().resume(runId, {
      drive: false,
      layer: layers.some((l) => l.id === accepted) ? accepted : null,
      draftLayer: layers.some((l) => l.id === draft) ? draft : null,
    });
    if (engineerHost.getState().projectId === projectId && engineerHost.getState().store === store)
      engineerHost.setState({ selected: null, hidden: [], thumbnails: {}, error: null });
  } catch (e) {
    if (engineerHost.getState().store === store)
      engineerHost.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

export async function refreshRunHistory(restoreLatest = false): Promise<void> {
  const { store, projectId } = engineerHost.getState();
  if (!store || !projectId) return;
  try {
    const r = await bridge.call('engineer:runList', { projectId });
    if (engineerHost.getState().store !== store || !r.ok || !r.value.ok) return;
    engineerHost.setState({ history: r.value.runs });
    const latest = r.value.runs[0];
    if (restoreLatest && latest && !store.getState().run && !store.getState().busy)
      await restoreRun(latest.id);
  } catch (e) {
    if (engineerHost.getState().store === store)
      engineerHost.setState({ error: e instanceof Error ? e.message : String(e) });
  }
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

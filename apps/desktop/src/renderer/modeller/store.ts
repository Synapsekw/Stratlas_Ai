import {
  addParts,
  applyDimension,
  drawingsOf,
  findDrawing,
  newProcModel,
  parsePlacement,
  readDrawingParts,
  setPartStatus,
  updatePart,
  type DimensionKey,
  type DrawingInfo,
  type DrawingPlacement,
  type PartPatch,
} from '@aio/modelling';
import type {
  DrawingImportParams,
  JobRecord,
  ModelFitParams,
  PartStatus,
  ProcModel,
  ProcModelSummary,
  ProcPart,
} from '@aio/schema';
import { assetUrl, type Workspace } from '@aio/workspace';
import type { z } from 'zod';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import type { Jobs } from '../jobs';

/**
 * The Model builder (BLD-11): the procedural model open in it, its parts and what a person (or the
 * agent) does to them. Models are saved through `model:write` after every change, so the file on
 * disk is always what the screen shows. Imports and fits run as pipeline jobs.
 */

type ImportParams = z.input<typeof DrawingImportParams>;
type FitParams = z.input<typeof ModelFitParams>;

export interface ModellerState {
  open: boolean;
  models: ProcModelSummary[];
  readOnly: boolean;
  model: ProcModel | null;
  selected: string | null;
  /** What is running, in words ("Importing the drawing"), or null. */
  busy: string | null;
  error: string | null;
  notice: string | null;
}

export interface ModellerActions {
  show: () => Promise<void>;
  hide: () => void;
  refresh: () => Promise<void>;
  openModel: (id: string) => Promise<string | null>;
  /** The open model, or a new one saved first ("Site model"). */
  ensureModel: () => Promise<ProcModel | null>;
  select: (partId: string | null) => void;
  setStatus: (ids: readonly string[] | 'all', status: PartStatus) => Promise<string | null>;
  editPart: (partId: string, patch: PartPatch) => Promise<string | null>;
  editDimension: (partId: string, key: DimensionKey, value: number) => Promise<string | null>;
  /** Copy candidate parts of an imported drawing as drafts; the parts added, or an error. */
  addFromDrawing: (
    drawing?: string,
    filter?: { tags?: readonly string[]; classes?: readonly string[] },
  ) => Promise<{ added: ProcPart[] } | { error: string }>;
  /** Add parts the agent worked out, as drafts. */
  addAgentParts: (
    parts: readonly Record<string, unknown>[],
    runId?: string,
  ) => Promise<{ added: ProcPart[] } | { error: string }>;
  drawings: () => DrawingInfo[];
  placement: (drawing: DrawingInfo) => Promise<DrawingPlacement>;
  importDrawing: (params: ImportParams) => Promise<string | null>;
  fitCloud: (params: Omit<FitParams, 'model'>) => Promise<string | null>;
  build: (draft?: boolean) => Promise<{ layer: string } | { error: string }>;
  setCloudDrawings: (allow: boolean) => Promise<string | null>;
  dismiss: () => void;
}

export type Modeller = ModellerState & ModellerActions;

export interface ModellerDeps {
  bridge: Bridge;
  workspace: StoreApi<Workspace>;
  jobs: StoreApi<Jobs>;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => Date;
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);

/** Resolves with the job record once it has finished. */
export function waitForJob(jobs: StoreApi<Jobs>, id: string): Promise<JobRecord> {
  return new Promise((resolve) => {
    const check = (s: Jobs) => {
      const j = s.jobs.find((x) => x.id === id);
      if (j && FINISHED.has(j.status)) {
        stop();
        resolve(j);
        return true;
      }
      return false;
    };
    const stop = jobs.subscribe((s) => {
      check(s);
    });
    check(jobs.getState());
  });
}

const DEFAULT_MODEL = { id: 'site-model', name: 'Site model' };

export function createModeller(deps: ModellerDeps): StoreApi<Modeller> {
  const { bridge, workspace, jobs } = deps;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const fetchJson =
    deps.fetchJson ??
    (async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not read ${url} (${String(r.status)}).`);
      return (await r.json()) as unknown;
    });
  const project = () => workspace.getState().project;

  async function reloadManifest(): Promise<void> {
    const p = project();
    if (!p) return;
    const r = await bridge.call('project:open', { path: p.root });
    const ws = workspace.getState();
    if (r.ok && r.value.ok && ws.project?.id === p.id) ws.replaceManifest(r.value.manifest);
  }

  async function runJob(
    pipeline: 'drawing.import' | 'model.fit_cloud',
    params: Record<string, unknown>,
    busy: string,
  ): Promise<JobRecord | string> {
    const p = project();
    if (!p) return 'No project is open.';
    const error = await jobs.getState().start({ pipeline, project: p.root, params });
    if (error) return error;
    const id = jobs.getState().selected;
    if (!id) return 'The job did not start.';
    store.setState({ busy });
    const job = await waitForJob(jobs, id);
    store.setState({ busy: null });
    if (job.status !== 'done') {
      return job.error ?? `The job stopped (${job.status}). See Jobs for its log.`;
    }
    return job;
  }

  const store = createStore<Modeller>()((set, get) => {
    async function save(next: ProcModel): Promise<string | null> {
      const p = project();
      if (!p) return 'No project is open.';
      if (get().readOnly)
        return 'This project is a read-only package. Models are not saved into it.';
      const r = await bridge.call('model:write', { projectId: p.id, model: next });
      const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
      if (error) {
        set({ error });
        return error;
      }
      set({ model: next, error: null });
      void get().refresh();
      return null;
    }

    async function change(fn: (m: ProcModel) => ProcModel): Promise<string | null> {
      const m = get().model;
      if (!m) return 'No model is open.';
      try {
        return await save(fn(m));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        set({ error });
        return error;
      }
    }

    return {
      open: false,
      models: [],
      readOnly: false,
      model: null,
      selected: null,
      busy: null,
      error: null,
      notice: null,

      show: async () => {
        set({ open: true });
        await get().refresh();
        const { model, models } = get();
        const first = models[0];
        if (!model && first) await get().openModel(first.id);
      },
      hide: () => {
        set({ open: false });
      },
      dismiss: () => {
        set({ error: null, notice: null });
      },

      refresh: async () => {
        const p = project();
        if (!p) {
          set({ models: [], model: null, selected: null });
          return;
        }
        const r = await bridge.call('model:list', { projectId: p.id });
        if (!r.ok) set({ error: r.error });
        else if (!r.value.ok) set({ error: r.value.error });
        else set({ models: r.value.models, readOnly: r.value.readOnly });
      },

      openModel: async (id) => {
        const p = project();
        if (!p) return 'No project is open.';
        const r = await bridge.call('model:read', { projectId: p.id, id });
        const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
        if (error || !r.ok || !r.value.ok) {
          set({ error });
          return error;
        }
        set({ model: r.value.model, readOnly: r.value.readOnly, selected: null, error: null });
        return null;
      },

      ensureModel: async () => {
        const current = get().model;
        if (current) return current;
        const known = get().models.find((m) => m.id === DEFAULT_MODEL.id);
        if (known) {
          await get().openModel(known.id);
          return get().model;
        }
        const m = newProcModel({ ...DEFAULT_MODEL, now: now() });
        return (await save(m)) ? null : m;
      },

      select: (partId) => {
        set({ selected: partId });
      },

      setStatus: (ids, status) => change((m) => setPartStatus(m, ids, status, now())),
      editPart: (partId, patch) => change((m) => updatePart(m, partId, patch, now())),
      editDimension: (partId, key, value) =>
        change((m) => {
          const part = m.parts.find((x) => x.id === partId);
          if (!part) throw new Error(`The model has no part "${partId}".`);
          const next = applyDimension(part, key, value);
          return {
            ...m,
            updatedAt: now(),
            parts: m.parts.map((x) => (x.id === partId ? next : x)),
          };
        }),

      drawings: () => drawingsOf(project()?.manifest),

      placement: async (d) => {
        const p = project();
        if (!p) throw new Error('No project is open.');
        return parsePlacement(await fetchJson(assetUrl(p.id, { path: d.placement })));
      },

      addFromDrawing: async (key, filter = {}) => {
        const p = project();
        if (!p) return { error: 'No project is open.' };
        const list = get().drawings();
        const d = findDrawing(list, key);
        if (!d) {
          return {
            error: list.length
              ? `No drawing "${key ?? ''}". Imported drawings: ${list.map((x) => x.name).join(', ')}.`
              : 'No drawing is imported yet. Import a DXF drawing first.',
          };
        }
        let candidates: ProcPart[];
        try {
          candidates = readDrawingParts(await fetchJson(assetUrl(p.id, { path: d.parts }))).parts;
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        const tags = filter.tags?.map((t) => t.toLowerCase());
        const classes = filter.classes?.map((c) => c.toLowerCase());
        const wanted = candidates.filter(
          (c) =>
            (!tags?.length || (c.tag !== undefined && tags.includes(c.tag.toLowerCase()))) &&
            (!classes?.length ||
              (c.class !== undefined && classes.includes(c.class.toLowerCase()))),
        );
        if (wanted.length === 0) {
          return { error: `The drawing ${d.name} has no parts that match.` };
        }
        const m = await get().ensureModel();
        if (!m) return { error: get().error ?? 'The model could not be saved.' };
        const before = new Set(m.parts.map((x) => x.id));
        const next = addParts(m, wanted, now());
        const withSource = next.sources?.some((s) => s.ref === d.dxf)
          ? next
          : {
              ...next,
              sources: [...(next.sources ?? []), { kind: 'drawing' as const, ref: d.dxf }],
            };
        const error = await save(withSource);
        if (error) return { error };
        return { added: withSource.parts.filter((x) => !before.has(x.id)) };
      },

      addAgentParts: async (parts, runId) => {
        const m = await get().ensureModel();
        if (!m) return { error: get().error ?? 'The model could not be saved.' };
        const taken = new Set(m.parts.map((x) => x.id));
        let n = 1;
        const made = parts.map((raw) => {
          while (taken.has(`agent-${String(n)}`)) n++;
          const id = `agent-${String(n)}`;
          taken.add(id);
          return {
            ...raw,
            id,
            status: 'draft',
            origin: { by: 'agent', ...(runId ? { runId } : {}) },
          } as unknown as ProcPart;
        });
        const next = addParts(m, made, now());
        const error = await save(next);
        return error ? { error } : { added: next.parts.slice(m.parts.length) };
      },

      importDrawing: async (params) => {
        set({ error: null, notice: null });
        const r = await runJob('drawing.import', params, 'Importing the drawing');
        if (typeof r === 'string') {
          set({ error: r });
          return r;
        }
        await reloadManifest();
        set({
          notice: 'The drawing is imported. Its plan is on the site and its parts can be added.',
        });
        return null;
      },

      fitCloud: async (params) => {
        set({ error: null, notice: null });
        const m = await get().ensureModel();
        if (!m) return get().error ?? 'The model could not be saved.';
        const before = m.parts.length;
        const r = await runJob(
          'model.fit_cloud',
          { ...params, model: m.id },
          'Fitting parts to the point cloud',
        );
        if (typeof r === 'string') {
          set({ error: r });
          return r;
        }
        await get().openModel(m.id);
        await get().refresh();
        const added = (get().model?.parts.length ?? before) - before;
        set({
          notice:
            added > 0
              ? `${String(added)} draft part${added === 1 ? '' : 's'} fitted. Accept or reject them.`
              : 'No part fitted. Try another region or a larger fit distance.',
        });
        return null;
      },

      build: async (draft = false) => {
        const p = project();
        const m = get().model;
        if (!p || !m) return { error: 'No model is open.' };
        set({ busy: draft ? 'Building the preview' : 'Building the model', error: null });
        const r = await bridge.call('model:build', { projectId: p.id, id: m.id, draft });
        set({ busy: null });
        const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
        if (error || !r.ok || !r.value.ok) {
          set({ error });
          return { error: error ?? 'The model could not be built.' };
        }
        await reloadManifest();
        await get().refresh();
        set({
          notice: draft
            ? 'The preview is in the 3D view.'
            : 'The model is built. It is in the 3D view.',
        });
        return { layer: r.value.layer };
      },

      setCloudDrawings: async (allow) => {
        const p = project();
        if (!p) return 'No project is open.';
        const r = await bridge.call('ai:setCloudDrawings', { projectId: p.id, allow });
        const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
        if (error) {
          set({ error });
          return error;
        }
        await reloadManifest();
        return null;
      },
    };
  });

  // an import or fit started anywhere (the Jobs screen too) changes the project: show it
  const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  jobs.subscribe((s, prev) => {
    const p = project();
    if (!p) return;
    const finished = s.jobs.find(
      (j) =>
        j.status === 'done' &&
        (j.pipeline === 'drawing.import' || j.pipeline === 'model.fit_cloud') &&
        key(j.project) === key(p.root) &&
        prev.jobs.find((x) => x.id === j.id)?.status !== 'done',
    );
    if (!finished) return;
    void reloadManifest();
    void store.getState().refresh();
  });

  // a model belongs to its project
  workspace.subscribe((s, prev) => {
    if (s.project?.id === prev.project?.id) return;
    store.setState({ model: null, models: [], selected: null, error: null, notice: null });
    if (store.getState().open) void store.getState().refresh();
  });

  return store;
}

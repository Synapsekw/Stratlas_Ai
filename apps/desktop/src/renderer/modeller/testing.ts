import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
  JobRecord,
  ProcModel,
  ProjectManifest,
} from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { createStore } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import type { Jobs } from '../jobs';
import { createModeller } from './store';

export const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'site',
  name: 'Synthetic site',
  crs: { epsg: 32640 },
  origin: [400000, 2800000, 0],
  captures: [],
  layers: [
    {
      kind: 'raster',
      id: 'plan-plot',
      name: 'plot.dxf plan',
      visible: true,
      src: { path: 'drawings/plot/plan.png' },
      role: 'plan',
      format: 'image',
      corners: { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] },
    },
  ],
  severityModels: [],
  classCatalogues: [],
};

export const candidates: ProcModel = {
  schema: 'aio.procmodel/1',
  id: 'plot',
  name: 'plot.dxf',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  parts: [
    {
      kind: 'cylinder',
      id: 'dxf-1A',
      tag: 'T-101',
      class: 'tank',
      status: 'draft',
      origin: { by: 'drawing', file: 'drawings/plot.dxf', layer: 'TANKS', entity: '1A' },
      base: [0, 0, 0],
      radius: 6,
      height: 12.5,
    },
    {
      kind: 'cylinder',
      id: 'dxf-1B',
      tag: 'T-102',
      class: 'tank',
      status: 'draft',
      origin: { by: 'drawing', file: 'drawings/plot.dxf', layer: 'TANKS', entity: '1B' },
      base: [20, 0, 0],
      radius: 4,
      height: 10,
    },
    {
      kind: 'extrusion',
      id: 'dxf-2C',
      class: 'building',
      status: 'draft',
      origin: { by: 'drawing', file: 'drawings/plot.dxf', layer: 'BUILDINGS', entity: '2C' },
      footprint: [
        [0, 20],
        [10, 20],
        [10, 30],
      ],
      baseY: 0,
      height: 4,
    },
  ],
};

/** A Model builder store over an in-memory bridge, workspace and jobs (tests only). */
export function setupModeller() {
  const files = new Map<string, ProcModel>();
  const calls: { channel: string; req: unknown }[] = [];
  const bridge: Bridge = {
    call: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      const answer = (v: unknown) =>
        Promise.resolve({ ok: true as const, value: v as IpcResponse<C> });
      const r = req as Record<string, unknown>;
      switch (channel) {
        case 'model:list':
          return answer({
            ok: true,
            readOnly: false,
            models: [...files.values()].map((m) => ({
              id: m.id,
              name: m.name,
              parts: m.parts.length,
              accepted: m.parts.filter((p) => p.status === 'accepted').length,
              updatedAt: m.updatedAt,
            })),
          });
        case 'model:write': {
          const m = r.model as ProcModel;
          files.set(m.id, m);
          return answer({ ok: true });
        }
        case 'model:read': {
          const m = files.get(r.id as string);
          return answer(m ? { ok: true, model: m, readOnly: false } : { ok: false, error: 'no' });
        }
        case 'model:build':
          return answer({ ok: true, layer: 'model-site-model', glb: 'models/site-model.glb' });
        case 'project:open':
          return answer({ ok: true, manifest: { ...manifest, aiCloudDrawings: true }, issues: [] });
        default:
          return answer({ ok: true });
      }
    },
  };
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'site', root: 'C:/p/site', manifest });
  const started: { pipeline: string; params: Record<string, unknown> }[] = [];
  const jobs = createStore<Jobs>()((set) => ({
    runtime: null,
    jobs: [],
    logs: {},
    selected: null,
    error: null,
    draft: null,
    init: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    select: () => Promise.resolve(),
    cancel: () => Promise.resolve(null),
    open: () => Promise.resolve(null),
    prepare: () => undefined,
    start: (req) => {
      if (!('pipeline' in req)) return Promise.resolve('resume');
      started.push({ pipeline: req.pipeline, params: req.params });
      const job = {
        id: `j${String(started.length)}`,
        pipeline: req.pipeline,
        project: req.project,
        params: req.params,
        status: 'running',
        progress: 0,
        steps: [],
        artifacts: [],
        createdAt: '',
        updatedAt: '',
      } as JobRecord;
      set((s) => ({ jobs: [job, ...s.jobs], selected: job.id }));
      return Promise.resolve(null);
    },
  }));
  const finish = (status: JobRecord['status'], error?: string) => {
    jobs.setState((s) => ({
      jobs: s.jobs.map((j, i) => (i === 0 ? { ...j, status, ...(error ? { error } : {}) } : j)),
    }));
  };
  const modeller = createModeller({
    bridge,
    workspace,
    jobs,
    fetchJson: (url) => {
      if (url.endsWith('parts.procmodel.json')) return Promise.resolve(candidates);
      return Promise.reject(new Error(`404 ${url}`));
    },
    now: () => new Date('2026-10-06T10:00:00Z'),
  });
  return { modeller, files, calls, workspace, started, finish };
}

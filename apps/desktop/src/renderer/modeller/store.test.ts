import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
  JobRecord,
  ProcModel,
  ProjectManifest,
} from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import type { Jobs } from '../jobs';
import { createModeller } from './store';

const manifest: ProjectManifest = {
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

const candidates: ProcModel = {
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

function setup() {
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

describe('model builder store', () => {
  it('adds the parts of an imported drawing as drafts, into a new site model', async () => {
    const { modeller, files } = setup();
    await modeller.getState().show();
    expect(
      modeller
        .getState()
        .drawings()
        .map((d) => d.stem),
    ).toEqual(['plot']);
    const r = await modeller.getState().addFromDrawing(undefined, { classes: ['tank'] });
    expect('added' in r && r.added.map((p) => p.tag)).toEqual(['T-101', 'T-102']);
    const saved = files.get('site-model');
    expect(saved?.parts.every((p) => p.status === 'draft')).toBe(true);
    expect(saved?.sources).toEqual([{ kind: 'drawing', ref: 'drawings/plot.dxf' }]);
    // adding the same drawing again does not double it
    const again = await modeller.getState().addFromDrawing('plot.dxf');
    expect('added' in again && again.added.map((p) => p.id)).toEqual(['dxf-2C']);
    expect(files.get('site-model')?.parts).toHaveLength(3);
  });

  it('finds parts by tag, and says when nothing matches', async () => {
    const { modeller } = setup();
    const r = await modeller.getState().addFromDrawing(undefined, { tags: ['t-102'] });
    expect('added' in r && r.added.map((p) => p.tag)).toEqual(['T-102']);
    expect(await modeller.getState().addFromDrawing(undefined, { tags: ['X-1'] })).toEqual({
      error: 'The drawing plot.dxf has no parts that match.',
    });
    expect(await modeller.getState().addFromDrawing('other')).toEqual({
      error: 'No drawing "other". Imported drawings: plot.dxf.',
    });
  });

  it('accepts, edits and rejects parts, saving each change', async () => {
    const { modeller, files } = setup();
    await modeller.getState().addFromDrawing();
    await modeller.getState().setStatus('all', 'accepted');
    await modeller.getState().editDimension('dxf-1A', 'height', 14);
    await modeller.getState().setStatus(['dxf-2C'], 'rejected');
    const m = files.get('site-model');
    expect(m?.parts.map((p) => p.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(m?.parts[0]).toMatchObject({ height: 14 });
    expect(await modeller.getState().editDimension('dxf-1A', 'radius', -1)).toBe(
      'Radius must be more than 0.',
    );
  });

  it('adds the agent parts as drafts with an agent origin', async () => {
    const { modeller, files } = setup();
    const r = await modeller
      .getState()
      .addAgentParts([{ kind: 'box', base: [0, 0, 0], size: [2, 2, 2], class: 'skid' }], 'run-1');
    expect('added' in r && r.added[0]).toMatchObject({
      id: 'agent-1',
      status: 'draft',
      origin: { by: 'agent', runId: 'run-1' },
    });
    expect(files.get('site-model')?.parts).toHaveLength(1);
  });

  it('fits a cloud into the open model through a job and reports the new drafts', async () => {
    const { modeller, files, started, finish } = setup();
    await modeller.getState().ensureModel();
    const running = modeller.getState().fitCloud({ layer: 'scan' });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([
      { pipeline: 'model.fit_cloud', params: { layer: 'scan', model: 'site-model' } },
    ]);
    expect(modeller.getState().busy).toBe('Fitting parts to the point cloud');
    // the pipeline appended two drafts
    const m = files.get('site-model');
    if (!m) throw new Error('no model');
    files.set('site-model', { ...m, parts: [...candidates.parts.slice(0, 2)] });
    finish('done');
    expect(await running).toBeNull();
    expect(modeller.getState().notice).toBe('2 draft parts fitted. Accept or reject them.');
    expect(modeller.getState().busy).toBeNull();
  });

  it('shows the job error when an import fails', async () => {
    const { modeller, finish } = setup();
    const running = modeller.getState().importDrawing({ src: 'C:/x/plot.dxf' });
    await Promise.resolve();
    finish('failed', '"plot.dxf" has no drawing units. Set the drawing units and import again.');
    expect(await running).toMatch(/Set the drawing units/);
    expect(modeller.getState().error).toMatch(/Set the drawing units/);
  });

  it('builds the model and reloads the manifest', async () => {
    const { modeller, workspace, calls } = setup();
    await modeller.getState().addFromDrawing();
    expect(await modeller.getState().build()).toEqual({ layer: 'model-site-model' });
    expect(calls.some((c) => c.channel === 'project:open')).toBe(true);
    expect(workspace.getState().project?.manifest.aiCloudDrawings).toBe(true);
  });

  it('forgets the model when another project opens', async () => {
    const { modeller, workspace } = setup();
    await modeller.getState().addFromDrawing();
    workspace.getState().openProject({ id: 'other', root: 'C:/p/other', manifest });
    expect(modeller.getState().model).toBeNull();
  });
});

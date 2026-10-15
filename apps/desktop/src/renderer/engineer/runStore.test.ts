import type {
  EngineerProposal,
  EngineerRun,
  EngineerSetup,
  EvidencePack,
  GlbCheckReport,
  IpcRequest,
  JobRecord,
  ProcModel,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  createRunStore,
  DECLINED_IDENTIFY,
  OFFLINE_IDENTIFY,
  STAGES,
  type RunIpc,
  type RunState,
} from './runStore';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SHA = (c: string) => c.repeat(40);

/** A synthetic metric chimney pack: 60 m, tapering, two flues, a side render and a photo. */
function cloudEvidence(run: string, o: Partial<EvidencePack> = {}): EvidencePack {
  return {
    schema: 'aio.evidence/1',
    run,
    crs: { epsg: 32639 },
    units: 'm',
    crop: null,
    bounds: { min: [-6, 0, -6], max: [6, 60, 6] },
    samples: { read: 50_000, kept: 40_000, ground: 2_000 },
    axis: { point: [0, 0, 0], dir: [0, 1, 0], tiltDeg: 0.1 },
    base: [0, 0, 0],
    height: 60,
    slices: Array.from({ length: 30 }, (_, i) => ({
      y: i * 2,
      centre: [0, 0] as [number, number],
      r: 5 - i * 0.05,
      residualM: 0.02,
      support: 400,
      coverage: 0.8,
      shape: 'circle' as const,
    })),
    taper: {
      profile: [
        { y: 0, r: 5 },
        { y: 60, r: 3.5 },
      ],
      residualM: 0.03,
    },
    members: [
      {
        kind: 'flue',
        items: [
          { centre: [1, 61, 0], size: 0.8, support: 120 },
          { centre: [-1, 61, 0], size: 0.8, support: 110 },
        ],
        metrics: { residualM: 0.02, regularity: 0.9 },
      },
    ],
    familyHints: { fillRatio: 0.4, slenderness: 6, topFeatures: 2, suggested: 'chimney' },
    colours: [{ y0: 0, y1: 60, rgb: [180, 170, 150] }],
    photos: [
      {
        id: SHA('a'),
        original: 'photos/one.jpg',
        w: 4000,
        h: 3000,
        orientationApplied: true,
        blur: 120,
      },
    ],
    images: [
      {
        id: 'img-side-n',
        file: 'img/side-n.png',
        kind: 'side',
        view: 'north',
        w: 512,
        h: 1024,
        bytes: 10,
        sha1: SHA('b'),
      },
      {
        id: 'img-photo-1',
        file: 'img/photo-1.jpg',
        kind: 'photo',
        view: 'photo',
        w: 1024,
        h: 768,
        bytes: 10,
        sha1: SHA('c'),
      },
    ],
    reconstruction: 'not-needed',
    warnings: [],
    ...o,
  };
}

/** Photos only, one image: nothing metric. */
function photoEvidence(run: string): EvidencePack {
  return cloudEvidence(run, {
    crs: null,
    bounds: null,
    samples: { read: 0, kept: 0, ground: 0 },
    axis: null,
    base: null,
    height: null,
    slices: [],
    taper: null,
    members: [],
    familyHints: null,
    colours: [],
    images: [
      {
        id: 'img-photo-1',
        file: 'img/photo-1.jpg',
        kind: 'photo',
        view: 'photo',
        w: 1024,
        h: 768,
        bytes: 10,
        sha1: SHA('c'),
      },
    ],
    reconstruction: 'unavailable',
  });
}

const PROPOSAL: EngineerProposal = {
  family: { value: 'chimney', reasons: ['tall tapering shaft'] },
  identity: { sameAsset: true, conflicts: [] },
  components: [
    {
      role: 'flue',
      kind: 'flue',
      count: 2,
      units: 'ratio',
      params: {},
      imageIds: ['img-side-n'],
      observed: true,
    },
  ],
  unresolved: [],
  notes: '',
};

const CLEAN: GlbCheckReport = {
  validatorErrors: 0,
  validatorWarnings: 0,
  messages: [],
  finite: true,
  indicesValid: true,
  normalsUnit: true,
  degenerate: 0,
  duplicateTris: 0,
  unintendedHoles: [],
  intendedOpenOk: true,
  openingProblems: [],
  triangles: 1000,
  withinBudget: true,
};

function setup(o: Partial<EngineerSetup> = {}): EngineerSetup {
  return {
    sources: { clouds: [{ layer: 'cloud-1' }], meshes: [], photos: [{ path: 'photos/one.jpg' }] },
    family: 'auto',
    scope: 'asset',
    detail: 'fast',
    placement: 'from-source',
    ...o,
  };
}

/** A project's run files, jobs, models and layers in memory, recording every IPC call. */
class FakeProject {
  calls: { channel: string; payload: unknown }[] = [];
  runs = new Map<string, EngineerRun>();
  proposals = new Map<string, EngineerProposal>();
  evidence = new Map<string, EvidencePack>();
  jobs = new Map<string, JobRecord>();
  models = new Map<string, ProcModel>();
  layers = new Set<string>();
  engineerCalls = 0;
  jobsStarted = 0;
  /** What the measuring job writes for a run. */
  makeEvidence: (run: string) => EvidencePack = (run) => cloudEvidence(run);
  /** What the AI answers, pass by pass. */
  answer: (req: IpcRequest<'ai:engineer'>) => IpcRequestOutcome = () => ({
    kind: 'proposal',
    proposal: PROPOSAL,
    cached: false,
    costUsd: 0.05,
  });
  /** Holds the next AI answer until released (to cancel in flight). */
  hold: Promise<void> | null = null;

  private log(channel: string, payload: unknown) {
    this.calls.push({ channel, payload });
  }

  ipc(): RunIpc {
    return {
      runRead: (runId) => {
        this.log('engineer:runRead', { runId });
        return Promise.resolve({
          run: this.runs.get(runId) ?? null,
          evidence: this.evidence.get(runId) ?? null,
          proposal: this.proposals.get(runId) ?? null,
        });
      },
      runWrite: (run, proposal) => {
        this.log('engineer:runWrite', { run, proposal });
        this.runs.set(run.id, structuredClone(run));
        if (proposal) this.proposals.set(run.id, structuredClone(proposal));
        return Promise.resolve();
      },
      evidenceImage: (runId, imageId) => {
        this.log('engineer:evidenceImage', { runId, imageId });
        return Promise.resolve(PNG);
      },
      preview: (req) => {
        this.log('ai:engineerPreview', req);
        return Promise.resolve({
          ok: true,
          route: { task: 'engineer', provider: 'anthropic', model: 'test-vision' },
          cloud: true,
          flags: { photos: false, scans: false },
          estimateUsd: 0.05,
          content: { text: 'request', images: [], leftOut: [], bytes: 0 },
          consent: 'token-1',
        });
      },
      engineer: async (req) => {
        this.log('ai:engineer', req);
        this.engineerCalls++;
        if (this.hold) await this.hold;
        return this.answer(req);
      },
      cancel: (runId) => {
        this.log('ai:cancel', { runId });
        return Promise.resolve();
      },
      enqueueJob: (req) => {
        this.log('jobs:start', req);
        this.jobsStarted++;
        const id = 'resume' in req ? req.resume : `job-${String(this.jobsStarted)}`;
        const run = 'resume' in req ? (this.jobs.get(id)?.params.run as string) : req.params.run;
        const rec: JobRecord = {
          id,
          pipeline: 'model.evidence',
          project: 'C:/projects/site',
          params: { run },
          status: 'running',
          progress: 0,
          steps: [],
          artifacts: [],
          createdAt: '2026-10-15T10:00:00Z',
          updatedAt: '2026-10-15T10:00:00Z',
        };
        this.jobs.set(id, rec);
        return Promise.resolve(rec);
      },
      jobStatus: (jobId) => {
        this.log('jobs:list', { jobId });
        const rec = this.jobs.get(jobId);
        if (!rec) return Promise.resolve(null);
        if (rec.status === 'running') {
          const run = rec.params.run as string;
          this.evidence.set(run, this.makeEvidence(run));
          rec.status = 'done';
        }
        return Promise.resolve({ ...rec });
      },
      cancelJob: (jobId) => {
        this.log('jobs:cancel', { jobId });
        const rec = this.jobs.get(jobId);
        if (rec) rec.status = 'cancelled';
        return Promise.resolve();
      },
      modelRead: (id) => {
        this.log('model:read', { id });
        return Promise.resolve(this.models.get(id) ?? null);
      },
      modelWrite: (model) => {
        this.log('model:write', { model });
        this.models.set(model.id, structuredClone(model));
        return Promise.resolve();
      },
      modelBuild: (id, draft) => {
        this.log('model:build', { id, draft });
        const layer = `model-${draft ? 'draft-' : ''}${id}`;
        this.layers.add(layer);
        return Promise.resolve({
          layer,
          report: {
            triangles: 1000,
            overBudget: false,
            detail: 'fast',
            simplified: [],
            failed: [],
            notes: [],
          },
        });
      },
      validate: (id, draft, detail) => {
        this.log('engineer:validate', { id, draft, detail });
        return Promise.resolve(CLEAN);
      },
      accept: (id) => {
        this.log('engineer:accept', { id });
        this.layers.delete(`model-draft-${id}`);
        this.layers.add(`model-${id}`);
        return Promise.resolve({ layer: `model-${id}` });
      },
      setCloudEvidence: (o) => {
        this.log('ai:setCloudEvidence', o);
        return Promise.resolve();
      },
    };
  }
}
type IpcRequestOutcome = Awaited<ReturnType<RunIpc['engineer']>>;

let clock = 0;
function store(p: FakeProject, o: { online?: boolean; autoSend?: boolean } = {}) {
  const s = createRunStore({
    ipc: p.ipc(),
    project: { crs: { epsg: 32639 }, origin: [500000, 3200000, 0] },
    now: () => new Date(Date.UTC(2026, 9, 15, 10, 0, clock++)).toISOString(),
    online: () => o.online ?? true,
    sleep: () => Promise.resolve(),
    newRunId: () => 'run-test-1',
  });
  if (o.autoSend !== false)
    s.subscribe((st, prev) => {
      if (st.preview && !prev.preview)
        queueMicrotask(() => {
          s.getState().sendPreview({ once: { photos: true, scans: true }, costConfirmed: false });
        });
    });
  return s;
}

const statuses = (st: RunState) => STAGES.map((x) => st.run?.stages[x]?.status ?? '-');

/** The order in which stages first became done, from the run.json writes. */
function doneOrder(p: FakeProject): string[] {
  const order: string[] = [];
  for (const c of p.calls) {
    if (c.channel !== 'engineer:runWrite') continue;
    const run = (c.payload as { run: EngineerRun }).run;
    for (const s of STAGES)
      if (run.stages[s]?.status === 'done' && !order.includes(s)) order.push(s);
  }
  return order;
}

describe('engineering run store', () => {
  it('a cloud and photos run reaches review with the stages in order', async () => {
    const p = new FakeProject();
    const s = store(p);
    await s.getState().start(setup());
    const st = s.getState();
    expect(st.error).toBeNull();
    expect(statuses(st)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(doneOrder(p)).toEqual([...STAGES]);
    expect(st.proposal).toEqual(PROPOSAL);
    expect(p.proposals.get('run-test-1')).toEqual(PROPOSAL);
    expect(st.model?.assemblies.filter((a) => a.kind === 'flue')).toHaveLength(2);
    expect(st.model?.georef?.horizontal.status).toBe('from-source');
    expect(st.report).toEqual(CLEAN);
    expect(st.draftLayer).toBe('model-draft-eng-test-1');
    expect(st.run?.usage.costUsd).toBeCloseTo(0.05, 6);
    expect(p.engineerCalls).toBe(1); // fast: one pass
    // the request went with the consent token of its preview
    const req = p.calls.find((c) => c.channel === 'ai:engineer')?.payload as {
      consent: { token: string };
      images: { id: string }[];
    };
    expect(req.consent.token).toBe('token-1');
    expect(req.images.map((i) => i.id)).toEqual(['img-side-n', 'img-photo-1']);
  });

  it('offline: identify is skipped with the reason and the draft is measured only', async () => {
    const p = new FakeProject();
    const s = store(p, { online: false });
    await s.getState().start(setup());
    const st = s.getState();
    expect(statuses(st)).toEqual(['done', 'done', 'skipped', 'done', 'done', 'done']);
    expect(st.run?.stages.identify?.message).toBe(OFFLINE_IDENTIFY);
    expect(st.proposal).toBeNull();
    expect(p.engineerCalls).toBe(0);
    expect(p.calls.some((c) => c.channel === 'ai:engineerPreview')).toBe(false);
    const bases = new Set(
      (st.model?.assemblies ?? []).flatMap((a) => Object.values(a.quality).map((q) => q.basis)),
    );
    expect(bases.has('observed')).toBe(false);
    expect(bases.has('measured')).toBe(true);
  });

  it('photos alone and offline stops after inspect with the reason', async () => {
    const p = new FakeProject();
    p.makeEvidence = photoEvidence;
    const s = store(p, { online: false });
    await s
      .getState()
      .start(setup({ sources: { clouds: [], meshes: [], photos: [{ path: 'photos/one.jpg' }] } }));
    const st = s.getState();
    expect(statuses(st)).toEqual(['done', 'done', 'skipped', '-', '-', '-']);
    expect(st.error).toBe(OFFLINE_IDENTIFY);
    expect(st.model).toBeNull();
  });

  it('one photo without a reference: provisional scale, unplaced, reconstruction unavailable', async () => {
    const p = new FakeProject();
    p.makeEvidence = photoEvidence;
    const s = store(p);
    await s.getState().start(
      setup({
        sources: { clouds: [], meshes: [], photos: [{ path: 'photos/one.jpg' }] },
        placement: 'unplaced',
      }),
    );
    const st = s.getState();
    expect(st.error).toBeNull();
    expect(st.model?.scale?.status).toBe('provisional');
    expect(st.model?.georef?.horizontal.status).toBe('unplaced');
    expect(st.model?.georef?.scale.status).toBe('provisional');
    expect(st.run?.reconstruction).toBe('unavailable');
    expect(p.runs.get('run-test-1')?.reconstruction).toBe('unavailable');
  });

  it('cancel during identify leaves inspect and estimate done and sends nothing', async () => {
    const p = new FakeProject();
    const s = store(p, { autoSend: false });
    const unsub = s.subscribe((st, prev) => {
      if (st.preview && !prev.preview) void s.getState().cancel();
    });
    await s.getState().start(setup());
    unsub();
    const st = s.getState();
    expect(statuses(st).slice(0, 3)).toEqual(['done', 'done', 'cancelled']);
    expect(p.engineerCalls).toBe(0);
    expect(st.busy).toBe(false);
    expect(st.preview).toBeNull();
    // retry picks up at identify, without measuring again
    const jobs = p.jobsStarted;
    s.subscribe((now, prev) => {
      if (now.preview && !prev.preview)
        queueMicrotask(() => {
          s.getState().sendPreview({ once: { photos: true, scans: true }, costConfirmed: false });
        });
    });
    await s.getState().retry();
    expect(statuses(s.getState())).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(p.jobsStarted).toBe(jobs);
  });

  it('cancel while the AI request is in flight asks main to cancel it', async () => {
    const p = new FakeProject();
    let release: () => void = () => undefined;
    p.hold = new Promise<void>((r) => {
      release = r;
    });
    p.answer = () => ({ kind: 'failed', error: 'Cancelled.', code: 'cancelled' });
    const s = store(p);
    const done = s.getState().start(setup());
    await expect.poll(() => p.engineerCalls).toBe(1);
    const cancelled = s.getState().cancel();
    release();
    await cancelled;
    await done;
    expect(p.calls.some((c) => c.channel === 'ai:cancel')).toBe(true);
    expect(s.getState().run?.stages.identify?.status).toBe('cancelled');
  });

  it('a declined send skips identify and still builds the measured draft', async () => {
    const p = new FakeProject();
    const s = store(p, { autoSend: false });
    s.subscribe((st, prev) => {
      if (st.preview && !prev.preview)
        queueMicrotask(() => {
          s.getState().declinePreview();
        });
    });
    await s.getState().start(setup());
    expect(statuses(s.getState())).toEqual(['done', 'done', 'skipped', 'done', 'done', 'done']);
    expect(s.getState().run?.stages.identify?.message).toBe(DECLINED_IDENTIFY);
    expect(p.engineerCalls).toBe(0);
  });

  it('reopening a finished run neither measures nor asks the AI again', async () => {
    const p = new FakeProject();
    await store(p).getState().start(setup());
    const jobs = p.jobsStarted;
    const asked = p.engineerCalls;
    const writes = p.calls.filter((c) => c.channel === 'model:write').length;
    const again = store(p);
    await again.getState().resume('run-test-1');
    const st = again.getState();
    expect(st.error).toBeNull();
    expect(statuses(st)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(p.jobsStarted).toBe(jobs);
    expect(p.engineerCalls).toBe(asked);
    expect(p.calls.filter((c) => c.channel === 'model:write').length).toBe(writes);
    expect(st.proposal).toEqual(PROPOSAL);
  });

  it('reopening a run whose job was interrupted resumes that job, not a new one', async () => {
    const p = new FakeProject();
    const s = store(p, { autoSend: false });
    // stop at the preview, then pretend the app closed while the job had not finished
    s.subscribe((st, prev) => {
      if (st.preview && !prev.preview) void s.getState().cancel();
    });
    await s.getState().start(setup());
    const job = p.jobs.get('job-1');
    if (!job) throw new Error('no job');
    job.status = 'interrupted';
    const run = p.runs.get('run-test-1');
    if (!run) throw new Error('no run');
    p.runs.set('run-test-1', {
      ...run,
      stages: { inspect: { status: 'running', output: 'job-1' } },
    });
    await store(p).getState().resume('run-test-1');
    const starts = p.calls.filter((c) => c.channel === 'jobs:start').map((c) => c.payload);
    expect(starts).toEqual([
      { params: expect.objectContaining({ run: 'run-test-1' }) as unknown },
      { resume: 'job-1' },
    ]);
  });

  it('an identity conflict stops with the images, and dropping them runs again', async () => {
    const p = new FakeProject();
    let first = true;
    p.answer = (req) => {
      const conflict = first && req.images.some((i) => i.id === 'img-photo-1');
      first = false;
      return {
        kind: 'proposal',
        proposal: conflict
          ? {
              ...PROPOSAL,
              identity: {
                sameAsset: false,
                conflicts: [
                  { imageIds: ['img-photo-1'], reason: 'a lattice tower, not a chimney' },
                ],
              },
            }
          : PROPOSAL,
        cached: false,
        costUsd: 0,
        ...(conflict ? { identityConflict: true as const } : {}),
      };
    };
    const s = store(p);
    await s.getState().start(setup());
    let st = s.getState();
    expect(st.run?.stages.identify?.status).toBe('failed');
    expect(st.error).toContain('img-photo-1');
    expect(st.conflicts).toHaveLength(1);
    expect(st.model).toBeNull();
    await s.getState().dropImages(['img-photo-1']);
    st = s.getState();
    expect(statuses(st)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    const last = p.calls.filter((c) => c.channel === 'ai:engineer').at(-1)?.payload as {
      images: { id: string }[];
    };
    expect(last.images.map((i) => i.id)).toEqual(['img-side-n']);
  });

  it('accepting twice leaves one model layer', async () => {
    const p = new FakeProject();
    const s = store(p);
    await s.getState().start(setup());
    await s.getState().accept();
    await s.getState().accept();
    expect([...p.layers]).toEqual(['model-eng-test-1']);
    expect(s.getState().layer).toBe('model-eng-test-1');
  });

  it('a rebuild with the person values regenerates without asking the AI again', async () => {
    const p = new FakeProject();
    const s = store(p);
    await s.getState().start(setup());
    const asked = p.engineerCalls;
    await s
      .getState()
      .rebuild({ params: {}, counts: { flue: 3 }, levels: {}, removed: [], added: [] });
    expect(p.engineerCalls).toBe(asked);
    expect(s.getState().model?.assemblies.filter((a) => a.kind === 'flue')).toHaveLength(3);
    expect(statuses(s.getState())).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('no IPC payload holds a typed array or an array over 10 000 items', async () => {
    const p = new FakeProject();
    const s = store(p);
    await s.getState().start(setup());
    await s.getState().accept();
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) bad.push(`${path}: typed array`);
      else if (Array.isArray(v)) {
        if (v.length > 10_000) bad.push(`${path}: ${String(v.length)} items`);
        v.forEach((x, i) => {
          walk(x, `${path}[${String(i)}]`);
        });
      } else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const c of p.calls) walk(c.payload, c.channel);
    expect(bad).toEqual([]);
    expect(p.calls.length).toBeGreaterThan(10);
  });
});

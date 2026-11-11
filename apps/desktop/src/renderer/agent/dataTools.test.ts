// @vitest-environment jsdom
import { defaultToolContext, runRendererTool, type RendererToolContext } from '@aio/ai';
import type { ProjectManifest } from '@aio/schema';
import { captureIndex, workspace } from '@aio/workspace';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../detections/store', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    // accepting makes issues through the issue editor; the rest is the real review store
    acceptByIds: vi.fn(() => ({ accepted: [{ id: 'd1', issueId: 'i9' }], skipped: [] })),
  };
});

const { agentFacts, registerDataTools } = await import('./dataTools');
const det = await import('../detections/store');
const { jobs } = await import('../shell');
const { timeline } = await import('../workspace/timeline');
const { measureStore } = await import('../survey/measureStore');
const { factIndex } = await import('../facts/factStore');

const L = (o: Record<string, unknown>) => ({ visible: true, ...o });
const manifest = {
  captures: [
    { id: 'c2', label: 'Second', date: '2024-10-02' },
    { id: 'c1', label: '2024-09-04', date: '2024-09-04' },
  ],
  layers: [
    L({ kind: 'mesh', id: 'm1', name: 'Model', capture: 'c1' }),
    L({ kind: 'mesh', id: 'm2', name: 'Model 2', capture: 'c2' }),
    L({ kind: 'photos', id: 'ph', name: 'Photos', items: [] }),
    L({
      kind: 'walk',
      id: 'w1',
      name: 'Ground floor',
      capture: 'c2',
      durationS: 93.4,
      record: { path: 'w.json' },
      src: { path: 'w.mp4' },
      place: { pins: [], yawOffsetDeg: 0, heightM: 1.6, quality: 'good' },
    }),
  ],
} as unknown as ProjectManifest;

const d = (id: string, status: string, confidence: number, classId = 'crack') => ({
  id,
  pass: 'review.json',
  source: { kind: 'photo', layer: 'ph', photo: `${id}.jpg` },
  size: [1, 1],
  geom: { type: 'box', box: [0, 0, 1, 1] },
  classId,
  severity: 2,
  uncertain: false,
  note: '',
  confidence,
  status,
  origin: { kind: 'human', author: 'x' },
});

let fetched: unknown = null;
const ctx = (): RendererToolContext => ({
  ...defaultToolContext('scene3d'),
  fetchJson: () => (fetched === null ? Promise.reject(new Error('404')) : Promise.resolve(fetched)),
});

beforeAll(() => {
  registerDataTools();
});

beforeEach(() => {
  fetched = null;
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest },
    hidden: {},
    issues: [],
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  det.detections.setState({
    projectId: 'p',
    loading: false,
    loadError: null,
    readOnly: false,
    review: {
      ...det.detections.getState().review,
      detections: [
        d('d1', 'draft', 0.9),
        d('d2', 'draft', 0.4, 'leak'),
        d('d3', 'rejected', 0.7),
        d('d4', 'rejected', 0.6),
      ],
      past: [],
      future: [],
      revision: 0,
    },
  } as never);
});

describe('survey dates', () => {
  it('lists the dates oldest first, with their layers and the one in view', async () => {
    timeline.setState({ projectId: 'p', index: captureIndex(manifest), focus: 'c2' } as never);
    const r = await runRendererTool('list_surveys', {}, ctx());
    expect(r.result).toMatchObject({
      total: 2,
      dates: [
        { id: 'c1', date: '2024-09-04', layers: 1 },
        { id: 'c2', date: '2024-10-02', name: 'Second', inView: true },
      ],
    });
  });

  it('brings a date into view through the timeline, with an undo to the date before', async () => {
    timeline.setState({ projectId: 'p', index: captureIndex(manifest), focus: 'c2' } as never);
    const focusSurvey = vi.fn((id: string) => {
      timeline.setState({ focus: id } as never);
    });
    timeline.setState({ focusSurvey } as never);
    const r = await runRendererTool('set_survey_date', { date: '2024-09-04' }, ctx());
    expect(focusSurvey).toHaveBeenCalledWith('c1');
    expect(r.result).toMatchObject({ inView: { id: 'c1' } });
    expect(r.undo?.()).toBeNull();
    expect(focusSurvey).toHaveBeenLastCalledWith('c2');
  });

  it('offers no undo when no date was in view before: the layers it showed would stay', async () => {
    timeline.setState({ projectId: 'p', index: captureIndex(manifest), focus: null } as never);
    timeline.setState({
      focusSurvey: (id: string) => {
        timeline.setState({ focus: id } as never);
      },
    } as never);
    const r = await runRendererTool('set_survey_date', { date: 'latest' }, ctx());
    expect(timeline.getState().focus).toBe('c2');
    expect(r.undo).toBeUndefined();
  });

  it('refuses the undo after a project switch, or once the date in view changed since', async () => {
    timeline.setState({ projectId: 'p', index: captureIndex(manifest), focus: 'c2' } as never);
    timeline.setState({
      focusSurvey: (id: string) => {
        timeline.setState({ focus: id } as never);
      },
    } as never);
    const r = await runRendererTool('set_survey_date', { date: 'earliest' }, ctx());
    timeline.setState({ focus: 'c2' } as never);
    expect(r.undo?.()).toMatch(/changed since/);
    timeline.setState({ focus: 'c1', projectId: 'other' } as never);
    expect(r.undo?.()).toMatch(/another project/);
  });

  it('names the dates when the asked one does not exist', async () => {
    await expect(runRendererTool('set_survey_date', { date: 'June' }, ctx())).rejects.toThrow(
      /No survey date "June"/,
    );
  });
});

describe('detections', () => {
  it('lists the waiting ones by default, most confident first, with counts', async () => {
    const r = await runRendererTool('list_detections', {}, ctx());
    expect(r.result).toMatchObject({
      total: 4,
      byStatus: { draft: 2, rejected: 2 },
      matching: 2,
      byClass: { crack: 1, leak: 1 },
    });
    const rows = (r.result as { detections: { id: string }[] }).detections;
    expect(rows.map((x) => x.id)).toEqual(['d1', 'd2']);
  });

  const statusOf = (id: string) =>
    det.detections.getState().review.detections.find((x) => x.id === id)?.status;

  it('accepts into draft issues through the review', async () => {
    const a = await runRendererTool(
      'review_detections',
      { ids: ['d1'], decision: 'accept' },
      ctx(),
    );
    expect(det.acceptByIds).toHaveBeenCalledWith(['d1']);
    expect(a.result).toMatchObject({ accepted: [{ id: 'd1', issueId: 'i9' }] });
    expect(a.summary).toBe('1 detection accepted as a draft issue');
  });

  it('rejects the waiting ones, and its undo puts them back', async () => {
    const r = await runRendererTool(
      'review_detections',
      { ids: ['d1', 'd2', 'd3', 'zz'], decision: 'reject' },
      ctx(),
    );
    expect(r.result).toMatchObject({ rejected: 2, notWaiting: ['d3'], notFound: ['zz'] });
    expect([statusOf('d1'), statusOf('d2')]).toEqual(['rejected', 'rejected']);
    expect(r.undo?.()).toBeNull();
    expect([statusOf('d1'), statusOf('d2')]).toEqual(['draft', 'draft']);
  });

  it('reopens several as one review step, so one undo takes them all back', async () => {
    const before = det.detections.getState().review.past.length;
    const r = await runRendererTool(
      'review_detections',
      { ids: ['d3', 'd4'], decision: 'reopen' },
      ctx(),
    );
    expect([statusOf('d3'), statusOf('d4')]).toEqual(['draft', 'draft']);
    expect(det.detections.getState().review.past.length).toBe(before + 1);
    expect(r.undo?.()).toBeNull();
    expect([statusOf('d3'), statusOf('d4')]).toEqual(['rejected', 'rejected']);
  });

  it('refuses the undo once a later review came in by hand, and leaves both as they are', async () => {
    const r = await runRendererTool(
      'review_detections',
      { ids: ['d3', 'd4'], decision: 'reopen' },
      ctx(),
    );
    det.dispatch({ type: 'reject', id: 'd1', by: 'x', now: '2026-10-31T12:00:00Z' });
    expect(r.undo?.()).toMatch(/reviewed again since/);
    expect([statusOf('d1'), statusOf('d3'), statusOf('d4')]).toEqual([
      'rejected',
      'draft',
      'draft',
    ]);
  });

  it('refuses in a read-only project', async () => {
    det.detections.setState({ readOnly: true } as never);
    await expect(
      runRendererTool('review_detections', { ids: ['d1'], decision: 'reject' }, ctx()),
    ).rejects.toThrow(/read-only/);
  });
});

describe('jobs, thermal and walks', () => {
  it("lists this project's jobs, the running ones on request", async () => {
    const job = (id: string, status: string, project = 'C:/p') => ({
      id,
      pipeline: 'survey.prepare',
      project,
      params: {},
      status,
      progress: 0.5,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-31T10:00:00Z',
      updatedAt: '2026-10-31T10:00:00Z',
    });
    jobs.setState({
      jobs: [job('j1', 'running'), job('j2', 'done'), job('j3', 'running', 'C:/other')],
    } as never);
    const all = await runRendererTool('list_jobs', {}, ctx());
    expect(all.result).toMatchObject({ total: 2, running: 1 });
    const active = await runRendererTool('list_jobs', { active: true }, ctx());
    expect((active.result as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toEqual(['j1']);
  });

  it('sums the thermal file: hot spots hottest first, dismissed ones left out', async () => {
    const spot = (id: string, state: string, deltaC: number) => ({
      id,
      state,
      origin: 'detection',
      sightings: [
        {
          layer: 'ph',
          photo: 'a',
          box: { type: 'box', x: 0, y: 0, w: 1, h: 1 },
          peakC: 80,
          meanC: 60,
        },
      ],
      reference: { kind: 'surroundings', valueC: 30 },
      peakC: 30 + deltaC,
      meanC: 50,
      deltaC,
      severity: 2,
      ...(state === 'confirmed' ? { issueId: 'i1' } : {}),
    });
    fetched = {
      schema: 'aio.thermal/1',
      photos: {},
      readings: [],
      hotspots: [
        spot('h1', 'proposed', 12),
        spot('h2', 'confirmed', 45),
        spot('h3', 'dismissed', 90),
      ],
    };
    const r = await runRendererTool('thermal_summary', { layer: 'ph' }, ctx());
    const out = r.result as { hotSpots: { id: string; deltaC: number }[]; layers: unknown[] };
    expect(out.layers).toHaveLength(1);
    expect(out.hotSpots.map((h) => h.id)).toEqual(['h2', 'h1']);
  });

  it('lists the walks with their date, length and placement', async () => {
    const r = await runRendererTool('list_walks', {}, ctx());
    expect(r.result).toMatchObject({
      total: 1,
      walks: [
        {
          id: 'w1',
          date: '2024-10-02',
          lengthS: 93,
          processed: false,
          placed: true,
          placement: 'good',
        },
      ],
    });
  });
});

describe('facts for the tool list', () => {
  it('says what the project has, and leaves out what the app cannot tell yet', () => {
    measureStore.setState({ projectId: 'other', status: 'loading' } as never);
    const f = agentFacts();
    expect(f.walks).toBe(true);
    expect(f.detections).toBe(true);
    expect(f.measurements).toBeUndefined();
    measureStore.setState({
      projectId: 'p',
      status: 'ready',
      file: { schema: 'aio.measurements/1', measurements: [] },
    } as never);
    expect(agentFacts()).toMatchObject({ measurements: false, volumes: false });
  });

  it('says whether the fact index is ready for the open project', () => {
    factIndex.setState({ projectId: 'p', status: { state: 'building', counts: {}, links: 0 } });
    expect(agentFacts().factIndex).toBe(false);
    factIndex.setState({ projectId: 'p', status: { state: 'ready', counts: {}, links: 0 } });
    expect(agentFacts().factIndex).toBe(true);
    factIndex.setState({ projectId: 'other', status: { state: 'ready', counts: {}, links: 0 } });
    expect(agentFacts().factIndex).toBe(false);
    factIndex.setState({ projectId: null, status: null });
  });
});

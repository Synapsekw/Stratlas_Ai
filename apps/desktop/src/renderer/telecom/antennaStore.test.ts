// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AntennasFile,
  TOWER_HINT_NEEDED,
  type AntennaKind,
  type AntennaStatus,
  type AntennaUnit,
  type JobRecord,
} from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from '../exports/exports';
import { boxCropSelection } from './antennaBoxEdit';
import { boxWithValues, userValue } from './antennaTyped';
import {
  beginBoxDrag,
  boxEditBlocked,
  cancelBoxDrag,
  commitBoxDrag,
  dragBox,
  drawnFile,
  antennaStore,
  applyAiLabels,
  beginFlag,
  cancelHint,
  deleteUnits,
  deleteBlockedReason,
  setUnitsStatus,
  visibleTickedIds,
  toggleTicked,
  endFlag,
  resetTypedValue,
  setTypedValue,
  setUnitKind,
  startFlag,
  cycleLabelMode,
  decideAntenna,
  getAiLabelPref,
  hideAllAntennas,
  setAntennaFilter,
  setAntennaSolo,
  showAllAntennas,
  stepAntenna,
  filteredUnits,
  toggleGroupHidden,
  loadAntennas,
  openAntennaReview,
  patchUnitUser,
  runDetection,
  selectAntenna,
  setAiLabelPref,
  setCloudLayer,
  setLabelMode,
  setUnitStatus,
  toggleAntennaHidden,
} from './antennaStore';

type Call = [string, Record<string, unknown>];

const h = vi.hoisted(() => ({
  disk: { file: null as AntennasFile | null, readOnly: false },
  calls: [] as Call[],
  refuseWrite: false,
  refuseDelete: null as string | null,
  starts: 0,
  delayRead: null as null | Promise<void>,
}));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  const jobs = createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] }));
  return {
    jobs,
    bridge: {
      call: vi.fn(async (channel: string, req: Record<string, unknown>) => {
        h.calls.push([channel, req]);
        if (channel === 'telecom:readAntennas') {
          const snapshot = structuredClone(h.disk);
          if (h.delayRead) await h.delayRead;
          return {
            ok: true,
            value: { ok: true, file: snapshot.file, readOnly: snapshot.readOnly },
          };
        }
        if (channel === 'telecom:writeAntennas') {
          if (h.refuseWrite) return { ok: true, value: { ok: false, error: 'Newer on disk.' } };
          h.disk.file = structuredClone(req.file) as AntennasFile;
          return { ok: true, value: { ok: true } };
        }
        if (channel === 'telecom:deleteAntennas') {
          if (h.refuseDelete) return { ok: true, value: { ok: false, error: h.refuseDelete } };
          const gone = new Set(req.ids as string[]);
          const left = need(h.disk.file);
          h.disk.file = { ...left, units: left.units.filter((u) => !gone.has(u.id)) };
          return {
            ok: true,
            value: { ok: true, deleted: [...gone], file: structuredClone(h.disk.file) },
          };
        }
        if (channel === 'ai:antennaLabelPreview')
          return {
            ok: true,
            value: {
              ok: true,
              provider: 'prov',
              model: 'm1',
              cloud: true,
              photosAllowed: true,
              crops: [],
              missing: [],
              token: 'tok',
            },
          };
        if (channel === 'jobs:start')
          return {
            ok: true,
            value: { ok: true, job: { id: `j${++h.starts}`, status: 'starting' } },
          };
        return { ok: false, error: 'unexpected' };
      }),
    },
  };
});

const shell = await import('../shell');
const jobsStore = shell.jobs as unknown as {
  setState: (s: { jobs: unknown[] }) => void;
};
// eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn, no `this`
const bridgeCall = vi.mocked(shell.bridge.call);

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };

function sampleFile(): AntennasFile {
  const f = AntennasFile.parse(structuredClone(contract.example));
  return { ...f, units: f.units.map((u) => ({ ...u, status: 'draft' as const })) };
}

const emitJob = (job: Partial<JobRecord> & { id: string; status: JobRecord['status'] }) => {
  jobsStore.setState({ jobs: [job] });
};

const state = () => antennaStore.getState();
const need = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error('missing in test');
  return v;
};
const file = (): AntennasFile => need(state().file);
const unit = (i: number) => need(file().units[i]);
const starts = () => h.calls.filter(([c]) => c === 'jobs:start');
const lastStart = () =>
  need(starts().at(-1))[1] as { params: Record<string, unknown>; project: string };
const writes = () => h.calls.filter(([c]) => c === 'telecom:writeAntennas');

function okLabels(labels: { unitId: string; label: string; reason: string }[]) {
  return {
    ok: true as const,
    provider: 'prov',
    model: 'm1',
    promptVersion: 'v1',
    labels: labels as never,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.01,
    warnings: [],
  };
}

beforeEach(() => {
  h.disk = { file: null, readOnly: false };
  h.calls = [];
  h.refuseWrite = false;
  h.refuseDelete = null;
  h.starts = 0;
  h.delayRead = null;
  bridgeCall.mockClear();
  jobsStore.setState({ jobs: [] });
  antennaStore.setState({
    projectId: null,
    root: null,
    file: null,
    readOnly: false,
    status: 'idle',
    message: null,
    jobId: null,
    running: false,
    needsHint: false,
    selected: null,
    hidden: {},
    filter: 'all',
    solo: null,
    note: null,
    cloudLayer: null,
    labelMode: 'all',
    aiPreview: null,
    aiNote: null,
    flagging: null,
    flagJob: null,
    flagStarting: false,
    ticked: {},
    flyRequest: null,
    boxEdit: null,
  });
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading', () => {
  it('loads no run yet as a ready null file', async () => {
    await loadAntennas('p1', '/p');
    expect(state()).toMatchObject({
      status: 'ready',
      file: null,
      projectId: 'p1',
      root: '/p',
      readOnly: false,
    });
    expect(h.calls[0]).toEqual(['telecom:readAntennas', { projectId: 'p1' }]);
  });

  it('reloads for the same project and drops everything on a root switch', async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    const id = unit(0).id;
    selectAntenna(id);
    toggleAntennaHidden(id);
    expect(state().file?.units.length).toBe(3);

    // a repeat call keeps the selection while the unit still exists
    await loadAntennas('p1', '/p');
    expect(state().selected).toBe(id);
    expect(state().hidden).toEqual({ [id]: true });

    // another project starts clean
    h.disk.file = null;
    await loadAntennas('p2', '/q');
    expect(state()).toMatchObject({
      projectId: 'p2',
      root: '/q',
      file: null,
      selected: null,
      hidden: {},
      status: 'ready',
    });
  });

  it('clears a first read error once a later read of the same project succeeds', async () => {
    bridgeCall.mockResolvedValueOnce({ ok: false, error: 'Disk gone.' });
    await loadAntennas('p1', '/p');
    expect(state()).toMatchObject({ status: 'error', message: 'Disk gone.', file: null });
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    expect(state()).toMatchObject({ status: 'ready', message: null });
    expect(state().file?.units.length).toBe(3);
  });

  it('forgets a selection whose unit is gone after a reload', async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    selectAntenna(unit(1).id);
    const f = sampleFile();
    f.units = f.units.slice(0, 1);
    h.disk.file = f;
    await loadAntennas('p1', '/p');
    expect(state().selected).toBeNull();
  });

  it('ignores a slow read that a newer load has overtaken', async () => {
    h.disk.file = sampleFile();
    let release!: () => void;
    h.delayRead = new Promise<void>((r) => {
      release = r;
    });
    const slow = loadAntennas('p1', '/p');
    h.delayRead = null;
    h.disk.file = null;
    await loadAntennas('p2', '/q');
    release();
    await slow;
    expect(state().projectId).toBe('p2');
    expect(state().file).toBeNull();
  });

  it('keeps a written file when a read that started before the write ends after it', async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    const id = unit(0).id;
    let release!: () => void;
    h.delayRead = new Promise<void>((r) => {
      release = r;
    });
    const slow = loadAntennas('p1', '/p'); // snapshots the draft file, then waits
    h.delayRead = null;
    await setUnitStatus(id, 'accepted');
    expect(unit(0).status).toBe('accepted');
    release();
    await slow;
    expect(unit(0).status).toBe('accepted');
    expect(need(need(h.disk.file).units[0]).status).toBe('accepted');
    expect(state().status).toBe('ready');
  });
});

describe('running', () => {
  beforeEach(async () => {
    await loadAntennas('p1', '/p');
  });

  it('starts telecom.antennas with a run id and automatic cloud', async () => {
    await runDetection();
    expect(bridgeCall).toHaveBeenCalledWith('jobs:start', {
      pipeline: 'telecom.antennas',
      project: '/p',
      params: { run: expect.stringMatching(/^run-[a-z0-9-]+$/) as unknown },
    });
    expect(state().running).toBe(true);
    expect(state().jobId).toBe('j1');
  });

  it('passes the chosen cloud layer', async () => {
    setCloudLayer('cloud-7');
    await runDetection();
    expect(lastStart().params.cloud).toEqual({ layer: 'cloud-7' });
    expect(state().cloudLayer).toBe('cloud-7');
  });

  it('ignores a second run while one is going', async () => {
    await runDetection();
    await runDetection();
    expect(starts()).toHaveLength(1);
  });

  it('reloads the file when the job finishes', async () => {
    await runDetection();
    h.disk.file = sampleFile();
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().file?.units.length).toBe(3);
    });
    expect(state().running).toBe(false);
    expect(state().jobId).toBeNull();
  });

  it('ignores a finished job that is not ours', async () => {
    await runDetection();
    emitJob({ id: 'other', status: 'done' });
    expect(state().running).toBe(true);
  });

  it('needs a hint after the job fails with the hint message, then re-runs with towerHint', async () => {
    await runDetection();
    emitJob({ id: 'j1', status: 'failed', error: TOWER_HINT_NEEDED });
    expect(state().needsHint).toBe(true);
    expect(state().running).toBe(false);
    expect(state().message).toBeNull();
    await runDetection({ towerHint: [1.5, -2] });
    expect(lastStart().params.towerHint).toEqual([1.5, -2]);
    expect(starts()).toHaveLength(2);
    expect(state().needsHint).toBe(false);
    expect(state().running).toBe(true);
  });

  it('shows any other failure as a message', async () => {
    await runDetection();
    emitJob({ id: 'j1', status: 'failed', error: 'Out of memory.' });
    expect(state()).toMatchObject({ needsHint: false, running: false, message: 'Out of memory.' });
  });

  it('lets the person cancel the hint request', async () => {
    await runDetection();
    emitJob({ id: 'j1', status: 'failed', error: TOWER_HINT_NEEDED });
    cancelHint();
    expect(state().needsHint).toBe(false);
  });

  it('frees the run when the job is cancelled', async () => {
    await runDetection();
    emitJob({ id: 'j1', status: 'cancelled' });
    expect(state().running).toBe(false);
    expect(state().jobId).toBeNull();
  });
});

describe('review', () => {
  beforeEach(async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('accepts a unit and writes the file', async () => {
    const id = unit(0).id;
    await setUnitStatus(id, 'accepted');
    expect(unit(0).status).toBe('accepted');
    expect(writes()).toHaveLength(1);
    const sent = need(writes()[0])[1] as { projectId: string; file: AntennasFile };
    expect(sent.projectId).toBe('p1');
    expect(sent.file.units.map((u) => u.status)).toEqual(['accepted', 'draft', 'draft']);
    expect(need(need(h.disk.file).units[0]).status).toBe('accepted');
  });

  it('rejects a unit', async () => {
    const id = unit(1).id;
    await setUnitStatus(id, 'rejected');
    expect(file().units.map((u) => u.status)).toEqual(['draft', 'rejected', 'draft']);
  });

  it('patches user fields without touching values', async () => {
    const before = structuredClone(unit(1));
    await patchUnitUser(before.id, { model: 'Model X', weightKg: 12.5, active: true });
    const after = unit(1);
    expect(after.user).toMatchObject({ model: 'Model X', weightKg: 12.5, active: true });
    expect({ ...after, user: null }).toEqual({ ...before, user: null });
    // a later patch merges and an undefined field is cleared
    await patchUnitUser(before.id, { model: undefined, frequencies: '1800' });
    const again = unit(1).user;
    expect(again.model).toBeUndefined();
    expect(again).toMatchObject({ weightKg: 12.5, active: true, frequencies: '1800' });
    expect(Object.keys(again)).not.toContain('model');
  });

  it('applies two quick changes one after the other without losing the first', async () => {
    await Promise.all([
      setUnitStatus(unit(0).id, 'accepted'),
      setUnitStatus(unit(1).id, 'rejected'),
    ]);
    expect(file().units.map((u) => u.status)).toEqual(['accepted', 'rejected', 'draft']);
    expect(writes()).toHaveLength(2);
  });

  it('does nothing for an unknown unit', async () => {
    await setUnitStatus('ant-missing', 'accepted');
    expect(writes()).toHaveLength(0);
  });

  it('reloads and says so when the write is refused', async () => {
    const id = unit(0).id;
    h.refuseWrite = true;
    await setUnitStatus(id, 'accepted');
    expect(state().message).toBe('Newer on disk.');
    expect(unit(0).status).toBe('draft');
    expect(h.calls.filter(([c]) => c === 'telecom:readAntennas')).toHaveLength(2);
  });

  it('writes nothing in a read-only package', async () => {
    h.disk.readOnly = true;
    await loadAntennas('p1', '/p');
    expect(state().readOnly).toBe(true);
    await setUnitStatus(unit(0).id, 'accepted');
    expect(writes()).toHaveLength(0);
    await runDetection();
    expect(starts()).toHaveLength(0);
  });

  it('selects and hides units', () => {
    const id = unit(0).id;
    selectAntenna(id);
    expect(state().selected).toBe(id);
    toggleAntennaHidden(id);
    expect(state().hidden).toEqual({ [id]: true });
    toggleAntennaHidden(id);
    expect(state().hidden).toEqual({});
    selectAntenna(null);
    expect(state().selected).toBeNull();
  });
});

describe('AI labels', () => {
  beforeEach(async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('applyAiLabels never changes a number', async () => {
    const before = structuredClone(unit(0));
    const others = structuredClone(file().units.slice(1));
    await applyAiLabels(
      okLabels([{ unitId: before.id, label: 'radio-unit', reason: 'r' }]),
      'ai-1',
      'p1',
    );
    const after = unit(0);
    expect(after.kind).toBe('other');
    expect(after.kindBasis).toBe('ai');
    expect(after.ai).toMatchObject({
      provider: 'prov',
      model: 'm1',
      promptVersion: 'v1',
      runId: 'ai-1',
      reason: 'r',
    });
    expect({ ...after, kind: before.kind, kindBasis: before.kindBasis, ai: undefined }).toEqual({
      ...before,
      ai: undefined,
    });
    // every numeric field is the same, down to box and values
    expect(after.box).toEqual(before.box);
    expect(after.azimuthGridDeg).toEqual(before.azimuthGridDeg);
    expect(after.downtiltDeg).toEqual(before.downtiltDeg);
    expect(after.widthM).toEqual(before.widthM);
    expect(after.heightM).toEqual(before.heightM);
    expect(after.depthM).toEqual(before.depthM);
    expect(after.support).toBe(before.support);
    expect(after.convergenceDeg).toBe(before.convergenceDeg);
    // units without a label are untouched
    expect(file().units.slice(1)).toEqual(others);
    expect(file().run.ai).toMatchObject({
      id: 'ai-1',
      provider: 'prov',
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(AntennasFile.safeParse(state().file).success).toBe(true);
    expect(need(need(h.disk.file).units[0]).kindBasis).toBe('ai');
  });

  it('maps each label to its kind', async () => {
    await applyAiLabels(
      okLabels([
        { unitId: unit(0).id, label: 'short-antenna', reason: 'a' },
        { unitId: unit(1).id, label: 'panel', reason: 'b' },
        { unitId: unit(2).id, label: 'dish', reason: 'c' },
      ]),
      'ai-2',
      'p1',
    );
    expect(file().units.map((u) => u.kind)).toEqual(['short', 'panel', 'dish']);
  });

  it('leaves user-set kinds alone', async () => {
    const id = unit(0).id;
    const f = structuredClone(file());
    f.units[0] = { ...need(f.units[0]), kind: 'dish', kindBasis: 'user' };
    antennaStore.setState({ file: f });
    await applyAiLabels(okLabels([{ unitId: id, label: 'radio-unit', reason: 'r' }]), 'ai-3', 'p1');
    const u = unit(0);
    expect(u.kind).toBe('dish');
    expect(u.kindBasis).toBe('user');
    expect(u.ai).toBeUndefined();
  });

  it('ignores labels for units that are not in the file, and records no usage', async () => {
    const before = structuredClone(file());
    await applyAiLabels(
      okLabels([{ unitId: 'ant-gone', label: 'dish', reason: 'r' }]),
      'ai-4',
      'p1',
    );
    expect(file()).toEqual(before);
    expect(file().run.ai).toBeUndefined();
    expect(writes()).toHaveLength(0);
  });

  it('drops labels that arrive after a switch to another project', async () => {
    const id = unit(0).id;
    h.disk.file = { ...sampleFile(), units: [] };
    await loadAntennas('p2', '/q');
    expect(state().projectId).toBe('p2');
    await applyAiLabels(okLabels([{ unitId: id, label: 'dish', reason: 'r' }]), 'ai-5', 'p1');
    expect(writes()).toHaveLength(0);
    expect(file().units).toEqual([]);
    expect(file().run.ai).toBeUndefined();
  });
});

describe('AI preference', () => {
  it('keeps the preference per project', () => {
    expect(getAiLabelPref('p1')).toBe(false);
    setAiLabelPref('p1', true);
    expect(getAiLabelPref('p1')).toBe(true);
    expect(getAiLabelPref('p2')).toBe(false);
    expect(localStorage.getItem('quadrion.telecom.aiLabel.p1')).not.toBeNull();
    setAiLabelPref('p1', false);
    expect(getAiLabelPref('p1')).toBe(false);
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getAiLabelPref('p1')).toBe(false);
    expect(() => {
      setAiLabelPref('p1', true);
    }).not.toThrow();
    expect(() => {
      setAiLabelPref('p1', false);
    }).not.toThrow();
  });
});

type Spec = [id: string, kind: AntennaKind, status: AntennaStatus];

/** A file whose units are the given ids, kinds and statuses (copies of the fixture's first). */
function fileOf(specs: Spec[], runId = 'run-a1'): AntennasFile {
  const f = sampleFile();
  const base = need(f.units[0]);
  return {
    ...f,
    run: { ...f.run, id: runId },
    units: specs.map(([id, kind, status]) => ({ ...base, id, kind, status })),
  };
}

const sel = () => state().selected;

describe('review walk', () => {
  it('group eye hides a partly hidden group, then shows it', async () => {
    h.disk.file = fileOf([
      ['p1', 'panel', 'draft'],
      ['p2', 'panel', 'draft'],
      ['d1', 'dish', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    toggleAntennaHidden('p1');
    toggleGroupHidden('panel');
    expect(state().hidden).toEqual({ p1: true, p2: true });
    toggleGroupHidden('panel');
    expect(state().hidden).toEqual({});
    toggleGroupHidden('dish');
    expect(state().hidden).toEqual({ d1: true });
  });

  it('solo and walking never write the hidden map', async () => {
    h.disk.file = fileOf([
      ['a', 'panel', 'draft'],
      ['b', 'panel', 'draft'],
      ['c', 'dish', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    toggleAntennaHidden('a');
    setAntennaSolo('panel');
    stepAntenna(1);
    stepAntenna(1);
    stepAntenna(1);
    expect(state().hidden).toEqual({ a: true });
    setAntennaSolo(null);
    expect(state().solo).toBeNull();
    expect(state().hidden).toEqual({ a: true });
  });

  it('Hide all hides every unit and Show all clears hidden and solo', async () => {
    h.disk.file = fileOf([
      ['a', 'panel', 'draft'],
      ['b', 'dish', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    hideAllAntennas();
    expect(state().hidden).toEqual({ a: true, b: true });
    setAntennaSolo('dish');
    showAllAntennas();
    expect(state().hidden).toEqual({});
    expect(state().solo).toBeNull();
  });

  it('steps inside the filter and wraps', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['acc', 'panel', 'accepted'],
      ['d2', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('draft');
    stepAntenna(1);
    expect(sel()).toBe('d1');
    stepAntenna(1);
    expect(sel()).toBe('d2');
    stepAntenna(1);
    expect(sel()).toBe('d1');
    stepAntenna(-1);
    expect(sel()).toBe('d2');
    selectAntenna(null);
    stepAntenna(-1);
    expect(sel()).toBe('d2');
  });

  it('changing the filter moves a selection that falls outside it, and clears the note', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['acc', 'panel', 'accepted'],
    ]);
    await loadAntennas('p1', '/p');
    selectAntenna('d1');
    antennaStore.setState({ note: 'x' });
    setAntennaFilter('accepted');
    expect(sel()).toBe('acc');
    expect(state().note).toBeNull();
    setAntennaFilter('rejected');
    expect(sel()).toBeNull();
  });

  it('loading selects nothing, and a filter change keeps nothing selected', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['acc', 'panel', 'accepted'],
    ]);
    await loadAntennas('p1', '/p');
    expect(sel()).toBeNull();
    setAntennaFilter('all');
    expect(sel()).toBeNull();
    setAntennaFilter('accepted');
    expect(sel()).toBeNull();
    await loadAntennas('p1', '/p');
    expect(sel()).toBeNull();
  });

  it('a filter change keeps a selection that stays inside it', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['acc', 'panel', 'accepted'],
    ]);
    await loadAntennas('p1', '/p');
    selectAntenna('acc');
    setAntennaFilter('all');
    expect(sel()).toBe('acc');
  });

  it('decide on a selection outside the filter moves to the first unit of the filter', async () => {
    h.disk.file = fileOf([
      ['acc', 'panel', 'accepted'],
      ['d1', 'panel', 'draft'],
      ['d2', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('draft');
    // a pick in 3D can select a unit the filter does not list
    selectAntenna('acc');
    await decideAntenna('rejected');
    expect(unit(0).status).toBe('rejected');
    expect(sel()).toBe('d1');
  });

  it('decide leaves a selection made while its write was going', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['d2', 'panel', 'draft'],
      ['d3', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    selectAntenna('d1');
    const going = decideAntenna('accepted');
    selectAntenna('d3');
    await going;
    expect(unit(0).status).toBe('accepted');
    expect(sel()).toBe('d3');
  });

  it('openAntennaReview reveals the first draft in the panel order', async () => {
    h.disk.file = fileOf([
      ['o1', 'other', 'draft'],
      ['acc', 'panel', 'accepted'],
      ['s1', 'short', 'draft'],
      ['p1', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    setAntennaFilter('all');
    const before = state().reveal;
    openAntennaReview();
    expect(state().filter).toBe('draft');
    expect(sel()).toBe('p1');
    expect(state().reveal).toBe(before + 1);
  });

  it('openAntennaReview without drafts only reveals the section', async () => {
    h.disk.file = fileOf([
      ['a', 'panel', 'accepted'],
      ['b', 'dish', 'rejected'],
    ]);
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('all');
    const before = state().reveal;
    openAntennaReview();
    expect(state().filter).toBe('draft');
    expect(sel()).toBeNull();
    expect(state().reveal).toBe(before + 1);
  });

  it('Accept on the active filter moves to the next, and says done after the last', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['d2', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    selectAntenna('d1');
    await decideAntenna('accepted');
    expect(file().units.map((u) => u.status)).toEqual(['accepted', 'draft']);
    expect(sel()).toBe('d2');
    await decideAntenna('accepted');
    expect(sel()).toBeNull();
    expect(state().note).toBe('Every antenna in this filter is done.');
  });

  it('keeps the selection on the All filter', async () => {
    h.disk.file = fileOf([
      ['d1', 'panel', 'draft'],
      ['d2', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    setAntennaFilter('all');
    selectAntenna('d1');
    await decideAntenna('rejected');
    expect(sel()).toBe('d1');
    expect(unit(0).status).toBe('rejected');
  });

  it('pressing the active decision again returns the unit to draft', async () => {
    h.disk.file = fileOf([
      ['a', 'panel', 'accepted'],
      ['b', 'panel', 'draft'],
    ]);
    await loadAntennas('p1', '/p');
    setAntennaFilter('accepted');
    selectAntenna('a');
    await decideAntenna('accepted');
    expect(unit(0).status).toBe('draft');
    expect(state().note).toBe('Every antenna in this filter is done.');
  });

  it('decide does nothing read-only', async () => {
    h.disk.file = fileOf([['a', 'panel', 'draft']]);
    h.disk.readOnly = true;
    await loadAntennas('p1', '/p');
    selectAntenna('a');
    await decideAntenna('accepted');
    expect(writes()).toHaveLength(0);
  });

  it('decide does nothing with nothing selected', async () => {
    h.disk.file = fileOf([['a', 'panel', 'draft']]);
    await loadAntennas('p1', '/p');
    await decideAntenna('accepted');
    expect(writes()).toHaveLength(0);
  });

  it('a new project starts on To review when it has drafts, else All', async () => {
    h.disk.file = fileOf([['a', 'panel', 'draft']]);
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('draft');
    h.disk.file = fileOf([['a', 'panel', 'accepted']]);
    await loadAntennas('p2', '/q');
    expect(state().filter).toBe('all');
  });

  it('a run finishing with drafts switches the filter to To review; a plain reload keeps it', async () => {
    h.disk.file = fileOf([['a', 'panel', 'accepted']], 'run-1');
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('all');
    setAntennaSolo('panel');
    await runDetection();
    h.disk.file = fileOf(
      [
        ['a', 'panel', 'accepted'],
        ['b', 'panel', 'draft'],
      ],
      'run-2',
    );
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().filter).toBe('draft');
    });
    expect(state().solo).toBe('panel');
    setAntennaFilter('accepted');
    await loadAntennas('p1', '/p');
    expect(state().filter).toBe('accepted');
    expect(state().solo).toBe('panel');
  });
});

describe('filteredUnits order', () => {
  it('groups by kind in the panel order, then file order', () => {
    const f = sampleFile();
    const kinds: AntennaKind[] = ['other', 'dish', 'panel', 'short', 'panel'];
    const base = need(f.units[0]);
    const units = kinds.map((kind, i) => ({ ...base, id: `k${i}`, kind }));
    const order = filteredUnits({ ...f, units }, 'all').map((u) => u.id);
    const id = (i: number) => need(units[i]).id;
    expect(order).toEqual([id(2), id(4), id(3), id(1), id(0)]);
  });
});

describe('labels mode', () => {
  it('starts on all and cycles off, selected, all', () => {
    expect(antennaStore.getInitialState().labelMode).toBe('all');
    cycleLabelMode();
    expect(state().labelMode).toBe('off');
    cycleLabelMode();
    expect(state().labelMode).toBe('selected');
    cycleLabelMode();
    expect(state().labelMode).toBe('all');
    setLabelMode('selected');
    expect(state().labelMode).toBe('selected');
  });

  it('lasts the session: a project switch keeps it and nothing is written', async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    setLabelMode('off');
    await loadAntennas('p2', '/q');
    expect(state().labelMode).toBe('off');
    expect(h.calls.filter(([c]) => c === 'telecom:writeAntennas')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- flagging

const flagSel = {
  sel: {
    shape: 'lasso' as const,
    polygon: [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ] as [number, number][],
    viewProj: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
  },
  bounds: {
    min: [0, 0, 0] as [number, number, number],
    max: [1, 1, 1] as [number, number, number],
  },
  anchor: [0.5, 0.5, 0.5] as [number, number, number],
  layer: 'cloud-7',
};

/** The sample file with one more unit: the first one as a flagged unit `id`. */
function withFlagged(id: string, extra: Partial<AntennaUnit> = {}): AntennasFile {
  const f = sampleFile();
  const base = need(f.units[0]);
  return {
    ...f,
    units: [
      ...f.units,
      { ...base, id, name: 'F1', origin: 'flagged', status: 'accepted', ...extra },
    ],
  };
}

const previews = () => h.calls.filter(([c]) => c === 'ai:antennaLabelPreview');

describe('flagging', () => {
  beforeEach(async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('beginFlag is refused while detection runs', async () => {
    await runDetection();
    beginFlag();
    expect(state().flagging).toBeNull();
    emitJob({ id: 'j1', status: 'cancelled' });
    beginFlag();
    expect(state().flagging).toEqual({ unit: null });
    endFlag();
    expect(state().flagging).toBeNull();
    beginFlag('ant-a3');
    expect(state().flagging).toEqual({ unit: 'ant-a3' });
  });

  it('beginFlag is refused read-only, with no inventory, and while a flag job runs', async () => {
    h.disk.readOnly = true;
    await loadAntennas('p1', '/p');
    beginFlag();
    expect(state().flagging).toBeNull();
    h.disk = { file: null, readOnly: false };
    await loadAntennas('p1', '/p');
    beginFlag();
    expect(state().flagging).toBeNull();
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
    beginFlag();
    await startFlag(flagSel);
    beginFlag();
    expect(state().flagging).toBeNull();
  });

  it('startFlag sends telecom.flag with the selection and ends the tool', async () => {
    beginFlag();
    await startFlag(flagSel);
    const start = need(starts()[0])[1] as {
      pipeline: string;
      project: string;
      params: { unit: string; redraw?: true; cloud: unknown; selection: unknown };
    };
    expect(start.pipeline).toBe('telecom.flag');
    expect(start.project).toBe('/p');
    expect(start.params.unit).toMatch(/^ant-f-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(start.params.redraw).toBeUndefined();
    expect(start.params.cloud).toEqual({ layer: 'cloud-7' });
    expect(start.params.selection).toEqual({
      polygon: flagSel.sel.polygon,
      viewProj: flagSel.sel.viewProj,
      bounds: flagSel.bounds,
      anchor: flagSel.anchor,
    });
    expect(state().flagging).toBeNull();
    expect(state().flagJob).toEqual({ id: 'j1', unit: start.params.unit });
  });

  it('a redraw keeps the unit id', async () => {
    beginFlag('ant-a3');
    await startFlag(flagSel);
    expect(lastStart().params).toMatchObject({ unit: 'ant-a3', redraw: true });
  });

  it('a flag job and the detection job do not end each other', async () => {
    beginFlag();
    await startFlag(flagSel);
    expect(state().flagJob?.id).toBe('j1');
    // detection is refused meanwhile; a run already going (another window) is watched apart
    antennaStore.setState({ running: true, jobId: 'j2' });
    jobsStore.setState({
      jobs: [
        { id: 'j1', status: 'running' },
        { id: 'j2', status: 'failed', error: 'Out of memory.' },
      ],
    });
    expect(state().running).toBe(false);
    expect(state().flagJob?.id).toBe('j1');
    jobsStore.setState({ jobs: [{ id: 'j1', status: 'cancelled' }] });
    expect(state().flagJob).toBeNull();
  });

  it('detection is refused while a flag job starts or runs', async () => {
    beginFlag();
    const starting = startFlag(flagSel);
    expect(state().flagStarting).toBe(true);
    await runDetection();
    expect(starts().map(([, r]) => r.pipeline)).toEqual(['telecom.flag']);
    await starting;
    expect(state().flagStarting).toBe(false);
    await runDetection();
    expect(starts()).toHaveLength(1);
    expect(state().running).toBe(false);
    emitJob({ id: 'j1', status: 'cancelled' });
    await runDetection();
    expect(lastStart()).toMatchObject({ pipeline: 'telecom.antennas' });
  });

  it('an outline closed after detection started says why it was not measured', async () => {
    beginFlag();
    antennaStore.setState({ running: true });
    await startFlag(flagSel);
    expect(starts()).toHaveLength(0);
    expect(state().flagging).toBeNull();
    expect(state().message).toBe(
      'Antenna detection started, so the outline was not measured. Draw it again when it ends.',
    );
  });

  it('a failed flag job shows its error', async () => {
    beginFlag();
    await startFlag(flagSel);
    emitJob({ id: 'j1', status: 'failed', error: 'Too few points.' });
    expect(state().flagJob).toBeNull();
    expect(state().message).toBe('Too few points.');
  });

  it('a finished flag job reloads and selects the new unit', async () => {
    beginFlag();
    await startFlag(flagSel);
    const id = need(state().flagJob).unit;
    h.disk.file = withFlagged(id);
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().selected).toBe(id);
    });
    expect(state().file?.units.some((u) => u.id === id)).toBe(true);
    expect(state().flagJob).toBeNull();
    expect(previews()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('a finished flag job keeps a message on screen', async () => {
    beginFlag();
    await startFlag(flagSel);
    const id = need(state().flagJob).unit;
    antennaStore.setState({ message: 'The antenna file changed on disk. It was loaded again.' });
    h.disk.file = withFlagged(id);
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().selected).toBe(id);
    });
    expect(state().message).toBe('The antenna file changed on disk. It was loaded again.');
  });

  it('a finished flag job shows every unit when the filter would hide the new one', async () => {
    expect(state().filter).toBe('draft');
    beginFlag();
    await startFlag(flagSel);
    const id = need(state().flagJob).unit;
    h.disk.file = withFlagged(id);
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().selected).toBe(id);
    });
    expect(state().filter).toBe('all');
  });

  it('a finished flag job keeps a filter that lists the new unit', async () => {
    setAntennaFilter('accepted');
    beginFlag();
    await startFlag(flagSel);
    const id = need(state().flagJob).unit;
    h.disk.file = withFlagged(id);
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().selected).toBe(id);
    });
    expect(state().filter).toBe('accepted');
  });

  it('a finished flag job offers AI labels for that unit only when the preference is on', async () => {
    setAiLabelPref('p1', true);
    beginFlag();
    await startFlag(flagSel);
    const id = need(state().flagJob).unit;
    h.disk.file = withFlagged(id, { kind: 'other', kindBasis: 'geometry' });
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(state().aiPreview).not.toBeNull();
    });
    expect(previews()).toHaveLength(1);
    expect(need(previews()[0])[1]).toEqual({ projectId: 'p1', unitIds: [id] });
    expect(state().aiPreview?.unitIds).toEqual([id]);
  });

  it('a finished redraw rebuilds the box from the typed values it kept', async () => {
    beginFlag('ant-a3');
    await startFlag(flagSel);
    const f = sampleFile();
    const u = need(f.units[0]);
    // the job measured a new box; the typed azimuth still wins
    f.units[0] = {
      ...u,
      origin: 'flagged',
      azimuthGridDeg: userValue(200),
      box: { ...u.box, centre: [11, 21, 32] },
    };
    h.disk.file = f;
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    const expected = boxWithValues(need(f.units[0]));
    await vi.waitFor(() => {
      expect(unit(0).box).toEqual(expected);
    });
    expect(need(need(h.disk.file).units[0]).box).toEqual(expected);
    expect(state().selected).toBe('ant-a3');
  });
});

describe('box handles', () => {
  const top = { axis: 1, sign: 1 } as const;
  const crop = boxCropSelection(
    [0, 30, 0],
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ],
    [0.3, 2.6, 0.15],
  );
  const lastToast = () => need(toasts.getState().toasts.at(-1));

  beforeEach(async () => {
    toasts.setState({ toasts: [] });
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('a drag moves one face of the drawn box and leaves the file alone', () => {
    const before = unit(0);
    expect(beginBoxDrag(before.id, top)).toBe(true);
    dragBox(2.6);
    const e = need(state().boxEdit);
    expect(e.box.extents[1]).toBe(2.6);
    expect(file().units[0]).toBe(before);
    const drawn = need(drawnFile(state().file, e));
    expect(need(drawn.units[0]).box).toBe(e.box);
    expect(writes()).toHaveLength(0);
  });

  it('Escape (cancel) and a release that moved nothing start no job', async () => {
    beginBoxDrag(unit(0).id, top);
    dragBox(2.6);
    cancelBoxDrag();
    expect(state().boxEdit).toBeNull();
    beginBoxDrag(unit(0).id, top);
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    expect(state().boxEdit).toBeNull();
    expect(starts()).toHaveLength(0);
  });

  it('is refused read-only, while detection runs, while flagging, and on a dish', async () => {
    h.disk.readOnly = true;
    await loadAntennas('p1', '/p');
    expect(beginBoxDrag(unit(0).id, top)).toBe(false);
    h.disk.readOnly = false;
    await loadAntennas('p1', '/p');
    await runDetection();
    expect(beginBoxDrag(unit(0).id, top)).toBe(false);
    emitJob({ id: 'j1', status: 'cancelled' });
    beginFlag();
    expect(boxEditBlocked(unit(0).id)).not.toBe(false);
    endFlag();
    expect(boxEditBlocked(unit(0).id)).toBe(false);
    const dish = file().units.find((u) => u.kind === 'dish');
    if (dish) expect(boxEditBlocked(dish.id)).not.toBe(false);
    antennaStore.setState({
      file: {
        ...file(),
        units: file().units.map((u, i) => (i === 0 ? { ...u, kind: 'dish' as const } : u)),
      },
    });
    expect(boxEditBlocked(unit(0).id)).not.toBe(false);
    expect(beginBoxDrag(unit(0).id, top)).toBe(false);
  });

  it('a release starts a telecom.flag redraw with the box crop and says so', async () => {
    const id = unit(0).id;
    beginBoxDrag(id, top);
    dragBox(2.6);
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    expect(lastStart()).toMatchObject({
      project: '/p',
      params: { unit: id, redraw: true, cloud: { layer: 'cloud-1' }, selection: crop },
    });
    expect(state().boxEdit?.phase).toBe('measure');
    expect(state().flagJob?.unit).toBe(id);
    expect(boxEditBlocked(id)).not.toBe(false);
    expect(lastToast().state).toBe('running');
  });

  it('with no cloud layer the box goes back and no job starts', async () => {
    beginBoxDrag(unit(0).id, top);
    dragBox(2.6);
    await commitBoxDrag({ layer: null, selection: crop });
    expect(state().boxEdit).toBeNull();
    expect(starts()).toHaveLength(0);
  });

  it('a re-measure that gives the size back smaller keeps the dragged size as typed', async () => {
    const before = unit(0);
    beginBoxDrag(before.id, top);
    dragBox(2.6);
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    const f = sampleFile();
    const u = need(f.units[0]);
    f.units[0] = {
      ...u,
      origin: 'flagged',
      heightM: { value: 1.9, basis: 'measured', quality: { basis: 'measured' } },
      box: { ...u.box, extents: [u.box.extents[0], 1.9, u.box.extents[2]] },
    };
    h.disk.file = f;
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(unit(0).heightM).toEqual(userValue(2.6));
    });
    expect(unit(0).measured?.heightM?.value).toBe(1.9);
    expect(unit(0).origin).toBe('flagged');
    expect(state().boxEdit).toBeNull();
    expect(lastToast().state).toBe('done');
    expect(lastToast().message).toContain('2.60 m is kept');
  });

  it('a re-measure that gives the dragged size stands as measured, no extra write', async () => {
    const before = unit(0);
    beginBoxDrag(before.id, top);
    dragBox(2.6);
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    const f = sampleFile();
    const u = need(f.units[0]);
    f.units[0] = {
      ...u,
      origin: 'flagged',
      heightM: { value: 2.61, basis: 'measured', quality: { basis: 'measured' } },
    };
    h.disk.file = f;
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(lastToast().state).toBe('done');
    });
    expect(writes()).toHaveLength(0);
    expect(unit(0).heightM?.value).toBe(2.61);
    expect(state().boxEdit).toBeNull();
  });

  it('too few points keeps the dragged box and the earlier angles, and says so', async () => {
    const before = unit(0);
    beginBoxDrag(before.id, top);
    dragBox(2.6);
    const dragged = need(state().boxEdit).box;
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    const f = sampleFile();
    const u = { ...need(f.units[0]), origin: 'flagged' as const };
    delete u.azimuthGridDeg;
    delete u.downtiltDeg;
    delete u.plumbDeg;
    delete u.widthM;
    delete u.heightM;
    delete u.depthM;
    f.units[0] = {
      ...u,
      box: { centre: [0, 0, 0], axes: before.box.axes, extents: [0.2, 0.2, 0.2] },
    };
    h.disk.file = f;
    emitJob({ id: 'j1', status: 'done' });
    await vi.waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(unit(0).box).toEqual(dragged);
    });
    expect(unit(0).azimuthGridDeg).toEqual(before.azimuthGridDeg);
    expect(lastToast().message).toContain('Too few points');
  });

  it('a failed job puts the box back and the toast says why', async () => {
    beginBoxDrag(unit(0).id, top);
    dragBox(2.6);
    await commitBoxDrag({ layer: 'cloud-1', selection: crop });
    emitJob({ id: 'j1', status: 'failed', error: 'No points.' });
    expect(state().boxEdit).toBeNull();
    expect(state().flagJob).toBeNull();
    expect(lastToast()).toMatchObject({ state: 'error', message: 'No points.' });
    expect(writes()).toHaveLength(0);
  });
});

describe('typed values and kinds', () => {
  beforeEach(async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('setTypedValue writes a user value and moves the box', async () => {
    const before = structuredClone(unit(0));
    await setTypedValue(before.id, 'azimuthGridDeg', 90);
    const after = unit(0);
    expect(after.azimuthGridDeg).toEqual(userValue(90));
    expect(after.measured?.azimuthGridDeg).toEqual(before.azimuthGridDeg);
    expect(after.box).not.toEqual(before.box);
    // outward normal now points grid east (downtilt 4 degrees kept)
    expect(after.box.axes[2][0]).toBeCloseTo(Math.cos((4 * Math.PI) / 180));
    expect(writes()).toHaveLength(1);
    expect(AntennasFile.safeParse(state().file).success).toBe(true);
  });

  it('resetTypedValue brings back the measured value', async () => {
    const before = structuredClone(unit(0));
    await setTypedValue(before.id, 'widthM', 0.5);
    expect(unit(0).box.extents[0]).toBe(0.5);
    await resetTypedValue(before.id, 'widthM');
    expect(unit(0).widthM).toEqual(before.widthM);
    expect(unit(0).box.extents[0]).toBe(0.3);
    expect(unit(0).measured).toBeUndefined();
    expect(writes()).toHaveLength(2);
    // nothing to go back to: nothing written
    await resetTypedValue(before.id, 'widthM');
    expect(writes()).toHaveLength(2);
  });

  it("setUnitKind marks the kind as the person's", async () => {
    const id = unit(0).id;
    await applyAiLabels(okLabels([{ unitId: id, label: 'dish', reason: 'r' }]), 'ai-1', 'p1');
    expect(unit(0).ai).toBeDefined();
    await setUnitKind(id, 'other');
    expect(unit(0).kind).toBe('other');
    expect(unit(0).kindBasis).toBe('user');
    expect(Object.keys(unit(0))).not.toContain('ai');
  });

  it('deletes detected and flagged units through one IPC call', async () => {
    h.disk.file = withFlagged('ant-f-x');
    await loadAntennas('p1', '/p');
    const ids = [unit(0).id, 'ant-f-x'];
    expect(await deleteUnits(ids)).toEqual({ ok: true });
    const calls = h.calls.filter(([c]) => c === 'telecom:deleteAntennas');
    expect(calls).toEqual([['telecom:deleteAntennas', { projectId: 'p1', ids }]]);
    expect(file().units.map((u) => u.id)).toEqual([unit(0).id, unit(1).id]);
    expect(writes()).toHaveLength(0);
  });

  it('drops deleted ids from selected, hidden and ticked', async () => {
    h.disk.file = withFlagged('ant-f-x');
    await loadAntennas('p1', '/p');
    selectAntenna('ant-f-x');
    toggleAntennaHidden('ant-f-x');
    toggleAntennaHidden(unit(0).id);
    toggleTicked('ant-f-x');
    toggleTicked(unit(1).id);
    await deleteUnits(['ant-f-x']);
    expect(state().selected).toBeNull();
    expect(state().hidden).toEqual({ [unit(0).id]: true });
    expect(state().ticked).toEqual({ [unit(1).id]: true });
  });

  it('runs after a pending review write', async () => {
    await loadAntennas('p1', '/p');
    const id = unit(0).id;
    void setUnitStatus(id, 'accepted');
    await deleteUnits([unit(1).id]);
    const order = h.calls
      .map(([c]) => c)
      .filter((c) => c === 'telecom:writeAntennas' || c === 'telecom:deleteAntennas');
    expect(order).toEqual(['telecom:writeAntennas', 'telecom:deleteAntennas']);
  });

  it('keeps the file and reports the error on a refusal', async () => {
    await loadAntennas('p1', '/p');
    selectAntenna(unit(0).id);
    h.refuseDelete = 'Newer on disk.';
    expect(await deleteUnits([unit(0).id])).toEqual({ ok: false, error: 'Newer on disk.' });
    expect(file().units).toHaveLength(3);
    expect(state().selected).toBe(unit(0).id);
  });

  it('does nothing read-only', async () => {
    h.disk.readOnly = true;
    await loadAntennas('p1', '/p');
    const r = await deleteUnits([unit(0).id]);
    expect(r.ok).toBe(false);
    expect(h.calls.some(([c]) => c === 'telecom:deleteAntennas')).toBe(false);
    expect(file().units).toHaveLength(3);
  });
});

describe('antenna bulk helpers', () => {
  beforeEach(async () => {
    h.disk.file = sampleFile();
    await loadAntennas('p1', '/p');
  });

  it('setUnitsStatus changes several units in one write', async () => {
    const ids = [unit(0).id, unit(1).id];
    await setUnitsStatus(ids, 'accepted');
    expect(writes()).toHaveLength(1);
    expect(
      file()
        .units.filter((u) => u.status === 'accepted')
        .map((u) => u.id),
    ).toEqual(ids);
    expect(unit(2).status).toBe('draft');
  });

  it('setUnitsStatus writes nothing for ids that are not in the file', async () => {
    await setUnitsStatus(['nope'], 'accepted');
    expect(writes()).toHaveLength(0);
  });

  it('visibleTickedIds counts only the ticked rows the filter shows', () => {
    const [a, b] = [unit(0).id, unit(1).id];
    antennaStore.setState({
      file: {
        ...file(),
        units: file().units.map((u) => (u.id === b ? { ...u, status: 'accepted' as const } : u)),
      },
      filter: 'all',
      ticked: { [a]: true, [b]: true, gone: true },
    });
    expect(visibleTickedIds(state()).sort()).toEqual([a, b].sort());
    setAntennaFilter('draft');
    expect(visibleTickedIds(state())).toEqual([a]);
  });

  it('deleteBlockedReason names a read-only file, a detection and a flag job', () => {
    expect(deleteBlockedReason()).toBe(false);
    expect(deleteBlockedReason({ ...state(), readOnly: true })).toBeTruthy();
    expect(deleteBlockedReason({ ...state(), running: true })).toBe(
      'Antenna detection is already running.',
    );
    expect(deleteBlockedReason({ ...state(), flagStarting: true })).toBeTruthy();
    expect(deleteBlockedReason({ ...state(), flagJob: { id: 'j', unit: 'u' } })).toBeTruthy();
  });

  it('deleteUnits reloads the inventory after a refusal', async () => {
    h.refuseDelete = 'Newer on disk.';
    const reads = () => h.calls.filter(([c]) => c === 'telecom:readAntennas').length;
    const before = reads();
    expect(await deleteUnits([unit(0).id])).toEqual({ ok: false, error: 'Newer on disk.' });
    expect(reads()).toBe(before + 1);
  });

  it('a refusal with no text still says something', async () => {
    h.refuseDelete = ' ';
    const r = await deleteUnits([unit(0).id]);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.length).toBeGreaterThan(5);
  });
});

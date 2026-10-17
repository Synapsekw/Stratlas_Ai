// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile, TOWER_HINT_NEEDED, type JobRecord } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  antennaStore,
  applyAiLabels,
  cancelHint,
  getAiLabelPref,
  loadAntennas,
  patchUnitUser,
  runDetection,
  selectAntenna,
  setAiLabelPref,
  setCloudLayer,
  setUnitStatus,
  toggleAntennaHidden,
} from './antennaStore';

type Call = [string, Record<string, unknown>];

const h = vi.hoisted(() => ({
  disk: { file: null as AntennasFile | null, readOnly: false },
  calls: [] as Call[],
  refuseWrite: false,
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
    cloudLayer: null,
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

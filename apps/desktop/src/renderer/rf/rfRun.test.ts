// @vitest-environment jsdom
import type { AntennasFile, JobRecord, RfSectorsFile } from '@aio/schema';
import { RF_COVERAGE_MIN_PACK } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchStore } from '../workspace/workbench/workbenchStore';
import { personToolLive } from '../workspace/workbench/tabsModel';
import { createAgentPaneStore, startAgentPaneFollow } from '../agent/agentPaneStore';
import {
  antennasFile,
  lteSettings,
  sectorsFile,
  unit,
  ANTENNA_ENTRY,
  RADIO_ENTRY,
} from './__fixtures__/rfData';
import { loadRf, patchStudy, resetRf, rfStore, setPackStatus } from './rfStore';
import { openCoverage, openRfTab, startRfRun } from './rfTab';

type Call = [string, Record<string, unknown>];

const h = vi.hoisted(() => ({
  antennas: null as AntennasFile | null,
  sectors: null as RfSectorsFile | null,
  calls: [] as Call[],
  startError: null as string | null,
  runs: [] as unknown[],
}));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  const jobs = createStore<{ jobs: JobRecord[] }>(() => ({ jobs: [] }));
  return {
    jobs,
    bridge: {
      call: vi.fn((channel: string, req: Record<string, unknown>) => {
        h.calls.push([channel, req]);
        const ok = (value: unknown) => Promise.resolve({ ok: true, value });
        switch (channel) {
          case 'telecom:readAntennas':
            return ok({ ok: true, file: structuredClone(h.antennas), readOnly: false });
          case 'rf:readSectors':
            return ok({ ok: true, file: structuredClone(h.sectors), readOnly: false, orphans: [] });
          case 'rf:listCatalogue':
            return ok({
              ok: true,
              entries: [ANTENNA_ENTRY, RADIO_ENTRY].map((entry) => ({ origin: 'builtin', entry })),
              warnings: [],
            });
          case 'rf:listRuns':
            return ok({ ok: true, runs: h.runs });
          case 'rf:writeSectors':
            h.sectors = structuredClone(req.file) as RfSectorsFile;
            return ok({ ok: true });
          case 'jobs:start':
            if (h.startError) return ok({ ok: false, error: h.startError });
            return ok({ ok: true, job: job('running', req.params as Record<string, unknown>) });
          default:
            return Promise.resolve({ ok: false, error: 'unexpected' });
        }
      }),
    },
  };
});

function job(
  status: JobRecord['status'],
  params: Record<string, unknown> = {},
  error?: string,
): JobRecord {
  return {
    id: 'job-1',
    pipeline: 'rf.coverage',
    project: '/p3',
    params,
    status,
    progress: 0,
    steps: [],
    artifacts: [],
    createdAt: '2026-10-17T10:00:00Z',
    updatedAt: '2026-10-17T10:00:01Z',
    ...(error ? { error } : {}),
  };
}

const shell = await import('../shell');
const jobsStore = shell.jobs as unknown as {
  setState: (s: { jobs: JobRecord[] }) => void;
};

beforeEach(async () => {
  resetRf();
  h.calls = [];
  h.startError = null;
  h.runs = [];
  h.antennas = antennasFile([unit('ant-a1', 10)]);
  h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-a1'] }], [lteSettings('ant-a1')]);
  setPackStatus({ state: 'ok', version: RF_COVERAGE_MIN_PACK });
  await loadRf('p3');
});
afterEach(() => {
  jobsStore.setState({ jobs: [] });
});

describe('startRfRun', () => {
  it('saves pending edits, starts rf.coverage, keeps the RF tab open and not live', async () => {
    const bench = createWorkbenchStore(null);
    openRfTab(undefined, bench);
    patchStudy({ radiusM: 2000 });
    const r = await startRfRun('/p3', bench);
    expect(r.ok).toBe(true);
    const order = h.calls
      .map(([c]) => c)
      .filter((c) => c === 'rf:writeSectors' || c === 'jobs:start');
    expect(order).toEqual(['rf:writeSectors', 'jobs:start']);
    expect(h.sectors?.study.radiusM).toBe(2000);
    // a run is an activity (review I2): the tab is open in front, but not a live tool
    expect(bench.getState().front).toBe('rf');
    expect(bench.getState().tabs.find((t) => t.id === 'rf')?.live).toBeFalsy();
    // pinned (spec F1): the next panel opened does not replace it
    expect(bench.getState().tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
    expect(rfStore.getState().check.refusals).toContain('running');
    jobsStore.setState({ jobs: [job('done')] });
    expect(rfStore.getState().running).toBe(false);
    expect(bench.getState().tabs.find((t) => t.id === 'rf')).toBeDefined();
    await Promise.resolve();
    expect(h.calls.some(([c]) => c === 'rf:listRuns')).toBe(true);
  });

  it('opens the RF tab when a run starts from elsewhere', async () => {
    const bench = createWorkbenchStore(null);
    await startRfRun('/p3', bench);
    expect(bench.getState().front).toBe('rf');
    expect(bench.getState().tabs.filter((t) => t.id === 'rf')).toHaveLength(1);
    expect(bench.getState().tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
  });

  it('openCoverage opens the tab pinned, and another panel does not replace it', () => {
    const bench = createWorkbenchStore(null);
    openCoverage(bench);
    expect(bench.getState().front).toBe('rf');
    bench.getState().open('measure');
    expect(bench.getState().tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
  });

  it('while a run is in progress the drawer stays closed and the agent pane is not minimised', async () => {
    const bench = createWorkbenchStore(null);
    const pane = createAgentPaneStore(false);
    const stop = startAgentPaneFollow(pane, bench);
    const seq = bench.getState().toolSeq;
    await startRfRun('/p3', bench);
    expect(rfStore.getState().running).toBe(true);
    // the drawer opens only on a toolSeq move (Drawer.tsx); no tool went live
    expect(bench.getState().toolSeq).toBe(seq);
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    expect(pane.getState().mode).toBe('normal');
    jobsStore.setState({ jobs: [job('done')] });
    expect(pane.getState().mode).toBe('normal');
    stop();
  });

  it('keeps the job error when the job fails, and main refusals too', async () => {
    const bench = createWorkbenchStore(null);
    await startRfRun('/p3', bench);
    jobsStore.setState({ jobs: [job('failed', {}, 'No eligible antenna')] });
    expect(rfStore.getState().runError).toBe('No eligible antenna');
    h.startError = 'Processing tools too old';
    const r = await startRfRun('/p3', bench);
    expect(r).toEqual({ ok: false, code: 'failed', message: 'Processing tools too old' });
    expect(rfStore.getState().running).toBe(false);
    expect(personToolLive(bench.getState().tabs)).toBe(false);
  });

  it('does not start while the store refuses (pack unknown)', async () => {
    setPackStatus(null);
    const r = await startRfRun('/p3', createWorkbenchStore(null));
    expect(r).toEqual({ ok: false, code: 'refused' });
    expect(h.calls.some(([c]) => c === 'jobs:start')).toBe(false);
  });
});

describe('openRfTab', () => {
  it('opens the RF tab in front, or shows it when it is there', () => {
    const bench = createWorkbenchStore(null);
    openRfTab('ant-a1', bench);
    expect(bench.getState().front).toBe('rf');
    expect(rfStore.getState().focusUnitId).toBe('ant-a1');
    bench.getState().show('selection');
    openRfTab(undefined, bench);
    expect(bench.getState().front).toBe('rf');
    expect(bench.getState().tabs.filter((t) => t.id === 'rf')).toHaveLength(1);
  });
});

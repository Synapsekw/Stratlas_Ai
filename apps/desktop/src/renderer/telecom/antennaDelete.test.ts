// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the mock disk is set before use */
import type { AntennasFile, RfSectorsFile } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { antennasFile, lteSettings, sectorsFile, unit } from '../rf/__fixtures__/rfData';
import { rfStore } from '../rf/rfStore';
import {
  antennaDeleteStore,
  askDeleteAntennas,
  cancelDeleteAntennas,
  confirmDeleteAntennas,
  sectorsHolding,
} from './antennaDelete';
import { antennaStore } from './antennaStore';

type Call = [string, Record<string, unknown>];
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  fail: null as string | null,
  file: null as AntennasFile | null,
}));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string, req: Record<string, unknown>) => {
        h.calls.push([channel, req]);
        if (channel === 'telecom:deleteAntennas') {
          if (h.fail) return Promise.resolve({ ok: true, value: { ok: false, error: h.fail } });
          const gone = new Set(req.ids as string[]);
          const left = h.file!;
          const file = { ...left, units: left.units.filter((u) => !gone.has(u.id)) };
          return Promise.resolve({ ok: true, value: { ok: true, deleted: [...gone], file } });
        }
        if (channel === 'rf:writeSectors')
          return Promise.resolve({ ok: true, value: { ok: true } });
        return Promise.resolve({ ok: false, error: 'unexpected' });
      }),
    },
  };
});

const names = ['P1', 'P2', 'P3'];
function setUp(opts: { dirty?: boolean; plan?: boolean } = {}) {
  const units = ['ant-a', 'ant-b', 'ant-c'].map((id, i) => ({
    ...unit(id, i * 120),
    name: names[i] ?? id,
  }));
  const file = antennasFile(units, 100);
  h.file = file;
  antennaStore.setState({ projectId: 'p1', root: '/p', file, readOnly: false, selected: null });
  const sectors: RfSectorsFile = sectorsFile(
    [
      { id: 'sec-s1', antennaIds: ['ant-a'] },
      { id: 'sec-s2', antennaIds: ['ant-b'] },
    ],
    units.slice(0, 2).map((u) => lteSettings(u.id)),
  );
  rfStore.setState({
    projectId: 'p1',
    hasFile: opts.plan !== false,
    readOnly: false,
    dirty: opts.dirty ?? false,
    sectors,
  });
}

beforeEach(() => {
  h.calls = [];
  h.fail = null;
  antennaDeleteStore.setState({ ask: null, busy: false });
});

describe('antennaDelete', () => {
  it('asks once, naming one unit', () => {
    setUp();
    askDeleteAntennas(['ant-c']);
    const { ask } = antennaDeleteStore.getState();
    expect(ask).toMatchObject({ ids: ['ant-c'], names: ['P3'], sectors: [], planUnsaved: false });
    expect(h.calls).toEqual([]);
  });

  it('names the sector holding a unit', () => {
    setUp();
    askDeleteAntennas(['ant-b', 'ant-c']);
    const ask = antennaDeleteStore.getState().ask;
    expect(ask?.sectors).toHaveLength(1);
    expect(ask?.sectors[0]).toMatchObject({ unitId: 'ant-b', unitName: 'P2' });
    expect(ask?.sectors[0]?.sector).toBeTruthy();
    expect(sectorsHolding(['ant-c'])).toEqual([]);
  });

  it('holds no sector when the plan has no file', () => {
    setUp({ plan: false });
    expect(sectorsHolding(['ant-a'])).toEqual([]);
  });

  it('flags planUnsaved when the RF copy is dirty', () => {
    setUp({ dirty: true });
    askDeleteAntennas(['ant-a']);
    expect(antennaDeleteStore.getState().ask?.planUnsaved).toBe(true);
  });

  it('confirm deletes then removes from the plan', async () => {
    setUp();
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(h.calls.map(([c]) => c)).toEqual(['telecom:deleteAntennas', 'rf:writeSectors']);
    expect(antennaDeleteStore.getState()).toEqual({ ask: null, busy: false });
    expect(antennaStore.getState().file?.units.map((u) => u.id)).toEqual(['ant-b', 'ant-c']);
    expect(rfStore.getState().sectors.antennas.map((a) => a.antennaId)).toEqual(['ant-b']);
  });

  it('a refusal shows the failure and leaves the plan', async () => {
    setUp();
    h.fail = 'Newer on disk.';
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(antennaStore.getState().message).toContain('Newer on disk.');
    expect(h.calls.map(([c]) => c)).toEqual(['telecom:deleteAntennas']);
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('cancel changes nothing', () => {
    setUp();
    askDeleteAntennas(['ant-a']);
    cancelDeleteAntennas();
    expect(antennaDeleteStore.getState().ask).toBeNull();
    expect(h.calls).toEqual([]);
    expect(antennaStore.getState().file?.units).toHaveLength(3);
  });
});

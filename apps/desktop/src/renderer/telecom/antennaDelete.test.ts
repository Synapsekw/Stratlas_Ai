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
  dismissUndoDeleteAntennas,
  sectorsHolding,
  undoDeleteAntennas,
  antennaUndoStore,
} from './antennaDelete';
import { antennaStore } from './antennaStore';

type Call = [string, Record<string, unknown>];
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  fail: null as string | null,
  writeFail: null as string | null,
  file: null as AntennasFile | null,
  sectorsOnDisk: null as RfSectorsFile | null,
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
          h.file = file;
          return Promise.resolve({ ok: true, value: { ok: true, deleted: [...gone], file } });
        }
        if (channel === 'telecom:writeAntennas') {
          if (h.writeFail)
            return Promise.resolve({ ok: true, value: { ok: false, error: h.writeFail } });
          h.file = req.file as AntennasFile;
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
        if (channel === 'telecom:readAntennas')
          return Promise.resolve({ ok: true, value: { ok: true, file: h.file, readOnly: false } });
        if (channel === 'rf:writeSectors') {
          h.sectorsOnDisk = req.file as RfSectorsFile;
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
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
    // the plan as saved: the same plan (with unsaved edits, they are not in the units' places)
    saved: opts.plan === false ? null : sectors,
  });
}

beforeEach(() => {
  h.calls = [];
  h.fail = null;
  h.writeFail = null;
  antennaDeleteStore.setState({ ask: null, busy: false });
  antennaUndoStore.setState({ undo: [] });
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
    // a refusal reads the inventory again, as an ordinary edit does
    expect(h.calls.map(([c]) => c)).toEqual(['telecom:deleteAntennas', 'telecom:readAntennas']);
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

describe('antennaDelete while a job runs', () => {
  it.each([
    ['a detection', { running: true }],
    ['a flag start', { flagStarting: true }],
    ['a flag job', { flagJob: { id: 'j1', unit: 'ant-a' } }],
  ])('refuses to ask during %s', (_name, busy) => {
    setUp();
    antennaStore.setState(busy);
    askDeleteAntennas(['ant-a']);
    expect(antennaDeleteStore.getState().ask).toBeNull();
    antennaStore.setState({ running: false, flagStarting: false, flagJob: null });
    askDeleteAntennas(['ant-a']);
    expect(antennaDeleteStore.getState().ask).not.toBeNull();
  });

  it('shows main text as it is, once', async () => {
    setUp();
    h.fail = 'The antennas were not deleted: the file is newer.';
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(antennaStore.getState().message).toBe(
      'The antennas were not deleted: the file is newer.',
    );
  });

  it('shows a fallback sentence when main gave no text', async () => {
    setUp();
    h.fail = ' ';
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(antennaStore.getState().message).toMatch(/^The antennas were not deleted: .+/);
  });

  it('says nothing when the project changed under the question', async () => {
    setUp();
    antennaStore.setState({ message: null });
    askDeleteAntennas(['ant-a']);
    antennaStore.setState({ file: null });
    await confirmDeleteAntennas();
    expect(antennaStore.getState().message).toBeNull();
  });
});

describe('undo of a delete (item 27)', () => {
  const ids = () => antennaStore.getState().file?.units.map((u) => u.id);
  const plan = () => rfStore.getState().sectors;
  const holder = (id: string) => plan().sectors.find((x) => x.antennaIds.includes(id))?.id;

  it('offers the delete for undo, and Undo puts the units back into the current file and their sector', async () => {
    setUp();
    const before = structuredClone(plan());
    askDeleteAntennas(['ant-a', 'ant-c']);
    await confirmDeleteAntennas();
    expect(ids()).toEqual(['ant-b']);
    expect(plan().antennas.map((x) => x.antennaId)).toEqual(['ant-b']);
    // ant-a was alone in sec-s1: the sector went with it
    expect(plan().sectors.map((x) => x.id)).toEqual(['sec-s2']);
    expect(antennaUndoStore.getState().undo).toHaveLength(1);
    h.calls = [];
    await undoDeleteAntennas();
    // one normal save of the inventory (main then brings back the crops and the deletion record),
    // then the saved plan with the unit back in its sector
    expect(h.calls.map(([c]) => c)).toEqual(['telecom:writeAntennas', 'rf:writeSectors']);
    expect(ids()).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(h.file?.units.map((u) => u.id)).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(holder('ant-a')).toBe('sec-s1');
    expect(plan().sectors.find((x) => x.id === 'sec-s1')?.name).toBeTruthy();
    // its RF settings come back whole, in the plan on disk too
    for (const id of ['ant-a', 'ant-b'])
      expect(plan().antennas.find((x) => x.antennaId === id)).toEqual(
        before.antennas.find((x) => x.antennaId === id),
      );
    expect(h.sectorsOnDisk?.antennas.map((x) => x.antennaId).sort()).toEqual(['ant-a', 'ant-b']);
    expect(rfStore.getState().dirty).toBe(false);
    expect(antennaUndoStore.getState().undo).toEqual([]);
  });

  it('puts a unit back into a sector that still holds others', async () => {
    setUp();
    const both = {
      ...plan(),
      sectors: [{ id: 'sec-s1', name: 'S1', antennaIds: ['ant-a', 'ant-b'] }],
    };
    rfStore.setState({ sectors: both, saved: both });
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(plan().sectors[0]?.antennaIds).toEqual(['ant-b']);
    await undoDeleteAntennas();
    expect(plan().sectors[0]?.antennaIds.slice().sort()).toEqual(['ant-a', 'ant-b']);
  });

  it('with unsaved Coverage edits, the sector membership comes back into the copy only', async () => {
    setUp({ dirty: true });
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    h.calls = [];
    await undoDeleteAntennas();
    expect(h.calls.map(([c]) => c)).toEqual(['telecom:writeAntennas']);
    expect(holder('ant-a')).toBe('sec-s1');
    expect(rfStore.getState().dirty).toBe(true);
    expect(plan().antennas.some((x) => x.antennaId === 'ant-a')).toBe(true);
  });

  it('a refused delete offers no undo, and Dismiss lets go of it', async () => {
    setUp();
    h.fail = 'Newer on disk.';
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(antennaUndoStore.getState().undo).toEqual([]);
    h.fail = null;
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    expect(antennaUndoStore.getState().undo).toHaveLength(1);
    dismissUndoDeleteAntennas();
    expect(antennaUndoStore.getState().undo).toEqual([]);
  });

  it('a refused Undo keeps the delete for undo and says why in the group; the next Undo brings the unit back', async () => {
    setUp();
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    h.writeFail = 'The antenna file is read-only.';
    await undoDeleteAntennas();
    expect(ids()).toEqual(['ant-b', 'ant-c']);
    expect(antennaStore.getState().message).toBe('The antenna file is read-only.');
    expect(antennaUndoStore.getState().undo).toHaveLength(1);
    h.writeFail = null;
    await undoDeleteAntennas();
    expect(ids()).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(holder('ant-a')).toBe('sec-s1');
    expect(antennaUndoStore.getState().undo).toEqual([]);
  });

  it('two Undo presses at once write once and take only that delete off', async () => {
    setUp();
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    askDeleteAntennas(['ant-b']);
    await confirmDeleteAntennas();
    h.calls = [];
    await Promise.all([undoDeleteAntennas(), undoDeleteAntennas()]);
    expect(h.calls.filter(([c]) => c === 'telecom:writeAntennas')).toHaveLength(1);
    expect(ids()).toEqual(['ant-b', 'ant-c']);
    // the delete of ant-a is still offered
    expect(antennaUndoStore.getState().undo.map((u) => u.removed[0]?.unit.id)).toEqual(['ant-a']);
  });

  it('an undo for another project is dropped, not written', async () => {
    setUp();
    askDeleteAntennas(['ant-a']);
    await confirmDeleteAntennas();
    antennaStore.setState({ projectId: 'p2' });
    h.calls = [];
    await undoDeleteAntennas();
    expect(h.calls).toEqual([]);
    expect(antennaUndoStore.getState().undo).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyMeasurements, MeasurementsFile, type SitePoint } from '@aio/schema';
import { initialDraw, measurementReadout } from '@aio/survey';
import {
  drawEvent,
  editEvent,
  isDirty,
  liveReading,
  loadMeasurements,
  measureStore,
  saveMeasurements,
  startEditing,
  startTool,
  stopTool,
  flipAzimuth,
  forgetMeasureWrites,
  askNewFolder,
  deleteMeasurements,
  endNewFolder,
  measureFolders,
  renameMeasurement,
  revealMeasurement,
  revertMeasurements,
  select,
  setMeasurementColour,
  setMeasurementHidden,
  setMeasurementsHidden,
  setMeasureVisibilityMemory,
  dismissUndoDelete,
  setAutosave,
  undoDeleteMeasurements,
} from './measureStore';
import { createMeasureVisibilityMemory } from './measureVisibility';

const io = vi.hoisted(() => ({
  saved: emptyFile(),
  writes: 0,
  readOnly: false,
  /** Writes per project. */
  writesTo: new Map<string, number>(),
  /** While set, a call on this channel waits for it before it answers. */
  gate: null as { channel: string; wait: Promise<void> } | null,
  /** While set, a write is refused (the disk is full). */
  writeFails: false,
}));
function emptyFile(): MeasurementsFile {
  return { schema: 'aio.measurements/1' as const, measurements: [] };
}
vi.mock('../shell', () => ({
  bridge: {
    call: async (channel: string, payload: { file?: unknown; projectId?: string }) => {
      if (io.gate?.channel === channel) await io.gate.wait;
      if (channel === 'survey:writeMeasurements') {
        if (io.writeFails) return { ok: true, value: { ok: false, error: 'Disk full' } };
        io.saved = MeasurementsFile.parse(JSON.parse(JSON.stringify(payload.file)) as unknown);
        io.writes++;
        const p = payload.projectId ?? '';
        io.writesTo.set(p, (io.writesTo.get(p) ?? 0) + 1);
        return { ok: true, value: { ok: true } };
      }
      if (channel === 'survey:readMeasurements')
        return { ok: true, value: { ok: true, file: io.saved, readOnly: io.readOnly } };
      return { ok: false, error: 'Not configured' };
    },
  },
  jobs: { getState: () => ({}) },
}));

/** The deletion the notice offers to undo (the latest). */
const topUndo = () => measureStore.getState().undoDeletes.at(-1) ?? null;

const env = { view: '3d' as const, clampZ: () => -99, snap: () => null };
const click = (raw: SitePoint) => {
  drawEvent({ type: 'click', raw, screen: { x: 1, y: 1 }, shift: true }, env);
};

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as unknown as Storage;
}
let memory = createMeasureVisibilityMemory(memoryStorage());

const measurement = (id: string, style?: { color: string; fill?: string }) => ({
  id,
  family: 'line' as const,
  tool: 'distance' as const,
  label: id,
  scope: { kind: 'site' as const },
  items: [],
  results: [],
  points: [
    [0, 0, 0],
    [3, 4, 0],
  ] as SitePoint[],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(style ? { style } : {}),
});
/** Load a saved file with these measurements for 'p1' through the mocked bridge. */
async function loadFile(
  ms: (ReturnType<typeof measurement> & { folder?: string })[],
): Promise<void> {
  io.saved = MeasurementsFile.parse({ schema: 'aio.measurements/1', measurements: ms });
  measureStore.setState({ projectId: null });
  await loadMeasurements('p1');
}

beforeEach(() => {
  io.saved = emptyFile();
  io.writes = 0;
  io.readOnly = false;
  io.writesTo.clear();
  io.gate = null;
  io.writeFails = false;
  forgetMeasureWrites();
  memory = createMeasureVisibilityMemory(memoryStorage());
  setMeasureVisibilityMemory(memory);
  measureStore.setState({
    file: emptyMeasurements(),
    savedText: JSON.stringify(emptyMeasurements()),
    projectId: 'test',
    status: 'ready',
    readOnly: false,
    tool: null,
    draw: null,
    editing: null,
    selected: [],
    focus: null,
    message: null,
    autosave: false,
    saving: false,
    measurementsVisible: true,
    hiddenMeasurements: [],
    // a test that does not load a file starts with no undo or reveal of the one before
    undoDeletes: [],
    reveal: null,
  });
});

describe('telecom fixed point drawing and persistence', () => {
  it('finishes tilt on the second actual pick, preserving its height without angle locking', () => {
    startTool('antenna-tilt');
    click([10, 20, 30]);
    click([10, 20, 40]);
    expect(measureStore.getState().file.measurements[0]?.points).toEqual([
      [10, 20, 30],
      [10, 20, 40],
    ]);
    expect(measureStore.getState().tool).toBeNull();
    expect(io.writes).toBe(0);
    expect(isDirty(measureStore.getState())).toBe(true);
  });

  it('rejects coincident endpoints and lets the user replace the last pick', () => {
    startTool('clearance');
    click([1, 2, 3]);
    click([1, 2, 3]);
    expect(measureStore.getState().file.measurements).toHaveLength(0);
    expect(measureStore.getState().draw?.points).toHaveLength(1);
    expect(measureStore.getState().message).toBeTruthy();
    click([1, 2, 8]);
    expect(measureStore.getState().file.measurements).toHaveLength(1);
  });

  it('supports undo and cancel while typed values and an early Finish cannot construct points', () => {
    startTool('azimuth');
    click([0, 0, 10]);
    click([0, 0, 20]);
    drawEvent({ type: 'key', key: '5' }, env);
    drawEvent({ type: 'key', key: 'Enter' }, env);
    expect(measureStore.getState().draw?.points).toHaveLength(2);
    drawEvent({ type: 'undo' }, env);
    expect(measureStore.getState().draw?.points).toHaveLength(1);
    drawEvent({ type: 'key', key: 'Escape' }, env);
    expect(measureStore.getState().tool).toBeNull();
  });

  it('prevents map picks and read-only input from creating telecom measurements', () => {
    startTool('clearance');
    drawEvent(
      { type: 'click', raw: [1, 2, 3], screen: { x: 1, y: 1 }, shift: false },
      { view: 'map' },
    );
    expect(measureStore.getState().draw?.points).toHaveLength(0);
    measureStore.setState({ readOnly: true });
    click([1, 2, 3]);
    click([1, 2, 4]);
    expect(measureStore.getState().file.measurements).toHaveLength(0);
    stopTool();
    startTool('azimuth');
    expect(measureStore.getState().tool).toBeNull();
  });

  it('keeps azimuth at three vertices during edits and preserves a flipped normal on save/reopen', async () => {
    startTool('azimuth');
    click([0, 0, 0]);
    click([0, 0, 2]);
    click([2, 0, 0]);
    const m = measureStore.getState().file.measurements[0];
    expect(m).toBeDefined();
    if (!m) return;
    flipAzimuth(m.id);
    startEditing();
    editEvent({ type: 'down-mid', seg: 0 });
    editEvent({ type: 'delete', vertex: 0 });
    expect(measureStore.getState().editing?.points).toHaveLength(3);
    editEvent({ type: 'set', vertex: 0, coords: { z: 1 } });
    expect(measureStore.getState().file.measurements[0]?.points[0]?.[2]).toBe(1);
    await saveMeasurements();
    expect(isDirty(measureStore.getState())).toBe(false);
    await loadMeasurements(null);
    await loadMeasurements('test');
    const reopened = measureStore.getState().file.measurements[0];
    expect(reopened && measurementReadout(reopened)[0]?.value).toBe(180);
    startTool('azimuth');
    click([0, 0, 1]);
    await loadMeasurements(null);
    expect(measureStore.getState().tool).toBeNull();
  });
});

describe('saved measurement view visibility', () => {
  it('drawing and editing do not unhide; a new measurement is visible', async () => {
    await loadFile([measurement('m1'), measurement('m2')]);
    setMeasurementsHidden(['m1'], true);
    startTool('distance');
    click([0, 0, 0]);
    click([3, 4, 0]);
    drawEvent({ type: 'key', key: 'Enter' }, env);
    const s = measureStore.getState();
    expect(s.hiddenMeasurements).toEqual(['m1']);
    expect(s.hiddenMeasurements).not.toContain(s.focus);
    select(['m2'], 'm2');
    startEditing();
    expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
  });
});

describe('one Distance tool, with a measure-without-saving mode (D19)', () => {
  it('a transient Distance reads, finishes and keeps its line, but never adds a measurement', () => {
    startTool('distance', { transient: true });
    expect(measureStore.getState().tool).toMatchObject({ tool: 'distance', transient: true });
    click([0, 0, 0]);
    click([3, 4, 0]);
    drawEvent({ type: 'key', key: 'Enter' }, env);
    const s = measureStore.getState();
    expect(s.file.measurements).toHaveLength(0);
    expect(isDirty(s)).toBe(false);
    // the result stays on the canvas: its points, done, the tool still on
    expect(s.draw?.done).toBe(true);
    expect(s.draw?.points).toHaveLength(2);
    expect(s.tool?.tool).toBe('distance');
    // moving the pointer keeps the finished line; the next click starts a new one
    drawEvent({ type: 'move', raw: [9, 9, 0], screen: { x: 2, y: 2 }, shift: false }, env);
    expect(measureStore.getState().draw?.points).toHaveLength(2);
    click([5, 5, 0]);
    expect(measureStore.getState().draw?.points).toHaveLength(1);
  });

  it('a read-only project always measures transient, and only with the tools that read', () => {
    measureStore.setState({ readOnly: true });
    startTool('distance');
    expect(measureStore.getState().tool).toMatchObject({ tool: 'distance', transient: true });
    click([0, 0, 0]);
    click([0, 10, 0]);
    expect(measureStore.getState().draw?.points).toHaveLength(2);
    drawEvent({ type: 'finish' }, env);
    expect(measureStore.getState().file.measurements).toHaveLength(0);
    stopTool();
    startTool('area');
    expect(measureStore.getState().tool).toBeNull();
  });

  it('a normal Distance puts the line in the project on Enter (unsaved until Save)', () => {
    startTool('distance');
    expect(measureStore.getState().tool?.transient).toBeFalsy();
    click([0, 0, 0]);
    click([3, 4, 0]);
    drawEvent({ type: 'key', key: 'Enter' }, env);
    const s = measureStore.getState();
    expect(s.file.measurements.map((m) => [m.tool, m.label])).toEqual([['distance', 'Distance 1']]);
    expect(s.reveal).toEqual({ id: s.focus, seq: s.reveal?.seq, openSidebar: false });
    expect(io.writes).toBe(0);
  });

  it('hides and shows one saved measurement in the views', () => {
    startTool('distance');
    click([0, 0, 0]);
    click([3, 4, 0]);
    drawEvent({ type: 'finish' }, env);
    const id = measureStore.getState().file.measurements[0]?.id ?? '';
    setMeasurementHidden(id, true);
    expect(measureStore.getState().hiddenMeasurements).toEqual([id]);
    setMeasurementHidden(id, false);
    expect(measureStore.getState().hiddenMeasurements).toEqual([]);
    // view state only: the file is untouched
    expect(isDirty(measureStore.getState())).toBe(true);
    expect(io.writes).toBe(0);
  });
});

describe('measurement layers: remembered visibility and edits', () => {
  const two = () => loadFile([measurement('m1'), measurement('m2')]);
  const find = (id: string) => measureStore.getState().file.measurements.find((m) => m.id === id);

  it('hiding is personal view state: not unsaved, no write, remembered on reload', async () => {
    await two();
    setMeasurementsHidden(['m1'], true);
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(io.writes).toBe(0);
    measureStore.setState({ projectId: null });
    await loadMeasurements('p1');
    expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
  });

  it('a deleted hidden id survives Revert and is pruned on the next load', async () => {
    await two();
    setMeasurementsHidden(['m1'], true);
    deleteMeasurements(['m1']);
    revertMeasurements();
    expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
    io.saved = MeasurementsFile.parse({
      schema: 'aio.measurements/1',
      measurements: [measurement('m2')],
    });
    measureStore.setState({ projectId: null });
    await loadMeasurements('p1');
    expect(measureStore.getState().hiddenMeasurements).toEqual([]);
    expect(memory.load('p1')).toEqual([]);
  });

  it('a read-only package still hides and remembers', async () => {
    io.readOnly = true;
    await two();
    setMeasurementsHidden(['m1'], true);
    expect(memory.load('p1')).toEqual(['m1']);
  });

  it('a preset colour sets the colour, and the fill only when it matched', async () => {
    await loadFile([
      measurement('m1', { color: '#ffd166', fill: '#ffd166' }),
      measurement('m2', { color: '#ffd166', fill: '#000000' }),
      measurement('m3'),
    ]);
    setMeasurementColour(['m1', 'm2', 'm3'], '#ef476f');
    expect(find('m1')?.style).toMatchObject({ color: '#ef476f', fill: '#ef476f' });
    expect(find('m2')?.style).toMatchObject({ color: '#ef476f', fill: '#000000' });
    expect(find('m3')?.style).toEqual({ color: '#ef476f' });
    expect(isDirty(measureStore.getState())).toBe(true);
  });

  it('renames up to 200 characters, never to empty', async () => {
    await two();
    expect(renameMeasurement('m1', '  Fence line  ')).toBe(true);
    expect(find('m1')?.label).toBe('Fence line');
    expect(renameMeasurement('m1', 'Fence line')).toBe(false);
    expect(renameMeasurement('m1', '   ')).toBe(false);
    expect(renameMeasurement('m1', 'x'.repeat(201))).toBe(false);
    expect(renameMeasurement('m1', 'x'.repeat(200))).toBe(true);
  });

  it('asks the tree to reveal a measurement and to open a new folder', () => {
    revealMeasurement('m1');
    const seq = measureStore.getState().reveal?.seq ?? 0;
    expect(measureStore.getState().reveal).toEqual({ id: 'm1', seq, openSidebar: true });
    askNewFolder(['m1', 'm2']);
    expect(measureStore.getState().newFolder).toMatchObject({ ids: ['m1', 'm2'] });
    expect(measureStore.getState().reveal).toMatchObject({ id: 'm1', seq: seq + 1 });
    endNewFolder();
    expect(measureStore.getState().newFolder).toBeNull();
  });

  it('lists the distinct folders A to Z', () => {
    const f = MeasurementsFile.parse({
      schema: 'aio.measurements/1',
      measurements: [
        { ...measurement('a'), folder: ' Zed ' },
        { ...measurement('b'), folder: 'alpha' },
        { ...measurement('c'), folder: 'Zed' },
        { ...measurement('d'), folder: '  ' },
      ],
    });
    expect(measureFolders(f)).toEqual(['alpha', 'Zed']);
  });
});

describe('a deletion can be undone', () => {
  const three = () =>
    loadFile([
      { ...measurement('m1'), folder: 'Fence' },
      measurement('m2', { color: '#ff0000', fill: '#00ff00' }),
      { ...measurement('m3'), folder: 'Fence' },
    ]);
  const ids = () => measureStore.getState().file.measurements.map((m) => m.id);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('deleting offers an undo that brings the same measurements back in their places', async () => {
    await three();
    const before = measureStore.getState().file;
    deleteMeasurements(['m1', 'm3']);
    expect(ids()).toEqual(['m2']);
    expect(topUndo()?.items.map((x) => x.m.id)).toEqual(['m1', 'm3']);
    undoDeleteMeasurements();
    expect(measureStore.getState().file.measurements).toEqual(before.measurements);
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(topUndo()).toBeNull();
  });

  it('the undo puts the measurements back after later edits, without doubling one already back', async () => {
    await three();
    deleteMeasurements(['m2']);
    revertMeasurements();
    // Revert brought it back already: the undo has nothing left to do
    expect(topUndo()).toBeNull();
    deleteMeasurements(['m1']);
    // a later edit: a new measurement at the end
    measureStore.setState((s) => ({
      file: { ...s.file, measurements: [...s.file.measurements, measurement('m4')] },
    }));
    undoDeleteMeasurements();
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
    undoDeleteMeasurements();
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('with Autosave on, the undo is saved too, even while the deletion is still being written', async () => {
    await three();
    setAutosave(true);
    deleteMeasurements(['m2']);
    // the deletion's save is in flight
    expect(measureStore.getState().saving).toBe(true);
    undoDeleteMeasurements();
    await flush();
    await flush();
    expect(io.saved.measurements.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('dismissing, a project switch and a read-only file leave no undo', async () => {
    await three();
    deleteMeasurements(['m1']);
    dismissUndoDelete();
    expect(topUndo()).toBeNull();
    deleteMeasurements(['m2']);
    measureStore.setState({ projectId: null });
    await loadMeasurements('p1');
    expect(topUndo()).toBeNull();
    measureStore.setState({ readOnly: true });
    deleteMeasurements(['m1']);
    expect(topUndo()).toBeNull();
  });

  it('a second deletion keeps the first one undoable: Undo takes them back latest first', async () => {
    await three();
    const before = measureStore.getState().file;
    deleteMeasurements(['m1']);
    deleteMeasurements(['m3']);
    expect(topUndo()?.items.map((x) => x.m.id)).toEqual(['m3']);
    undoDeleteMeasurements();
    expect(ids()).toEqual(['m2', 'm3']);
    expect(topUndo()?.items.map((x) => x.m.id)).toEqual(['m1']);
    undoDeleteMeasurements();
    expect(measureStore.getState().file.measurements).toEqual(before.measurements);
    expect(topUndo()).toBeNull();
  });

  it('keeps the last 10 deletions; Revert trims what it brought back, Dismiss lets go of all', async () => {
    await loadFile(Array.from({ length: 12 }, (_, i) => measurement(`m${String(i)}`)));
    for (let i = 0; i < 12; i++) deleteMeasurements([`m${String(i)}`]);
    expect(measureStore.getState().undoDeletes).toHaveLength(10);
    for (let i = 0; i < 10; i++) undoDeleteMeasurements();
    // the two oldest deletions are gone for good
    expect(ids()).toEqual(Array.from({ length: 10 }, (_, i) => `m${String(i + 2)}`));
    expect(topUndo()).toBeNull();
    await three();
    deleteMeasurements(['m1']);
    deleteMeasurements(['m2']);
    expect(await saveMeasurements()).toBe(true);
    deleteMeasurements(['m3']);
    revertMeasurements();
    // m3 came back with Revert; m1 and m2 were saved gone, so their undos stay
    expect(measureStore.getState().undoDeletes.map((u) => u.items[0]?.m.id)).toEqual(['m1', 'm2']);
    dismissUndoDelete();
    expect(measureStore.getState().undoDeletes).toEqual([]);
  });
});

describe('an autosave and the undo against what happens meanwhile', () => {
  const gate = (channel: string) => {
    let open: () => void = () => undefined;
    io.gate = {
      channel,
      wait: new Promise<void>((r) => {
        open = r;
      }),
    };
    return () => {
      io.gate = null;
      open();
    };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('a save still writing for one project does not touch, or save, the next one', async () => {
    await loadFile([measurement('m1'), measurement('m2')]);
    measureStore.setState({ projectId: 'A' });
    setAutosave(true);
    const writeA = gate('survey:writeMeasurements');
    deleteMeasurements(['m1']);
    expect(measureStore.getState().saving).toBe(true);
    // the person opens B; its file is still being read when A's write answers
    const readB = gate('survey:readMeasurements');
    void loadMeasurements('B');
    const bSaved = measureStore.getState().savedText;
    writeA();
    await flush();
    expect(io.writesTo.get('B') ?? 0).toBe(0);
    expect(measureStore.getState().projectId).toBe('B');
    expect(measureStore.getState().savedText).toBe(bSaved);
    expect(measureStore.getState().saving).toBe(false);
    readB();
    await flush();
    expect(io.writesTo.get('B') ?? 0).toBe(0);
    setAutosave(false);
  });

  it('opening a project again waits for its write still in flight, then reads what it wrote', async () => {
    await loadFile([measurement('m1'), measurement('m2')]);
    measureStore.setState({ projectId: 'A' });
    setAutosave(true);
    const writeA = gate('survey:writeMeasurements');
    deleteMeasurements(['m1']);
    expect(measureStore.getState().saving).toBe(true);
    // A, then B, then A again while A's first write is still in flight
    await loadMeasurements('B');
    const loadA = loadMeasurements('A');
    await flush();
    // the file is not read before the write lands
    expect(measureStore.getState().status).toBe('loading');
    writeA();
    await loadA;
    await flush();
    const loaded = measureStore.getState();
    expect(loaded.status).toBe('ready');
    expect(loaded.file.measurements.map((m) => m.id)).toEqual(['m2']);
    expect(isDirty(loaded)).toBe(false);
    expect(loaded.message).toBeNull();
    setAutosave(false);
  });

  it('a write that fails still lets the project open again', async () => {
    await loadFile([measurement('m1'), measurement('m2')]);
    measureStore.setState({ projectId: 'A' });
    setAutosave(true);
    io.writeFails = true;
    const writeA = gate('survey:writeMeasurements');
    deleteMeasurements(['m1']);
    await loadMeasurements('B');
    const loadA = loadMeasurements('A');
    writeA();
    await loadA;
    expect(measureStore.getState().status).toBe('ready');
    expect(measureStore.getState().file.measurements.map((m) => m.id)).toEqual(['m1', 'm2']);
    setAutosave(false);
  });

  /** A, then B, then A again, with each of A's two reads waiting for its own door. */
  async function aBaWithReadsHeld(): Promise<{
    openFirst: () => void;
    openSecond: () => void;
    done: Promise<unknown>;
  }> {
    io.saved = MeasurementsFile.parse({
      schema: 'aio.measurements/1',
      measurements: [measurement('m1'), measurement('m2')],
    });
    measureStore.setState({ projectId: null });
    const doors: (() => void)[] = [];
    const hold = () => {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((r) => {
        open = r;
      });
      io.gate = { channel: 'survey:readMeasurements', wait };
      doors.push(open);
    };
    hold();
    const a1 = loadMeasurements('A');
    io.gate = null;
    const b = loadMeasurements('B');
    hold();
    const a2 = loadMeasurements('A');
    io.gate = null;
    await flush();
    const [openFirst = () => undefined, openSecond = () => undefined] = doors;
    return { openFirst, openSecond, done: Promise.all([a1, b, a2]) };
  }

  it('the first read of A answering after A was opened again is not taken as loaded', async () => {
    const { openFirst, openSecond, done } = await aBaWithReadsHeld();
    openFirst();
    await flush();
    // the latest load's read is still out: nothing to show or edit yet
    expect(measureStore.getState().status).toBe('loading');
    openSecond();
    await done;
    expect(measureStore.getState().status).toBe('ready');
    deleteMeasurements(['m1']);
    expect(measureStore.getState().file.measurements.map((m) => m.id)).toEqual(['m2']);
  });

  it('the first read of A answering late does not put back the file over an edit', async () => {
    const { openFirst, openSecond, done } = await aBaWithReadsHeld();
    openSecond();
    await flush();
    expect(measureStore.getState().status).toBe('ready');
    deleteMeasurements(['m1']);
    openFirst();
    await done;
    await flush();
    const s = measureStore.getState();
    expect(s.file.measurements.map((m) => m.id)).toEqual(['m2']);
    expect(isDirty(s)).toBe(true);
    expect(s.undoDeletes).toHaveLength(1);
  });

  it('saving is refused unless the file is loaded', async () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      measureStore.setState({
        status,
        file: { schema: 'aio.measurements/1', measurements: [measurement('m1')] },
      });
      expect(await saveMeasurements()).toBe(false);
    }
    expect(io.writes).toBe(0);
    expect(measureStore.getState().saving).toBe(false);
  });

  it('Undo while another measurement is being edited ends that edit: no geometry crosses over', async () => {
    await loadFile([
      measurement('x'),
      {
        ...measurement('r'),
        points: [
          [10, 10, 0],
          [13, 14, 0],
        ] as SitePoint[],
      },
    ]);
    select(['x'], 'x');
    startEditing();
    expect(measureStore.getState().editing).not.toBeNull();
    deleteMeasurements(['r']);
    undoDeleteMeasurements();
    editEvent({ type: 'set', vertex: 0, coords: { z: 7 } });
    const r = measureStore.getState().file.measurements.find((m) => m.id === 'r');
    expect(r?.points).toEqual([
      [10, 10, 0],
      [13, 14, 0],
    ]);
  });
});

describe('liveReading', () => {
  it('liveReading shows the primary row', () => {
    // distance headlines the slope length (13 m here), not the horizontal 5 m
    measureStore.setState({
      tool: { tool: 'distance', template: null, picks: {} },
      draw: {
        ...initialDraw('line'),
        points: [
          [0, 0, 0],
          [3, 4, 12],
        ],
        done: true,
      },
    });
    const reading = liveReading(measureStore.getState());
    expect(reading).toMatch(/^13(\.0+)? m$/);
  });
});

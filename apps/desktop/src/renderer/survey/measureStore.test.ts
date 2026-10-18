import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyMeasurements, MeasurementsFile, type SitePoint } from '@aio/schema';
import { measurementReadout } from '@aio/survey';
import {
  drawEvent,
  editEvent,
  isDirty,
  loadMeasurements,
  measureStore,
  saveMeasurements,
  startEditing,
  startTool,
  stopTool,
  flipAzimuth,
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
  setMeasurementsVisible,
  setMeasureVisibilityMemory,
} from './measureStore';
import { createMeasureVisibilityMemory } from './measureVisibility';

const io = vi.hoisted(() => ({ saved: emptyFile(), writes: 0, readOnly: false }));
function emptyFile(): MeasurementsFile {
  return { schema: 'aio.measurements/1' as const, measurements: [] };
}
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, payload: { file?: unknown }) => {
      if (channel === 'survey:writeMeasurements') {
        io.saved = MeasurementsFile.parse(JSON.parse(JSON.stringify(payload.file)) as unknown);
        io.writes++;
        return Promise.resolve({ ok: true, value: { ok: true } });
      }
      if (channel === 'survey:readMeasurements')
        return Promise.resolve({
          ok: true,
          value: { ok: true, file: io.saved, readOnly: io.readOnly },
        });
      return Promise.resolve({ ok: false, error: 'Not configured' });
    },
  },
  jobs: { getState: () => ({}) },
}));

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
async function loadFile(ms: ReturnType<typeof measurement>[]): Promise<void> {
  io.saved = MeasurementsFile.parse({ schema: 'aio.measurements/1', measurements: ms });
  measureStore.setState({ projectId: null });
  await loadMeasurements('p1');
}

beforeEach(() => {
  io.saved = emptyFile();
  io.writes = 0;
  io.readOnly = false;
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
  it('hides editing handles without changing saved data or requiring a write, including in read-only mode', () => {
    startTool('clearance');
    click([0, 0, 1]);
    click([0, 0, 3]);
    startEditing();
    const file = measureStore.getState().file;
    measureStore.setState({ readOnly: true, savedText: JSON.stringify(file) });
    setMeasurementsVisible(false);
    expect(measureStore.getState().measurementsVisible).toBe(false);
    expect(measureStore.getState().editing).toBeNull();
    expect(measureStore.getState().file).toBe(file);
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(io.writes).toBe(0);
    setMeasurementsVisible(true);
    expect(measureStore.getState().measurementsVisible).toBe(true);
  });

  it('resets visibility on a project switch while leaving an active draft usable during a view toggle', async () => {
    startTool('azimuth');
    click([0, 0, 1]);
    setMeasurementsVisible(false);
    expect(measureStore.getState().draw?.points).toHaveLength(1);
    await loadMeasurements(null);
    expect(measureStore.getState().measurementsVisible).toBe(true);
  });

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

  it('hides and shows one saved measurement in the views; Show all brings every one back', () => {
    startTool('distance');
    click([0, 0, 0]);
    click([3, 4, 0]);
    drawEvent({ type: 'finish' }, env);
    const id = measureStore.getState().file.measurements[0]?.id ?? '';
    setMeasurementHidden(id, true);
    expect(measureStore.getState().hiddenMeasurements).toEqual([id]);
    setMeasurementHidden(id, false);
    expect(measureStore.getState().hiddenMeasurements).toEqual([]);
    setMeasurementHidden(id, true);
    setMeasurementsVisible(true);
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

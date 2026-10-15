import { describe, expect, it } from 'vitest';
import { Issue } from './annotation';
import { ipc } from './ipc';
import {
  decodeSelection,
  encodeSelection,
  SELECTION_HEADER_BYTES,
  SELECTION_MAX_POINTS,
  SelectionName,
  selectionByteLength,
} from './selection';

const base = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  source: 'agent',
} as const;

const ring = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
];

const placed = {
  ...base,
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    { on: 'mesh', layer: 'model', geom: { type: 'spolygon', points: ring }, from: { sighting: 0 } },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'polygon3', points: ring, height: 0.4 },
      from: { sighting: 0 },
    },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/i1-cloud.sel' }, count: 12, lod: 4 },
      from: { sighting: 0 },
    },
  ],
};

describe('findings on a model: issue fields', () => {
  it('keeps from on mesh and cloud sightings and lod on a selection through a JSON round trip', () => {
    expect(Issue.parse(JSON.parse(JSON.stringify(placed)))).toEqual(placed);
  });

  it('still reads issues without the new fields', () => {
    expect(Issue.safeParse({ ...base, sightings: [placed.sightings[0]] }).success).toBe(true);
  });

  it('refuses a negative or fractional from index, extra keys in from and a negative lod', () => {
    const accepts = (s: unknown) => Issue.safeParse({ ...base, sightings: [s] }).success;
    const mesh = placed.sightings[1];
    expect(accepts({ ...mesh, from: { sighting: -1 } })).toBe(false);
    expect(accepts({ ...mesh, from: { sighting: 0.5 } })).toBe(false);
    expect(accepts({ ...mesh, from: { sighting: 0, extra: 1 } })).toBe(false);
    const sel = placed.sightings[3];
    expect(accepts({ ...sel, geom: { ...sel?.geom, lod: -2 } })).toBe(false);
  });
});

describe('selection files', () => {
  it('round-trips points and the octree depth', () => {
    const pts = new Float32Array([0, 1, 2, -3.5, 4.25, 1e3]);
    const bytes = encodeSelection(pts, 6);
    expect(bytes.byteLength).toBe(selectionByteLength(2));
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('AIOSEL01');
    const back = decodeSelection(bytes);
    expect(back?.lod).toBe(6);
    expect([...(back?.positions ?? [])]).toEqual([...pts]);
  });

  it('refuses a wrong magic, a short file and a count that does not match the length', () => {
    const good = encodeSelection(new Float32Array([1, 2, 3]), 0);
    const wrong = good.slice();
    wrong[0] = 0x58;
    expect(decodeSelection(wrong)).toBeNull();
    expect(decodeSelection(good.subarray(0, SELECTION_HEADER_BYTES - 1))).toBeNull();
    expect(decodeSelection(good.subarray(0, good.byteLength - 4))).toBeNull();
    const longer = new Uint8Array(good.byteLength + 4);
    longer.set(good);
    expect(decodeSelection(longer)).toBeNull();
    const over = good.slice();
    new DataView(over.buffer).setUint32(8, SELECTION_MAX_POINTS + 1, true);
    expect(decodeSelection(over)).toBeNull();
  });

  it('refuses positions that are not whole points', () => {
    expect(() => encodeSelection(new Float32Array([1, 2]), 0)).toThrow('x, y, z');
  });

  it('names files with letters, digits, dash and underscore only', () => {
    expect(SelectionName.safeParse('i1-cloud-d2').success).toBe(true);
    expect(SelectionName.safeParse('../x').success).toBe(false);
    expect(SelectionName.safeParse('').success).toBe(false);
  });

  it('has an IPC channel that checks the name', () => {
    const req = ipc['project:writeSelection'].request;
    const data = encodeSelection(new Float32Array([0, 0, 0]), 1);
    expect(req.safeParse({ projectId: 'p', name: 'i1-cloud', data }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', name: 'a/b', data }).success).toBe(false);
  });
});

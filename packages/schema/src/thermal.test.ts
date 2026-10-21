import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADING,
  HotSpot,
  THERMAL_CANDIDATES_SCHEMA,
  THERMAL_MIN_PACK,
  THERMAL_RASTER_SCHEMA,
  THERMAL_SCHEMA,
  ThermalCandidatesFile,
  ThermalDecodeParams,
  ThermalFile,
  ThermalGrading,
  ThermalRasterIndex,
  ThermalRasterMeta,
  ThermalReading,
  ThermalReference,
  ThermalSettings,
  thermalPhotoKey,
} from './thermal';

const settings = { emissivity: 0.95, distanceM: 18, airC: 32, humidityPct: 60, reflectedC: null };
const hex = 'a'.repeat(64);

const sighting = {
  layer: 'l1',
  photo: 'p1',
  box: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
  peakC: 80,
  meanC: 70,
};
const hotspot = {
  id: 'h1',
  state: 'proposed',
  origin: 'detection',
  sightings: [sighting],
  reference: { kind: 'surroundings', valueC: 40 },
  peakC: 80,
  meanC: 70,
  deltaC: 40,
  severity: 3,
};

describe('ThermalSettings', () => {
  it('accepts the usual values', () => {
    expect(ThermalSettings.safeParse(settings).success).toBe(true);
    expect(ThermalSettings.safeParse({ ...settings, reflectedC: 25 }).success).toBe(true);
  });
  it('refuses out-of-range values', () => {
    expect(ThermalSettings.safeParse({ ...settings, emissivity: 0 }).success).toBe(false);
    expect(ThermalSettings.safeParse({ ...settings, emissivity: 1.01 }).success).toBe(false);
    expect(ThermalSettings.safeParse({ ...settings, humidityPct: 101 }).success).toBe(false);
    expect(ThermalSettings.safeParse({ ...settings, distanceM: -1 }).success).toBe(false);
  });
});

describe('ThermalReading', () => {
  const base = {
    id: 'r1',
    layer: 'l1',
    photo: 'p1',
    stats: { maxC: 50, minC: 20, meanC: 30 },
  };
  it('takes the image shapes and a line', () => {
    for (const geom of [
      { type: 'point', x: 1, y: 2 },
      { type: 'box', x: 1, y: 2, w: 3, h: 4 },
      {
        type: 'polygon',
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
      {
        type: 'line',
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ])
      expect(ThermalReading.safeParse({ ...base, geom }).success, geom.type).toBe(true);
  });
  it('refuses a line of one point', () => {
    const geom = { type: 'line', points: [[0, 0]] };
    expect(ThermalReading.safeParse({ ...base, geom }).success).toBe(false);
  });
});

describe('HotSpot', () => {
  it('accepts a proposed spot', () => {
    expect(HotSpot.safeParse(hotspot).success).toBe(true);
    expect(HotSpot.safeParse({ ...hotspot, severity: null }).success).toBe(true);
  });
  it('refuses a confirmed spot without an issue', () => {
    expect(HotSpot.safeParse({ ...hotspot, state: 'confirmed' }).success).toBe(false);
    expect(HotSpot.safeParse({ ...hotspot, state: 'confirmed', issueId: 'i1' }).success).toBe(true);
  });
  it('refuses a non-integer severity', () => {
    expect(HotSpot.safeParse({ ...hotspot, severity: 1.5 }).success).toBe(false);
  });
});

describe('ThermalReference', () => {
  it('needs a readingId for a reading', () => {
    expect(ThermalReference.safeParse({ kind: 'reading', valueC: 30 }).success).toBe(false);
    expect(
      ThermalReference.safeParse({ kind: 'reading', readingId: 'r1', valueC: 30 }).success,
    ).toBe(true);
    expect(ThermalReference.safeParse({ kind: 'surroundings', valueC: 30 }).success).toBe(true);
  });
});

describe('grading', () => {
  it('has the default levels', () => {
    expect(DEFAULT_GRADING.levels).toEqual([
      { value: 1, minDeltaC: 4 },
      { value: 2, minDeltaC: 16 },
      { value: 3, minDeltaC: 40.1 },
    ]);
  });
  it('refuses non-ascending minDeltaC', () => {
    const bad = {
      levels: [
        { value: 1, minDeltaC: 16 },
        { value: 2, minDeltaC: 4 },
      ],
    };
    expect(ThermalGrading.safeParse(bad).success).toBe(false);
    expect(ThermalGrading.safeParse(DEFAULT_GRADING).success).toBe(true);
  });
});

describe('ThermalFile', () => {
  it('round-trips an empty file', () => {
    const f = { schema: THERMAL_SCHEMA, photos: {}, readings: [], hotspots: [] };
    expect(ThermalFile.parse(f)).toEqual(f);
  });
  it('round-trips a full example', () => {
    const f = {
      schema: THERMAL_SCHEMA,
      defaults: settings,
      photos: { [thermalPhotoKey('l1', 'p1')]: { settings } },
      readings: [
        {
          id: 'r1',
          layer: 'l1',
          photo: 'p1',
          geom: { type: 'point', x: 1, y: 2 },
          stats: { maxC: 50, minC: 20, meanC: 30 },
        },
      ],
      hotspots: [{ ...hotspot, state: 'confirmed', issueId: 'i1', note: 'n' }],
      grading: DEFAULT_GRADING,
      alignment: { l1: { dx: 1, dy: -2, scale: 1.02 } },
    };
    expect(ThermalFile.parse(f)).toEqual(f);
  });
  it('keys photos by layer and photo', () => {
    expect(thermalPhotoKey('l1', 'p1')).toBe('l1/p1');
  });
});

describe('rasters', () => {
  const meta = {
    schema: THERMAL_RASTER_SCHEMA,
    width: 640,
    height: 512,
    family: 'flir',
    camera: 'FLIR T',
    settings,
    clamped: [],
    minC: 10,
    maxC: 90,
    medianC: 30,
    decoder: 'x/1',
    settingsKey: hex,
  };
  it('parses a meta and checks size and key', () => {
    expect(ThermalRasterMeta.safeParse(meta).success).toBe(true);
    expect(ThermalRasterMeta.safeParse({ ...meta, width: 0 }).success).toBe(false);
    expect(ThermalRasterMeta.safeParse({ ...meta, height: 1.5 }).success).toBe(false);
    expect(ThermalRasterMeta.safeParse({ ...meta, settingsKey: 'abc' }).success).toBe(false);
  });
  it('parses an index', () => {
    const i = {
      schema: THERMAL_RASTER_SCHEMA,
      photos: { p1: { status: 'ok' }, p2: { status: 'unsupported', reason: 'no data' } },
    };
    expect(ThermalRasterIndex.safeParse(i).success).toBe(true);
    expect(ThermalRasterIndex.safeParse({ ...i, photos: { p1: { status: 'bad' } } }).success).toBe(
      false,
    );
  });
});

describe('candidates and params', () => {
  it('parses a candidates file', () => {
    const f = { schema: THERMAL_CANDIDATES_SCHEMA, candidates: [] };
    expect(ThermalCandidatesFile.safeParse(f).success).toBe(true);
  });
  it('decode params', () => {
    expect(ThermalDecodeParams.safeParse({ layerId: 'l1' }).success).toBe(true);
    expect(
      ThermalDecodeParams.safeParse({ layerId: 'l1', photos: ['a'], force: true }).success,
    ).toBe(true);
    expect(ThermalDecodeParams.safeParse({}).success).toBe(false);
    expect(THERMAL_MIN_PACK).toBe('0.21.0');
  });
});

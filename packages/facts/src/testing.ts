/** A small project folder with one record of every kind the index reads (tests only). */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The signed journal fixture of `@aio/schema` (three devices, issue ops). */
export const JOURNAL_FIXTURE = join(
  here,
  '..',
  '..',
  'schema',
  'src',
  '__fixtures__',
  'journal',
  'valid',
);

const put = (root: string, rel: string, value: unknown) => {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Origin of the fixture's frame: local (x, z) is easting 1000 + x, northing 2000 - z. */
export const ORIGIN = [1000, 2000, 0] as const;

export const result = (toCapture: string, netM3: number) => ({
  item: 'vol',
  status: 'ok',
  cutM3: 0,
  fillM3: netM3,
  netM3,
  totalM3: netM3,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 100,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Base',
  toLabel: toCapture,
  toCapture,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: `fp-${toCapture}`,
  computedAt: `${toCapture === 'c1' ? '2026-07-02' : '2026-08-02'}T00:00:00.000Z`,
});

export const measurement = (series: unknown[]) => ({
  id: 'pile-north',
  family: 'polygon',
  tool: 'volume',
  label: 'North stockpile',
  scope: { kind: 'site' },
  // a 20 m square around easting 1010, northing 1990 (local x 10, z 10)
  points: [
    [1000, 1980, 5],
    [1020, 1980, 5],
    [1020, 2000, 5],
    [1000, 2000, 5],
  ],
  description: 'Crushed gravel heap by the gate',
  items: [{ id: 'vol', from: { kind: 'previous' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  series,
  createdAt: '2026-07-01T09:00:00.000Z',
});

/** The antenna inventory example of `@aio/schema` (aio.antennas/1). */
const ANTENNAS_FIXTURE = join(
  here,
  '..',
  '..',
  'schema',
  'src',
  '__fixtures__',
  'antennas-contract.json',
);

/**
 * Write `telecom/antennas.json` from the schema's example, its first unit made `ant-a1` with the
 * name and review state given, for survey date `captureId` (absent: no date on the run).
 */
export function writeAntennaInventory(
  root: string,
  unit: { name: string; status: 'draft' | 'accepted' | 'rejected' },
  captureId?: string,
): void {
  const example = (JSON.parse(readFileSync(ANTENNAS_FIXTURE, 'utf8')) as { example: AnyJson })
    .example;
  const run = example.run as AnyJson;
  const units = example.units as AnyJson[];
  const first = { ...(units[0] ?? {}), id: 'ant-a1', ...unit };
  put(root, 'telecom/antennas.json', {
    ...example,
    run: { ...run, ...(captureId ? { captureId } : {}) },
    units: [first],
  });
}

/** Record `ant-a1` as deleted (`telecom/antenna-deletions.json`). */
export function writeAntennaDeletion(root: string): void {
  put(root, 'telecom/antenna-deletions.json', {
    schema: 'aio.antenna-deletions/1',
    deletions: [
      {
        unitId: 'ant-a1',
        name: 'A1',
        kind: 'panel',
        box: {
          centre: [1005, 1995, 30],
          axes: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          extents: [0.3, 1.4, 0.1],
        },
        deletedAt: '2026-08-10T00:00:00.000Z',
      },
    ],
  });
}

type AnyJson = Record<string, unknown>;

export function writeFixtureProject(root: string, opts: { journal?: boolean } = {}): void {
  put(root, 'manifest.json', {
    schema: 'aio.project/1',
    id: 'fixture',
    name: 'Fixture quarry',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [
      { id: 'c1', label: 'July survey', date: '2026-07-01' },
      { id: 'c2', label: 'August survey', date: '2026-08-01' },
    ],
    layers: [
      {
        kind: 'photos',
        id: 'ph1',
        name: 'Drone photos August',
        capture: 'c2',
        items: [
          { id: 'p1', src: { path: 'photos/DJI_0001.JPG' }, pos: [10, 30, 10] },
          { id: 'p2', src: { path: 'photos/DJI_0002.JPG' }, pos: [200, 30, 200] },
        ],
      },
    ],
    severityModels: [],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Quarry',
        assetType: 'quarry',
        classes: [{ id: 'crack', label: 'Crack', color: '#ff0000', severityModel: 'sev' }],
      },
    ],
  });
  put(root, 'survey/measurements.json', {
    schema: 'aio.measurements/1',
    measurements: [measurement([result('c1', 1200), result('c2', 950)])],
  });
  put(root, 'survey/qa/c2.json', {
    schema: 'aio.survey-qa/1',
    capture: 'c2',
    level: 'moderate',
    status: 'hold',
    checkpoints: { count: 4, rmseM: 0.12, meanM: 0, maxAbsM: 0.2, points: [] },
    hold: { at: '2026-08-02T10:00:00.000Z', reason: 'Checkpoint RMSE over the limit' },
    checkedAt: '2026-08-02T10:00:00.000Z',
  });
  put(root, 'detections/run-1.json', {
    schema: 'aio.detections/1',
    source: 'ai',
    layer: 'ph1',
    createdAt: '2026-08-03T00:00:00.000Z',
    detections: [
      {
        id: 'd1',
        photo: 'p1',
        class: 'crack',
        confidence: 0.8,
        bbox: [0, 0, 10, 10],
        issueId: 'i1',
      },
      { id: 'd2', photo: 'p2', class: 'crack', status: 'rejected', bbox: [0, 0, 10, 10] },
      { photo: 'p2', class: 'crack', bbox: [10, 0, 0, 10] },
    ],
  });
  put(root, 'issues.json', {
    schema: 'aio.issues/1',
    issues: [
      {
        id: 'i1',
        code: 'D012',
        classId: 'crack',
        severityModelId: 'sev',
        severity: 3,
        status: 'reviewed',
        title: 'Crack in the ramp wall',
        note: 'Widening since July',
        author: 'Reviewer',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        sightings: [
          { on: 'image', layer: 'ph1', photo: 'p1', geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 } },
        ],
        source: 'agent',
        capture: 'c2',
      },
    ],
  });
  put(root, 'change/c1-c2-issues.json', {
    schema: 'aio.change/1',
    id: 'c1-c2-issues',
    from: 'c1',
    to: 'c2',
    producer: 'issues',
    createdAt: '2026-08-05T00:00:00.000Z',
    items: [{ kind: 'issue', id: 'it1', verdict: 'new', to: 'i1', label: 'New crack' }],
  });
  put(root, 'thermal/thermal.json', {
    schema: 'aio.thermal/1',
    photos: {},
    readings: [],
    hotspots: [
      {
        id: 'h1',
        state: 'proposed',
        origin: 'detection',
        sightings: [
          {
            layer: 'ph1',
            photo: 'p1',
            box: { type: 'box', x: 0, y: 0, w: 4, h: 4 },
            peakC: 71,
            meanC: 60,
          },
        ],
        reference: { kind: 'surroundings', valueC: 30 },
        peakC: 71,
        meanC: 60,
        deltaC: 41,
        severity: null,
      },
    ],
  });
  put(root, 'walks/gate-walk/walk.json', {
    schema: 'aio.walk/1',
    id: 'gate-walk',
    name: 'Gate walk',
    createdAt: '2026-08-06T00:00:00.000Z',
    source: {
      file: 'VID_0001.mp4',
      layout: 'equirect',
      streams: [{ width: 3840, height: 1920, codec: 'avc1', fps: 30 }],
    },
    video: {
      src: 'walks/gate-walk/walk.mp4',
      width: 3840,
      height: 1920,
      durationS: 95,
      fps: 30,
      audio: false,
    },
  });
  // one antenna measured on both dates (M2 per-date copies), tilted further on the later one
  for (const [capture, tilt, status] of [
    ['c1', 2, 'accepted'],
    ['c2', 5, 'draft'],
  ] as const) {
    put(root, `telecom/history/${capture}.json`, {
      schema: 'aio.antenna-history/1',
      captureId: capture,
      runId: `run-${capture}`,
      at: capture === 'c1' ? '2026-07-02T00:00:00.000Z' : '2026-08-02T00:00:00.000Z',
      units: [
        {
          id: 'ant-a1',
          name: 'A1',
          kind: 'panel',
          status,
          reviewed: capture === 'c1',
          centre: [1005, 1995, 30],
          extents: [0.3, 1.4, 0.1],
          azimuthGridDeg: 120,
          downtiltDeg: tilt,
          centreHeightM: 30,
        },
      ],
    });
  }
  // the agent's project notes (A3): one about the pile, one about the whole project
  put(root, 'ai/memory.json', {
    schema: 'aio.agent-memory/1',
    notes: [
      {
        id: 'n-pile1',
        text: 'The north pile is weighed as crushed granite',
        about: 'measurement:pile-north',
        by: 'agent',
        createdAt: '2026-08-03T09:00:00.000Z',
      },
      {
        id: 'n-units',
        text: 'Report volumes in cubic yards',
        by: 'person',
        createdAt: '2026-08-04T09:00:00.000Z',
      },
    ],
  });
  if (opts.journal)
    cpSync(join(JOURNAL_FIXTURE, 'journal'), join(root, 'journal'), { recursive: true });
}

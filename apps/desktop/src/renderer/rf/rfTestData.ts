/** Test fixtures for the RF store: antenna units, catalogue entries and sectors. Tests only. */
import {
  AntennasFile,
  RfCatalogueEntry,
  RF_SECTORS_SCHEMA,
  DEFAULT_RF_STUDY,
  type AntennaUnit,
  type RfAntennaSettings,
  type RfSectorsFile,
} from '@aio/schema';

const val = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const, residualM: 0.004, support: 900, coverage: 0.8 },
});

export function unit(id: string, azimuth: number, over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id,
    name: id.slice(4).toUpperCase(),
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'accepted',
    box: {
      centre: [500000, 2700000, 131.5],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.3, 1.3, 0.15],
    },
    support: 1800,
    azimuthGridDeg: val(azimuth),
    downtiltDeg: val(4),
    widthM: val(0.3),
    heightM: val(1.3),
    depthM: val(0.15),
    convergenceDeg: 0.5,
    photos: [],
    user: {},
    runId: 'run-a1',
    createdAt: '2026-10-17T09:00:00Z',
    ...over,
  };
}

/** `groundZ: null` leaves the field out. */
export function antennasFile(units: AntennaUnit[], groundZ: number | null = 100): AntennasFile {
  return AntennasFile.parse({
    schema: 'aio.antennas/1',
    run: {
      id: 'run-a1',
      at: '2026-10-17T09:00:00Z',
      params: { run: 'run-a1' },
      cloudLayer: 'cloud-1',
      axis: { point: [0, 0, 0], dir: [0, 0, 1], source: 'auto' },
      crown: { floorZ: 120, topZ: 140, radiusM: 1.2 },
      ...(groundZ === null ? {} : { groundZ }),
      north: 'grid',
      warnings: [],
      counts: { panel: units.length, short: 0, dish: 0, other: 0 },
    },
    units,
  });
}

export const ANTENNA_ENTRY = RfCatalogueEntry.parse({
  kind: 'antenna',
  id: 'ant-x',
  vendor: 'Maker',
  model: 'P1',
  source: 'user',
  verified: true,
  ports: [
    {
      id: 'low',
      bandRangeMhz: [698, 960],
      gainDbi: 15,
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 12,
      frontToBackDb: 28,
      etilt: { minDeg: 2, maxDeg: 10, stepDeg: 1 },
      patterns: [],
    },
    {
      id: 'high',
      bandRangeMhz: [1710, 2690],
      gainDbi: 17,
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 7,
      frontToBackDb: 30,
      etilt: { minDeg: 0, maxDeg: 8, stepDeg: 1 },
      patterns: [],
    },
  ],
});

export const RADIO_ENTRY = RfCatalogueEntry.parse({
  kind: 'radio',
  id: 'rru-x',
  vendor: 'Maker',
  model: 'R1',
  source: 'user',
  verified: true,
  bandRangeMhz: [1710, 2690],
  txPorts: 4,
  rxPorts: 4,
  maxPowerDbmPerPort: 43,
  maxBandwidthMhz: 20,
  mounting: 'tower',
});

export const AAU_ENTRY = RfCatalogueEntry.parse({
  kind: 'aau',
  id: 'aau-x',
  vendor: 'Maker',
  model: 'A1',
  source: 'user',
  verified: true,
  bandRangeMhz: [3300, 3800],
  ports: 64,
  totalPowerDbm: 53,
  ssbGainDbi: 24,
  ssbHBeamwidthDeg: 65,
  ssbVBeamwidthDeg: 8,
  etilt: { minDeg: 3, maxDeg: 9, stepDeg: 1 },
});

/** A ready separate-equipment setup with one LTE 1800 carrier. */
export function lteSettings(
  antennaId: string,
  over: Partial<RfAntennaSettings> = {},
): RfAntennaSettings {
  return {
    antennaId,
    equipment: { kind: 'separate', antenna: 'ant-x', radio: 'rru-x' },
    etiltDeg: 4,
    active: true,
    carriers: [
      { id: 'c1', tech: 'lte', band: 'B3', bandwidthMhz: 20, port: 'high', feederLossDb: 0 },
    ],
    ...over,
  };
}

export function sectorsFile(
  sectors: { id: string; antennaIds: string[] }[],
  antennas: RfAntennaSettings[],
): RfSectorsFile {
  return {
    schema: RF_SECTORS_SCHEMA,
    sectors: sectors.map((s, i) => ({ ...s, name: `S${String(i + 1)}` })),
    antennas,
    study: structuredClone(DEFAULT_RF_STUDY),
  };
}

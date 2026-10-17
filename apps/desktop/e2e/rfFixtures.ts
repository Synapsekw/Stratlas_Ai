/**
 * RF coverage fixture: the tiny project (its own CRS) with a synthetic antenna inventory, made up
 * for the tests (no real site, operator or place). Three accepted panels face 0, 120 and 240
 * degrees grid, 30 m above the tower-base ground, and one draft panel hangs lower on the same
 * tower. There is no `rf/` folder: the RF tab starts from nothing.
 */
import { ANTENNAS_SCHEMA, AntennasFile, type AntennaUnit } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The tower base in the project CRS, close to the tiny project's origin. */
export const RF_SITE = { east: 500_020, north: 3_200_020, groundZ: 0, heightM: 30 } as const;

/** Unit ids: the three accepted panels, then the draft one. */
export const RF_PANELS = ['ant-p1', 'ant-p2', 'ant-p3'] as const;
export const RF_DRAFT = 'ant-p4';

const measured = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const, residualM: 0.004, support: 900, coverage: 0.8 },
});

function panel(
  id: string,
  name: string,
  azimuthDeg: number,
  status: AntennaUnit['status'],
  heightM: number,
): AntennaUnit {
  // a little off the tower axis, towards the panel's own face
  const a = (azimuthDeg * Math.PI) / 180;
  return {
    id,
    name,
    kind: 'panel',
    kindBasis: 'geometry',
    status,
    box: {
      centre: [
        RF_SITE.east + 0.8 * Math.sin(a),
        RF_SITE.north + 0.8 * Math.cos(a),
        RF_SITE.groundZ + heightM,
      ],
      axes: [
        [Math.cos(a), -Math.sin(a), 0],
        [0, 0, 1],
        [Math.sin(a), Math.cos(a), 0],
      ],
      extents: [0.3, 1.3, 0.15],
    },
    support: 1800,
    azimuthGridDeg: measured(azimuthDeg),
    downtiltDeg: measured(2),
    widthM: measured(0.3),
    heightM: measured(1.3),
    depthM: measured(0.15),
    convergenceDeg: 0,
    photos: [],
    user: {},
    runId: 'run-rf-e2e',
    createdAt: '2026-10-17T09:00:00Z',
  };
}

/** The inventory: three accepted panels and one draft. */
export function rfAntennas(): AntennasFile {
  const units = [
    panel(RF_PANELS[0], 'P1', 0, 'accepted', RF_SITE.heightM),
    panel(RF_PANELS[1], 'P2', 120, 'accepted', RF_SITE.heightM),
    panel(RF_PANELS[2], 'P3', 240, 'accepted', RF_SITE.heightM),
    panel(RF_DRAFT, 'P4', 300, 'draft', RF_SITE.heightM - 6),
  ];
  return AntennasFile.parse({
    schema: ANTENNAS_SCHEMA,
    run: {
      id: 'run-rf-e2e',
      at: '2026-10-17T09:00:00Z',
      params: { run: 'run-rf-e2e' },
      cloudLayer: 'tower-cloud',
      axis: { point: [RF_SITE.east, RF_SITE.north, 0], dir: [0, 0, 1], source: 'auto' },
      crown: { floorZ: 22, topZ: 32, radiusM: 1.2 },
      groundZ: RF_SITE.groundZ,
      north: 'grid',
      warnings: [],
      counts: { panel: units.length, short: 0, dish: 0, other: 0 },
    },
    units,
  });
}

/**
 * Turn the tiny project (it has a CRS, `tinyManifest`) into the RF fixture by adding
 * `telecom/antennas.json`. No `rf/` folder is written.
 */
export async function writeRfProject(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, 'telecom'), { recursive: true });
  await writeFile(join(projectDir, 'telecom', 'antennas.json'), JSON.stringify(rfAntennas()));
}

/** `rf/sectors.json` as saved by the RF tab, or null before the first save. */
export async function readRfSectors(projectDir: string): Promise<{
  sectors: { id: string; antennaIds: string[] }[];
  antennas: {
    antennaId: string;
    etiltDeg?: number;
    equipment?: { kind: string; antenna?: string; radio?: string };
    carriers: { tech: string; band: string; bandwidthMhz: number }[];
  }[];
  study: { radiusM: number; gridResolutionM: number };
} | null> {
  try {
    return JSON.parse(await readFile(join(projectDir, 'rf', 'sectors.json'), 'utf8')) as never;
  } catch {
    return null;
  }
}

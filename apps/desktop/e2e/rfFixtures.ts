/**
 * RF coverage fixture: the tiny project (its own CRS) with a synthetic antenna inventory, made up
 * for the tests (no real site, operator or place). Three accepted panels face 0, 120 and 240
 * degrees grid, 30 m above the tower-base ground, and one draft panel hangs lower on the same
 * tower. There is no `rf/` folder: the RF tab starts from nothing.
 */
import {
  ANTENNAS_SCHEMA,
  AntennasFile,
  ProjectManifest,
  RfSectorsFile,
  type AntennaUnit,
} from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tinyManifest } from './fixtures';
import { packPngCloud } from './telecomFixtures';

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

export interface RfFixtureOptions {
  /** Every unit a draft: nothing reviewed yet, so Auto-plan asks for a review first. */
  allDraft?: boolean;
  /**
   * A small tower cloud (`tower-cloud`) beside the quad: the inventory is drawn in the 3D view,
   * with its Labels control, and a selected unit shows its card.
   */
  cloud?: boolean;
}

/** The inventory: three accepted panels and one draft (or four drafts, `allDraft`). */
export function rfAntennas(opts: RfFixtureOptions = {}): AntennasFile {
  const status = opts.allDraft ? 'draft' : 'accepted';
  const units = [
    panel(RF_PANELS[0], 'P1', 0, status, RF_SITE.heightM),
    panel(RF_PANELS[1], 'P2', 120, status, RF_SITE.heightM),
    panel(RF_PANELS[2], 'P3', 240, status, RF_SITE.heightM),
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
export async function writeRfProject(
  projectDir: string,
  opts: RfFixtureOptions = {},
): Promise<void> {
  await mkdir(join(projectDir, 'telecom'), { recursive: true });
  await writeFile(join(projectDir, 'telecom', 'antennas.json'), JSON.stringify(rfAntennas(opts)));
  if (opts.cloud) await writeTowerCloud(projectDir);
}

/**
 * A plain tower in the project's local frame (y up, x east, -z north from the origin): a mast of
 * points up to the panels' height and a ring of ground around its base.
 */
async function writeTowerCloud(projectDir: string): Promise<void> {
  const manifest = tinyManifest();
  const [ox, oy] = manifest.origin;
  const [cx, cz] = [RF_SITE.east - ox, -(RF_SITE.north - oy)];
  const xyz: number[] = [];
  for (let y = 0; y <= RF_SITE.heightM + 2; y += 0.1) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      xyz.push(cx + 0.4 * Math.cos(a), y, cz + 0.4 * Math.sin(a));
    }
  }
  for (let r = 1; r <= 10; r += 1) {
    for (let k = 0; k < 36; k++) {
      const a = (k * Math.PI) / 18;
      xyz.push(cx + r * Math.cos(a), 0, cz + r * Math.sin(a));
    }
  }
  const count = await packPngCloud(projectDir, 'tower', xyz, [170, 178, 186], 0.1);
  manifest.layers.push({
    id: 'tower-cloud',
    name: 'Tower cloud',
    kind: 'pointcloud',
    visible: true,
    format: 'png-packed',
    src: { path: 'cloud/index.json' },
    pointCount: count,
  });
  await writeFile(
    join(projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest)),
  );
}

/**
 * `rf/sectors.json` as saved by the RF tab, parsed with its schema (a file the schema refuses
 * fails the test), or null before the first save.
 */
export async function readRfSectors(projectDir: string): Promise<RfSectorsFile | null> {
  let text: string;
  try {
    text = await readFile(join(projectDir, 'rf', 'sectors.json'), 'utf8');
  } catch {
    return null;
  }
  return RfSectorsFile.parse(JSON.parse(text));
}

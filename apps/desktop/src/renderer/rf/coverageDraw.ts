/**
 * From grids to what the map and the scene draw: corners in lon/lat and in the local frame, the
 * sheet's size and ground height, and the boresight arrows. Pure, with the line-up shift applied
 * once here, so map and scene move together (R9).
 */
import { frameProjection } from '@aio/maps';
import {
  shiftEN,
  type AntennasFile,
  type DateShift,
  type ProjectManifest,
  type RfRun,
} from '@aio/schema';
import type { CoverageGrids } from './coverageGrids';
import { gridCorners } from './coverageGrids';
import { hex, sectorColour } from './coverageRamp';
import type { CoverageMapDraw } from './coverageMap';
import type { SceneArrow } from './coverageScene';
import type { RfUnitRow } from './rfModel';

/** One antenna's boresight: where it is (project CRS, unshifted) and which way it faces. */
export interface Boresight {
  east: number;
  north: number;
  z: number;
  azimuthGridDeg: number;
  downtiltDeg: number;
  sectorIndex: number;
}

const RAD = Math.PI / 180;
/** Map arrow length as a share of the study radius. */
const MAP_ARROW_SHARE = 0.08;
/** Scene arrow length, metres. */
export const SCENE_ARROW_M = 25;

/** The boresights of a run: its antennas as the run used them, by sector. */
export function runBoresights(run: RfRun): Boresight[] {
  const sectorOf = new Map<string, number>();
  run.inputs.sectors.sectors.forEach((s, i) => {
    for (const id of s.antennaIds) sectorOf.set(id, i);
  });
  return run.inputs.antennas.flatMap((a) => {
    const i = sectorOf.get(a.id);
    if (i === undefined || a.azimuthGridDeg === undefined) return [];
    return [
      {
        east: a.centre[0],
        north: a.centre[1],
        z: a.centre[2],
        azimuthGridDeg: a.azimuthGridDeg,
        downtiltDeg: a.downtiltDeg ?? 0,
        sectorIndex: i,
      },
    ];
  });
}

/** The boresights of a preview's participants, from the inventory. */
export function previewBoresights(
  sources: readonly { antennaId: string; sectorId: string }[],
  antennas: AntennasFile | null,
  sectorIds: readonly string[],
): Boresight[] {
  if (!antennas) return [];
  const seen = new Set<string>();
  const out: Boresight[] = [];
  for (const s of sources) {
    if (seen.has(s.antennaId)) continue;
    seen.add(s.antennaId);
    const u = antennas.units.find((x) => x.id === s.antennaId);
    const az = u?.azimuthGridDeg?.value;
    if (!u || az === undefined) continue;
    out.push({
      east: u.box.centre[0],
      north: u.box.centre[1],
      z: u.box.centre[2],
      azimuthGridDeg: az,
      downtiltDeg: u.downtiltDeg?.value ?? 0,
      sectorIndex: Math.max(0, sectorIds.indexOf(s.sectorId)),
    });
  }
  return out;
}

/**
 * Tower-base ground height (project vertical datum) under the shown coverage: the run's antennas'
 * ground, else the participants' centre height minus their height above ground; null if unknown.
 */
export function groundZOf(
  run: RfRun | null,
  rows: readonly RfUnitRow[],
  antennas: AntennasFile | null,
): number | null {
  const zs: number[] = [];
  if (run)
    for (const a of run.inputs.antennas) {
      if (typeof a.groundZ === 'number') zs.push(a.groundZ);
      else if (typeof a.heightM === 'number') zs.push(a.centre[2] - a.heightM);
    }
  else
    for (const r of rows) {
      if (r.excluded !== null || r.height.heightM === null) continue;
      if (r.height.groundZ !== null) zs.push(r.height.groundZ);
      else {
        const u = antennas?.units.find((x) => x.id === r.id);
        if (u) zs.push(u.box.centre[2] - r.height.heightM);
      }
    }
  if (zs.length === 0) return antennas?.run.groundZ ?? null;
  return zs.reduce((a, b) => a + b, 0) / zs.length;
}

type LonLat = [number, number];

/** The map's image corners and arrows; null without a projection (no CRS the map knows). */
export function mapPlacement(
  g: CoverageGrids,
  manifest: Pick<ProjectManifest, 'crs' | 'origin'>,
  shift: DateShift | null,
  bores: readonly Boresight[],
): { corners: [LonLat, LonLat, LonLat, LonLat]; arrows: CoverageMapDraw['arrows'] } | null {
  const proj = frameProjection(manifest.crs, manifest.origin);
  if (!proj) return null;
  const [ox, oy] = manifest.origin;
  const ll = (e: number, n: number): LonLat => {
    const p = proj.toLonLat([e - ox, 0, oy - n]);
    return [p[0], p[1]];
  };
  const [tl, tr, br, bl] = gridCorners(g.grid, shift).map(([e, n]) => ll(e, n));
  const radius = (g.grid.width * g.grid.resolutionM) / 2;
  const L = radius * MAP_ARROW_SHARE;
  const arrows = bores.map((b) => {
    const [e, n] = shiftEN([b.east, b.north] as [number, number], shift);
    const a = b.azimuthGridDeg * RAD;
    const tip: [number, number] = [e + L * Math.sin(a), n + L * Math.cos(a)];
    const head = (turn: number): [number, number] => [
      tip[0] - 0.22 * L * Math.sin(a + turn),
      tip[1] - 0.22 * L * Math.cos(a + turn),
    ];
    const left = head(0.45);
    const right = head(-0.45);
    return {
      path: [
        ll(e, n),
        ll(tip[0], tip[1]),
        ll(left[0], left[1]),
        ll(tip[0], tip[1]),
        ll(right[0], right[1]),
      ],
      colour: hex(sectorColour(b.sectorIndex)),
    };
  });
  return { corners: [tl ?? [0, 0], tr ?? [0, 0], br ?? [0, 0], bl ?? [0, 0]], arrows };
}

/** The scene sheet's local centre and size, and the arrows, line-up shift applied. */
export function scenePlacement(
  g: CoverageGrids,
  origin: readonly [number, number, number],
  shift: DateShift | null,
  bores: readonly Boresight[],
): { centre: [number, number]; sizeM: [number, number]; arrows: SceneArrow[] } {
  const sizeE = g.grid.width * g.grid.resolutionM;
  const sizeN = g.grid.height * g.grid.resolutionM;
  const [ce, cn] = shiftEN(
    [g.grid.originEast + sizeE / 2, g.grid.originNorth - sizeN / 2] as [number, number],
    shift,
  );
  const arrows = bores.map((b): SceneArrow => {
    const [e, n] = shiftEN([b.east, b.north] as [number, number], shift);
    const a = b.azimuthGridDeg * RAD;
    const t = b.downtiltDeg * RAD;
    return {
      from: [e - origin[0], b.z - origin[2], -(n - origin[1])],
      // grid north is -z, east is +x; a positive downtilt points down
      dir: [Math.sin(a) * Math.cos(t), -Math.sin(t), -Math.cos(a) * Math.cos(t)],
      lengthM: SCENE_ARROW_M,
      colour: hex(sectorColour(b.sectorIndex)),
    };
  });
  return { centre: [ce - origin[0], -(cn - origin[1])], sizeM: [sizeE, sizeN], arrows };
}

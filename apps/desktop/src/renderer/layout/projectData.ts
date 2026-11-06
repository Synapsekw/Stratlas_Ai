/**
 * What a project holds, as the layout presets read it (D7): the layer kinds of its manifest, its
 * dated surveys, and what the stores have read beside it (piles, a road, antennas, thermal
 * photos). A preset value the data cannot honour falls back (`applyPreset`); the data, never the
 * project type, decides what exists.
 */
import type { ProjectManifest } from '@aio/schema';
import { datedCount } from '../workspace/timelinePref';
import type { PanelData } from '../workspace/workbench/tabsModel';

export interface ProjectData {
  /** No layer at all yet (a project just made): its 3D view holds the import hint. */
  empty: boolean;
  /** The active space can show the map (false only for a space with its own local frame). */
  map: boolean;
  video: boolean;
  walks: boolean;
  panoramas: boolean;
  photos: boolean;
  pointcloud: boolean;
  mesh: boolean;
  ortho: boolean;
  dsm: boolean;
  /** Two or more survey dates. */
  dated: boolean;
  piles: boolean;
  road: boolean;
  antennas: boolean;
  thermal: boolean;
}

export const NO_PROJECT_DATA: ProjectData = {
  empty: false,
  // a map is there unless a space has its own frame
  map: true,
  video: false,
  walks: false,
  panoramas: false,
  photos: false,
  pointcloud: false,
  mesh: false,
  ortho: false,
  dsm: false,
  dated: false,
  piles: false,
  road: false,
  antennas: false,
  thermal: false,
};

/** What the stores beside the manifest have read. */
export interface StoreData {
  map: boolean;
  piles: boolean;
  road: boolean;
  antennas: boolean;
  thermal: boolean;
}

type Manifest = Pick<ProjectManifest, 'layers' | 'captures'>;

export function projectData(manifest: Manifest, stores: StoreData): ProjectData {
  const has = (kind: string) => manifest.layers.some((l) => l.kind === kind);
  const raster = (role: string) =>
    manifest.layers.some((l) => l.kind === 'raster' && l.role === role);
  return {
    empty: manifest.layers.length === 0,
    video: has('video'),
    walks: has('walk'),
    panoramas: has('panoramas'),
    photos: has('photos'),
    pointcloud: has('pointcloud'),
    mesh: has('mesh'),
    ortho: raster('ortho'),
    dsm: raster('dsm'),
    dated: datedCount(manifest.captures) >= 2,
    ...stores,
  };
}

/** A store's read: the project it is for, and how far it got. */
export interface StoreRead {
  projectId: string | null;
  status: string;
}

/** The read is this project's and done (an error is done too: nothing more will come). */
export function readDone(projectId: string, read: StoreRead): boolean {
  return read.projectId === projectId && read.status !== 'idle' && read.status !== 'loading';
}

/**
 * Whether the stores beside the manifest hold this project's data yet (its measurements and its
 * volumes): the layout applies only then, so one project's piles never decide another's opening.
 */
export function storesSettled(projectId: string, reads: readonly StoreRead[]): boolean {
  return reads.every((r) => readDone(projectId, r));
}

/** The same data as the right panel's sections and the tool registry read it. */
export function panelDataOf(d: ProjectData): PanelData {
  const model3d = d.pointcloud || d.mesh;
  return {
    pointcloud: d.pointcloud,
    model3d,
    surface: model3d || d.ortho || d.dsm,
    video: d.video,
    photos: d.photos || d.panoramas,
    dated: d.dated,
    volumes: d.piles,
    road: d.road,
    flightlines: false,
  };
}

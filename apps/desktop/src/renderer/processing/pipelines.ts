/**
 * The pipelines in a person's words: their area (the Advanced list in Settings), a job's plain
 * title, and its kind (the tag on a row of the project's Processing drawer). The pipeline titles
 * and descriptions are the frozen contract of `@aio/schema`; the plain words live here.
 */
import { PIPELINES, type PipelineName } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

// ---------------------------------------------------------------- pipelines by area

export type PipelineGroupId =
  | 'photos'
  | 'inspection'
  | 'volumes'
  | 'change'
  | 'survey'
  | 'water'
  | 'import'
  | 'packs'
  | 'road'
  | 'system';

/** The areas of the Advanced list, in the order they show. */
export const PIPELINE_GROUPS: readonly { id: PipelineGroupId; label: string }[] = [
  { id: 'photos', label: 'Photos to maps' },
  { id: 'inspection', label: 'Inspection' },
  { id: 'volumes', label: 'Stockpiles and volumes' },
  { id: 'change', label: 'Change between dates' },
  { id: 'survey', label: 'Survey tools' },
  { id: 'water', label: 'Water and haul roads' },
  { id: 'import', label: 'Import and convert' },
  { id: 'packs', label: 'Map packs' },
  { id: 'road', label: 'Road survey' },
  { id: 'system', label: 'System' },
];

/**
 * The area of every pipeline. A `Record` over `PipelineName`: a pipeline added to the schema
 * without an area here does not compile, and `pipelines.test.ts` fails on it.
 */
export const PIPELINE_GROUP: Record<PipelineName, PipelineGroupId> = {
  'photo.align': 'photos',
  'photo.georef': 'photos',
  'photo.products': 'photos',
  'aik.cameras': 'inspection',
  'aik.project': 'inspection',
  'aik.records': 'inspection',
  'inspection.run': 'inspection',
  'volumetric.process': 'volumes',
  'volumetric.build': 'volumes',
  'change.raster': 'change',
  'change.surface': 'change',
  'change.cloud': 'change',
  'change.mesh': 'change',
  'change.frames': 'change',
  'change.lineup': 'change',
  'survey.prepare': 'survey',
  'survey.compare': 'survey',
  'survey.overlay': 'survey',
  'survey.section': 'survey',
  'survey.export': 'survey',
  'survey.qa': 'survey',
  'survey.cleanup': 'survey',
  'geo.calibration': 'survey',
  'hydro.flood': 'water',
  'hydro.flow': 'water',
  'hydro.rainfall': 'water',
  'haul.analyse': 'water',
  'walk.process': 'import',
  'pano.stitch': 'import',
  'model.evidence': 'import',
  'pointcloud.to_copc': 'import',
  'pointcloud.clean': 'import',
  'drawing.import': 'import',
  'design.import': 'import',
  'opf.import': 'import',
  'opf.export': 'import',
  'bentley.import': 'import',
  'model.fit_cloud': 'import',
  'tiles.mesh': 'import',
  'tiles.cloud': 'import',
  'packs.imagery': 'packs',
  'packs.terrain': 'packs',
  'road.build': 'road',
  'system.selftest': 'system',
};

export interface PipelineInfo {
  name: string;
  title: string;
  description: string;
}

const groupOf = (name: string): PipelineGroupId | undefined =>
  (PIPELINE_GROUP as Partial<Record<string, PipelineGroupId>>)[name];

/** Pipelines of `list` that have no area (none, unless the schema grew without this file). */
export function ungroupedPipelines(list: readonly PipelineInfo[] = PIPELINES): string[] {
  return list.filter((p) => groupOf(p.name) === undefined).map((p) => p.name);
}

/**
 * The pipelines by area, for the `<optgroup>`s of the Advanced list: every pipeline of `list`
 * exactly once, in the list's order inside its area. A pipeline without an area is never hidden:
 * it shows in a last group, **Other**.
 */
export function groupedPipelines<T extends PipelineInfo>(
  list: readonly T[],
): { id: PipelineGroupId | 'other'; label: string; pipelines: T[] }[] {
  const groups: { id: PipelineGroupId | 'other'; label: string; pipelines: T[] }[] =
    PIPELINE_GROUPS.map((g) => ({
      ...g,
      pipelines: list.filter((p) => groupOf(p.name) === g.id),
    }));
  const other = list.filter((p) => groupOf(p.name) === undefined);
  if (other.length) groups.push({ id: 'other', label: 'Other', pipelines: other });
  return groups.filter((g) => g.pipelines.length > 0);
}

// ---------------------------------------------------------------- job titles in plain words

/** Jobs of **Create maps from photos** read as one activity in the list, not as three pipelines. */
const PLAIN_TITLES: Partial<Record<PipelineName, string>> = {
  'photo.align': 'Maps from photos: matching the photos',
  'photo.georef': 'Maps from photos: ground control',
  'photo.products': 'Maps from photos: building the maps',
};

/** A job's title in the list and its details: plain words where there are any, else the pipeline's. */
export function jobTitle(name: PipelineName): string {
  return PLAIN_TITLES[name] ?? PIPELINES.find((p) => p.name === name)?.title ?? name;
}

// ---------------------------------------------------------------- the kind of a job

/** What a job is, for the tag on its row: map processing and AI work are told apart at a glance. */
export type JobKind = 'maps' | 'survey' | 'ai' | 'files' | 'system';

/**
 * The kind of every pipeline. A `Record` over `PipelineName`: a pipeline added to the schema
 * without a kind here does not compile, and `pipelines.test.ts` fails on it.
 */
export const JOB_KIND: Record<PipelineName, JobKind> = {
  'photo.align': 'maps',
  'photo.georef': 'maps',
  'photo.products': 'maps',
  'model.fit_cloud': 'maps',
  'volumetric.process': 'survey',
  'volumetric.build': 'survey',
  'change.raster': 'survey',
  'change.surface': 'survey',
  'change.cloud': 'survey',
  'change.mesh': 'survey',
  'change.frames': 'survey',
  'change.lineup': 'survey',
  'survey.prepare': 'survey',
  'survey.compare': 'survey',
  'survey.overlay': 'survey',
  'survey.section': 'survey',
  'survey.qa': 'survey',
  'survey.cleanup': 'survey',
  'geo.calibration': 'survey',
  'hydro.flood': 'survey',
  'hydro.flow': 'survey',
  'hydro.rainfall': 'survey',
  'haul.analyse': 'survey',
  'walk.process': 'maps',
  'pano.stitch': 'maps',
  'model.evidence': 'maps',
  'road.build': 'survey',
  'aik.cameras': 'ai',
  'aik.project': 'ai',
  'aik.records': 'ai',
  'inspection.run': 'ai',
  'pointcloud.to_copc': 'files',
  'pointcloud.clean': 'files',
  'drawing.import': 'files',
  'design.import': 'files',
  'opf.import': 'files',
  'opf.export': 'files',
  'bentley.import': 'files',
  'tiles.mesh': 'files',
  'tiles.cloud': 'files',
  'survey.export': 'files',
  'packs.imagery': 'system',
  'packs.terrain': 'system',
  'system.selftest': 'system',
};

export const KIND_LABEL: Record<JobKind, MessageKey> = {
  maps: 'processing.kind.maps',
  survey: 'processing.kind.survey',
  ai: 'processing.kind.ai',
  files: 'processing.kind.files',
  system: 'processing.kind.system',
};

/** A job's kind. A pipeline this version does not know (a newer pack) is System. */
export function jobKind(name: string): JobKind {
  return (JOB_KIND as Partial<Record<string, JobKind>>)[name] ?? 'system';
}

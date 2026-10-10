/**
 * The Jobs screen in a person's words. **New job** offers a short list of tasks, each a real
 * starting point with a guided entry somewhere in the app; the pipelines themselves stay
 * available under **Advanced**, grouped by area. The pipeline titles and descriptions are the
 * frozen contract of `@aio/schema`; the plain words and the grouping live here.
 */
import { PIPELINES, type PipelineName } from '@aio/schema';
import type { IconName } from '@aio/ui';

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
 * without an area here does not compile, and `jobTasks.test.ts` fails on it.
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
  'pointcloud.to_copc': 'import',
  'drawing.import': 'import',
  'design.import': 'import',
  'opf.import': 'import',
  'opf.export': 'import',
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

// ---------------------------------------------------------------- the tasks of New job

export type JobTaskId =
  | 'photo-maps'
  | 'model'
  | 'changes'
  | 'site-cut-fill'
  | 'survey-check'
  | 'overlays'
  | 'stockpiles'
  | 'import'
  | 'export';

export type JobTaskSection = 'maps' | 'measure' | 'import';

export interface JobTask {
  id: JobTaskId;
  section: JobTaskSection;
  title: string;
  hint: string;
  icon: IconName;
  /** The pipelines this task ends up running, through its own guided screen. */
  pipelines: readonly PipelineName[];
  /** What the task needs before it can open: an open project, or one with two survey dates. */
  needs: 'nothing' | 'project' | 'two-dates';
}

export const JOB_TASK_SECTIONS: readonly { id: JobTaskSection; label: string }[] = [
  { id: 'maps', label: 'Maps and models' },
  { id: 'measure', label: 'Measure and compare' },
  { id: 'import', label: 'Import and convert' },
];

/** The first task of the chooser, and the Jobs screen's primary action. */
export const PRIMARY_TASK: JobTaskId = 'photo-maps';

/**
 * The tasks **New job** offers, in order. Each opens a guided screen that already exists; none
 * has a form of its own here. A pipeline with no guided screen is not offered as a task: it stays
 * in the Advanced list.
 */
export const JOB_TASKS: readonly JobTask[] = [
  {
    id: 'photo-maps',
    section: 'maps',
    title: 'Create maps from photos',
    hint: 'Drone photos in, a photo map, surface models and a 3D model out.',
    icon: 'photo',
    pipelines: ['photo.align', 'photo.georef', 'photo.products'],
    needs: 'project',
  },
  {
    id: 'model',
    section: 'maps',
    title: 'Build a model from a drawing or point cloud',
    hint: 'Place a DXF plot plan, or fit tanks, buildings and pipes to a point cloud.',
    icon: 'plant',
    pipelines: ['drawing.import', 'model.fit_cloud'],
    needs: 'project',
  },
  {
    id: 'changes',
    section: 'measure',
    title: 'Compare two survey dates',
    hint: 'What changed between two dates: imagery, surfaces, point clouds and models.',
    icon: 'history',
    pipelines: ['change.raster', 'change.surface', 'change.cloud', 'change.mesh', 'change.frames'],
    needs: 'two-dates',
  },
  {
    id: 'site-cut-fill',
    section: 'measure',
    title: 'Cut and fill for the whole site',
    hint: 'Volumes between two surfaces, or against a design.',
    icon: 'pile',
    pipelines: ['survey.compare'],
    needs: 'project',
  },
  {
    id: 'survey-check',
    section: 'measure',
    title: 'Check a survey',
    hint: 'Against checkpoints and the previous survey. Cleanup and crop are beside it.',
    icon: 'shield',
    pipelines: ['survey.qa', 'survey.cleanup', 'survey.prepare'],
    needs: 'project',
  },
  {
    id: 'overlays',
    section: 'measure',
    title: 'Contours, slope and relief',
    hint: 'Terrain overlays of a surface, or of the difference between two.',
    icon: 'layers',
    pipelines: ['survey.overlay'],
    needs: 'project',
  },
  {
    id: 'stockpiles',
    section: 'measure',
    title: 'Measure stockpiles',
    hint: 'A new Volumetric project from the surfaces or point clouds of each survey date.',
    icon: 'ruler',
    pipelines: ['volumetric.build'],
    needs: 'nothing',
  },
  {
    id: 'import',
    section: 'import',
    title: 'Import files',
    hint: 'Point clouds, drawings, designs and OPF projects are converted as they come in.',
    icon: 'import',
    pipelines: ['pointcloud.to_copc', 'drawing.import', 'design.import', 'opf.import'],
    needs: 'project',
  },
  {
    id: 'export',
    section: 'import',
    title: 'Export survey data',
    hint: 'Surfaces, maps, clouds, contours and measurements in the formats others use.',
    icon: 'download',
    pipelines: ['survey.export'],
    needs: 'project',
  },
];

export interface TaskContext {
  /** A project is open. */
  project: boolean;
  /** Survey dates of the open project. */
  surveyDates: number;
}

/** Why a task cannot open right now, in words, or null when it can. */
export function taskBlocked(task: JobTask, ctx: TaskContext): string | null {
  if (task.needs === 'nothing') return null;
  if (!ctx.project) return 'Open a project first.';
  if (task.needs === 'two-dates' && ctx.surveyDates < 2)
    return 'This project needs two survey dates.';
  return null;
}

/** The tasks of one section, in order. */
export const tasksOf = (section: JobTaskSection): JobTask[] =>
  JOB_TASKS.filter((t) => t.section === section);

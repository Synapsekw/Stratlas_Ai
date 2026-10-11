/**
 * The tasks **New job** offers. Removed with the Jobs screen; the pipelines' areas, titles and
 * kinds live in `processing/pipelines.ts`.
 */
import type { PipelineName } from '@aio/schema';
import type { IconName } from '@aio/ui';

export {
  groupedPipelines,
  jobTitle,
  PIPELINE_GROUP,
  PIPELINE_GROUPS,
  ungroupedPipelines,
  type PipelineGroupId,
  type PipelineInfo,
} from '../processing/pipelines';

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

/**
 * Read tools for the data the app gained since mid-October (A2, agent.md 4.5): survey dates,
 * measurements and volumes, where findings gather, detections, jobs, thermal and walks. Specs
 * here (both processes); executors in survey-tools.ts (measurements, volumes, ranking) and in the
 * desktop renderer (agent/dataTools.ts: dates, detections, jobs, thermal, walks).
 */
import { z } from 'zod';
import type { ToolSpec } from './tools';

const Ref = z.string().min(1).max(200);
const Limit = (n: number) => z.number().int().min(1).max(200).default(n);

export const surveyToolInputs = {
  list_surveys: z.object({}).strict(),
  set_survey_date: z
    .object({
      date: Ref.describe('Capture id, date (YYYY-MM-DD), name, or "earliest" or "latest"'),
    })
    .strict(),
  list_measurements: z
    .object({
      tool: z
        .enum(['volume', 'distance', 'area', 'elevation', 'section', 'other'])
        .optional()
        .describe('Only this kind'),
      text: z.string().max(200).optional().describe('Name contains'),
      date: Ref.optional().describe('Only measurements filed under this survey date'),
      limit: Limit(50),
    })
    .strict(),
  get_volume: z
    .object({
      measurement: Ref.optional().describe(
        'Volume measurement id or name (e.g. "SP1"); default every pile',
      ),
      date: Ref.optional().describe('Survey date (id, date or name); default every date'),
    })
    .strict(),
  rank_locations: z
    .object({
      by: z
        .enum(['position', 'zone'])
        .default('position')
        .describe('Cluster findings by position (cellM grid) or by zone name'),
      cellM: z.number().min(1).max(1000).default(20),
      status: z.enum(['open', 'all']).default('open'),
      where: Ref.optional().describe(
        'Only findings on an asset tag, an area, or "selection"; default the whole project',
      ),
      limit: Limit(10),
    })
    .strict(),
  list_detections: z
    .object({
      status: z.enum(['draft', 'accepted', 'rejected', 'all']).default('draft'),
      classId: Ref.optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      limit: Limit(30),
    })
    .strict(),
  review_detections: z
    .object({
      ids: z.array(Ref).min(1).max(200).describe('Detection ids from list_detections'),
      decision: z
        .enum(['accept', 'reject', 'reopen'])
        .describe('accept: each becomes a draft issue; reject; reopen: back to waiting'),
    })
    .strict(),
  list_jobs: z
    .object({
      active: z.boolean().default(false).describe('Only running or starting jobs'),
      limit: Limit(15),
    })
    .strict(),
  thermal_summary: z
    .object({
      layer: Ref.optional().describe('Photos layer id or name; default every thermal layer'),
      limit: Limit(10),
    })
    .strict(),
  list_walks: z.object({}).strict(),
} as const;

export type SurveyToolName = keyof typeof surveyToolInputs;
export type SurveyToolInput<N extends SurveyToolName> = z.output<(typeof surveyToolInputs)[N]>;

const S = (
  name: SurveyToolName,
  risk: 'read' | 'navigate' | 'write',
  description: string,
  undoable = false,
): ToolSpec => ({
  meta: { name, description, scope: 'project', risk },
  input: surveyToolInputs[name],
  undoable,
});

export const SURVEY_TOOL_SPECS: ToolSpec[] = [
  S(
    'list_surveys',
    'read',
    'The survey dates (captures) of the project, oldest first: id, date, name, layer count, which one is in view.',
  ),
  S('set_survey_date', 'navigate', 'Bring a survey date into view, as the date strip does.', true),
  S(
    'list_measurements',
    'read',
    'Measurements (distances, areas, volumes, sections...) with id, name, kind, survey date, folder and figure.',
  ),
  S(
    'get_volume',
    'read',
    'Stockpile volumes as their cards show them: per pile and survey date the net, cut and fill m³, area, peak height, base, tonnes when the pile has a material, stale figures flagged; totals per date.',
  ),
  S(
    'rank_locations',
    'read',
    'Where findings gather: clusters by position or zone, scored by severity and count, worst first, each with a point for fly_to.',
  ),
  S(
    'list_detections',
    'read',
    'Detections waiting for review (or accepted, rejected): counts by status and class, and rows with id, class, confidence, photo.',
  ),
  S(
    'review_detections',
    'write',
    'Accept (each becomes a draft issue), reject or reopen detections. The app asks for approval first.',
    true,
  ),
  S(
    'list_jobs',
    'read',
    "The project's processing jobs, newest first: pipeline, status, progress, message, times.",
  ),
  S(
    'thermal_summary',
    'read',
    'Thermal results: per layer the photos, readings and hot spots (peak, delta-T, severity, state), hottest first.',
  ),
  S(
    'list_walks',
    'read',
    'Walk-through videos (360 walks): id, name, survey date, length, processed, placed and placement quality.',
  ),
];

/** The ones this package runs (survey-tools.ts); the rest run in the desktop renderer. */
const IN_PACKAGE = new Set(['list_measurements', 'get_volume', 'rank_locations']);
export const SURVEY_PACKAGE_SPECS = SURVEY_TOOL_SPECS.filter((s) => IN_PACKAGE.has(s.meta.name));
/** Registered with `registerToolSpec`: their executors come with the desktop app. */
export const SURVEY_HOST_SPECS = SURVEY_TOOL_SPECS.filter((s) => !IN_PACKAGE.has(s.meta.name));

/** Tools that need data the project may not have (`AgentFacts` key), for `fitsProject`. */
export const SURVEY_TOOL_NEEDS: Readonly<
  Record<string, 'captures' | 'measurements' | 'volumes' | 'detections' | 'thermal' | 'walks'>
> = {
  list_surveys: 'captures',
  set_survey_date: 'captures',
  list_measurements: 'measurements',
  get_volume: 'volumes',
  list_detections: 'detections',
  review_detections: 'detections',
  thermal_summary: 'thermal',
  list_walks: 'walks',
};

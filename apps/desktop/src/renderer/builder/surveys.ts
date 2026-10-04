import { pipelineParams } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

/**
 * Survey dates of a new volumetric project (the wizard's last step): per date a DSM GeoTIFF or a
 * point cloud, and optionally an orthomosaic. They become a `volumetric.build` job that runs the
 * Volumetric Survey Kit once the project exists.
 */
export interface SurveyInput {
  date: string;
  dsm: string;
  cloud: string;
  ortho: string;
}

/** The kit compares two dates (cut and fill between them); one date gives volumes only. */
export const MAX_SURVEYS = 2;

export const RASTER_FILTERS = [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }];
export const CLOUD_FILTERS = [{ name: 'Point cloud', extensions: ['las', 'laz', 'e57', 'ply'] }];

export const emptySurvey = (date = ''): SurveyInput => ({ date, dsm: '', cloud: '', ortho: '' });

/** File name of a path, for display. */
export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** True when nothing was entered: the project is created without a build. */
export function noSurveys(list: readonly SurveyInput[]): boolean {
  return list.every((s) => !s.dsm && !s.cloud && !s.ortho);
}

/** What blocks the build, as an i18n key, or null. */
export function surveyProblem(list: readonly SurveyInput[]): MessageKey | null {
  if (noSurveys(list)) return null;
  for (const s of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return 'builder.surveys.needDate';
    if (!s.dsm && !s.cloud) return 'builder.surveys.needSurface';
  }
  if (new Set(list.map((s) => s.date)).size !== list.length) return 'builder.surveys.sameDate';
  return null;
}

/** The `volumetric.build` params: surveys in date order as e1, e2; validated by the schema. */
export function buildParams(list: readonly SurveyInput[]): Record<string, unknown> {
  const epochs = [...list]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s, i) => ({
      id: `e${String(i + 1)}`,
      date: s.date,
      ...(s.dsm ? { dsm: s.dsm } : { cloud: s.cloud }),
      ...(s.ortho ? { ortho: s.ortho } : {}),
    }));
  const r = pipelineParams('volumetric.build').safeParse({ config: { epochs } });
  if (!r.success) throw new Error(r.error.issues[0]?.message ?? 'Invalid surveys');
  return r.data;
}

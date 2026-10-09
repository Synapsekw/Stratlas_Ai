/**
 * Whether the site's readout tables (`survey/geodesy/site-transform.json`, written by
 * `survey.prepare` through G1's `write_site_tables`) still match the site settings, and how they
 * are written again (M11 G1, data-conventions section 25).
 *
 * The tables are made with the display CRS, the vertical datum and the applied calibration of the
 * moment. After a person applies or removes a calibration or changes the site settings they are
 * stale: the cursor must not show coordinates through them. `siteTablesStale` says so from the
 * header alone; `refreshSiteTables` re-runs `survey.prepare` on one prepared surface (its source is
 * unchanged, so it is skipped and only the tables are written again, over the extent of every
 * prepared surface).
 */
import type { HeightTiles, ProjectManifest, SurveySettings } from '@aio/schema';
import { bridge } from '../shell';

type Crs = ProjectManifest['crs'];

/** The parts of the `aio.site-transform/1` header the check reads. */
export interface SiteTablesHeader {
  to?: Crs;
  calibration?: string;
  geoid?: string;
  geoidGrid?: unknown;
}

/**
 * Why the tables no longer match the settings, or null when they do. `dataCrs` is the manifest
 * `crs` (the display CRS when the settings name none).
 */
export function siteTablesStale(
  header: SiteTablesHeader,
  settings: SurveySettings,
  dataCrs: Crs,
): string | null {
  const cal = settings.calibration ?? null;
  if ((header.calibration ?? null) !== cal) {
    return cal
      ? 'the site calibration was applied after they were made'
      : 'the site calibration was removed after they were made';
  }
  if (!cal && header.to) {
    const display = settings.crs ?? dataCrs;
    if ('epsg' in display && 'epsg' in header.to && display.epsg !== header.to.epsg) {
      return 'the display coordinate system changed after they were made';
    }
  }
  const vd = settings.verticalDatum;
  if (vd.kind === 'geoid' && header.geoid !== vd.geoid) {
    return 'the geoid changed after they were made';
  }
  const heights = vd.kind !== 'project' || cal !== null;
  if (heights !== Boolean(header.geoidGrid)) {
    return 'the vertical datum changed after they were made';
  }
  return null;
}

/** The `survey.prepare` surface that rewrites the tables: a prepared DSM first, else any. */
export function refreshSurface(
  surfaces: readonly HeightTiles[],
): { id: string; name: string; source: HeightTiles['source']; capture?: string } | null {
  const pick = surfaces.find((s) => s.source.kind === 'dsm') ?? surfaces[0];
  if (!pick) return null;
  return {
    id: pick.id,
    name: pick.name,
    source: pick.source,
    ...(pick.capture ? { capture: pick.capture } : {}),
  };
}

/**
 * Write the site tables again through `survey.prepare`; `done` runs when the job ends (the tables
 * are read again then). Answers an error, or null when the job started or there is nothing
 * prepared (then there are no tables to bring up to date).
 */
export async function refreshSiteTables(
  project: { id: string; root: string },
  done: () => void,
): Promise<string | null> {
  const listed = await bridge.call('survey:surfaces', { projectId: project.id });
  if (!listed.ok) return listed.error;
  if (!listed.value.ok) return listed.value.error;
  const surface = refreshSurface(listed.value.surfaces);
  if (!surface) return null;
  const r = await bridge.call('jobs:start', {
    pipeline: 'survey.prepare',
    project: project.root,
    params: { surfaces: [surface] },
  });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  const jobId = r.value.job.id;
  const aio = window.aio as typeof window.aio | undefined;
  const off = aio?.on('jobs:event', (e) => {
    if (e.type !== 'update' || e.job.id !== jobId) return;
    if (e.job.status === 'done' || e.job.status === 'failed' || e.job.status === 'cancelled') {
      off?.();
      done();
    }
  });
  return null;
}

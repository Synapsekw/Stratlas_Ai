/**
 * The street map of the open project's 3D view, read from the stores: the remembered choice
 * (`siteBasemap.ts`), the pack that covers the site, and the landscape from packs it gives way to
 * (`siteTiles.ts`). The layer (`useSiteBasemapLayer`) and the toolbar button share it.
 */
import { useWorkspace } from '@aio/workspace';
import {
  landscapeOn,
  siteBasemapOn,
  useSiteBasemap,
  wantsSiteBasemap,
  type StreetMap3d,
} from './siteBasemap';
import { useGround, useRasterPacks } from './siteTiles';

export function useStreetMap3d(): StreetMap3d {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const wanted = useWorkspace((s) => (s.project ? wantsSiteBasemap(s.project.manifest) : false));
  const on = useSiteBasemap((s) => (projectId ? siteBasemapOn(s.choices, projectId) : false));
  const covered = useSiteBasemap((s) => s.covered);
  const prefs = useRasterPacks((s) => s.prefs);
  const landscape = landscapeOn(prefs, useGround());
  return { projectId, wanted, on, covered, landscape, shown: wanted && on && !landscape };
}

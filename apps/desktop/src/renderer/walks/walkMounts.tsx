/**
 * The 360 video pane on the split's mount point (`EXTRA_PANES`), registered once (imported by
 * `workspace/m8Mounts.tsx`, which the stage loads). Kept in its own module so the pane and the
 * mount point never import each other. Satellite under a walk placed on the map is wired here too
 * (`placeBasemap.ts`), where the map's packs are already loaded.
 */
import { workspace } from '@aio/workspace';
import { basemapModel, siteLonLat } from '../workspace/basemap';
import { rasterPacks } from '../workspace/siteTiles';
import { EXTRA_PANES } from '../workspace/SplitPanes';
import { followPlaceBasemap } from './placeBasemap';
import { placeSession } from './placeWalk';
import { Walk360Pane } from './Walk360Pane';

EXTRA_PANES.walk360 = {
  label: 'walk.pane',
  icon: 'pano',
  zone: 'video',
  render: () => <Walk360Pane />,
};

followPlaceBasemap(placeSession, rasterPacks, () => {
  const r = rasterPacks.getState();
  const site = siteLonLat(workspace.getState().project?.manifest ?? null);
  return basemapModel(r.prefs, r.imagery, r.terrain, site).satellite;
});

/**
 * The 360 video pane on the split's mount point (`EXTRA_PANES`), registered once (imported by
 * `workspace/m8Mounts.tsx`, which the stage loads). Kept in its own module so the pane and the
 * mount point never import each other.
 */
import { EXTRA_PANES } from '../workspace/SplitPanes';
import { Walk360Pane } from './Walk360Pane';

EXTRA_PANES.walk360 = {
  label: 'walk.pane',
  icon: 'pano',
  zone: 'video',
  render: () => <Walk360Pane />,
};

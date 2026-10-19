/**
 * The M8 streams' tools and panes on C1's mount points, registered once (imported by the stage):
 * C2's Side by side, Swipe and Blend bar beside Compare dates (`COMPARE_TOOLS`), the line-up chip
 * in that bar's row (`COMPARE_VIEW_TOOLS`) and C4's Frames pane in the split (`EXTRA_PANES`). Kept in its own module so the stream modules and the mount
 * points never import each other (no import cycle through `SplitPanes`).
 */
import { CompareLineUp } from '../lineup/CompareLineUp';
import { COMPARE_TOOLS } from './CompareControls';
import { FramesPane } from './FramesPane';
import { COMPARE_VIEW_TOOLS, CompareViewControls } from './MapSwipe';
import { EXTRA_PANES } from './SplitPanes';
// the 360 video pane registers itself on the same mount point (walks/walkMounts.tsx)
import '../walks/walkMounts';

if (!COMPARE_TOOLS.includes(CompareViewControls)) COMPARE_TOOLS.push(CompareViewControls);
// whether the two dates line up, with Line up (lineup/CompareLineUp.tsx), in the row under the
// island beside Side by side, Swipe and Blend
if (!COMPARE_VIEW_TOOLS.includes(CompareLineUp)) COMPARE_VIEW_TOOLS.push(CompareLineUp);

EXTRA_PANES.frames = {
  label: 'frames.pane',
  icon: 'history',
  zone: 'video',
  render: () => <FramesPane />,
};

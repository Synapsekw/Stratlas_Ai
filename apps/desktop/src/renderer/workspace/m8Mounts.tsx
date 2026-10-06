/**
 * The M8 streams' tools and panes on C1's mount points, registered once (imported by the stage):
 * C2's Side by side, Swipe and Blend bar beside Compare dates (`COMPARE_TOOLS`) and C4's Frames
 * pane in the split (`EXTRA_PANES`). Kept in its own module so the stream modules and the mount
 * points never import each other (no import cycle through `SplitPanes`).
 */
import { COMPARE_TOOLS } from './CompareControls';
import { FramesPane } from './FramesPane';
import { CompareViewControls } from './MapSwipe';
import { EXTRA_PANES } from './SplitPanes';

if (!COMPARE_TOOLS.includes(CompareViewControls)) COMPARE_TOOLS.push(CompareViewControls);

EXTRA_PANES.frames = {
  label: 'frames.pane',
  icon: 'history',
  zone: 'video',
  render: () => <FramesPane />,
};

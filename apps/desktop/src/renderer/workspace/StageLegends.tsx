/**
 * The point cloud legends of a 3D view. A pane that shows one survey date of several names its
 * `view` (its stage): the legend then reads that view's clouds only, so each side of a comparison
 * shows the range and the classes it draws. Without a view: every cloud on screen, as in a single
 * 3D view.
 */
import type { EngineStage } from '@aio/engine';
import {
  ClassificationLegend,
  ElevationLegend,
  pointcloudSettings,
  useClassificationLegend,
  useElevationRange,
} from '@aio/pointcloud';
import { localToProject } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';

interface LegendProps {
  view?: EngineStage | null | undefined;
}

/** The elevation ramp and its range in metres while the clouds are coloured by elevation. */
export function StageElevationLegend({ view }: LegendProps) {
  const range = useElevationRange(pointcloudSettings, view);
  const origin = useWorkspace((s) => s.project?.manifest.origin);
  return (
    <ElevationLegend
      className="elev-legend overlay-box"
      range={range}
      toElevation={(y) => (origin ? localToProject(origin, [0, y, 0])[2] : y)}
    />
  );
}

/** The classes of the shown points while the clouds are coloured by classification. */
export function StageClassLegend({ view }: LegendProps) {
  const { counts, hidden } = useClassificationLegend(pointcloudSettings, view);
  return (
    <ClassificationLegend
      className="elev-legend class-legend overlay-box"
      counts={counts}
      hidden={hidden}
      onToggle={(c) => {
        pointcloudSettings.getState().toggleClass(c);
      }}
    />
  );
}

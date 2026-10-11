import { useT } from '@aio/ui';
import { siteBasemap, streetMapTool } from './siteBasemap';
import { Tool } from './StageTools';
import { useStreetMap3d } from './streetMap3d';

/**
 * The street map under the site in 3D, on and off in one click. Greyed out, with the reason as
 * its label, when no installed pack covers the site or the landscape from packs is drawn instead;
 * absent for a project that cannot have it.
 */
export function StreetMapTool() {
  const t = useT();
  const state = useStreetMap3d();
  const tool = streetMapTool(state);
  const { projectId, on } = state;
  if (!tool || !projectId) return null;
  return (
    <Tool
      icon="map"
      label={t(tool.label)}
      pressed={tool.pressed}
      disabled={tool.disabled}
      testId="street-map-3d"
      onClick={() => {
        siteBasemap.getState().set(projectId, !on);
      }}
    />
  );
}

/**
 * The point cloud legends of a 3D view. A pane that shows one survey date of several names its
 * `view` (its stage): the legend then reads that view's clouds only, so each side of a comparison
 * shows the range and the classes it draws. Without a view: every cloud on screen, as in a single
 * 3D view.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import {
  ClassificationLegend,
  ElevationLegend,
  pointcloudCleanup,
  pointcloudSettings,
  useClassificationLegend,
  useElevationRange,
} from '@aio/pointcloud';
import { localToProject, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { cleanup, useCleanup } from '../pointcloud/cleanupStore';

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

const wrap = {
  position: 'absolute',
  insetInlineEnd: 14,
  bottom: 84,
  zIndex: 4,
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '50%',
  overflow: 'hidden',
  pointerEvents: 'auto',
} as const;
const scroll = { minHeight: 0, overflow: 'auto' } as const;
const note = {
  flex: 'none',
  padding: '6px 10px',
  maxWidth: 220,
  font: 'var(--t-11, 11px) var(--f-ui, system-ui)',
  color: 'var(--fg-3, #8a94a6)',
} as const;

/**
 * The classes of the shown points while the clouds are coloured by classification. With the Clean
 * up panel open it edits the panel's cloud (one undo step per toggle, named in the header); with
 * the panel closed it edits the global setting, and says so when a shown cloud keeps its own.
 */
export function StageClassLegend({ view }: LegendProps) {
  const { counts, hidden } = useClassificationLegend(pointcloudSettings, view);
  const panelOpen = useCleanup((s) => s.panelOpen);
  const active = useCleanup((s) => s.active);
  // a read-only package or a look-only reviewer: the cloud's classes are shown, not changed
  const lookOnly = useAnnotateReadOnly();
  const pkg = useCleanup((s) => s.readOnly);
  const readOnly = pkg || lookOnly;
  const recipes = useStore(pointcloudCleanup, (s) => s.recipes);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const off = useWorkspace((s) => s.hidden);
  const own = panelOpen && active ? recipes[active] : undefined;
  const name = own && active ? (layers?.find((l) => l.id === active)?.name ?? active) : '';
  const someOwn = (layers ?? []).some((l) => recipes[l.id] && !off[l.id]);
  const locked = own !== undefined && readOnly;
  if (!counts) return null;
  const legend = (
    <ClassificationLegend
      className="class-legend"
      counts={counts}
      hidden={own ? own.hiddenClasses : hidden}
      onToggle={(c) => {
        if (!own || !active) {
          pointcloudSettings.getState().toggleClass(c);
          return;
        }
        if (readOnly) return;
        const set = own.hiddenClasses.includes(c)
          ? own.hiddenClasses.filter((x) => x !== c)
          : [...own.hiddenClasses, c].sort((a, b) => a - b);
        void cleanup.commit(active, { ...own, hiddenClasses: set });
      }}
    />
  );
  return (
    <div className="elev-legend overlay-box" style={wrap}>
      {own && (
        <div style={note} data-testid="class-legend-title">
          {t('cleanup.legend.title', { name })}
        </div>
      )}
      {locked ? (
        <div
          style={scroll}
          title={t(pkg ? 'cleanup.readOnly' : 'cleanup.lookOnly')}
          aria-disabled="true"
        >
          <div inert style={{ opacity: 0.6 }}>
            {legend}
          </div>
        </div>
      ) : (
        <div style={scroll}>{legend}</div>
      )}
      {!own && someOwn && (
        <div style={note} data-testid="class-legend-note">
          {t('cleanup.legend.note')}
        </div>
      )}
    </div>
  );
}

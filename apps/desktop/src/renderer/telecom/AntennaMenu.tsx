/**
 * The right-click menu of an antenna row in the project list: the registered antenna actions.
 * Opened on a ticked row while it is ticked with others, it acts on all the ticked rows (the
 * single-unit actions drop out); otherwise on the row alone.
 */
import { actionsFor, ContextMenu, makeActionCtx, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useShell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { toastHost } from '../shell/actions/toastHost';
import { timeline } from '../workspace/timeline';
import { useAntennas } from './antennaStore';

export interface AntennaMenuAt {
  x: number;
  y: number;
  id: string;
  projectId: string;
}

export function AntennaMenu({ at, onClose }: { at: AntennaMenuAt | null; onClose: () => void }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const hidden = useWorkspace((s) => s.hidden);
  const pkg = useShell((s) => s.pkg);
  const ticked = useAntennas((s) => s.ticked);
  const unit = useAntennas((s) => (at ? s.file?.units.find((u) => u.id === at.id) : undefined));
  if (!at || !unit || project?.id !== at.projectId) return null;
  registerSidebarActions();
  const tickedIds = Object.keys(ticked);
  const ids = tickedIds.length > 1 && ticked[at.id] ? tickedIds : [at.id];
  const label = t('actions.header.antennas', { count: ids.length });
  const title = ids.length > 1 ? label : unit.name;
  const items = actionsFor(
    { kind: 'antennas', ids, clicked: at.id },
    makeActionCtx({
      manifest: project.manifest,
      hidden,
      focus: timeline.getState().focus,
      pkg: !!pkg,
      host: toastHost(title),
    }),
  );
  if (items.length === 0) return null;
  return (
    <ContextMenu
      items={items}
      x={at.x}
      y={at.y}
      label={title}
      title={title}
      testId="antenna-menu"
      onClose={onClose}
    />
  );
}

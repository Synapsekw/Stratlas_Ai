/**
 * The right-click menu of a measurement in the 3D view or on the map (`measurePick`): the same
 * registered actions as its row in the Datasets tree. Opened on a marked measurement while two or
 * more are marked, it acts on all of them (Rename and Fly to on the one clicked).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { actionsFor, ContextMenu, makeActionCtx, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useShell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { toastHost } from '../shell/actions/toastHost';
import type { MeasureMenuAt } from './measurePick';
import { useMeasure } from './measureStore';

export function MeasureMenu({ at, onClose }: { at: MeasureMenuAt | null; onClose: () => void }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const hidden = useWorkspace((s) => s.hidden);
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  const selected = useMeasure((s) => s.selected);
  const measurement = useMeasure((s) =>
    at ? s.file.measurements.find((m) => m.id === at.id) : undefined,
  );
  if (!at || !measurement || project?.id !== at.projectId) return null;
  registerSidebarActions();
  const ids = selected.length > 1 && selected.includes(at.id) ? selected : [at.id];
  const label =
    ids.length > 1 ? t('actions.header.measurements', { count: ids.length }) : measurement.label;
  const items = actionsFor(
    { kind: 'measurements', ids, clicked: at.id },
    makeActionCtx({
      manifest: project.manifest,
      hidden,
      pkg: !!pkg,
      canEdit: !pkg && !lookOnly,
      host: toastHost(label),
    }),
  );
  if (items.length === 0) return null;
  return (
    <ContextMenu
      items={items}
      x={at.x}
      y={at.y}
      label={label}
      title={label}
      testId="measure-menu"
      onClose={onClose}
    />
  );
}

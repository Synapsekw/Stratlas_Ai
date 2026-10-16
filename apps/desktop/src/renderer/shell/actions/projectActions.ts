import {
  defineAction,
  registerActions,
  t,
  type Action,
  type ActionCtx,
  type ActionSection,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { builder } from '../../builder/state';
import { farNotice } from '../../builder/farSession';
import { pickTileset } from '../../builder/ImportTileset';
import { allowedActions, exportUnavailable, type ExportActionId } from '../../exports/exportModel';
import { runExportAction } from '../../exports/exports';
import { pickAndScanPanos } from '../../panos/panos';
import { shell } from '../../shell';
import { addDateMenu } from '../AddSurveyDate';
import { layerProps } from '../LayerProperties';
import { editBlocked } from './reasons';

/** The layers the show and hide all items count: everything but the retired viewers. */
function datasetIds(ctx: ActionCtx): string[] {
  return ctx.manifest.layers.filter((l) => l.kind !== 'legacy').map((l) => l.id);
}

/** An item of the project menu that changes the project: greyed, not hidden, when it cannot. */
const edit = (
  id: string,
  label: MessageKey,
  icon: IconName,
  section: ActionSection,
  run: () => void | Promise<void>,
) =>
  defineAction({
    id,
    label,
    icon,
    section,
    targets: ['project'],
    disabled: (_t, ctx) => editBlocked(ctx),
    run,
  });

const projectItems: Action[] = [
  edit('project.addData', 'actions.project.addData', 'plus', 'edit', () =>
    builder.getState().pickAndImport(),
  ),
  edit('project.addPanos', 'actions.project.addPanos', 'pano', 'edit', () => pickAndScanPanos()),
  edit('project.addDrawing', 'actions.project.addDrawing', 'drawing', 'edit', () =>
    builder.getState().pickAndAddDrawing(),
  ),
  edit('project.addSurveyDate', 'palette.addSurveyDate', 'calendar-plus', 'edit', () => {
    const s = shell.getState();
    if (s.settings.sidebarCollapsed) void s.toggleSidebar();
    addDateMenu.getState().set(true);
  }),
  defineAction({
    id: 'project.showAll',
    label: 'actions.project.showAll',
    icon: 'eye',
    section: 'view',
    targets: ['project'],
    appliesTo: (_t, ctx) => datasetIds(ctx).some((id) => ctx.hidden[id]),
    run: (_t, ctx) => {
      workspace.getState().setLayersVisible(datasetIds(ctx), true);
    },
  }),
  defineAction({
    id: 'project.hideAll',
    label: 'actions.project.hideAll',
    icon: 'eye-off',
    section: 'view',
    targets: ['project'],
    appliesTo: (_t, ctx) => datasetIds(ctx).some((id) => !ctx.hidden[id]),
    run: (_t, ctx) => {
      workspace.getState().setLayersVisible(datasetIds(ctx), false);
    },
  }),
  edit('project.importFolder', 'palette.importFlightFolder', 'folder', 'file', () =>
    builder.getState().pickAndImportFolder(),
  ),
  edit('project.import360', 'actions.project.import360', 'video', 'file', () =>
    builder.getState().pickAndImport360(),
  ),
  edit('project.importTiles', 'actions.project.importTiles', 'globe', 'file', () => pickTileset()),
  defineAction({
    id: 'project.checkPlacement',
    label: 'actions.project.checkPlacement',
    icon: 'crosshair',
    section: 'view',
    targets: ['project'],
    run: () => {
      const id = workspace.getState().project?.id;
      if (id) void farNotice.getState().check(id, 'all');
    },
  }),
  defineAction({
    id: 'project.exports',
    label: 'actions.project.exports',
    icon: 'download',
    section: 'file',
    targets: ['project'],
    submenu: (_t, ctx) =>
      allowedActions(shell.getState().pkg).map((a) => ({
        id: a.id,
        label: a.label,
        icon: a.icon,
        disabled: exportUnavailable(a.id, ctx.manifest, workspace.getState().issues) ?? false,
      })),
    run: (_t, _ctx, sub) => {
      if (sub) runExportAction(sub as ExportActionId, { legend: true });
    },
  }),
  defineAction({
    id: 'project.properties',
    label: 'actions.project.properties',
    icon: 'settings',
    section: 'file',
    targets: ['project'],
    run: () => {
      layerProps.getState().openProject();
    },
  }),
  defineAction({
    id: 'project.close',
    label: 'actions.project.close',
    icon: 'x',
    section: 'file',
    targets: ['project'],
    run: () => {
      shell.getState().closeProject();
    },
  }),
  defineAction({
    id: 'project.emptyTrash',
    label: 'actions.project.emptyTrash',
    icon: 'trash',
    section: 'danger',
    targets: ['project'],
    disabled: (_t, ctx) =>
      editBlocked(ctx) || (ctx.trashEntries === 0 ? t('actions.reason.trashEmpty') : false),
    run: (_t, ctx) => {
      ctx.host.emptyTrash();
    },
  }),
];

/** The add items of a group header that has a matching project command (not in a package). */
const groupItems: Action[] = [
  defineAction({
    id: 'group.addDrawing',
    label: 'actions.project.addDrawing',
    icon: 'drawing',
    section: 'edit',
    targets: ['group'],
    appliesTo: (g) => g.group === 'drawings',
    disabled: (_t, ctx) => editBlocked(ctx),
    run: () => builder.getState().pickAndAddDrawing(),
  }),
  defineAction({
    id: 'group.add360',
    label: 'actions.group.add360',
    icon: 'video',
    section: 'edit',
    targets: ['group'],
    appliesTo: (g) => g.group === 'walks',
    disabled: (_t, ctx) => editBlocked(ctx),
    run: () => builder.getState().pickAndImport360(),
  }),
];

/** Register the project menu and the group add items; returns the unregister. */
export function registerProjectActions(): () => void {
  return registerActions([...projectItems, ...groupItems]);
}

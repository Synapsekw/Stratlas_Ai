import { getActiveScene } from '@aio/engine';
import {
  defineAction,
  registerActions,
  t,
  targetCount,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type MessageKey,
  type SubItem,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { shell } from '../../shell';
import { focusPoint, frameOf } from '../../survey/measureScene';
import {
  askNewFolder,
  deleteMeasurements,
  measureFolders,
  measureStore,
  revealMeasurement,
  setFolder,
  setMeasurementColour,
  setMeasurementsHidden,
} from '../../survey/measureStore';
import { renameRequest } from '../renameRequest';
import { editBlocked } from './reasons';

/*
 * The right-click actions of the measurement rows in the Datasets tree: rename, colour, hide or
 * show, fly to, move to a folder and delete. Several marked rows take Colour, Hide or Show, Move
 * and Delete together; Rename and Fly to act on the row the menu opened on.
 */

type Target = Extract<MenuTarget, { kind: 'measurements' }>;

/** The preset colours of a measurement (not the draft or snap colours the tools draw with). */
export const MEASURE_COLOURS: readonly { id: string; hex: string; label: MessageKey }[] = [
  { id: 'yellow', hex: '#ffd166', label: 'actions.measure.colour.yellow' },
  { id: 'red', hex: '#ef476f', label: 'actions.measure.colour.red' },
  { id: 'green', hex: '#06d6a0', label: 'actions.measure.colour.green' },
  { id: 'blue', hex: '#118ab2', label: 'actions.measure.colour.blue' },
  { id: 'purple', hex: '#9b5de5', label: 'actions.measure.colour.purple' },
  { id: 'orange', hex: '#f78c40', label: 'actions.measure.colour.orange' },
  { id: 'white', hex: '#ffffff', label: 'actions.measure.colour.white' },
  { id: 'grey', hex: '#94a3b8', label: 'actions.measure.colour.grey' },
];

const DEFAULT_COLOUR = '#ffd166';

/** Why an edit is greyed: a package, a reviewer who may only look, or a read-only measurements file. */
export function measureEditBlocked(ctx: ActionCtx): string | false {
  return (
    editBlocked(ctx) || (measureStore.getState().readOnly ? t('actions.reason.package') : false)
  );
}

/** Show a measurement in the site view: go there and frame it. False when it is gone. */
export function flyToMeasurement(id: string): boolean {
  const manifest = workspace.getState().project?.manifest;
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (!m || !manifest) return false;
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const f = focusPoint(m, frameOf(manifest));
  workspace.getState().flyTo({ kind: 'point', p: f.p, distance: f.distance });
  getActiveScene()?.requestRender();
  return true;
}

const blocked = (_tg: Target, ctx: ActionCtx): string | false => measureEditBlocked(ctx);

/** The marked measurements that are in the saved file. */
function marked(tg: Target) {
  const which = new Set(tg.ids);
  return measureStore.getState().file.measurements.filter((m) => which.has(m.id));
}

const anyShown = (tg: Target): boolean => {
  const hidden = measureStore.getState().hiddenMeasurements;
  return tg.ids.some((id) => !hidden.includes(id));
};

const actions: readonly Action[] = [
  defineAction<'measurements'>({
    id: 'measure.rename',
    label: 'actions.measure.rename',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    shortcut: 'tree.rename',
    disabled: blocked,
    run: (tg) => {
      renameRequest.getState().askMeasure(tg.clicked);
      revealMeasurement(tg.clicked);
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.colour',
    label: 'actions.measure.colour',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    present: 'picks',
    disabled: blocked,
    submenu: (tg): SubItem[] => {
      const ms = marked(tg);
      return MEASURE_COLOURS.map((c) => ({
        id: c.hex,
        label: t(c.label),
        swatch: c.hex,
        testId: `measure-colour-${c.id}`,
        checked: ms.length > 0 && ms.every((m) => (m.style?.color ?? DEFAULT_COLOUR) === c.hex),
      }));
    },
    run: (tg, _ctx, sub) => {
      if (sub) setMeasurementColour(tg.ids, sub);
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.visibility',
    label: (tg) => t(anyShown(tg) ? 'actions.measure.hide' : 'actions.measure.show'),
    icon: 'eye',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    run: (tg) => {
      setMeasurementsHidden(tg.ids, anyShown(tg));
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.flyTo',
    label: 'actions.measure.flyTo',
    icon: 'target',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    run: (tg, ctx) => {
      if (!flyToMeasurement(tg.clicked)) ctx.host.note(t('actions.measure.notFound'), true);
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.moveToFolder',
    label: 'actions.measure.moveToFolder',
    icon: 'folder',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    present: 'submenu',
    disabled: blocked,
    submenu: (tg): SubItem[] => {
      const ms = marked(tg);
      const folders = measureFolders(measureStore.getState().file);
      return [
        ...folders.map((f) => ({
          id: `to:${f}`,
          label: f,
          icon: 'folder' as const,
          testId: `measure-folder-to-${f}`,
          ...(ms.length > 0 && ms.every((m) => m.folder?.trim() === f)
            ? { disabled: t('actions.measure.inFolder') }
            : {}),
        })),
        { id: 'none', label: t('actions.measure.noFolder'), testId: 'measure-folder-to-none' },
        {
          id: 'new',
          label: t('actions.measure.newFolder'),
          icon: 'plus' as const,
          testId: 'measure-folder-new',
        },
      ];
    },
    run: (tg, _ctx, sub) => {
      if (sub === 'new') askNewFolder(tg.ids);
      else if (sub === 'none') setFolder(tg.ids, '');
      else if (sub?.startsWith('to:')) setFolder(tg.ids, sub.slice(3));
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.delete',
    label: (tg) =>
      targetCount(tg) > 1
        ? t('actions.measure.deleteCount', { count: targetCount(tg) })
        : t('actions.measure.delete'),
    icon: 'trash',
    section: 'danger',
    targets: ['measurements'],
    multi: true,
    disabled: blocked,
    run: (tg) => {
      deleteMeasurements(tg.ids);
    },
  }),
];

/** Register the measurement row actions. */
export function registerMeasureActions(): () => void {
  return registerActions(actions);
}

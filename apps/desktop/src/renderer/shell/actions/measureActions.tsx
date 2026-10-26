import { isAnnotateReadOnly } from '@aio/annotate';
import { getActiveScene } from '@aio/engine';
import {
  defineAction,
  registerActions,
  t,
  targetCount,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type SubItem,
} from '@aio/ui';
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { isTelecomTool } from '@aio/survey';
import { workspace } from '@aio/workspace';
import { shell } from '../../shell';
import { DEFAULT_MEASURE_COLOUR, MEASURE_COLOURS } from '../../survey/measureColours';
import { measureFoldersOf, needsDate } from '../../survey/measureRows';
import { moveMeasurementsToDate } from '../../survey/measureMoveRun';
import { focusPoint, frameOf } from '../../survey/measureScene';
import {
  askNewFolder,
  deleteMeasurements,
  measureStore,
  revealMeasurement,
  setFolder,
  setMeasurementColour,
  setMeasurementsHidden,
  startEditing,
} from '../../survey/measureStore';
import { openMeasurement } from '../../survey/pile/openPile';
import { renameRequest } from '../renameRequest';
import { dateLabel, editBlocked } from './reasons';

/*
 * The right-click actions of the measurement rows in the Datasets tree: rename, colour, hide or
 * show, fly to, move to a folder, move to another survey date and delete. Several marked rows take
 * Colour, Hide or Show, the Moves and Delete together; Rename and Fly to act on the row the menu
 * opened on.
 */

type Target = Extract<MenuTarget, { kind: 'measurements' }>;

/** The one measurement palette (`survey/measureColours`): these swatches and the panel's picker. */
export { MEASURE_COLOURS };

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

const SPANS = Symbol('spans');

/**
 * The date the marked measurements share: a capture id, null for "Needs a date", undefined when
 * the project has no dates, or SPANS when they sit on different ones.
 */
function dateKeyOf(
  ms: readonly SurveyMeasurement[],
  manifest: ProjectManifest | null,
): string | null | undefined | typeof SPANS {
  if (!manifest || manifest.captures.length === 0) return undefined;
  const keys = new Set(
    ms.map((m) => (m.scope.kind === 'survey' && !needsDate(m, manifest) ? m.scope.capture : null)),
  );
  if (keys.size > 1) return SPANS;
  const [only] = keys;
  return keys.size === 1 ? only : undefined;
}

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
        checked:
          ms.length > 0 && ms.every((m) => (m.style?.color ?? DEFAULT_MEASURE_COLOUR) === c.hex),
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
  // the boundary's vertex edit in the view (the card's Vertices section has it too); a pile's
  // volume goes stale with the edit and is worked out again as after any outline edit
  defineAction<'measurements'>({
    id: 'measure.editBoundary',
    label: 'actions.measure.editBoundary',
    icon: 'polygon',
    section: 'edit',
    targets: ['measurements'],
    appliesTo: (tg) => {
      const m = measureStore.getState().file.measurements.find((x) => x.id === tg.clicked);
      return m?.family === 'polygon' && !isTelecomTool(m.tool);
    },
    disabled: (tg, ctx) => {
      const why = measureEditBlocked(ctx);
      if (why) return why;
      const s = measureStore.getState();
      if (s.editing && s.focus === tg.clicked) return t('actions.measure.editBoundary.editing');
      if (!s.measurementsVisible || s.hiddenMeasurements.includes(tg.clicked))
        return t('actions.measure.editBoundary.hidden');
      return false;
    },
    run: (tg) => {
      // opened where it was right-clicked: the camera stays unless the pile is out of view
      openMeasurement(tg.clicked, undefined, 'if-out-of-view');
      startEditing();
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
      const manifest = workspace.getState().project?.manifest ?? null;
      const key = dateKeyOf(ms, manifest);
      const apart = key === SPANS ? { disabled: t('actions.measure.spansDates') } : null;
      const folders = measureFoldersOf(
        measureStore.getState().file,
        key === SPANS ? undefined : key,
        manifest,
      );
      return [
        ...folders.map((f) => ({
          id: `to:${f}`,
          label: f,
          icon: 'folder' as const,
          testId: `measure-folder-to-${f}`,
          ...(apart ??
            (ms.length > 0 && ms.every((m) => m.folder?.trim() === f)
              ? { disabled: t('actions.measure.inFolder') }
              : {})),
        })),
        {
          id: 'none',
          label: t('actions.measure.noFolder'),
          testId: 'measure-folder-to-none',
          ...apart,
        },
        {
          id: 'new',
          label: t('actions.measure.newFolder'),
          icon: 'plus' as const,
          testId: 'measure-folder-new',
          ...apart,
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
    id: 'measure.moveToDate',
    label: 'actions.measure.moveToDate',
    section: 'edit',
    targets: ['measurements'],
    multi: true,
    present: 'submenu',
    appliesTo: (_tg, ctx) => ctx.manifest.captures.length > 0,
    // the keyboard path of dropping rows on a survey date folder (the same move, note and Undo)
    disabled: (tg, ctx) => {
      const why = measureEditBlocked(ctx);
      if (why) return why;
      if (isAnnotateReadOnly()) return t('actions.reason.readOnly');
      return marked(tg).some((m) => isTelecomTool(m.tool)) ? t('tree.measure.move.telecom') : false;
    },
    submenu: (tg, ctx): SubItem[] => {
      const key = dateKeyOf(marked(tg), ctx.manifest);
      return [...ctx.manifest.captures]
        .filter((c) => c.id !== key)
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
        .map((c) => ({
          id: c.id,
          label: dateLabel(c),
          swatch: ctx.tags[c.id]?.colour ?? '',
          testId: `measure-date-to-${c.id}`,
        }));
    },
    run: (tg, _ctx, sub) => {
      if (sub && !isAnnotateReadOnly()) void moveMeasurementsToDate(tg.ids, sub);
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

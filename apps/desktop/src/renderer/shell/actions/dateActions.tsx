import type { Capture } from '@aio/schema';
import {
  DATE_ICONS,
  defineAction,
  EVERY_DATE,
  formatDate,
  registerActions,
  t,
  type Action,
  type ActionCtx,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { DATE_COLOURS, workspace } from '@aio/workspace';
import { builder } from '../../builder/state';
import { openLineUpFor, removeLineUp } from '../../lineup/lineUpActions';
import { lineUpApp } from '../../lineup/lineUpStore';
import { timeline } from '../../workspace/timeline';
import {
  COMPARE_WITH_ACTIONS,
  compareTargets,
  compareWith,
  type CompareRequest,
} from '../../workspace/compareWith';
import { updateCapture } from '../dateFolders';
import { askRemove } from '../removal';
import { compareContextFor, exportLayersFlow, zoomToLayers } from './layerActions';
import { dateLabel, editBlocked, inPackage } from './reasons';

/** The capture a date target names, or undefined on Every date. */
function captureOf(captureId: string | null, ctx: ActionCtx): Capture | undefined {
  return captureId === null ? undefined : ctx.manifest.captures.find((c) => c.id === captureId);
}

/** The layer ids of the folder a date target names (Every date: the shared folder). */
function layersOf(captureId: string | null, ctx: ActionCtx): readonly string[] {
  return ctx.folderLayers[captureId ?? EVERY_DATE] ?? [];
}

/** The folder's datasets that have files and a place (no basemap, no retired viewer). */
function datasetsOf(captureId: string | null, ctx: ActionCtx): string[] {
  const kinds = new Map(ctx.manifest.layers.map((l) => [l.id, l.kind]));
  return layersOf(captureId, ctx).filter((id) => {
    const k = kinds.get(id);
    return k !== 'basemap' && k !== 'legacy';
  });
}

/** Say what a failed save returned. */
async function saved(ctx: ActionCtx, done: Promise<string | null>): Promise<void> {
  const error = await done;
  if (error) ctx.host.note(error, true);
}

/** Add data into a date: whatever the import brings in is filed under it. */
async function importIntoDate(captureId: string, ctx: ActionCtx): Promise<void> {
  const before = new Set((workspace.getState().project?.manifest.layers ?? []).map((l) => l.id));
  await builder.getState().pickAndImport();
  const now = workspace.getState().project?.manifest.layers ?? [];
  const added = now.map((l) => l.id).filter((id) => !before.has(id));
  if (added.length > 0) ctx.host.moveLayers(added, captureId);
}

/** A date folder item that needs a real capture; greyed, not hidden, when the project cannot change. */
const onCapture = (
  id: string,
  label: MessageKey,
  icon: IconName,
  section: Action['section'],
  testId: string | undefined,
  run: (captureId: string, ctx: ActionCtx) => void | Promise<void>,
  o: { edit?: boolean; disabled?: (captureId: string, ctx: ActionCtx) => string | false } = {},
) =>
  defineAction({
    id,
    label,
    icon,
    section,
    targets: ['date'],
    ...(testId ? { testId } : {}),
    appliesTo: (d, ctx) => captureOf(d.captureId, ctx) !== undefined,
    disabled: (d, ctx) =>
      (o.edit ? editBlocked(ctx) : false) || (o.disabled?.(d.captureId ?? '', ctx) ?? false),
    run: (d, ctx) => run(d.captureId ?? '', ctx),
  });

/** Why the line-up items are greyed: the project cannot change, or the step is not up yet. */
const lineUpBlocked = (ctx: ActionCtx) =>
  editBlocked(ctx) || (lineUpApp.getState().store ? false : t('lineUp.menu.notReady'));

const dateItems: Action[] = [
  onCapture(
    'date.view',
    'tree.dates.menu.view',
    'target',
    'open',
    'date-menu-view',
    (id) => {
      timeline.getState().focusSurvey(id);
    },
    { disabled: (id, ctx) => (ctx.focus === id ? t('actions.reason.inView') : false) },
  ),
  defineAction({
    id: 'date.toggle',
    label: (_d, ctx) =>
      t(ctx.host.expanded ? 'tree.dates.menu.collapse' : 'tree.dates.menu.expand'),
    icon: 'chev-d',
    section: 'view',
    targets: ['date'],
    testId: 'date-menu-toggle',
    run: (_d, ctx) => {
      ctx.host.toggle?.();
    },
  }),
  defineAction({
    id: 'date.show',
    label: 'tree.dates.menu.showAll',
    icon: 'eye',
    section: 'view',
    targets: ['date'],
    testId: 'date-menu-show',
    appliesTo: (d, ctx) => layersOf(d.captureId, ctx).length > 0,
    disabled: (d, ctx) =>
      layersOf(d.captureId, ctx).some((id) => ctx.hidden[id])
        ? false
        : t('actions.reason.nothingToChange'),
    run: (d, ctx) => {
      workspace.getState().setLayersVisible([...layersOf(d.captureId, ctx)], true);
    },
  }),
  defineAction({
    id: 'date.hide',
    label: 'tree.dates.menu.hideAll',
    icon: 'eye-off',
    section: 'view',
    targets: ['date'],
    testId: 'date-menu-hide',
    appliesTo: (d, ctx) => layersOf(d.captureId, ctx).length > 0,
    disabled: (d, ctx) =>
      layersOf(d.captureId, ctx).every((id) => ctx.hidden[id])
        ? t('actions.reason.nothingToChange')
        : false,
    run: (d, ctx) => {
      workspace.getState().setLayersVisible([...layersOf(d.captureId, ctx)], false);
    },
  }),
  onCapture('date.zoomTo', 'actions.date.zoomTo', 'target', 'view', undefined, async (id, ctx) => {
    const ids = datasetsOf(id, ctx);
    if (ids.length === 0) {
      const capture = captureOf(id, ctx);
      ctx.host.note(
        t('actions.reason.noBounds', { name: capture ? formatDate(capture.date) : id }),
      );
      return;
    }
    await zoomToLayers(ids, (text) => {
      ctx.host.note(text);
    });
  }),
  defineAction({
    id: 'date.compare',
    label: 'tree.dates.menu.compare',
    icon: 'split',
    section: 'compare',
    targets: ['date'],
    testId: 'date-menu-compare',
    appliesTo: (d, ctx) =>
      captureOf(d.captureId, ctx) !== undefined && ctx.manifest.captures.length > 1,
    submenuTitle: (d, ctx) => {
      const c = captureOf(d.captureId, ctx);
      return t('tree.dates.menu.compareTitle', { date: formatDate(c?.date ?? d.captureId ?? '') });
    },
    submenu: (d, ctx) => {
      const from = d.captureId;
      if (from === null) return [];
      const byId = new Map(ctx.manifest.captures.map((c) => [c.id, c]));
      return compareTargets(from, undefined, compareContextFor(ctx)).map(({ capture, reason }) => {
        const c = byId.get(capture);
        const request: CompareRequest = { from, to: capture };
        return {
          id: capture,
          label: c ? dateLabel(c) : capture,
          swatch: ctx.tags[capture]?.colour ?? 'var(--fg-3)',
          disabled: reason ? t(reason) : false,
          testId: `compare-to-${capture}`,
          ...(reason
            ? {}
            : {
                after: (close: () => void) =>
                  COMPARE_WITH_ACTIONS.map((A, i) => <A key={i} request={request} close={close} />),
              }),
        };
      });
    },
    run: (d, _ctx, sub) => {
      if (d.captureId !== null && sub) compareWith({ from: d.captureId, to: sub });
    },
  }),
  onCapture(
    'date.rename',
    'tree.dates.menu.rename',
    'tag',
    'edit',
    'date-menu-rename',
    (id, ctx) => {
      ctx.host.renameDate(id);
    },
    { edit: true },
  ),
  defineAction({
    id: 'date.lineUp',
    label: 'lineUp.action',
    icon: 'target',
    section: 'edit',
    targets: ['date'],
    testId: 'date-menu-line-up',
    appliesTo: (d, ctx) =>
      captureOf(d.captureId, ctx) !== undefined && ctx.manifest.captures.length > 1,
    disabled: (_d, ctx) => lineUpBlocked(ctx),
    run: async (d, ctx) => {
      const why = d.captureId === null ? null : await openLineUpFor(d.captureId);
      if (why) ctx.host.note(why, true);
    },
  }),
  defineAction({
    id: 'date.removeLineUp',
    label: 'lineUp.remove',
    icon: 'undo',
    section: 'edit',
    targets: ['date'],
    testId: 'date-menu-remove-line-up',
    appliesTo: (d, ctx) => captureOf(d.captureId, ctx)?.lineUp !== undefined,
    disabled: (_d, ctx) => lineUpBlocked(ctx),
    run: (d) => {
      if (d.captureId !== null) removeLineUp(d.captureId);
    },
  }),
  defineAction({
    id: 'date.colour',
    label: 'tree.dates.menu.colour',
    section: 'edit',
    targets: ['date'],
    testId: 'date-menu-colour',
    present: 'picks',
    appliesTo: (d, ctx) => captureOf(d.captureId, ctx) !== undefined,
    disabled: (_d, ctx) => editBlocked(ctx),
    submenu: (d, ctx) =>
      Array.from({ length: DATE_COLOURS }, (_, i) => i + 1).map((n) => ({
        id: String(n),
        label: t('tree.dates.menu.colourN', { n }),
        swatch: `var(--date-${String(n)})`,
        checked: ctx.tags[d.captureId ?? '']?.colourIndex === n,
        testId: `date-menu-colour-${String(n)}`,
      })),
    run: (d, ctx, sub) => {
      if (d.captureId !== null && sub) {
        return saved(ctx, updateCapture(d.captureId, { colour: Number(sub) }));
      }
    },
  }),
  defineAction({
    id: 'date.icon',
    label: 'tree.dates.menu.icon',
    section: 'edit',
    targets: ['date'],
    testId: 'date-menu-icon',
    present: 'picks',
    appliesTo: (d, ctx) => captureOf(d.captureId, ctx) !== undefined,
    disabled: (_d, ctx) => editBlocked(ctx),
    submenu: (d, ctx) => [
      {
        id: 'none',
        label: t('tree.dates.menu.iconNone'),
        checked: !ctx.tags[d.captureId ?? '']?.icon,
        testId: 'date-menu-icon-none',
      },
      ...DATE_ICONS.map((name) => ({
        id: name,
        label: t('tree.dates.menu.iconN', { name }),
        icon: name,
        checked: ctx.tags[d.captureId ?? '']?.icon === name,
        testId: `date-menu-icon-${name}`,
      })),
    ],
    run: (d, ctx, sub) => {
      if (d.captureId !== null && sub) {
        return saved(ctx, updateCapture(d.captureId, { icon: sub === 'none' ? null : sub }));
      }
    },
  }),
  defineAction({
    id: 'date.reset',
    label: 'tree.dates.menu.reset',
    icon: 'undo',
    section: 'edit',
    targets: ['date'],
    testId: 'date-menu-reset',
    appliesTo: (d, ctx) => {
      const tag = ctx.tags[d.captureId ?? ''];
      return captureOf(d.captureId, ctx) !== undefined && (tag?.picked === true || !!tag?.icon);
    },
    disabled: (_d, ctx) => editBlocked(ctx),
    run: (d, ctx) => {
      if (d.captureId !== null) {
        return saved(ctx, updateCapture(d.captureId, { colour: null, icon: null }));
      }
    },
  }),
  onCapture(
    'date.addData',
    'actions.date.addData',
    'plus',
    'edit',
    undefined,
    (id, ctx) => importIntoDate(id, ctx),
    { edit: true },
  ),
  defineAction({
    id: 'date.export',
    label: 'actions.date.export',
    icon: 'download',
    section: 'file',
    targets: ['date'],
    appliesTo: (d, ctx) =>
      captureOf(d.captureId, ctx) !== undefined && datasetsOf(d.captureId, ctx).length > 0,
    disabled: (_d, ctx) => inPackage(ctx),
    run: (d, ctx) => exportLayersFlow(datasetsOf(d.captureId, ctx)),
  }),
  onCapture(
    'date.delete',
    'tree.delete',
    'trash',
    'danger',
    'date-menu-delete',
    (id) => {
      askRemove([{ capture: id }]);
    },
    { edit: true },
  ),
];

/** Register the survey date folder menu; returns the unregister. */
export function registerDateActions(): () => void {
  return registerActions(dateItems);
}

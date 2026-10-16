import type { Layer } from '@aio/schema';
import {
  defineAction,
  EVERY_DATE,
  everyLayer,
  formatDate,
  registerActions,
  t,
  targetLayers,
  type ActionCtx,
  type MenuTarget,
  type SubItem,
} from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { captureIndex, workspace } from '@aio/workspace';
import { Fragment } from 'react';
import { builder } from '../../builder/state';
import { listenExportProgress, toasts } from '../../exports/exports';
import { graphics } from '../../graphics';
import { bridge, shell } from '../../shell';
import { volumeHints } from '../../workspace/compare';
import { compareTargets, compareWith, COMPARE_WITH_ACTIONS } from '../../workspace/compareWith';
import type { CompareContext, CompareRequest } from '../../workspace/compareWith';
import { layerCapture } from '../../workspace/framesModel';
import { DEFAULT_SPLIT } from '../../workspace/splitModel';
import { stagePrefs } from '../../workspace/stagePrefs';
import { appBoundsDeps } from '../appBounds';
import { boundsOf, padBox } from '../layerBounds';
import { layerProps } from '../LayerProperties';
import { revealLayer } from '../layerInfo';
import { askRemove } from '../removal';
import { renameRequest } from '../renameRequest';
import { dateLabel, inPackage, readOnly } from './reasons';

type LayerTarget = Extract<MenuTarget, { kind: 'layers' | 'group' }>;

const editable = (l: Layer) => l.kind !== 'basemap' && l.kind !== 'legacy';

const idsOf = (target: LayerTarget): string[] => target.layerIds;

/** The rows Delete takes: datasets, not basemaps or retired viewers (as the marked header). */
const deletableIds = (target: LayerTarget, ctx: ActionCtx): string[] =>
  targetLayers(target, ctx)
    .filter(editable)
    .map((l) => l.id);

/** Rename a dataset; a layer whose date comes from its name keeps that date first. */
export async function commitLayerRename(layerId: string, name: string): Promise<string | null> {
  const p = workspace.getState().project;
  const layer = p?.manifest.layers.find((l) => l.id === layerId);
  if (!p || !layer) return t('layerProps.noProject');
  if (layer.capture === undefined) {
    const inferred = layerCapture(layer, captureIndex(p.manifest));
    if (inferred !== undefined) {
      const err = await builder.getState().saveLayers([layerId], { capture: inferred });
      if (err) return err;
    }
  }
  return builder.getState().saveLayers([layerId], { name });
}

/** Fly the camera to the box the datasets fill; a note says when none of them knows where it lies. */
export async function zoomToLayers(
  layerIds: readonly string[],
  note: (text: string) => void,
): Promise<void> {
  const box = await boundsOf(layerIds, appBoundsDeps());
  if (!box) {
    const first = workspace.getState().project?.manifest.layers.find((l) => l.id === layerIds[0]);
    note(t('actions.reason.noBounds', { name: first?.name ?? '' }));
    return;
  }
  const s = shell.getState();
  if (s.screen !== 'scene') s.go('scene');
  workspace.getState().flyTo({ kind: 'box', ...padBox(box) });
}

/** Ask for a folder, then copy the datasets into it with a progress toast. */
export async function exportLayersFlow(layerIds: readonly string[]): Promise<void> {
  const p = workspace.getState().project;
  if (!p) return;
  const pick = await bridge.call('dialog:openFolder', { title: t('layerExport.pick') });
  if (!pick.ok || !pick.value.path) return;
  const dir = pick.value.path;
  listenExportProgress();
  const jobId = `layers-${String(Date.now())}`;
  const ts = toasts.getState();
  ts.start(jobId, t('layerExport.title'));
  const r = await bridge.call('layer:export', {
    projectId: p.id,
    jobId,
    layerIds: [...layerIds],
    dir,
  });
  if (!r.ok) {
    ts.finish(jobId, 'error', r.error);
    return;
  }
  if (!r.value.ok) {
    ts.finish(jobId, 'error', r.value.error);
    return;
  }
  if (r.value.cancelled) {
    ts.finish(jobId, 'done', t('layerExport.cancelled'));
    return;
  }
  const done = t('layerExport.done', { count: r.value.written, dir });
  const skipped = r.value.skipped.length
    ? ` ${t('layerExport.skipped', { names: r.value.skipped.join(', ') })}`
    : '';
  ts.finish(jobId, r.value.written > 0 ? 'done' : 'error', `${done}${skipped}`);
}

/** What "Compare with" reads, taken from the stores and the menu's manifest (no hooks). */
export function compareContextFor(ctx: ActionCtx): CompareContext {
  const project = workspace.getState().project;
  return {
    layers: ctx.manifest.layers,
    index: captureIndex(ctx.manifest, volumeHints(volumetric.getState())),
    stageMode: shell.getState().stageMode,
    split:
      (project ? stagePrefs.getState().byProject[project.id]?.split : undefined) ?? DEFAULT_SPLIT,
    tier: graphics().getState().tier,
  };
}

/** The date the layers compare from: the folder they were opened in, else the one date they share. */
function commonDate(target: LayerTarget, ctx: ActionCtx): string | undefined {
  const index = captureIndex(ctx.manifest);
  const from = ctx.host.from;
  if (from !== undefined && index.captures.some((c) => c.id === from)) return from;
  const dates = new Set(targetLayers(target, ctx).map((l) => layerCapture(l, index)));
  const [only] = [...dates];
  return dates.size === 1 ? only : undefined;
}

const shown = (id: string, ctx: ActionCtx): boolean => ctx.hidden[id] !== true;

export function registerLayerActions(): () => void {
  return registerActions([
    defineAction<'layers' | 'group'>({
      id: 'layer.show',
      label: 'actions.layer.show',
      section: 'view',
      targets: ['layers', 'group'],
      multi: true,
      appliesTo: (target, ctx) =>
        everyLayer(target, ctx, () => true) && idsOf(target).some((id) => !shown(id, ctx)),
      run: (target) => {
        workspace.getState().setLayersVisible(idsOf(target), true);
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.hide',
      label: 'actions.layer.hide',
      section: 'view',
      targets: ['layers', 'group'],
      multi: true,
      appliesTo: (target, ctx) =>
        everyLayer(target, ctx, () => true) && idsOf(target).some((id) => shown(id, ctx)),
      run: (target) => {
        workspace.getState().setLayersVisible(idsOf(target), false);
      },
    }),
    defineAction<'group'>({
      id: 'group.toggle',
      label: (_t, ctx) =>
        ctx.host.expanded === true ? t('tree.dates.menu.collapse') : t('tree.dates.menu.expand'),
      section: 'view',
      targets: ['group'],
      appliesTo: (_t, ctx) => ctx.host.toggle !== undefined,
      run: (_t, ctx) => {
        ctx.host.toggle?.();
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.zoomTo',
      label: 'actions.layer.zoomTo',
      section: 'view',
      targets: ['layers', 'group'],
      multi: true,
      appliesTo: (target, ctx) => everyLayer(target, ctx, editable),
      run: (target, ctx) =>
        zoomToLayers(idsOf(target), (text) => {
          ctx.host.note(text);
        }),
    }),
    defineAction<'layers'>({
      id: 'layer.rename',
      label: 'actions.layer.rename',
      section: 'edit',
      targets: ['layers'],
      shortcut: 'tree.rename',
      appliesTo: (target, ctx) => everyLayer(target, ctx, (l) => l.kind !== 'basemap'),
      disabled: (_t, ctx) => readOnly(ctx),
      run: (target) => {
        const [id] = target.layerIds;
        if (id !== undefined) renameRequest.getState().ask(id);
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.moveToDate',
      label: 'tree.dates.move.fileUnder',
      section: 'edit',
      targets: ['layers', 'group'],
      multi: true,
      present: 'inline',
      appliesTo: (target, ctx) => ctx.datesOn && everyLayer(target, ctx, editable),
      disabled: (_t, ctx) => readOnly(ctx),
      submenu: (_t, ctx): SubItem[] => {
        const from = ctx.host.from;
        const dates = [...ctx.manifest.captures].sort(
          (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
        );
        return [
          {
            id: EVERY_DATE,
            label: t('tree.dates.move.none'),
            swatch: '',
            testId: 'move-to-every',
            checked: from === EVERY_DATE,
            disabled: from === EVERY_DATE ? t('tree.dates.move.none') : false,
          },
          ...dates.map((c): SubItem => ({
            id: c.id,
            label: dateLabel(c),
            swatch: ctx.tags[c.id]?.colour ?? '',
            testId: `move-to-${c.id}`,
            checked: from === c.id,
            disabled: from === c.id ? dateLabel(c) : false,
          })),
        ];
      },
      run: (target, ctx, sub) => {
        if (sub === undefined) return;
        ctx.host.moveLayers(idsOf(target), sub === EVERY_DATE ? null : sub);
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.compare',
      label: 'tree.dates.move.compare',
      section: 'compare',
      targets: ['layers', 'group'],
      multi: true,
      testId: 'move-compare',
      appliesTo: (target, ctx) =>
        everyLayer(target, ctx, editable) && captureIndex(ctx.manifest).captures.length > 1,
      disabled: (target, ctx) =>
        commonDate(target, ctx) === undefined ? t('actions.reason.mixedDates') : false,
      submenuTitle: (target, ctx) => {
        const from = commonDate(target, ctx);
        const c = ctx.manifest.captures.find((x) => x.id === from);
        return t('tree.dates.menu.compareTitle', { date: formatDate(c?.date ?? from ?? '') });
      },
      submenu: (target, ctx): SubItem[] => {
        const from = commonDate(target, ctx);
        if (from === undefined) return [];
        const layers = idsOf(target);
        const byId = new Map(ctx.manifest.captures.map((c) => [c.id, c]));
        return compareTargets(from, layers, compareContextFor(ctx)).map(
          ({ capture, reason }): SubItem => {
            const c = byId.get(capture);
            const request: CompareRequest = { from, to: capture, layers };
            return {
              id: capture,
              label: c ? dateLabel(c) : capture,
              swatch: ctx.tags[capture]?.colour ?? '',
              testId: `compare-to-${capture}`,
              disabled: reason === null ? false : t(reason),
              ...(reason === null
                ? {
                    after: (close: () => void) =>
                      COMPARE_WITH_ACTIONS.map((Extra, i) => (
                        <Fragment key={i}>
                          <Extra request={request} close={close} />
                        </Fragment>
                      )),
                  }
                : {}),
            };
          },
        );
      },
      run: (target, ctx, sub) => {
        const from = commonDate(target, ctx);
        if (sub === undefined || from === undefined) return;
        compareWith({ from, to: sub, layers: idsOf(target) });
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.export',
      label: 'actions.layer.export',
      section: 'file',
      targets: ['layers', 'group'],
      multi: true,
      appliesTo: (target, ctx) => everyLayer(target, ctx, editable),
      disabled: (_t, ctx) => inPackage(ctx),
      run: (target) => exportLayersFlow(idsOf(target)),
    }),
    defineAction<'layers'>({
      id: 'layer.reveal',
      label: 'actions.layer.reveal',
      section: 'file',
      targets: ['layers'],
      appliesTo: (target, ctx) => everyLayer(target, ctx, editable),
      disabled: (_t, ctx) => inPackage(ctx),
      run: async (target, ctx) => {
        const [id] = target.layerIds;
        if (id === undefined) return;
        const err = await revealLayer(id);
        if (err) ctx.host.note(err, true);
      },
    }),
    defineAction<'layers'>({
      id: 'layer.properties',
      label: 'actions.layer.properties',
      section: 'file',
      targets: ['layers'],
      run: (target) => {
        const [id] = target.layerIds;
        if (id !== undefined) layerProps.getState().openLayer(id);
      },
    }),
    defineAction<'layers' | 'group'>({
      id: 'layer.delete',
      label: (target, ctx) =>
        target.layerIds.length > 1
          ? t('actions.layer.deleteCount', { count: deletableIds(target, ctx).length })
          : t('tree.delete'),
      section: 'danger',
      targets: ['layers', 'group'],
      multi: true,
      testId: 'menu-delete',
      shortcut: 'tree.delete',
      appliesTo: (target, ctx) => deletableIds(target, ctx).length > 0,
      disabled: (_t, ctx) => readOnly(ctx),
      run: (target, ctx) => {
        askRemove(deletableIds(target, ctx).map((layer) => ({ layer })));
      },
    }),
  ]);
}

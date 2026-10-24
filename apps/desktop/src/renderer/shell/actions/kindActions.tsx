import { pinDisplay } from '@aio/annotate';
import { panoOpenable } from '@aio/engine';
import { COLOUR_MODES, pointcloudSettings } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import {
  defineAction,
  everyLayer,
  flightGroups,
  isDrawingPlanLayer,
  registerActions,
  t,
  targetCount,
  targetLayers,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type SubItem,
} from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { alignSources } from '../../builder/alignTo';
import { alignCamera, alignTo } from '../../builder/alignSession';
import { dropToGround } from '../../builder/dropSession';
import { droppable } from '../../builder/dropToGround';
import { openPhoto } from '../../builder/PhotoMenu';
import { builder } from '../../builder/state';
import { drawings } from '../../drawings/store';
import { withDrawingDisplay } from '../../drawings/display';
import { openSideBySide, startPlacing } from '../../drawings/DrawingControls';
import { createEngineeringModel, ENGINEERING_SOURCES, engineeringUiOn } from '../../engineer/ui';
import { cleanup, isCleanable } from '../../pointcloud/cleanupStore';
import { cleanupActionContext } from '../../pointcloud/cleanupActions';
import { jobForPano, panoStatus } from '../../panos/panoModel';
import { shapeOf } from '../../panos/PanoSphereRows';
import { photoUi } from '../../photogrammetry/store';
import { jobs, shell } from '../../shell';
import { startWalkCompare } from '../../walks/walkCompare';
import { openWalk, placeWalk } from '../../walks/walks';
import { flightPathShown, toggleFlightPath } from '../../workspace/flightPaths';
import { flightPathModel, updateFlightPaths } from '../../workspace/pathModel';
import { stagePrefs } from '../../workspace/stagePrefs';
import { knowsWhere } from '../layerBounds';
import { dateLabel, editBlocked } from './reasons';

type Panoramas = Extract<Layer, { kind: 'panoramas' }>;
type Walk = Extract<Layer, { kind: 'walk' }>;

/** The one layer a menu is on (a single row), or null for several items. */
function only(tg: MenuTarget, ctx: ActionCtx): Layer | null {
  if (targetCount(tg) !== 1) return null;
  return targetLayers(tg, ctx)[0] ?? null;
}

/** The one layer, when it is of `kind`. */
function oneOf<K extends Layer['kind']>(
  tg: MenuTarget,
  ctx: ActionCtx,
  kind: K,
): Extract<Layer, { kind: K }> | null {
  const l = only(tg, ctx);
  return l?.kind === kind ? (l as Extract<Layer, { kind: K }>) : null;
}

/** A walk with a saved placement (two pins or more, not marked unplaced). */
const walkPlaced = (w: Walk): boolean =>
  w.place !== undefined && w.place.pins.length >= 2 && w.place.quality !== 'unplaced';

const projectId = () => workspace.getState().project?.id;

/** The survey date a layer is filed under: the sidebar's folders, else the manifest's index. */
function captureOf(ctx: ActionCtx, layerId: string): string | null {
  for (const c of ctx.manifest.captures) if (ctx.folderLayers[c.id]?.includes(layerId)) return c.id;
  return captureIndex(ctx.manifest).of[layerId] ?? null;
}

/**
 * The datasets a photo set or photos can be aligned to: every layer with a known position that is
 * not excluded, newest date first and undated last, each under its date heading.
 */
export function alignTargets(ctx: ActionCtx, exclude: ReadonlySet<string>): SubItem[] {
  const dates = new Map(ctx.manifest.captures.map((c) => [c.id, c]));
  const rows = ctx.manifest.layers
    .filter(
      (l) => !exclude.has(l.id) && l.kind !== 'basemap' && l.kind !== 'legacy' && knowsWhere(l),
    )
    .map((l) => {
      const c = dates.get(captureOf(ctx, l.id) ?? '');
      return { l, c };
    });
  rows.sort((a, b) => {
    if (a.c && b.c) return b.c.date.localeCompare(a.c.date) || b.c.id.localeCompare(a.c.id);
    return a.c ? -1 : b.c ? 1 : 0;
  });
  return rows.map(({ l, c }) => ({
    id: l.id,
    label: l.name,
    group: c ? dateLabel(c) : t('actions.noDate'),
    testId: `align-to-${l.id}`,
  }));
}

/** What Align to moves, from the target of the menu. */
function alignSource(
  tg: Extract<MenuTarget, { kind: 'layers' | 'photos' }>,
): { layerIds: string[] } | { picks: { layerId: string; photoId: string }[] } {
  return tg.kind === 'photos' ? { picks: tg.picks } : { layerIds: tg.layerIds };
}

const sourceSets = (tg: Extract<MenuTarget, { kind: 'layers' | 'photos' }>): Set<string> =>
  new Set(tg.kind === 'photos' ? tg.picks.map((p) => p.layerId) : tg.layerIds);

const photosOnly = (tg: MenuTarget, ctx: ActionCtx) =>
  everyLayer(tg, ctx, (l) => l.kind === 'photos');

/** Picked photos that all carry a pin: their pin is their hand placement, nothing to align. */
const allPinned = (tg: MenuTarget, ctx: ActionCtx): boolean =>
  tg.kind === 'photos' &&
  tg.picks.every((p) => {
    const l = ctx.manifest.layers.find((x) => x.id === p.layerId);
    return l?.kind === 'photos' && l.items.find((i) => i.id === p.photoId)?.pin !== undefined;
  });

const stitchable = (layer: Panoramas, root: string) =>
  layer.items.filter((item) => {
    const k = panoStatus(item, jobForPano(jobs.getState().jobs, root, layer.id, item.id)).kind;
    return k === 'queued' || k === 'failed';
  });

const actions: readonly Action[] = [
  // point clouds
  defineAction({
    id: 'cloud.settings',
    label: 'actions.cloud.settings',
    section: 'view',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'pointcloud') !== null,
    run: () => {
      shell.getState().openCloudPanel();
    },
  }),
  defineAction({
    id: 'cloud.colourBy',
    label: 'actions.cloud.colourBy',
    section: 'view',
    targets: ['layers'],
    multi: true,
    appliesTo: (tg, ctx) => everyLayer(tg, ctx, (l) => l.kind === 'pointcloud'),
    submenu: (tg, ctx) => {
      const rgb = targetLayers(tg, ctx).some(
        (l) => l.kind === 'pointcloud' && l.format === 'png-packed',
      );
      const mode = pointcloudSettings.getState().colourMode;
      return COLOUR_MODES.filter((m) => m.id !== 'rgb' || rgb).map((m) => ({
        id: m.id,
        label: m.label,
        checked: m.id === mode,
      }));
    },
    run: (_tg, _ctx, sub) => {
      const m = COLOUR_MODES.find((x) => x.id === sub);
      if (m) pointcloudSettings.getState().setColourMode(m.id);
    },
  }),
  // point cloud cleanup: open the panel, at its noise or save section (pointcloud/cleanupActions.ts)
  ...(
    [
      { id: 'pointcloud.cleanup', label: 'cleanup.menu.open', section: undefined },
      { id: 'pointcloud.removeNoise', label: 'cleanup.menu.noise', section: 'noise' },
      { id: 'pointcloud.saveCleaned', label: 'cleanup.menu.save', section: 'save' },
    ] as const
  ).map((c) =>
    defineAction({
      id: c.id,
      label: c.label,
      section: 'edit',
      targets: ['layers'],
      testId: `menu-${c.id.replace('.', '-')}`,
      appliesTo: (tg, ctx) => {
        const l = only(tg, ctx);
        return l !== null && isCleanable(l);
      },
      disabled: (_tg, ctx) => (c.section === undefined ? false : editBlocked(ctx)),
      run: (tg, ctx) => {
        const l = only(tg, ctx);
        if (l) cleanupActionContext.openPanel(l.id, c.section);
      },
    }),
  ),
  defineAction({
    id: 'pointcloud.resetCleanup',
    label: 'cleanup.menu.reset',
    section: 'edit',
    targets: ['layers'],
    testId: 'menu-pointcloud-resetCleanup',
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return (
        l !== null && isCleanable(l) && Boolean(cleanup.store.getState().layers[l.id]?.present)
      );
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: async (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) await cleanupActionContext.reset(l.id);
    },
  }),
  // models
  defineAction({
    id: 'mesh.georef',
    label: 'actions.mesh.georef',
    section: 'edit',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'mesh') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) builder.getState().startAlign({ kind: 'mesh', layerId: l.id });
    },
  }),
  defineAction({
    id: 'mesh.place',
    label: 'place.menu',
    icon: 'target',
    section: 'edit',
    targets: ['layers'],
    testId: 'menu-place-model',
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'mesh') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) builder.getState().startAlign({ kind: 'place', layerId: l.id });
    },
  }),
  defineAction({
    id: 'layer.dropToGround',
    label: 'actions.layer.dropToGround',
    icon: 'target',
    section: 'edit',
    targets: ['layers'],
    multi: true,
    testId: 'menu-drop-to-ground',
    appliesTo: (tg, ctx) => {
      const ls = targetLayers(tg, ctx);
      return ls.length > 0 && ls.every((l) => droppable(l) !== 'no');
    },
    disabled: (tg, ctx) =>
      editBlocked(ctx) ||
      (targetLayers(tg, ctx).some((l) => droppable(l) === 'kit') && t('actions.reason.kitCloud')),
    run: (tg) => {
      void dropToGround.getState().drop(tg.layerIds);
    },
  }),
  defineAction({
    id: 'engineering.create',
    label: 'eng.entry.menu',
    icon: 'box',
    section: 'edit',
    targets: ['layers'],
    testId: 'menu-create-engineering',
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return engineeringUiOn() && l !== null && ENGINEERING_SOURCES.includes(l.kind);
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) createEngineeringModel([l.id]);
    },
  }),
  // drawings
  defineAction({
    id: 'drawing.settings',
    label: 'actions.drawing.settings',
    section: 'view',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return l !== null && isDrawingPlanLayer(l);
    },
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) drawings.getState().toggleControls(l.id);
    },
  }),
  defineAction({
    id: 'drawing.sideBySide',
    label: 'actions.drawing.sideBySide',
    icon: 'split',
    section: 'open',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return l !== null && isDrawingPlanLayer(l);
    },
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) openSideBySide(l.id);
    },
  }),
  defineAction({
    id: 'drawing.place',
    label: (tg, ctx) => {
      const l = only(tg, ctx);
      const provisional = l ? drawings.getState().placed[l.id]?.provisional === true : false;
      return t(provisional ? 'actions.drawing.place' : 'actions.drawing.placeAgain');
    },
    icon: 'target',
    section: 'edit',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return l !== null && isDrawingPlanLayer(l) && drawings.getState().placed[l.id] !== undefined;
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) startPlacing(l.id);
    },
  }),
  defineAction({
    id: 'drawing.onTop',
    label: (tg, ctx) => {
      const l = only(tg, ctx);
      const id = projectId();
      const on =
        l && id ? stagePrefs.getState().byProject[id]?.drawings?.[l.id]?.onTop === true : false;
      return t(on ? 'actions.drawing.behind' : 'actions.drawing.onTop');
    },
    section: 'view',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const l = only(tg, ctx);
      return l !== null && isDrawingPlanLayer(l);
    },
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      const id = projectId();
      if (!l || !id) return;
      const all = stagePrefs.getState().byProject[id]?.drawings;
      stagePrefs.getState().update(id, {
        drawings: withDrawingDisplay(all, l.id, { onTop: all?.[l.id]?.onTop !== true }),
      });
    },
  }),
  // 360 walks
  defineAction({
    id: 'walk.open',
    label: 'actions.walk.open',
    section: 'open',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'walk') !== null,
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) openWalk(l.id);
    },
  }),
  // the two walks side by side in the two 360 panes, this one leading (walks/walkCompare.ts)
  defineAction({
    id: 'walk.compareWith',
    label: 'actions.walk.compareWith',
    section: 'open',
    targets: ['layers'],
    present: 'submenu',
    testId: 'menu-walk-compareWith',
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'walk') !== null,
    disabled: (tg, ctx) => {
      const w = oneOf(tg, ctx, 'walk');
      return ctx.manifest.layers.some((l) => l.kind === 'walk' && l.id !== w?.id)
        ? false
        : t('actions.walk.compareNone');
    },
    submenuTitle: (tg, ctx) =>
      t('actions.walk.compareTitle', { name: oneOf(tg, ctx, 'walk')?.name ?? '' }),
    submenu: (tg, ctx) => {
      const w = oneOf(tg, ctx, 'walk');
      const dates = new Map(ctx.manifest.captures.map((c) => [c.id, c]));
      return ctx.manifest.layers
        .filter((l): l is Walk => l.kind === 'walk' && l.id !== w?.id)
        .map((l) => {
          const c = dates.get(captureOf(ctx, l.id) ?? '');
          return {
            id: l.id,
            label: l.name,
            group: c ? dateLabel(c) : t('actions.noDate'),
            testId: `compare-with-${l.id}`,
          };
        });
    },
    run: (tg, ctx, sub) => {
      const l = only(tg, ctx);
      if (l && sub !== undefined) startWalkCompare(l.id, sub);
    },
  }),
  defineAction({
    id: 'walk.place',
    label: (tg, ctx) => {
      const w = oneOf(tg, ctx, 'walk');
      return t(w && walkPlaced(w) ? 'actions.walk.editPlacement' : 'actions.walk.place');
    },
    section: 'edit',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'walk') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) placeWalk(l.id);
    },
  }),
  defineAction({
    id: 'walk.removePlacement',
    label: 'actions.walk.removePlacement',
    section: 'danger',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const w = oneOf(tg, ctx, 'walk');
      return w !== null && walkPlaced(w);
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) ctx.host.askUnplace(l.id);
    },
  }),
  // video and flights
  defineAction({
    id: 'video.calibrate',
    label: 'actions.video.calibrate',
    section: 'edit',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'video') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) builder.getState().startAlign({ kind: 'video', layerId: l.id });
    },
  }),
  defineAction({
    id: 'video.alignCamera',
    label: 'actions.video.alignCamera',
    section: 'edit',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'video') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg, ctx) => {
      const l = only(tg, ctx);
      if (l) alignCamera.getState().start(l.id);
    },
  }),
  defineAction({
    id: 'video.flightPath',
    label: (tg, ctx) => {
      const f = flightOf(tg, ctx);
      const m = flightPathModel();
      const shown = f && m ? flightPathShown(m.pref, f, m.activeFlight) : false;
      return t(shown ? 'actions.video.hidePath' : 'actions.video.showPath');
    },
    section: 'view',
    targets: ['layers'],
    multi: true,
    appliesTo: (tg, ctx) => flightOf(tg, ctx) !== null,
    run: (tg, ctx) => {
      const f = flightOf(tg, ctx);
      if (f) updateFlightPaths((p, m) => toggleFlightPath(p, f, m.flights, m.activeFlight));
    },
  }),
  // photos
  defineAction<'layers' | 'photos'>({
    id: 'photos.alignTo',
    label: 'actions.photos.alignTo',
    section: 'edit',
    targets: ['layers', 'photos'],
    multi: true,
    present: 'submenu',
    appliesTo: (tg, ctx) => photosOnly(tg, ctx) && !allPinned(tg, ctx),
    disabled: (tg, ctx) => {
      const block = editBlocked(ctx);
      if (block) return block;
      const hasPos = alignSources(ctx.manifest, null, alignSource(tg)).some(
        (s) => s.pos !== undefined,
      );
      if (!hasPos) return t('actions.reason.noPositions');
      return alignTargets(ctx, sourceSets(tg)).length === 0 ? t('actions.reason.noTargets') : false;
    },
    submenuTitle: (tg, ctx) => {
      const ls = targetLayers(tg, ctx);
      const name =
        tg.kind === 'photos' || ls.length !== 1
          ? t(tg.kind === 'photos' ? 'actions.header.photos' : 'actions.header.layers', {
              count: targetCount(tg),
            })
          : (ls[0]?.name ?? '');
      return t('actions.photos.alignToTitle', { name });
    },
    submenu: (tg, ctx) => alignTargets(ctx, sourceSets(tg)),
    run: async (tg, _ctx, sub) => {
      if (sub === undefined) return;
      await alignTo.getState().alignTo(alignSource(tg), sub);
    },
  }),
  defineAction({
    id: 'photos.createMaps',
    label: 'actions.photos.createMaps',
    section: 'file',
    targets: ['layers'],
    appliesTo: (tg, ctx) => oneOf(tg, ctx, 'photos') !== null,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: () => {
      photoUi.getState().openWizard();
    },
  }),
  defineAction({
    id: 'photos.openFirst',
    label: 'actions.photos.openFirst',
    section: 'open',
    targets: ['layers'],
    appliesTo: (tg, ctx) => (oneOf(tg, ctx, 'photos')?.items.length ?? 0) > 0,
    run: (tg, ctx) => {
      const l = oneOf(tg, ctx, 'photos');
      const first = l?.items[0];
      if (l && first) openPhoto(l.id, first.id);
    },
  }),
  // drone panoramas
  defineAction({
    id: 'pano.open',
    label: 'actions.pano.open',
    section: 'open',
    targets: ['layers'],
    appliesTo: (tg, ctx) => {
      const l = oneOf(tg, ctx, 'panoramas');
      return l?.items.some(panoOpenable) === true;
    },
    run: (tg, ctx) => {
      const l = oneOf(tg, ctx, 'panoramas');
      const item = l?.items.find(panoOpenable);
      if (!l || !item) return;
      const ws = workspace.getState();
      ws.setLayerVisible(l.id, true);
      shell.getState().go('scene');
      ws.openPano(l.id, item.id);
    },
  }),
  defineAction({
    id: 'pano.stitch',
    label: 'actions.pano.stitch',
    section: 'edit',
    targets: ['layers'],
    multi: true,
    appliesTo: (tg, ctx) => {
      const root = workspace.getState().project?.root;
      return (
        root !== undefined &&
        everyLayer(tg, ctx, (l) => l.kind === 'panoramas') &&
        targetLayers(tg, ctx).some((l) => l.kind === 'panoramas' && stitchable(l, root).length > 0)
      );
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: async (tg, ctx) => {
      const root = workspace.getState().project?.root;
      if (root === undefined) return;
      for (const l of targetLayers(tg, ctx)) {
        if (l.kind !== 'panoramas') continue;
        for (const item of stitchable(l, root))
          await jobs.getState().start({
            pipeline: 'pano.stitch',
            project: root,
            params: { layer: l.id, pano: item.id, quality: 'standard', shape: shapeOf(item) },
          });
      }
    },
  }),
  // annotations
  defineAction<'group' | 'annotations'>({
    id: 'annotations.open',
    label: 'actions.annotations.open',
    section: 'open',
    targets: ['group', 'annotations'],
    appliesTo: (tg) => tg.kind === 'annotations' || tg.group === 'annotations',
    run: () => {
      shell.getState().go('issues');
    },
  }),
  defineAction<'group' | 'annotations'>({
    id: 'annotations.pins',
    label: () =>
      t(
        pinDisplay.getState().filter === 'off'
          ? 'actions.annotations.showPins'
          : 'actions.annotations.hidePins',
      ),
    section: 'view',
    targets: ['group', 'annotations'],
    appliesTo: (tg) => tg.kind === 'annotations' || tg.group === 'annotations',
    run: () => {
      pinDisplay.getState().togglePins();
    },
  }),
];

/** The flight every targeted layer is a clip of, or null (not clips, or clips of several flights). */
function flightOf(tg: MenuTarget, ctx: ActionCtx): string | null {
  const ls = targetLayers(tg, ctx);
  if (ls.length === 0 || !ls.every((l) => l.kind === 'video')) return null;
  const flights = flightGroups(ctx.manifest.layers);
  const ids = new Set(ls.map((l) => flights.find((f) => f.clips.some((c) => c.id === l.id))?.id));
  const [one] = ids;
  return ids.size === 1 && one !== undefined ? one : null;
}

/** Register the right-click actions that belong to one kind of dataset. */
export function registerKindActions(): () => void {
  return registerActions(actions);
}

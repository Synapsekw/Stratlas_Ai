import { useAnnotateReadOnly } from '@aio/annotate';
import type { PanoRef, PhotoRef } from '@aio/schema';
import {
  defineAction,
  makeActionCtx,
  registerActions,
  t,
  targetCount,
  type Action,
  type ActionCtx,
  type MenuTarget,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useCallback } from 'react';
import { builder } from '../../builder/state';
import { mediaItem, type MediaKey } from '../../pins/pinModel';
import type { PinMode } from '../../pins/pinStore';
import { mediaName, pinSession } from '../../pins/placePin';
import { bridge, shell, useShell } from '../../shell';
import { readOnly } from './reasons';
import { toastHost } from './toastHost';

/*
 * The pin actions of a photo or 360 (pinned media design): place it on the site, move its pin,
 * set its direction, remove the pin, and move it between photos and 360s. Photos keep the
 * `photos` target (the Datasets photo rows, Media tiles); 360s and pins in the views are `media`.
 * Only pinned or unplaced items take a pin: an item placed by its GPS gets no Move or direction
 * here (a GPS correction is not this feature's job; the photo hand correction stays for that).
 */

type Target = Extract<MenuTarget, { kind: 'photos' | 'media' }>;
const TARGETS = ['photos', 'media'] as const;

/** The one photo or 360 the menu is on, or null for several. */
function keyOf(tg: Target): MediaKey | null {
  if (targetCount(tg) !== 1) return null;
  if (tg.kind === 'media') return tg.picks[0] ?? null;
  const p = tg.picks[0];
  return p ? { kind: 'photo', layerId: p.layerId, itemId: p.photoId } : null;
}

/** The key and its item in the manifest, or null. */
function picked(tg: Target, ctx: ActionCtx): { k: MediaKey; item: PhotoRef | PanoRef } | null {
  const k = keyOf(tg);
  const item = k ? mediaItem(ctx.manifest, k) : null;
  return k && item ? { k, item } : null;
}

/** Why a pin or a conversion is greyed: a package, or a reviewer who may only look. */
const blocked = (_tg: Target, ctx: ActionCtx): string | false =>
  ctx.pkg ? t('pin.convert.package') : readOnly(ctx);

/** Start the placing session on the site (the scene, the item's layer shown). */
function begin(k: MediaKey, mode: PinMode): void {
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  workspace.getState().setLayerVisible(k.layerId, true);
  pinSession.getState().begin(k, mode);
}

async function convert(k: MediaKey, to: 'pano' | 'photo', ctx: ActionCtx): Promise<void> {
  const project = workspace.getState().project;
  if (!project) return;
  const r = await bridge.call('builder:convertMedia', {
    projectId: project.id,
    layerId: k.layerId,
    itemId: k.itemId,
    to,
  });
  if (!r.ok) {
    ctx.host.note(r.error, true);
    return;
  }
  if (!r.value.ok) {
    ctx.host.note(r.value.error, true);
    return;
  }
  workspace.getState().replaceManifest(r.value.manifest);
}

const actions: readonly Action[] = [
  defineAction<'photos' | 'media'>({
    id: 'media.place',
    label: 'pin.place',
    icon: 'pin',
    section: 'edit',
    targets: TARGETS,
    appliesTo: (tg, ctx) => {
      const p = picked(tg, ctx);
      return p !== null && p.item.pos === undefined;
    },
    disabled: blocked,
    run: (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p) begin(p.k, 'place');
    },
  }),
  defineAction<'photos' | 'media'>({
    id: 'media.move',
    label: 'pin.move',
    icon: 'crosshair',
    section: 'edit',
    targets: TARGETS,
    appliesTo: (tg, ctx) => picked(tg, ctx)?.item.pin !== undefined,
    disabled: blocked,
    run: (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p) begin(p.k, 'move');
    },
  }),
  defineAction<'photos' | 'media'>({
    id: 'media.direction',
    label: 'pin.direction',
    icon: 'target',
    section: 'edit',
    targets: TARGETS,
    appliesTo: (tg, ctx) => picked(tg, ctx)?.item.pin !== undefined,
    disabled: blocked,
    run: (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p) begin(p.k, 'direction');
    },
  }),
  defineAction<'photos' | 'media'>({
    id: 'media.as360',
    label: 'pin.as360',
    icon: 'pano',
    section: 'edit',
    targets: TARGETS,
    appliesTo: (tg, ctx) => picked(tg, ctx)?.k.kind === 'photo',
    disabled: blocked,
    run: async (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p) await convert(p.k, 'pano', ctx);
    },
  }),
  defineAction<'photos' | 'media'>({
    id: 'media.asPhoto',
    label: 'pin.asPhoto',
    icon: 'photo',
    section: 'edit',
    targets: TARGETS,
    appliesTo: (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p?.k.kind !== 'pano') return false;
      // a stitched sphere or a partial one has no single image to show as a photo
      const item = p.item as PanoRef;
      return item.stitch === undefined && item.cov === undefined;
    },
    disabled: blocked,
    run: async (tg, ctx) => {
      const p = picked(tg, ctx);
      if (p) await convert(p.k, 'photo', ctx);
    },
  }),
  defineAction<'photos' | 'media'>({
    id: 'media.remove',
    label: 'pin.remove',
    icon: 'x',
    section: 'danger',
    targets: TARGETS,
    appliesTo: (tg, ctx) => picked(tg, ctx)?.item.pin !== undefined,
    disabled: blocked,
    run: async (tg, ctx) => {
      const p = picked(tg, ctx);
      if (!p) return;
      const err = await builder
        .getState()
        .saveLayers([p.k.layerId], { mediaPin: { itemId: p.k.itemId, pin: null } });
      if (err !== null) ctx.host.note(err, true);
    },
  }),
];

/** Register the pin actions of photos and 360s. */
export function registerPinActions(): () => void {
  return registerActions(actions);
}

/** The context the pin actions read, for a menu on `key`; null without a project. */
export function usePinActionCtx(): (key: MediaKey) => ActionCtx | null {
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  return useCallback(
    (key: MediaKey) => {
      const manifest = workspace.getState().project?.manifest;
      const item = manifest ? mediaItem(manifest, key) : null;
      if (!manifest || !item) return null;
      return makeActionCtx({
        manifest,
        hidden: workspace.getState().hidden,
        pkg: !!pkg,
        canEdit: !pkg && !lookOnly,
        host: toastHost(mediaName(item)),
      });
    },
    [pkg, lookOnly],
  );
}

/**
 * The point cloud cleanup actions of a layer's right-click menu, as plain records in the shape of
 * the sidebar's shared action registry (feat/sidebar-context-menus moves them there when it
 * rebases): `{ id, label, applies(target), multi, run(target, ctx) }`. The menu calls `run`; no
 * handler logic lives in JSX.
 */
import type { Layer } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import { cleanup, isCleanable } from './cleanupStore';

export interface CleanupTarget {
  layer: Layer;
  readOnly: boolean;
  hasRecipe: boolean;
}

export interface CleanupActionContext {
  openPanel(layerId: string, section?: 'noise' | 'save'): void;
  reset(layerId: string): Promise<boolean>;
}

export interface CleanupAction {
  id:
    | 'pointcloud.cleanup'
    | 'pointcloud.removeNoise'
    | 'pointcloud.saveCleaned'
    | 'pointcloud.resetCleanup';
  label: MessageKey;
  applies(target: CleanupTarget): boolean;
  multi: false;
  // the shared action registry's shape: a menu item may or may not wait on its action
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  run(target: CleanupTarget, ctx: CleanupActionContext): void | Promise<unknown>;
}

const editable = (t: CleanupTarget) => isCleanable(t.layer) && !t.readOnly;

export const CLEANUP_ACTIONS: readonly CleanupAction[] = [
  {
    id: 'pointcloud.cleanup',
    label: 'cleanup.menu.open',
    applies: (t) => isCleanable(t.layer),
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id);
    },
  },
  {
    id: 'pointcloud.removeNoise',
    label: 'cleanup.menu.noise',
    applies: editable,
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id, 'noise');
    },
  },
  {
    id: 'pointcloud.saveCleaned',
    label: 'cleanup.menu.save',
    applies: editable,
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id, 'save');
    },
  },
  {
    id: 'pointcloud.resetCleanup',
    label: 'cleanup.menu.reset',
    applies: (t) => editable(t) && t.hasRecipe,
    multi: false,
    run: (t, ctx) => ctx.reset(t.layer.id),
  },
];

export const cleanupActionContext: CleanupActionContext = {
  openPanel: (layerId, section) => {
    cleanup.openPanel(layerId, section);
  },
  reset: (layerId) => cleanup.reset(layerId),
};

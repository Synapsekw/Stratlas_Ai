/**
 * The cleanup tools on the stage: the clip box gizmo while the stage tool is `clipbox`, the box or
 * lasso selection while it is `pcselect`, for the active layer of the Clean up panel. A box drag
 * shows live (no step) and commits one step on release; a drawn selection counts the loaded points
 * it covers and waits in `pending` for Hide, Delete or Set class (the panel's bar). Ctrl+Z and
 * Ctrl+Shift+Z (Ctrl+Y) undo and redo while the panel or a cleanup tool is active.
 *
 * The tools work in the stage's local frame; the recipe holds world coordinates (cleanupFrame.ts).
 */
import {
  ClipBoxTool,
  PointSelectTool,
  type BoxHandle,
  type ClipBoxLocal,
  type EngineStage,
  type PointSelection,
} from '@aio/engine';
import { applyRegions, className, compileCleanup, countDrawn } from '@aio/pointcloud';
import { MAX_REGIONS, emptyCleanup, type PointcloudCleanup, type RegionAction } from '@aio/schema';
import { isShortcut, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { isTyping } from '../keys';
import { boxToLocal, boxToWorld, sameLocalBox, worldViewProj } from './cleanupFrame';
import { cleanup as appCleanup, type Cleanup } from './cleanupStore';

type V3 = readonly [number, number, number];

/**
 * Whether a point (in the frame `m` maps to clip) falls in the drawn outline: the recipe's own
 * region test (`applyRegions`) on a one-region recipe, so the count and the evaluators agree.
 */
export function selectionTest(
  m: readonly number[],
  polygon: readonly [number, number][],
): (x: number, y: number, z: number) => boolean {
  const compiled = compileCleanup({
    ...emptyCleanup('selection'),
    regions: [
      {
        id: 'selection',
        shape: 'lasso',
        viewProj: Array.from(m),
        polygon: polygon.map(([x, y]): [number, number] => [x, y]),
        action: { kind: 'hide' },
      },
    ],
  });
  const out = { cls: 0, hide: false, del: false };
  return (x, y, z) => applyRegions(compiled, x, y, z, 0, out).hide;
}

const newRegionId = () =>
  `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export async function applyPending(
  c: Cleanup,
  action: RegionAction,
  newId: () => string = newRegionId,
): Promise<boolean> {
  const p = c.store.getState().pending;
  if (!p) return false;
  const base = c.recipeOf(p.layerId) ?? emptyCleanup(p.layerId);
  if (base.regions.length >= MAX_REGIONS) {
    c.notify({
      text: t('cleanup.select.full', { max: MAX_REGIONS }),
      undo: false,
      error: true,
      layerId: p.layerId,
    });
    return false;
  }
  const region = { id: newId(), shape: p.shape, viewProj: p.viewProj, polygon: p.polygon, action };
  c.setPending(null);
  return c.commit(
    p.layerId,
    { ...base, regions: [...base.regions, region] },
    action.kind === 'class'
      ? { kind: 'classSet', name: className(action.value) }
      : { kind: action.kind === 'hide' ? 'hidden' : 'deleted' },
  );
}

/** Undo or redo for the cleanup scope; true when the key was taken. */
export function cleanupKey(e: KeyboardEvent, c: Cleanup, toolActive: boolean): boolean {
  const s = c.store.getState();
  if (!(s.panelOpen || toolActive) || !s.active || isTyping(e.target)) return false;
  if (isShortcut('cleanup.undo', e)) void c.undo(s.active);
  else if (isShortcut('cleanup.redo', e)) void c.redo(s.active);
  else return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

let liveBox: ClipBoxTool | null = null;
/** For the e2e specs (`__stratlas.pointcloudCleanup.handle`). */
export const cleanupDebug = {
  handleScreen: (h: BoxHandle) => liveBox?.handleScreen(h) ?? null,
};

const originOf = (): V3 | null => workspace.getState().project?.manifest.origin ?? null;

export function mountCleanupScene(stage: EngineStage, c: Cleanup = appCleanup): () => void {
  let box: {
    tool: ClipBoxTool;
    off: () => void;
    layerId: string;
    /** The recipe the gizmo last showed: a new one (undo, redo, elsewhere) moves it. */
    shown: PointcloudCleanup | null;
  } | null = null;
  let select: { tool: PointSelectTool; off: () => void; layerId: string } | null = null;

  const boxOf = (layerId: string, origin: V3): ClipBoxLocal | null => {
    const r = c.recipeOf(layerId);
    return r?.clipBox ? boxToLocal(r.clipBox, origin) : null;
  };

  const sync = () => {
    const s = c.store.getState();
    const origin = originOf();
    const layerId = s.active;
    const wantBox =
      stage.tool === 'clipbox' && layerId && origin && !s.readOnly ? boxOf(layerId, origin) : null;
    if (box && (!wantBox || box.layerId !== layerId)) {
      box.off();
      box = null;
      liveBox = null;
    }
    if (box && origin && c.recipeOf(box.layerId) !== box.shown) {
      box.shown = c.recipeOf(box.layerId);
      const local = boxOf(box.layerId, origin);
      if (local) box.tool.setBox(local);
    }
    if (wantBox && layerId && origin && !box) {
      const id = layerId;
      const o = origin;
      /** The recipe again in the view and on the gizmo (a refused or unchanged release). */
      const restore = () => {
        const r = c.recipeOf(id);
        c.preview(id, r);
        const local = boxOf(id, o);
        if (box?.layerId === id && local) box.tool.setBox(local);
      };
      const tool = new ClipBoxTool(stage, {
        box: wantBox,
        onChange: (local, done) => {
          const base = c.recipeOf(id) ?? emptyCleanup(id);
          const current = base.clipBox ? boxToLocal(base.clipBox, o) : null;
          if (done && current && sameLocalBox(local, current)) {
            // compared in the local frame: a release that changed nothing is no step
            restore();
            return;
          }
          const keep = base.clipBox?.keep ?? 'inside';
          const next = { ...base, clipBox: boxToWorld(local, o, keep) };
          if (!done) {
            c.preview(id, next);
            return;
          }
          void c.commit(id, next).then((ok) => {
            if (!ok) restore();
          });
        },
      });
      box = { tool, off: tool.attach(), layerId: id, shown: c.recipeOf(id) };
      liveBox = tool;
    }
    const wantSelect = stage.tool === 'pcselect' && !s.readOnly;
    if (select && (!wantSelect || !layerId || !origin || select.layerId !== layerId)) {
      select.off();
      select = null;
    }
    if (wantSelect && layerId && origin && !select) {
      const id = layerId;
      const o = origin;
      const tool = new PointSelectTool(stage, {
        shape: s.selectShape,
        onSelect: (sel: PointSelection) => {
          // the stage camera's view maps the local frame to clip; the recipe stores world to clip
          const count = countDrawn(stage, id, selectionTest(sel.viewProj, sel.polygon)).drawn;
          c.setPending({
            layerId: id,
            shape: sel.shape,
            polygon: sel.polygon,
            viewProj: worldViewProj(sel.viewProj, o),
            count,
          });
        },
        onCancel: () => {
          c.setPending(null);
          stage.setTool('select');
        },
      });
      select = { tool, off: tool.attach(), layerId: id };
    }
    select?.tool.setShape(s.selectShape);
  };

  const offStage = stage.onStateChange(sync);
  const offStore = c.store.subscribe(sync);
  const onKey = (e: KeyboardEvent) => {
    cleanupKey(e, c, stage.tool === 'clipbox' || stage.tool === 'pcselect');
  };
  window.addEventListener('keydown', onKey, { capture: true });
  sync();
  return () => {
    window.removeEventListener('keydown', onKey, { capture: true });
    offStage();
    offStore();
    box?.off();
    select?.off();
    box = null;
    select = null;
    liveBox = null;
    if (stage.tool === 'clipbox' || stage.tool === 'pcselect') stage.setTool('select');
  };
}

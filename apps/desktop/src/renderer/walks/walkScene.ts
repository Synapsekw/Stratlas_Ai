import type { EngineStage } from '@aio/engine';
import type { WalkFit } from '@aio/geo';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  type Material,
  Points,
  PointsMaterial,
  Vector2,
  Vector3,
} from 'three';

/*
 * The walk in the 3D view (design "Walk placing by start and end", unit 6): the path as a line
 * on the ground at the clicked heights, the shape that follows the pointer, and the Start and
 * End handles, drawn over the model (no depth test, raised render order). Hover through
 * `stage.raycast`, clicks through `stage.claimClicks`, a handle drag with the orbit controls off.
 * Placed walks are drawn faintly. The session behind it is wired in `WalkSceneMount.tsx`.
 */

export const WALK_SCENE_GROUP = 'aio-walks';
export const WALK_PREVIEW_NAME = 'aio-walk-preview';

/** A walk's path in the model, runs split where the dashed state changes. */
export interface WalkSceneWalk {
  id: string;
  colour: string;
  runs: { pts: [number, number, number][]; dashed: boolean }[];
}
/** What the walk being placed in the 3D view shows and takes. */
export interface WalkScenePlacing {
  walk: WalkSceneWalk | null;
  preview: { pts: [number, number, number][]; ghost: boolean; tooClose: boolean } | null;
  handles: { id: 'start' | 'end'; at: [number, number, number] }[];
  /** A click on the view is wanted (start, end, or a fine-tune pin, move or align). */
  clicks: boolean;
}
export interface WalkSceneInput {
  hover(at: [number, number] | null, y?: number): void;
  click(at: [number, number], y: number): void;
  drag(handle: 'start' | 'end', at: [number, number], y: number): void;
  endDrag(): void;
}
export interface WalkSceneView {
  /** Placed walks drawn faintly (not the one being placed). */
  setPlaced(walks: readonly WalkSceneWalk[]): void;
  setPlacing(p: WalkScenePlacing | null, input: WalkSceneInput | null): void;
  dispose(): void;
}
/** Lines sit this far above the ground, metres, so the ground does not hide them. */
const LIFT_M = 0.1;
/** A press this close to a handle (screen px) grabs it. */
const HANDLE_PX = 10;
const FAINT = 0.6;
const GHOST = 0.45;

export function sceneRuns(
  fit: WalkFit,
  durationS: number,
  stepS = 0.25,
  lift = LIFT_M,
): WalkSceneWalk['runs'] {
  const runs: WalkSceneWalk['runs'] = [];
  let cur: WalkSceneWalk['runs'][number] | null = null;
  const end = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  const step = Number.isFinite(stepS) && stepS > 0 ? stepS : 0.25;
  // whole steps, then the end itself, so the line always reaches the last second
  const n = Math.ceil(end / step - 1e-9);
  for (let i = 0; i <= n; i++) {
    const a = fit.at(Math.min(i * step, end));
    if (!a) {
      cur = null;
      continue;
    }
    const p: [number, number, number] = [a.xz[0], a.groundY + lift, a.xz[1]];
    if (cur?.dashed !== a.dashed) {
      // runs share their joint, so a dashed stretch meets the solid one
      const prev: WalkSceneWalk['runs'][number] | null = cur;
      const joint: [number, number, number] | undefined = prev?.pts.at(-1);
      const next: WalkSceneWalk['runs'][number] = { pts: joint ? [joint] : [], dashed: a.dashed };
      runs.push(next);
      cur = next;
    }
    cur.pts.push(p);
  }
  return runs.filter((r) => r.pts.length > 1);
}

export function previewPoints(
  xz: readonly [number, number][],
  y: [number, number] | null,
  lift = LIFT_M,
): [number, number, number][] {
  const n = xz.length;
  return xz.map((p, i) => {
    const f = n > 1 ? i / (n - 1) : 0;
    const h = y ? y[0] + (y[1] - y[0]) * f : 0;
    return [p[0], h + lift, p[1]];
  });
}

export function attachWalkScene(stage: EngineStage): WalkSceneView {
  const group = new Group();
  group.name = WALK_SCENE_GROUP;
  group.renderOrder = 45;
  stage.scene.add(group);
  const placedGroup = new Group();
  const placingGroup = new Group();
  group.add(placedGroup, placingGroup);
  const canvas = stage.renderer.domElement;

  let placing: WalkScenePlacing | null = null;
  let input: WalkSceneInput | null = null;
  let dragging: 'start' | 'end' | null = null;

  const line = (
    pts: readonly [number, number, number][],
    colour: string,
    opacity: number,
    dashed: boolean,
  ): Line => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flat(), 3));
    const common = { color: new Color(colour), depthTest: false, transparent: true, opacity };
    const l = new Line(
      g,
      dashed
        ? new LineDashedMaterial({ ...common, dashSize: 0.6, gapSize: 0.4 })
        : new LineBasicMaterial(common),
    );
    if (dashed) l.computeLineDistances();
    l.renderOrder = 45;
    return l;
  };
  const clear = (g: Group) => {
    for (const c of [...g.children]) {
      g.remove(c);
      if (c instanceof Line || c instanceof Points) {
        const o = c as unknown as { geometry: BufferGeometry; material: Material | Material[] };
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((x) => {
          x.dispose();
        });
      }
    }
  };
  const drawWalk = (g: Group, w: WalkSceneWalk, opacity: number) => {
    for (const r of w.runs) g.add(line(r.pts, w.colour, opacity, r.dashed));
  };

  const redraw = () => {
    clear(placingGroup);
    const p = placing;
    if (p?.walk) drawWalk(placingGroup, p.walk, 1);
    if (p?.preview && p.preview.pts.length > 1) {
      const l = line(
        p.preview.pts,
        p.walk?.colour ?? '#ffffff',
        p.preview.ghost ? GHOST : 1,
        p.preview.ghost || p.preview.tooClose,
      );
      l.name = WALK_PREVIEW_NAME;
      placingGroup.add(l);
    }
    if (p && p.handles.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new Float32BufferAttribute(
          p.handles.flatMap((h) => [h.at[0], h.at[1] + LIFT_M, h.at[2]]),
          3,
        ),
      );
      const pts = new Points(
        g,
        new PointsMaterial({
          color: new Color(p.walk?.colour ?? '#ffffff'),
          size: 14,
          sizeAttenuation: false,
          depthTest: false,
          transparent: true,
        }),
      );
      pts.renderOrder = 46;
      placingGroup.add(pts);
    }
    stage.requestRender();
  };

  const ground = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const hit = stage.raycast(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    return hit ? hit.point : null;
  };
  const tmp = new Vector3();
  const screenOf = (p: readonly [number, number, number]): Vector2 | null => {
    tmp.set(p[0], p[1], p[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return new Vector2(r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height);
  };
  const handleAt = (e: PointerEvent): 'start' | 'end' | null => {
    let best: 'start' | 'end' | null = null;
    let bestD = HANDLE_PX;
    for (const h of placing?.handles ?? []) {
      const s = screenOf(h.at);
      const d = s ? Math.hypot(s.x - e.clientX, s.y - e.clientY) : Infinity;
      if (d <= bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  };

  const onMove = (e: PointerEvent) => {
    if (!input) return;
    const p = ground(e);
    if (dragging) {
      if (p) input.drag(dragging, [p.x, p.z], p.y);
      return;
    }
    if (p) input.hover([p.x, p.z], p.y);
    else input.hover(null);
  };
  const onLeave = () => {
    if (!dragging) input?.hover(null);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !input) return;
    const h = handleAt(e);
    if (!h) return;
    dragging = h;
    stage.controls.enabled = false;
    e.stopImmediatePropagation();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = null;
    stage.controls.enabled = true;
    input?.endDrag();
  };
  const offClaim = stage.claimClicks((e) => {
    // the stage reports a handle grab that barely moved as a click before the window sees the
    // release: it belongs to the drag, so swallow it rather than place a pin there too
    if (dragging) return true;
    if (!placing?.clicks || !input) return false;
    const p = ground(e);
    if (p) input.click([p.x, p.z], p.y);
    return true;
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp);

  return {
    setPlaced: (walks) => {
      clear(placedGroup);
      for (const w of walks) drawWalk(placedGroup, w, FAINT);
      stage.requestRender();
    },
    setPlacing: (p, i) => {
      // a session that ends mid drag still ends the drag (orbit controls back on)
      if (!p || !i) onUp();
      placing = p;
      input = i;
      canvas.style.cursor = p?.clicks ? 'crosshair' : '';
      redraw();
    },
    dispose: () => {
      onUp();
      offClaim();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp);
      clear(placedGroup);
      clear(placingGroup);
      stage.scene.remove(group);
      stage.requestRender();
    },
  };
}

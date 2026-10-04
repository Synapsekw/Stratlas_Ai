import type { SceneHandle } from '@aio/engine';
import type { Issue, SeverityModel } from '@aio/schema';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Raycaster,
} from 'three';
import { drapedShapes, type MapToLocal } from './drape';

/** Height of draped map shapes above the ground plane, metres. */
const DRAPE_Y = 0.05;

export interface DrapeLayer {
  /** Every shape again (issues, project or pin filter changed). */
  shapes(
    issues: readonly Issue[],
    models: readonly SeverityModel[],
    toLocal: MapToLocal | null,
  ): void;
  /** Outline the selected issue (or nothing). */
  select(issue: Issue | null, models: readonly SeverityModel[], toLocal: MapToLocal | null): void;
  /** The issue whose draped fill is under the ray, if any. */
  pick(rc: Raycaster): string | null;
  dispose(): void;
}

/**
 * Issues' polygon map sightings draped on the ground (y = 0): outlines and a light fill in the
 * severity colour, the selected issue outlined in white on top. Drawn without depth test so the
 * ortho tiles never hide them.
 */
export function createDrapeLayer(handle: SceneHandle): DrapeLayer {
  const group = new Group();
  group.name = 'annotate-map-shapes';
  handle.scene.add(group);
  const lineMat = new LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const fillMat = new MeshBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.2,
    side: DoubleSide,
  });
  const selMat = new LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
  let lines: LineSegments | null = null;
  let fill: Mesh | null = null;
  let sel: LineSegments | null = null;
  let faceIssue: string[] = [];
  const clear = (o: LineSegments | Mesh | null) => {
    if (!o) return;
    group.remove(o);
    o.geometry.dispose();
  };
  return {
    shapes(issues, models, toLocal) {
      clear(lines);
      clear(fill);
      lines = null;
      fill = null;
      faceIssue = [];
      if (toLocal) {
        const d = drapedShapes(issues, models, null, toLocal, DRAPE_Y);
        if (d.lines.positions.length) {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(d.lines.positions, 3));
          g.setAttribute('color', new BufferAttribute(d.lines.colors, 3));
          lines = new LineSegments(g, lineMat);
          lines.renderOrder = 901;
          lines.frustumCulled = false;
          group.add(lines);
        }
        if (d.fill.indices.length) {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(d.fill.positions, 3));
          g.setAttribute('color', new BufferAttribute(d.fill.colors, 3));
          g.setIndex(d.fill.indices);
          g.computeBoundingSphere();
          fill = new Mesh(g, fillMat);
          fill.renderOrder = 900;
          faceIssue = d.fill.faceIssue;
          group.add(fill);
        }
      }
      handle.requestRender();
    },
    select(issue, models, toLocal) {
      clear(sel);
      sel = null;
      if (issue && toLocal) {
        const d = drapedShapes([issue], models, issue.id, toLocal, DRAPE_Y);
        if (d.selected) {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(d.selected.positions, 3));
          sel = new LineSegments(g, selMat);
          sel.renderOrder = 902;
          sel.frustumCulled = false;
          group.add(sel);
        }
      }
      handle.requestRender();
    },
    pick(rc) {
      if (!fill) return null;
      const hit = rc.intersectObject(fill, false)[0];
      const face = hit?.faceIndex;
      return face !== undefined && face !== null ? (faceIssue[face] ?? null) : null;
    },
    dispose() {
      clear(lines);
      clear(fill);
      clear(sel);
      handle.scene.remove(group);
      lineMat.dispose();
      fillMat.dispose();
      selMat.dispose();
    },
  };
}

import type { EngineStage } from '@aio/engine';
import { Color, Group, type Mesh, type Object3D, Vector2 } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { resolveCssColour } from '../walks/walkMapOverlay';

/*
 * The flight lines in the 3D view, next to the walks' paths (`walks/walkScene.ts`): one fat
 * polyline per visible flight, tagged with its layer so a click selects it (`hitLayer`).
 */

export const FLIGHTLINE_GROUP = 'aio-flightlines';
/** A flight line's width, screen px. */
export const FLIGHTLINE_PX = 3;

export interface FlightlineDraw {
  id: string;
  /** `x y z` per point, scene metres. */
  points: Float32Array;
  colour: string;
  visible: boolean;
}
export interface FlightlineView {
  set(lines: readonly FlightlineDraw[]): void;
  dispose(): void;
}

function hexOf(colour: string): number {
  try {
    return new Color(resolveCssColour(colour)).getHex();
  } catch {
    return 0xffffff;
  }
}

export function attachFlightlines(stage: EngineStage): FlightlineView {
  const group = new Group();
  group.name = FLIGHTLINE_GROUP;
  group.renderOrder = 44;
  stage.scene.add(group);
  const size = new Vector2();

  const free = (o: Object3D) => {
    o.traverse((c) => {
      const m = c as Partial<Mesh>;
      m.geometry?.dispose();
      const mat = m.material;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
  };
  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      free(c);
    }
  };

  return {
    set: (lines) => {
      clear();
      for (const l of lines) {
        if (!l.visible || l.points.length < 6) continue;
        const g = new LineGeometry();
        g.setPositions(l.points);
        const mat = new LineMaterial({
          color: hexOf(l.colour),
          linewidth: FLIGHTLINE_PX,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
          depthWrite: false,
        });
        mat.fog = false;
        const line = new Line2(g, mat);
        line.name = `aio-flightline-${l.id}`;
        line.userData = { layerId: l.id };
        line.renderOrder = 44;
        line.frustumCulled = false;
        // fat lines take their width in pixels of the canvas they are drawn on
        line.onBeforeRender = (renderer) => {
          renderer.getSize(size);
          mat.resolution.set(size.x, size.y);
        };
        group.add(line);
      }
      stage.requestRender();
    },
    dispose: () => {
      clear();
      stage.scene.remove(group);
      stage.requestRender();
    },
  };
}

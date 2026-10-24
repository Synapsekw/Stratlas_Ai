import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  DoubleSide,
} from 'three';
import { describe, expect, it } from 'vitest';
import { pilePickAt } from './VolumetricStage';

/*
 * A camera straight down on a 1000 x 1000 px view, 1 px a metre: local (x, z) is on screen at
 * (500 + x, 500 + z).
 */
const camera = new OrthographicCamera(-500, 500, 500, -500, 0.1, 1000);
camera.position.set(0, 100, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const rect = { left: 0, top: 0, width: 1000, height: 1000 };

/** A square from (x0, z0) to (x1, z1) at height 0, as a ring of (x, y, z). */
const ring = (x0: number, z0: number, x1: number, z1: number) => [
  x0,
  0,
  z0,
  x1,
  0,
  z0,
  x1,
  0,
  z1,
  x0,
  0,
  z1,
];

function pileGroup(id: string): Group {
  const g = new Group();
  g.name = `vol:${id}`;
  g.userData.pile = id;
  return g;
}

function bodyTop(x0: number, z0: number, x1: number, z1: number): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(ring(x0, z0, x1, z1)), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new Mesh(geo, new MeshBasicMaterial({ side: DoubleSide }));
  m.name = 'body-top';
  return m;
}

function toe(x0: number, z0: number, x1: number, z1: number): LineLoop {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(ring(x0, z0, x1, z1)), 3));
  const l = new LineLoop(geo, new LineBasicMaterial());
  l.name = 'toe';
  return l;
}

function scene(): Group {
  const root = new Group();
  // P1 has a body (any body mode draws `body-top`), P2 only its toe line (bodies hidden)
  const p1 = pileGroup('P1');
  p1.add(bodyTop(0, 0, 100, 100));
  const p2 = pileGroup('P2');
  p2.add(toe(-300, -300, -200, -200));
  root.add(p1, p2);
  root.updateMatrixWorld(true);
  return root;
}

describe('pilePickAt', () => {
  it('a body-top click picks the pile, whichever body mode drew it', () => {
    expect(pilePickAt(scene(), camera, rect, 550, 550)).toBe('P1');
  });

  it('a click near a toe line picks its pile when bodies are hidden', () => {
    // the toe's west edge is at x = -300, screen x 200
    expect(pilePickAt(scene(), camera, rect, 203, 250)).toBe('P2');
    // inside the toe but far from the line: no body there, no pick
    expect(pilePickAt(scene(), camera, rect, 250, 250)).toBeNull();
  });

  it('a hidden pile and empty ground pick nothing', () => {
    const root = scene();
    for (const c of root.children) c.visible = false;
    expect(pilePickAt(root, camera, rect, 550, 550)).toBeNull();
    expect(pilePickAt(scene(), camera, rect, 900, 900)).toBeNull();
  });
});

import {
  BoxGeometry,
  Group,
  Line,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Scene,
  type WebGLRenderer,
} from 'three';
import type { SceneHandle } from '@aio/engine';
import { describe, expect, it } from 'vitest';
import {
  createOcclusion,
  decodeDepth,
  encodeDepth,
  isOccluder,
  occlusionSlack,
  pointClear,
  type DepthSnapshot,
} from './occlusion';

const W = 40;
const H = 30;

/** A camera at z = 40 looking down -Z at the origin. */
function camera() {
  const c = new PerspectiveCamera(50, W / H, 0.1, 1000);
  c.position.set(0, 0, 40);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** A snapshot of a wall at z = 0 (40 m away) with a hole over the right half. */
function wallSnapshot(): DepthSnapshot {
  const cam = camera();
  const depth = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) depth[y * W + x] = x >= W / 2 ? Infinity : 40;
  return {
    width: W,
    height: H,
    depth,
    view: cam.matrixWorldInverse.clone(),
    proj: cam.projectionMatrix.clone(),
  };
}

describe('depth encoding', () => {
  it('round-trips view depth to a few millimetres and reads the clear colour as far', () => {
    const far = 20_000;
    for (const d of [0.5, 37.25, 412.8, 9_999]) {
      const [r, g, b] = encodeDepth(d, far);
      const out = decodeDepth(new Uint8Array([r, g, b, 255]), far, new Float32Array(1));
      expect(Math.abs((out[0] ?? 0) - d)).toBeLessThan(0.002);
    }
    const clear = decodeDepth(new Uint8Array([255, 255, 255, 255]), far, new Float32Array(1));
    expect(clear[0]).toBe(Infinity);
  });
});

describe('pointClear', () => {
  const snap = wallSnapshot();

  it('keeps pins on the facing surface and drops pins behind it', () => {
    expect(pointClear(snap, [-5, 0, 0])).toBe(true);
    // a metre behind the surface still counts as on it (anchors sit near the mesh)
    expect(pointClear(snap, [-5, 0, -0.8])).toBe(true);
    // the far face of a 20 m deep building
    expect(pointClear(snap, [-5, 0, -20])).toBe(false);
    // in front of the wall
    expect(pointClear(snap, [-5, 0, 10])).toBe(true);
  });

  it('sees pins through the hole and treats points outside the snapshot as clear', () => {
    expect(pointClear(snap, [5, 0, -20])).toBe(true);
    expect(pointClear(snap, [500, 0, -20])).toBe(true);
    expect(pointClear(snap, [0, 0, 60])).toBe(true);
  });

  it('allows more slack further away', () => {
    expect(occlusionSlack(10)).toBe(1);
    expect(occlusionSlack(300)).toBeCloseTo(9);
  });
});

describe('isOccluder', () => {
  const box = new BoxGeometry();
  it('takes opaque meshes and leaves out see-through, helper and non-mesh objects', () => {
    expect(isOccluder(new Mesh(box, new MeshBasicMaterial()))).toBe(true);
    expect(
      isOccluder(new Mesh(box, new MeshBasicMaterial({ transparent: true, opacity: 0.4 }))),
    ).toBe(false);
    expect(isOccluder(new Mesh(box, new MeshBasicMaterial({ depthWrite: false })))).toBe(false);
    const helper = new Mesh(box, new MeshBasicMaterial());
    helper.userData.helper = true;
    expect(isOccluder(helper)).toBe(false);
    const hooked = new Mesh(box, new MeshBasicMaterial());
    hooked.onBeforeRender = () => undefined;
    expect(isOccluder(hooked)).toBe(false);
    expect(isOccluder(new Points())).toBe(false);
    expect(isOccluder(new Line())).toBe(false);
  });
});

describe('createOcclusion', () => {
  function fakeRenderer(onRender: (scene: Scene) => void) {
    const el = { clientWidth: 400, clientHeight: 300 };
    let target: unknown = null;
    const calls: string[] = [];
    const renderer = {
      domElement: el,
      autoClear: false,
      shadowMap: { needsUpdate: true },
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => {
        target = t;
      },
      getClearColor: (c: { setRGB(r: number, g: number, b: number): void }) => c,
      getClearAlpha: () => 0,
      setClearColor: () => undefined,
      clear: () => undefined,
      render: (scene: Scene) => {
        calls.push('render');
        onRender(scene);
      },
      // the far plane everywhere: nothing hides anything
      readRenderTargetPixels: (
        _t: unknown,
        _x: number,
        _y: number,
        w: number,
        h: number,
        buf: Uint8Array,
      ) => {
        buf.fill(255, 0, w * h * 4);
      },
    };
    return { renderer: renderer as unknown as WebGLRenderer, calls };
  }

  function handle(renderer: WebGLRenderer, scene: Scene): SceneHandle {
    return {
      scene,
      camera: camera(),
      renderer,
      projectId: 'p',
      requestRender: () => undefined,
      onFrame: () => () => undefined,
      holdContinuous: () => () => undefined,
      projectionReceivers: () => [],
      raycast: () => null,
      raycastRay: () => null,
      addRaycastProvider: () => () => undefined,
      clippingPlanes: [],
      addRaycastTarget: () => () => undefined,
      addProjectionReceiver: () => () => undefined,
    };
  }

  it('renders only the opaque meshes, then restores the scene and the renderer', () => {
    const scene = new Scene();
    const wall = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const glass = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ transparent: true, opacity: 0.2 }),
    );
    const cloud = new Points();
    const pins = new Group();
    scene.add(wall, glass, cloud, pins);
    const seen: Record<string, boolean>[] = [];
    const { renderer, calls } = fakeRenderer((s) => {
      seen.push({
        wall: wall.visible,
        glass: glass.visible,
        cloud: cloud.visible,
        pins: pins.visible,
        override: s.overrideMaterial !== null,
      });
    });
    let updates = 0;
    const occ = createOcclusion(handle(renderer, scene), pins, () => {
      updates++;
    });
    occ.frame(1000);
    expect(calls).toEqual(['render']);
    expect(seen).toEqual([{ wall: true, glass: false, cloud: false, pins: false, override: true }]);
    expect([wall.visible, glass.visible, cloud.visible, pins.visible]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(scene.overrideMaterial).toBeNull();
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.shadowMap.needsUpdate).toBe(true);
    expect(updates).toBe(1);
    expect(occ.clear([0, 0, -500])).toBe(true);
    // the same view right away: no second render
    occ.frame(1010);
    expect(calls).toHaveLength(1);
    occ.dispose();
  });

  it('does nothing on a renderer that cannot render (tests, lost context)', () => {
    const scene = new Scene();
    const h = handle({ domElement: {} } as unknown as WebGLRenderer, scene);
    const occ = createOcclusion(h, new Group(), () => undefined);
    occ.frame(0);
    expect(occ.clear([0, 0, 0])).toBe(true);
    occ.dispose();
  });
});

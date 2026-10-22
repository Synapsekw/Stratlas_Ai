import {
  BackSide,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  type Camera,
  type Material,
  type Object3D,
  type PMREMGenerator,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

/** Makes the programs an object is drawn with ahead of its frame (`ProgramWarmup.compile`). */
export type CompileAhead = (object: Object3D, camera: Camera, scene: Scene) => Promise<void> | null;

/** The parts of three's `PMREMGenerator` (r186) that say which programs `fromScene` draws with. */
interface PmremInternals {
  _setSize(cubeSize: number): void;
  _allocateTargets(): WebGLRenderTarget;
  _ggxMaterial: Material | null;
  _lodMeshes: Mesh[] | null;
}

export interface PmremWarm {
  /** Resolves once `fromScene` will not wait for the driver; null when nothing has to wait. */
  ready: Promise<void> | null;
  /** Let go of what was made for the warm-up; call it after the `fromScene` it was for. */
  readonly release: () => void;
}

const NONE: PmremWarm = {
  ready: null,
  release: () => undefined,
};

/**
 * Make the shader programs `pmrem.fromScene(source, sigma 0, near, far, { size })` draws with
 * before it runs: the solid background box, `source`'s own materials (into a linear target,
 * without tone mapping) and the GGX convolution of a light map that size. The convolution is the
 * longest program of the stage to make (about 0.8 s on Direct3D at the first open of a project),
 * and `fromScene` makes it and uses it at once, freezing the window while the driver compiles.
 *
 * The generator's own convolution material for `size` is made here (three keeps it while the size
 * stays the same), so `fromScene` finds its program ready. Programs are shared by what they draw,
 * so the background box made here stands in for the generator's own; it is kept until `release`,
 * or its program would go with it. Answers `NONE` when this three.js build does not have what is
 * used here: `fromScene` then makes the programs itself, as before.
 */
export function warmPmrem(
  renderer: WebGLRenderer,
  pmrem: PMREMGenerator,
  size: number,
  source: Scene,
  compile: CompileAhead,
): PmremWarm {
  const p = pmrem as unknown as Partial<PmremInternals>;
  if (typeof p._setSize !== 'function' || typeof p._allocateTargets !== 'function') return NONE;
  const box = new Mesh(
    new BoxGeometry(),
    new MeshBasicMaterial({
      name: 'PMREM.Background',
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    }),
  );
  const release = () => {
    box.geometry.dispose();
    box.material.dispose();
  };
  const waits: Promise<void>[] = [];
  const add = (w: Promise<void> | null) => {
    if (w) waits.push(w);
  };
  let target: WebGLRenderTarget | null = null;
  let before: WebGLRenderTarget | null | undefined;
  try {
    before = renderer.getRenderTarget();
    p._setSize(size);
    target = p._allocateTargets();
    // the programs are made for drawing into the light map: linear colour, no tone mapping
    renderer.setRenderTarget(target);
    const cube = new PerspectiveCamera(90, 1, 0.1, 100);
    const empty = new Scene();
    add(compile(box, cube, empty));
    add(compile(source, cube, source));
    const ggx = p._ggxMaterial;
    const plane = p._lodMeshes?.[1];
    if (ggx && plane) add(compile(new Mesh(plane.geometry, ggx), new OrthographicCamera(), empty));
  } catch {
    // fromScene makes what is missing, in its frame
  } finally {
    if (before !== undefined) renderer.setRenderTarget(before);
    target?.dispose();
  }
  return {
    ready: waits.length > 0 ? Promise.all(waits).then(() => undefined) : null,
    release,
  };
}

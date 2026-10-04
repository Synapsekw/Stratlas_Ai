import type { SceneHandle } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import {
  Color,
  DoubleSide,
  Matrix4,
  NearestFilter,
  Object3D,
  RGBAFormat,
  ShaderLib,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type Mesh,
  type WebGLRenderer,
} from 'three';

/**
 * Pin occlusion: which issue pins the scene's surfaces hide from the camera. A small view-depth
 * snapshot of the opaque meshes (one extra low-resolution render, read back asynchronously) is
 * taken while the view changes, at most every `MOVE_MS`, and pins are tested against it on the
 * CPU (a few array reads each), so thousands of pins cost nothing per frame and the cost does not
 * grow with the mesh's triangle count.
 */

/** 24-bit fixed point view depth, as a fraction of the camera's far plane. */
const DEPTH_MAX = 16_777_215;
/** Longest side of the depth snapshot, pixels. */
const SNAP_MAX = 480;
/** Snapshot interval while the camera moves, and after other changes (layers, sections). */
const MOVE_MS = 80;
const IDLE_MS = 250;
/** A pin within this far behind the surface still counts as on it (anchors sit near, not on). */
const MIN_SLACK = 1;
const REL_SLACK = 0.03;
/** Of the 3 x 3 snapshot pixels around a pin, how many must not hide it. */
const MIN_CLEAR = 3;

/** Allowed depth behind the nearest surface for a pin `dist` metres from the camera. */
export const occlusionSlack = (dist: number): number => Math.max(MIN_SLACK, dist * REL_SLACK);

/** View depth to the snapshot's RGB bytes (the shader's encoding; for tests). */
export function encodeDepth(dist: number, far: number): [number, number, number] {
  const v = Math.round(Math.min(1, Math.max(0, dist / far)) * DEPTH_MAX);
  return [Math.floor(v / 65536), Math.floor(v / 256) % 256, v % 256];
}

/** RGBA bytes to view depth in metres; the clear colour (white) reads as Infinity. */
export function decodeDepth(rgba: Uint8Array, far: number, out: Float32Array): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const v =
      (rgba[i * 4] ?? 255) * 65536 + (rgba[i * 4 + 1] ?? 255) * 256 + (rgba[i * 4 + 2] ?? 255);
    out[i] = v >= DEPTH_MAX ? Infinity : (v / DEPTH_MAX) * far;
  }
  return out;
}

/** View depth per pixel (metres, GL row order: row 0 at the bottom) and the camera it saw. */
export interface DepthSnapshot {
  width: number;
  height: number;
  depth: Float32Array;
  /** The camera's `matrixWorldInverse` and `projectionMatrix` at capture. */
  view: Matrix4;
  proj: Matrix4;
}

const tmp = new Vector3();

/**
 * Whether a world point is clear of the surfaces in `snap`: in front of, or within
 * `occlusionSlack` behind, the depth of at least `MIN_CLEAR` of the 3 x 3 pixels around it.
 * Points outside the snapshot (behind its camera, off its edges) count as clear.
 */
export function pointClear(snap: DepthSnapshot, p: Vec3): boolean {
  tmp.set(p[0], p[1], p[2]).applyMatrix4(snap.view);
  const dist = -tmp.z;
  if (dist <= 0) return true;
  tmp.applyMatrix4(snap.proj);
  if (Math.abs(tmp.x) > 1 || Math.abs(tmp.y) > 1) return true;
  const { width: w, height: h, depth } = snap;
  const px = Math.min(w - 1, Math.floor((tmp.x * 0.5 + 0.5) * w));
  const py = Math.min(h - 1, Math.floor((tmp.y * 0.5 + 0.5) * h));
  const reach = dist - occlusionSlack(dist);
  let clear = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const y = Math.min(h - 1, Math.max(0, py + dy));
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(w - 1, Math.max(0, px + dx));
      if ((depth[y * w + x] ?? Infinity) >= reach) clear++;
    }
  }
  return clear >= MIN_CLEAR;
}

/**
 * Whether a renderable object hides what is behind it in the snapshot: opaque meshes that write
 * depth. Points, lines, sprites, helpers, see-through and self-rendering objects (EDL composite,
 * fat lines) do not.
 */
export function isOccluder(o: Object3D): boolean {
  const m = o as Partial<Mesh> & Object3D;
  if (!m.isMesh) return false;
  if (o.userData.helper === true) return false;
  if (o.onBeforeRender !== Object3D.prototype.onBeforeRender) return false;
  const g = m.geometry as { isInstancedBufferGeometry?: boolean } | undefined;
  if (g?.isInstancedBufferGeometry && !(m as { isInstancedMesh?: boolean }).isInstancedMesh)
    return false;
  const mats: Material[] = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
  return mats.some(
    (mat) =>
      mat.visible &&
      mat.colorWrite &&
      mat.depthWrite &&
      !(mat.transparent && mat.opacity < 0.99) &&
      !(mat as { isLineMaterial?: boolean }).isLineMaterial,
  );
}

/** Renderable objects that are not occluders (hidden while the snapshot renders). */
function isRenderable(o: Object3D): boolean {
  const r = o as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return r.isMesh === true || r.isPoints === true || r.isLine === true || r.isSprite === true;
}

export interface OcclusionSource {
  /** Every rendered frame, before the pins are laid out: may start a new snapshot. */
  frame(now: number): void;
  /** Whether a world point is unoccluded in the latest snapshot (true until there is one). */
  clear(p: Vec3): boolean;
  dispose(): void;
}

export type OcclusionFactory = (
  handle: SceneHandle,
  /** Left out of the snapshot (the pins themselves). */
  skip: Object3D,
  /** A new snapshot arrived: lay the pins out again. */
  onUpdate: () => void,
) => OcclusionSource;

const NONE: OcclusionSource = {
  frame: () => undefined,
  clear: () => true,
  dispose: () => undefined,
};

const DEPTH_FRAG = /* glsl */ `
uniform float uFar;
varying vec2 vHighPrecisionZW;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  // clip w is the view depth for a perspective camera
  float v = floor(clamp(vHighPrecisionZW.y / uFar, 0.0, 1.0) * 16777215.0 + 0.5);
  float r = floor(v / 65536.0);
  v -= r * 65536.0;
  float g = floor(v / 256.0);
  float b = v - g * 256.0;
  gl_FragColor = vec4(r, g, b, 255.0) / 255.0;
}`;

/**
 * The GPU occlusion source: a view-depth snapshot of the opaque meshes (section planes apply, so
 * pins in a cut-away part show), read back without stalling where the renderer can.
 */
export const createOcclusion: OcclusionFactory = (handle, skip, onUpdate) => {
  const r = handle.renderer as Partial<WebGLRenderer>;
  if (typeof r.render !== 'function' || typeof r.readRenderTargetPixels !== 'function') return NONE;
  const renderer = handle.renderer;
  const scene = handle.scene;
  const mat = new ShaderMaterial({
    vertexShader: ShaderLib.depth.vertexShader,
    fragmentShader: DEPTH_FRAG,
    uniforms: { uFar: { value: 1000 } },
    side: DoubleSide,
    clipping: true,
  });
  mat.clippingPlanes = handle.clippingPlanes;
  let target: WebGLRenderTarget | null = null;
  let bytes = new Uint8Array(0);
  let snap: DepthSnapshot | null = null;
  const capView = new Matrix4();
  const capProj = new Matrix4();
  let captured = false;
  let inFlight = false;
  let lastStart = -Infinity;
  let stale = true;
  let selfFrame = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let asyncOk = typeof r.readRenderTargetPixelsAsync === 'function';
  const white = new Color(1, 1, 1);
  const prevClear = new Color();
  const hide: Object3D[] = [];

  const deliver = (w: number, h: number, far: number, view: Matrix4, proj: Matrix4) => {
    snap = {
      width: w,
      height: h,
      depth: decodeDepth(bytes, far, new Float32Array(w * h)),
      view,
      proj,
    };
    selfFrame = true;
    onUpdate();
  };

  const capture = (now: number) => {
    const cam = handle.camera;
    const el = renderer.domElement;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw < 2 || ch < 2) return;
    const s = Math.min(0.5, SNAP_MAX / Math.max(cw, ch));
    const w = Math.max(8, Math.round(cw * s));
    const h = Math.max(8, Math.round(ch * s));
    if (target?.width !== w || target.height !== h) {
      target?.dispose();
      target = new WebGLRenderTarget(w, h, {
        type: UnsignedByteType,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: true,
        generateMipmaps: false,
      });
      bytes = new Uint8Array(w * h * 4);
    }
    lastStart = now;
    stale = false;
    captured = true;
    capView.copy(cam.matrixWorldInverse);
    capProj.copy(cam.projectionMatrix);
    (mat.uniforms.uFar as { value: number }).value = cam.far;

    hide.length = 0;
    scene.traverseVisible((o) => {
      if (o === skip || (isRenderable(o) && !isOccluder(o))) hide.push(o);
    });
    for (const o of hide) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    const prevShadow = renderer.shadowMap.needsUpdate;
    try {
      scene.overrideMaterial = mat;
      scene.background = null;
      renderer.shadowMap.needsUpdate = false;
      renderer.setRenderTarget(target);
      renderer.setClearColor(white, 1);
      renderer.autoClear = true;
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.needsUpdate = prevShadow;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      for (const o of hide) o.visible = true;
      hide.length = 0;
    }

    const view = capView.clone();
    const proj = capProj.clone();
    const far = cam.far;
    const rt = target;
    if (asyncOk) {
      inFlight = true;
      renderer
        .readRenderTargetPixelsAsync(rt, 0, 0, w, h, bytes)
        .then(() => {
          inFlight = false;
          if (!disposed && rt === target) deliver(w, h, far, view, proj);
        })
        .catch(() => {
          inFlight = false;
          asyncOk = false;
          stale = true;
          if (!disposed) handle.requestRender();
        });
    } else {
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, bytes);
      deliver(w, h, far, view, proj);
    }
  };

  return {
    frame(now) {
      if (disposed) return;
      const cam = handle.camera;
      if (!selfFrame) stale = true;
      selfFrame = false;
      const moved =
        !captured ||
        !capView.equals(cam.matrixWorldInverse) ||
        !capProj.equals(cam.projectionMatrix);
      if ((!moved && !stale) || inFlight) return;
      const wait = (moved ? MOVE_MS : IDLE_MS) - (now - lastStart);
      if (wait > 0) {
        timer ??= setTimeout(() => {
          timer = null;
          selfFrame = true;
          handle.requestRender();
        }, wait);
        return;
      }
      capture(now);
    },
    clear(p) {
      return snap ? pointClear(snap, p) : true;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      target?.dispose();
      mat.dispose();
    },
  };
};

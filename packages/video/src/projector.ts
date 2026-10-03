import type { LensModel } from '@aio/schema';
import type { Quaternion } from 'three';
import {
  Color,
  DoubleSide,
  FloatType,
  Matrix3,
  Matrix4,
  NearestFilter,
  PerspectiveCamera,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type IUniform,
  type Material,
  type Mesh,
  type Scene,
  type Texture,
  type WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { imageToRay } from './lens';

/**
 * Projective texturing of a drone video frame onto receiver meshes (mesh layers and the ground),
 * ported from the HCl artifact (`ly()`, f-theta) and the Al-Zour artifact (pinhole drape).
 *
 * The projection term is injected into the receivers' own materials with `onBeforeCompile`, so
 * lighting, clipping and every other feature of those materials keep working; patching is undone by
 * `detachAll()`. Occlusion uses a distance map rendered from the projector (shadow-map style), so
 * surfaces hidden from the drone are not painted.
 */

export interface ProjectorOptions {
  /** Blend weight of the video over the surface, 0..1. */
  opacity: number;
  /** Width of the soft edge, as a fraction of the frame (0 = hard edge). */
  vignette: number;
  /** Surfaces farther than this from the camera are not painted (metres). */
  maxDistance: number;
  /** Depth test against a distance map from the projector. */
  occlusion: boolean;
  /** Distance map resolution (longest side, pixels). */
  depthSize: number;
}

export const DEFAULT_PROJECTOR: ProjectorOptions = {
  opacity: 0.95,
  vignette: 0.04,
  maxDistance: 5000,
  occlusion: true,
  depthSize: 2048,
};

/** Camera layer used to render only the receivers into the distance map. */
export const PROJECTOR_DEPTH_LAYER = 30;

const CACHE_KEY = '|aio-projector-1';

const VERTEX_PARS = /* glsl */ `
varying vec3 vAioProjW;
`;

const VERTEX_MAIN = /* glsl */ `
{
  vec4 aioP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    aioP = batchingMatrix * aioP;
  #endif
  #ifdef USE_INSTANCING
    aioP = instanceMatrix * aioP;
  #endif
  vAioProjW = (modelMatrix * aioP).xyz;
}
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vAioProjW;
uniform float aioProjOn;
uniform sampler2D aioProjTex;
uniform vec3 aioProjPos;
uniform mat3 aioProjRot;
uniform float aioProjModel;
uniform float aioProjTanH;
uniform float aioProjRNorm;
uniform vec4 aioProjK;
uniform float aioProjAspect;
uniform float aioProjOpacity;
uniform float aioProjVignette;
uniform float aioProjMaxDist;
uniform float aioDepthOn;
uniform sampler2D aioDepthTex;
uniform mat4 aioDepthVP;
uniform vec2 aioDepthTexel;

float aioProjWeight(out vec2 uv) {
  vec3 rel = vAioProjW - aioProjPos;
  vec3 d = aioProjRot * rel;
  float L = length(d);
  uv = vec2(-1.0);
  if (L > aioProjMaxDist || L < 1e-4) return 0.0;
  if (aioProjModel < 0.5) {
    if (d.z > -1e-4) return 0.0;
    vec2 n = d.xy / (-d.z * aioProjTanH);
    n.y *= aioProjAspect;
    uv = n * 0.5 + 0.5;
  } else {
    float th = acos(clamp(-d.z / L, -1.0, 1.0));
    float psi = atan(d.y, d.x);
    float t2 = th * th;
    float r = th * (1.0 + t2 * (aioProjK.x + t2 * (aioProjK.y + t2 * (aioProjK.z + t2 * aioProjK.w))));
    float rho = r / aioProjRNorm;
    uv = vec2(0.5 + 0.5 * rho * cos(psi), 0.5 + 0.5 * rho * sin(psi) * aioProjAspect);
  }
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.0;
  vec2 e = min(uv, 1.0 - uv);
  float edge = aioProjVignette > 0.0 ? smoothstep(0.0, aioProjVignette, min(e.x, e.y)) : 1.0;
  vec3 fn = normalize(cross(dFdx(vAioProjW), dFdy(vAioProjW)));
  float facing = abs(dot(fn, -rel / L));
  float w = aioProjOpacity * edge * smoothstep(0.03, 0.18, facing);
  if (aioDepthOn > 0.5) {
    vec4 c = aioDepthVP * vec4(vAioProjW, 1.0);
    if (c.w > 0.0) {
      vec2 duv = c.xy / c.w * 0.5 + 0.5;
      if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) {
        // slope-scaled bias: one texel at this distance, larger at grazing angles
        float texelM = L * aioDepthTexel.x;
        float bias = 0.01 + 0.002 * L + 2.5 * texelM / max(facing, 0.1);
        float lit = 0.0;
        lit += step(L, texture2D(aioDepthTex, duv).r + bias);
        lit += step(L, texture2D(aioDepthTex, duv + vec2(aioDepthTexel.y, 0.0)).r + bias);
        lit += step(L, texture2D(aioDepthTex, duv - vec2(aioDepthTexel.y, 0.0)).r + bias);
        lit += step(L, texture2D(aioDepthTex, duv + vec2(0.0, aioDepthTexel.y)).r + bias);
        lit += step(L, texture2D(aioDepthTex, duv - vec2(0.0, aioDepthTexel.y)).r + bias);
        w *= lit / 5.0;
      }
    }
  }
  return w;
}
`;

const FRAGMENT_MAIN = /* glsl */ `
if (aioProjOn > 0.5) {
  vec2 aioUv;
  float aioW = aioProjWeight(aioUv);
  if (aioW > 0.0) {
    vec3 aioC = texture2D(aioProjTex, aioUv).rgb;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, aioC, aioW);
    gl_FragColor.a = max(gl_FragColor.a, aioW);
  }
}
`;

interface ProjectorUniforms {
  aioProjOn: IUniform<number>;
  aioProjTex: IUniform<Texture | null>;
  aioProjPos: IUniform<Vector3>;
  aioProjRot: IUniform<Matrix3>;
  aioProjModel: IUniform<number>;
  aioProjTanH: IUniform<number>;
  aioProjRNorm: IUniform<number>;
  aioProjK: IUniform<Vector4>;
  aioProjAspect: IUniform<number>;
  aioProjOpacity: IUniform<number>;
  aioProjVignette: IUniform<number>;
  aioProjMaxDist: IUniform<number>;
  aioDepthOn: IUniform<number>;
  aioDepthTex: IUniform<Texture | null>;
  aioDepthVP: IUniform<Matrix4>;
  aioDepthTexel: IUniform<Vector2>;
}

/** Own-property descriptors before patching (undefined: the prototype method was in use). */
interface Saved {
  compile: PropertyDescriptor | undefined;
  key: PropertyDescriptor | undefined;
}

const PATCHED_PROPS = ['onBeforeCompile', 'customProgramCacheKey'] as const;

/** Injects the projector into a shader; exported for tests. Returns false when it cannot. */
export function injectProjector(shader: { vertexShader: string; fragmentShader: string }): boolean {
  const vs = shader.vertexShader;
  const fs = shader.fragmentShader;
  if (!vs.includes('#include <project_vertex>') || !vs.includes('#include <common>')) return false;
  const fsAnchor = fs.includes('#include <colorspace_fragment>')
    ? '#include <colorspace_fragment>'
    : fs.includes('#include <dithering_fragment>')
      ? '#include <dithering_fragment>'
      : null;
  if (!fsAnchor || !fs.includes('#include <common>')) return false;
  shader.vertexShader = vs
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);
  const main = FRAGMENT_MAIN;
  shader.fragmentShader = fs
    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
    .replace(
      fsAnchor,
      // before colour space conversion: the video texel is linear like the lit colour
      fsAnchor === '#include <colorspace_fragment>'
        ? `${main}\n${fsAnchor}`
        : `${fsAnchor}\n${main}`,
    );
  return true;
}

const DISTANCE_VS = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 w = modelMatrix * p;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const DISTANCE_FS = /* glsl */ `
uniform vec3 uPos;
varying vec3 vW;
void main() { gl_FragColor = vec4(length(vW - uPos), 0.0, 0.0, 1.0); }
`;

const FAR = 1e9;

export class Projector {
  readonly uniforms: ProjectorUniforms;
  readonly options: ProjectorOptions;
  private readonly patched = new Map<Material, Saved>();
  private readonly layered = new Set<Mesh>();
  private readonly depthCam = new PerspectiveCamera();
  private depthTarget: WebGLRenderTarget | null = null;
  private readonly distanceMat: ShaderMaterial;
  private lens: LensModel | null = null;
  private depthValid = false;
  private depthOk = true;
  private readonly distanceUniforms = { uPos: { value: new Vector3() } };

  constructor(options: Partial<ProjectorOptions> = {}) {
    this.options = { ...DEFAULT_PROJECTOR, ...options };
    this.uniforms = {
      aioProjOn: { value: 0 },
      aioProjTex: { value: null },
      aioProjPos: { value: new Vector3() },
      aioProjRot: { value: new Matrix3() },
      aioProjModel: { value: 0 },
      aioProjTanH: { value: 1 },
      aioProjRNorm: { value: 1 },
      aioProjK: { value: new Vector4() },
      aioProjAspect: { value: 16 / 9 },
      aioProjOpacity: { value: this.options.opacity },
      aioProjVignette: { value: this.options.vignette },
      aioProjMaxDist: { value: this.options.maxDistance },
      aioDepthOn: { value: 0 },
      aioDepthTex: { value: null },
      aioDepthVP: { value: new Matrix4() },
      aioDepthTexel: { value: new Vector2() },
    };
    this.distanceMat = new ShaderMaterial({
      uniforms: this.distanceUniforms,
      vertexShader: DISTANCE_VS,
      fragmentShader: DISTANCE_FS,
      side: DoubleSide,
    });
    this.depthCam.layers.set(PROJECTOR_DEPTH_LAYER);
  }

  setOptions(o: Partial<ProjectorOptions>) {
    Object.assign(this.options, o);
    this.uniforms.aioProjOpacity.value = this.options.opacity;
    this.uniforms.aioProjVignette.value = this.options.vignette;
    this.uniforms.aioProjMaxDist.value = this.options.maxDistance;
    if (this.lens) this.setLens(this.lens);
  }

  setTexture(tex: Texture | null) {
    this.uniforms.aioProjTex.value = tex;
  }

  setEnabled(on: boolean) {
    this.uniforms.aioProjOn.value = on && this.uniforms.aioProjTex.value ? 1 : 0;
  }

  get enabled(): boolean {
    return this.uniforms.aioProjOn.value > 0.5;
  }

  setLens(lens: LensModel) {
    this.lens = lens;
    const u = this.uniforms;
    const half = (lens.hfovDeg * Math.PI) / 360;
    u.aioProjAspect.value = lens.aspect;
    if (lens.model === 'pinhole') {
      u.aioProjModel.value = 0;
      u.aioProjTanH.value = Math.tan(half);
    } else {
      const k = lens.k ?? [];
      u.aioProjModel.value = 1;
      u.aioProjK.value.set(k[0] ?? 0, k[1] ?? 0, k[2] ?? 0, k[3] ?? 0);
      const t2 = half * half;
      u.aioProjRNorm.value =
        half *
        (1 + t2 * ((k[0] ?? 0) + t2 * ((k[1] ?? 0) + t2 * ((k[2] ?? 0) + t2 * (k[3] ?? 0)))));
    }
    // Distance-map camera: a pinhole frustum that contains every ray of the frame.
    let tx = 0;
    let ty = 0;
    let ok = true;
    for (let i = 0; i <= 16; i++) {
      for (const [x, y] of [
        [i / 16, 0],
        [i / 16, 1],
        [0, i / 16],
        [1, i / 16],
      ] as const) {
        const d = imageToRay(lens, x, y);
        if (d[2] > -0.08) ok = false;
        else {
          tx = Math.max(tx, Math.abs(d[0] / -d[2]));
          ty = Math.max(ty, Math.abs(d[1] / -d[2]));
        }
      }
    }
    this.depthOk = ok;
    tx *= 1.04;
    ty *= 1.04;
    const cam = this.depthCam;
    cam.fov = (2 * Math.atan(ty) * 180) / Math.PI;
    cam.aspect = tx / ty;
    cam.near = Math.max(0.02, this.options.maxDistance * 2e-5);
    cam.far = this.options.maxDistance;
    cam.updateProjectionMatrix();
    const size = this.options.depthSize;
    const w = cam.aspect >= 1 ? size : Math.round(size * cam.aspect);
    const h = cam.aspect >= 1 ? Math.round(size / cam.aspect) : size;
    if (this.depthTarget?.width !== w || this.depthTarget.height !== h) {
      this.depthTarget?.dispose();
      this.depthTarget = new WebGLRenderTarget(w, h, {
        type: FloatType,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: true,
        generateMipmaps: false,
      });
    }
    // radians per texel horizontally, and texel size in uv
    u.aioDepthTexel.value.set((2 * tx) / w, 1 / Math.max(w, h));
    u.aioDepthTex.value = this.depthTarget.texture;
    this.depthValid = false;
  }

  /** Projector pose: camera position and three.js camera quaternion (looks down -Z). */
  setPose(pos: Vector3, q: Quaternion) {
    this.uniforms.aioProjPos.value.copy(pos);
    const inv = new Matrix4().makeRotationFromQuaternion(q).invert();
    this.uniforms.aioProjRot.value.setFromMatrix4(inv);
    this.depthCam.position.copy(pos);
    this.depthCam.quaternion.copy(q);
    this.depthCam.updateMatrixWorld(true);
    this.depthValid = false;
  }

  /** Patches the materials of these meshes (idempotent; new materials are picked up). */
  attach(meshes: readonly Mesh[]) {
    for (const mesh of meshes) {
      if (!this.layered.has(mesh)) {
        if (!mesh.layers.isEnabled(PROJECTOR_DEPTH_LAYER)) {
          mesh.layers.enable(PROJECTOR_DEPTH_LAYER);
          this.layered.add(mesh);
          this.depthValid = false;
        }
      }
      const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) this.patch(m);
    }
  }

  private patch(mat: Material) {
    if (this.patched.has(mat) || (mat as ShaderMaterial).isShaderMaterial) return;
    this.patched.set(mat, {
      compile: Object.getOwnPropertyDescriptor(mat, 'onBeforeCompile'),
      key: Object.getOwnPropertyDescriptor(mat, 'customProgramCacheKey'),
    });
    const origCompile = mat.onBeforeCompile.bind(mat);
    const origKey = mat.customProgramCacheKey.bind(mat);
    const uniforms = this.uniforms as unknown as Record<string, IUniform>;
    mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
      origCompile(shader, renderer);
      if (injectProjector(shader)) Object.assign(shader.uniforms, uniforms);
    };
    mat.customProgramCacheKey = () => origKey() + CACHE_KEY;
    mat.needsUpdate = true;
  }

  /** Restores every patched material and receiver layer. */
  detachAll() {
    for (const [mat, saved] of this.patched) {
      PATCHED_PROPS.forEach((prop, i) => {
        const desc = i === 0 ? saved.compile : saved.key;
        if (desc) Object.defineProperty(mat, prop, desc);
        else Reflect.deleteProperty(mat, prop);
      });
      mat.needsUpdate = true;
    }
    this.patched.clear();
    for (const mesh of this.layered) mesh.layers.disable(PROJECTOR_DEPTH_LAYER);
    this.layered.clear();
  }

  get patchedCount(): number {
    return this.patched.size;
  }

  /** Renders the distance map when the pose or receivers changed. Call before the main render. */
  updateDepth(renderer: WebGLRenderer, scene: Scene) {
    const u = this.uniforms;
    const use = this.options.occlusion && this.depthOk && this.enabled && !!this.depthTarget;
    u.aioDepthOn.value = use ? 1 : 0;
    if (!use || this.depthValid || !this.depthTarget) return;
    this.distanceUniforms.uPos.value = this.uniforms.aioProjPos.value;
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    const prevShadow = renderer.shadowMap.autoUpdate;
    scene.overrideMaterial = this.distanceMat;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.depthTarget);
    renderer.setClearColor(new Color(FAR, FAR, FAR), 1);
    renderer.autoClear = true;
    renderer.clear(true, true, false);
    renderer.render(scene, this.depthCam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadow;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    this.depthCam.updateMatrixWorld(true);
    u.aioDepthVP.value.multiplyMatrices(
      this.depthCam.projectionMatrix,
      this.depthCam.matrixWorldInverse,
    );
    this.depthValid = true;
  }

  /** Forces a new distance map on the next update (geometry moved). */
  invalidateDepth() {
    this.depthValid = false;
  }

  dispose() {
    this.detachAll();
    this.depthTarget?.dispose();
    this.distanceMat.dispose();
  }
}

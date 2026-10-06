import { Color, ShaderMaterial, Vector2 } from 'three';
import { CHANGE_RAMP_GLSL } from './changeRamp';
import { classColour } from './classes';
import { ELEVATION_RAMP_GLSL } from './ramp';
import type { ColourMode } from './settings';

/** The HCl artifact flight palette (`Vd`). */
export const FLIGHT_PALETTE = [
  '#5ab0ff',
  '#ff7a2d',
  '#8fd14f',
  '#e94b9a',
  '#fad34b',
  '#b68ef8',
  '#34d3c0',
  '#ff5a5a',
  '#c9d0dc',
  '#f2a65a',
] as const;

export const MODE_INDEX: Record<ColourMode, number> = {
  rgb: 0,
  intensity: 1,
  height: 2,
  flight: 3,
  classification: 4,
  change: 5,
};

/** The full-colour distance of a change cloud until its layer says otherwise (founder far, 30 cm). */
export const DEFAULT_CHANGE_RANGE = 0.3;

/** Class codes 0..31 have their own colour and show flag; higher codes share slot 31. */
export const CLASS_SLOTS = 32;

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef HAS_RGB
attribute vec3 aRgb;
#endif
#ifdef HAS_INTENSITY
attribute float aIntensity;
#endif
#ifdef HAS_CLASS
attribute float aClass;
#endif
#ifdef HAS_SCALAR
attribute float aScalar;
#endif
uniform float uSize;
uniform float uPxPerM;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uScale;
uniform float uMode;
uniform vec2 uHeight;
uniform vec3 uTint;
uniform vec3 uClassColours[${CLASS_SLOTS}];
uniform float uClassShown[${CLASS_SLOTS}];
uniform float uScalarRange;
uniform float uThreshold;
uniform float uDiverging;
uniform float uHideNoScalar;
varying vec3 vC;

${ELEVATION_RAMP_GLSL}
${CHANGE_RAMP_GLSL}
void main() {
#ifdef HAS_CLASS
  int cls = int(min(aClass, ${CLASS_SLOTS - 1}.0) + 0.5);
#else
  int cls = 1; // unclassified
#endif
  if (uClassShown[cls] < 0.5) {
    // hidden class: outside the clip volume, so nothing is rasterised
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  bool changeMode = uMode > 4.5;
#ifdef HAS_SCALAR
  // change mode: points closer to the earlier date than the threshold are not drawn
  bool hideChange = changeMode && abs(aScalar) < uThreshold;
#else
  // change mode: a cloud without the change field steps aside for the change clouds
  bool hideChange = changeMode && uHideNoScalar > 0.5;
#endif
  if (hideChange) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  // the user's size scale multiplies the on-screen size after the clamp (see pointSizePx)
  gl_PointSize = max(1.0, clamp(uSize * uPxPerM / max(0.01, -mvPosition.z), uMinPx, uMaxPx) * uScale);

#ifdef HAS_RGB
  vec3 rgb = aRgb;
#endif
#ifdef HAS_INTENSITY
  float inten = aIntensity;
#else
  float inten = dot(rgb, vec3(0.299, 0.587, 0.114));
#endif
#ifndef HAS_RGB
  float hh = 0.15 + inten * 0.85;
  vec3 rgb = vec3(0.55 * hh + 0.1, 0.85 * hh + 0.1, hh + 0.12);
#endif

  if (uMode < 0.5) {
    vC = rgb;
  } else if (uMode < 1.5) {
#ifdef HAS_RGB
    vC = vec3(0.08 + 0.92 * inten);
#else
    // an intensity-only cloud's own look (the kit's tinted intensity) is its intensity view
    vC = rgb;
#endif
  } else if (uMode < 2.5) {
    vC = elevationRamp((world.y - uHeight.x) / max(1e-3, uHeight.y - uHeight.x));
  } else if (uMode < 3.5) {
    vC = uTint * (0.35 + inten * 0.65);
  } else if (uMode < 4.5) {
    // class colour, shaded a little by brightness so structure still reads
    vC = uClassColours[cls] * (0.75 + 0.25 * inten);
  } else {
#ifdef HAS_SCALAR
    vC = changeRamp(aScalar / max(uScalarRange, 1e-6), uDiverging);
#else
    // no change field: a dim grey, so the change clouds stand out
    vC = vec3(0.18 + 0.12 * inten);
#endif
  }

  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec3 vC;

void main() {
  #include <clipping_planes_fragment>
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vC, 1.0);
}
`;

export interface PointMaterialOptions {
  hasRgb: boolean;
  hasIntensity: boolean;
  /** ASPRS class per point (COPC). */
  hasClass?: boolean;
  /** One float per point to colour by in the change mode (COPC extra bytes, `Distance`). */
  hasScalar?: boolean;
  /** World size of a point in metres (the user's size scale applies on screen, uScale). */
  baseSize: number;
  tint: string;
}

export type PointMaterial = ShaderMaterial & {
  uniforms: {
    uSize: { value: number };
    uPxPerM: { value: number };
    uMinPx: { value: number };
    uMaxPx: { value: number };
    /** The user's point size scale, applied to the on-screen size. */
    uScale: { value: number };
    uMode: { value: number };
    uHeight: { value: Vector2 };
    uTint: { value: Color };
    uClassColours: { value: Color[] };
    uClassShown: { value: number[] };
    /** Change mode: the scalar that gets the full colour (half range when diverging). */
    uScalarRange: { value: number };
    /** Change mode: points whose |scalar| is below this are hidden. */
    uThreshold: { value: number };
    /** Change mode: 1 for a signed (blue, grey, red) ramp, 0 for grey to red. */
    uDiverging: { value: number };
    /** Change mode: 1 hides clouds without a scalar (a change cloud is shown). */
    uHideNoScalar: { value: number };
  };
  userData: { baseSize: number };
};

/** The change-mode inputs of one layer's material. */
export interface ChangeUniforms {
  range: number;
  threshold: number;
  diverging: boolean;
  hideNoScalar: boolean;
}

export function applyChangeUniforms(m: PointMaterial, c: ChangeUniforms): void {
  m.uniforms.uScalarRange.value = c.range;
  m.uniforms.uThreshold.value = c.threshold;
  m.uniforms.uDiverging.value = c.diverging ? 1 : 0;
  m.uniforms.uHideNoScalar.value = c.hideNoScalar ? 1 : 0;
}

/**
 * On-screen point diameter in pixels, as the vertex shader computes it: the point's world size
 * attenuated by its depth and clamped to [minPx, maxPx], then multiplied by the user's size scale
 * (at least one pixel). Scaling after the clamp keeps the size slider effective where the
 * attenuated size sits on the clamp: sub-pixel points far away (octree nodes are sized to their
 * spacing, about a pixel) and large points up close.
 */
export function pointSizePx(
  worldSize: number,
  pxPerM: number,
  depth: number,
  minPx: number,
  maxPx: number,
  scale: number,
): number {
  const px = Math.min(maxPx, Math.max(minPx, (worldSize * pxPerM) / Math.max(0.01, depth)));
  return Math.max(1, px * scale);
}

/** Linear-space class colours for the shader (the output pass converts to sRGB). */
function classColours(): Color[] {
  return Array.from({ length: CLASS_SLOTS }, (_, c) => new Color(classColour(c)));
}

/** Point material: attenuated size with a pixel clamp, six colour modes, clipping planes. */
export function createPointMaterial(o: PointMaterialOptions): PointMaterial {
  const defines: Record<string, string> = {};
  if (o.hasRgb) defines.HAS_RGB = '';
  if (o.hasIntensity) defines.HAS_INTENSITY = '';
  if (o.hasClass) defines.HAS_CLASS = '';
  if (o.hasScalar) defines.HAS_SCALAR = '';
  const m = new ShaderMaterial({
    defines,
    vertexShader,
    fragmentShader,
    clipping: true,
    uniforms: {
      uSize: { value: o.baseSize },
      uPxPerM: { value: 800 },
      uMinPx: { value: 1 },
      uMaxPx: { value: 24 },
      uScale: { value: 1 },
      uMode: { value: 0 },
      uHeight: { value: new Vector2(0, 10) },
      uTint: { value: new Color(o.tint) },
      uClassColours: { value: classColours() },
      uClassShown: { value: new Array<number>(CLASS_SLOTS).fill(1) },
      uScalarRange: { value: DEFAULT_CHANGE_RANGE },
      uThreshold: { value: 0 },
      uDiverging: { value: 0 },
      uHideNoScalar: { value: 0 },
    },
  }) as PointMaterial;
  m.userData.baseSize = o.baseSize;
  return m;
}

/** Sets the per-class show flags from the hidden class codes. */
export function applyHiddenClasses(m: PointMaterial, hidden: readonly number[]): void {
  const shown = m.uniforms.uClassShown.value;
  shown.fill(1);
  for (const c of hidden) shown[Math.min(c, CLASS_SLOTS - 1)] = 0;
}

import { Color, ShaderMaterial, Vector2 } from 'three';
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
};

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
uniform float uSize;
uniform float uPxPerM;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uMode;
uniform vec2 uHeight;
uniform vec3 uTint;
uniform vec3 uClassColours[${CLASS_SLOTS}];
uniform float uClassShown[${CLASS_SLOTS}];
varying vec3 vC;

${ELEVATION_RAMP_GLSL}
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
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(uSize * uPxPerM / max(0.01, -mvPosition.z), uMinPx, uMaxPx);

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
  } else {
    // class colour, shaded a little by brightness so structure still reads
    vC = uClassColours[cls] * (0.75 + 0.25 * inten);
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
  /** World size of a point in metres before the user's size scale. */
  baseSize: number;
  tint: string;
}

export type PointMaterial = ShaderMaterial & {
  uniforms: {
    uSize: { value: number };
    uPxPerM: { value: number };
    uMinPx: { value: number };
    uMaxPx: { value: number };
    uMode: { value: number };
    uHeight: { value: Vector2 };
    uTint: { value: Color };
    uClassColours: { value: Color[] };
    uClassShown: { value: number[] };
  };
  userData: { baseSize: number };
};

/** Linear-space class colours for the shader (the output pass converts to sRGB). */
function classColours(): Color[] {
  return Array.from({ length: CLASS_SLOTS }, (_, c) => new Color(classColour(c)));
}

/** Point material: attenuated size with a pixel clamp, five colour modes, clipping planes. */
export function createPointMaterial(o: PointMaterialOptions): PointMaterial {
  const defines: Record<string, string> = {};
  if (o.hasRgb) defines.HAS_RGB = '';
  if (o.hasIntensity) defines.HAS_INTENSITY = '';
  if (o.hasClass) defines.HAS_CLASS = '';
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
      uMode: { value: 0 },
      uHeight: { value: new Vector2(0, 10) },
      uTint: { value: new Color(o.tint) },
      uClassColours: { value: classColours() },
      uClassShown: { value: new Array<number>(CLASS_SLOTS).fill(1) },
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

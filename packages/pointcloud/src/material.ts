import { Color, ShaderMaterial, Vector2 } from 'three';
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
};

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
uniform float uSize;
uniform float uPxPerM;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uMode;
uniform vec2 uHeight;
uniform vec3 uTint;
varying vec3 vC;

${ELEVATION_RAMP_GLSL}
void main() {
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
  } else {
    vC = uTint * (0.35 + inten * 0.65);
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
  };
  userData: { baseSize: number };
};

/** Point material: attenuated size with a pixel clamp, four colour modes, clipping planes. */
export function createPointMaterial(o: PointMaterialOptions): PointMaterial {
  const defines: Record<string, string> = {};
  if (o.hasRgb) defines.HAS_RGB = '';
  if (o.hasIntensity) defines.HAS_INTENSITY = '';
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
    },
  }) as PointMaterial;
  m.userData.baseSize = o.baseSize;
  return m;
}

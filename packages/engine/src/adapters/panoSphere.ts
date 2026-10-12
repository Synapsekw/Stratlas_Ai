import { BackSide, ShaderMaterial, type Color, type Texture } from 'three';
import type { PanoCoverage } from './panoMath';

/** Radius of the panorama sphere around the camera, metres (inside the camera's near/far). */
export const PANO_SPHERE_R = 50;

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Same mapping as panoUv (panoMath.ts): azimuth clockwise from -Z, image centre at `heading`. */
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float hasMap;
uniform float heading;
uniform float hspan;
uniform float vtop;
uniform float vbot;
uniform vec3 backdrop;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float az = degrees(atan(d.x, -d.z));
  float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
  float da = mod(az - heading + 540.0, 360.0) - 180.0;
  vec2 uv = vec2(0.5 + da / hspan, (el + vbot) / (vtop + vbot));
  if (hasMap < 0.5 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(backdrop, 1.0);
  } else {
    gl_FragColor = vec4(texture2D(map, uv).rgb, 1.0);
  }
  #include <colorspace_fragment>
}
`;

/** The inside-out panorama sphere shader with typed setters for its uniforms. */
export interface PanoSphereMaterial {
  material: ShaderMaterial;
  /** Show `tex` (null shows the backdrop). The previous texture is disposed. */
  setImage(tex: Texture | null): void;
  /** Image centre heading and the part of the sphere the image covers. */
  setFrame(headingDeg: number, cov: PanoCoverage): void;
  /** Dispose the material (the texture is released by `setImage(null)`). */
  dispose(): void;
}

export function panoSphereMaterial(backdrop: Color): PanoSphereMaterial {
  const uniforms = {
    map: { value: null as Texture | null },
    hasMap: { value: 0 },
    heading: { value: 0 },
    hspan: { value: 360 },
    vtop: { value: 90 },
    vbot: { value: 90 },
    backdrop: { value: backdrop },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  return {
    material,
    setImage(tex) {
      if (uniforms.map.value && uniforms.map.value !== tex) uniforms.map.value.dispose();
      uniforms.map.value = tex;
      uniforms.hasMap.value = tex ? 1 : 0;
    },
    setFrame(headingDeg, cov) {
      uniforms.heading.value = headingDeg;
      uniforms.hspan.value = cov.hspanDeg;
      uniforms.vtop.value = cov.vtopDeg;
      uniforms.vbot.value = cov.vbotDeg;
    },
    dispose() {
      material.dispose();
    },
  };
}

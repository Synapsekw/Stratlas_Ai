/**
 * The Globe's own light and air: one pass over the finished frame (a CesiumJS post-process
 * stage) that knows where the Earth is from the camera alone. Inside the Earth's outline it
 * shades the whole Earth softly from the upper left and lays a thin haze along the limb; outside
 * it draws a glow that hugs the limb and a sparse field of small stars. Everything fades with the
 * camera's height, so close to the ground the map keeps exactly its own colours.
 *
 * It replaces CesiumJS's sky box, sky atmosphere, ground atmosphere and day and night shading on
 * the street looks: those are a photograph's light, this is a drawing's. It costs one full-screen
 * pass and only on frames the Globe draws anyway (render on demand).
 */
import { Cartesian3 } from '@cesium/core';
import { PostProcessStage, type Scene } from '@cesium/engine';
import { wholeEarthAmount } from '../look';
import { hexRgb, type GlobePalette } from '../style';

const SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform vec3 u_rim;
uniform vec3 u_glow;
uniform vec3 u_light;
uniform float u_whole;
uniform float u_pixel;
in vec2 v_textureCoordinates;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

// a sparse field of small stars, fixed in space: cells on the faces of a cube around the camera
float stars(vec3 d) {
  vec3 a = abs(d);
  float m = max(a.x, max(a.y, a.z));
  vec2 uv;
  float face;
  if (m == a.x) { uv = d.yz / a.x; face = d.x > 0.0 ? 0.0 : 1.0; }
  else if (m == a.y) { uv = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; }
  else { uv = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; }
  vec2 g = uv * 40.0;
  vec2 cell = floor(g);
  float pick = hash(vec3(cell, face));
  if (pick > 0.16) return 0.0;
  vec2 at = vec2(hash(vec3(cell, face + 7.0)), hash(vec3(cell, face + 13.0))) * 0.7 + 0.15;
  float perPixel = max(length(dFdx(g)), length(dFdy(g)));
  float dist = length(fract(g) - at) / max(perPixel, 1e-6);
  float size = (0.55 + 0.9 * hash(vec3(cell, face + 21.0))) * u_pixel;
  float light = 0.18 + 0.82 * pow(pick / 0.16, 2.0);
  return light * (1.0 - smoothstep(size * 0.55, size * 1.25, dist));
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  // through the near plane: at the far plane the divide loses all precision near the ground
  vec4 eye = czm_inverseProjection * vec4(v_textureCoordinates * 2.0 - 1.0, -1.0, 1.0);
  vec3 dirEC = normalize(eye.xyz / eye.w);
  vec3 dirWC = normalize((czm_inverseView * vec4(dirEC, 0.0)).xyz);

  // the ray against the Earth, in the space where the ellipsoid is the unit sphere
  vec3 o = czm_viewerPositionWC / czm_ellipsoidRadii;
  vec3 d = dirWC / czm_ellipsoidRadii;
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  float near = (-b - sqrt(max(disc, 0.0))) / a;
  vec3 rgb = color.rgb;

  if (disc > 0.0 && near > 0.0) {
    vec3 n = normalize(o + near * d);
    vec3 nEC = normalize((czm_view * vec4(n, 0.0)).xyz);
    float facing = clamp(dot(nEC, -dirEC), 0.0, 1.0);
    // soft light from the upper left: never a black side
    float lit = clamp(dot(nEC, u_light), 0.0, 1.0);
    float shade = mix(1.0, 0.42 + 0.72 * lit, u_whole);
    rgb *= shade;
    // a lift of the lit side, so land and water part on the dark map from far away
    rgb += u_rim * 0.035 * lit * lit * u_whole;
    // the haze along the limb
    float limb = pow(1.0 - facing, 3.2);
    rgb += u_rim * limb * (0.16 + 0.5 * lit) * u_whole;
  } else {
    // how far the ray passes above the surface (unit sphere radii)
    float along = -b / a;
    float miss = along > 0.0 ? sqrt(max(dot(o, o) - b * b / a, 1.0)) - 1.0 : sqrt(dot(o, o)) - 1.0;
    // looking up and away from the Earth, the air thins with the angle above the horizon
    float up = along > 0.0 ? 0.0 : clamp(dot(normalize(o), dirWC), 0.0, 1.0);
    vec3 closest = normalize(o + max(along, 0.0) * d);
    float lit = clamp(dot(normalize((czm_view * vec4(closest, 0.0)).xyz), u_light), 0.0, 1.0);
    float far = mix(0.3, 1.0, u_whole);
    float thin = exp(-miss / 0.012 - up * 9.0);
    float wide = exp(-miss / 0.09 - up * 3.0);
    rgb += u_glow * (thin * (0.3 + 0.6 * lit) + wide * (0.05 + 0.13 * lit)) * far;
    rgb += vec3(0.82, 0.88, 1.0) * stars(dirWC) * (1.0 - thin) * 0.75;
  }
  out_FragColor = vec4(rgb, color.a);
}
`;

export interface Aura {
  readonly stage: PostProcessStage;
  setPalette(palette: GlobePalette): void;
}

/** Add the aura to a scene (off until `stage.enabled` is set). */
export function addAura(scene: Scene, palette: GlobePalette, pixelRatio: number): Aura {
  const rim = new Cartesian3();
  const glow = new Cartesian3();
  const apply = (p: GlobePalette) => {
    const [r, g, b] = hexRgb(p.accent);
    const [wr, wg, wb] = hexRgb(p.water);
    // the limb haze leans to the map's water blue, the outer glow to the accent
    Cartesian3.fromElements(
      0.5 * r + 2.2 * wr + 0.08,
      0.55 * g + 2.2 * wg + 0.12,
      0.6 * b + 2.2 * wb + 0.2,
      rim,
    );
    Cartesian3.fromElements(0.55 * r + 0.06, 0.8 * g + 0.08, 0.95 * b + 0.2, glow);
  };
  apply(palette);
  // towards the upper left and the viewer, in eye coordinates
  const light = Cartesian3.normalize(new Cartesian3(-0.52, 0.5, 0.69), new Cartesian3());
  const stage = new PostProcessStage({
    name: 'aio_globe_aura',
    fragmentShader: SHADER,
    uniforms: {
      u_rim: () => rim,
      u_glow: () => glow,
      u_light: () => light,
      u_whole: () => wholeEarthAmount(scene.camera.positionCartographic.height),
      u_pixel: () => pixelRatio,
    },
  });
  stage.enabled = false;
  scene.postProcessStages.add(stage);
  return { stage, setPalette: apply };
}

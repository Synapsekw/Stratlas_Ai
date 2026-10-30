/**
 * The Globe's own light and air: one pass over the finished frame (a CesiumJS post-process
 * stage) that knows where the Earth is from the camera alone. Inside the Earth's outline it
 * shades the whole Earth softly from the upper left, and it draws the outline itself as a
 * hairline: no glow and no stars. Everything fades with the camera's height, so close to the
 * ground the map keeps exactly its own colours.
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
uniform vec3 u_line;
uniform vec3 u_light;
uniform float u_whole;
uniform float u_pixel;
in vec2 v_textureCoordinates;

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

  // How far the ray misses the Earth (below zero: it hits), smooth across the outline, and how
  // much that changes from one pixel to the next: the outline is where it crosses zero. Taken
  // here, before any branch, so the derivative is the same on both sides of the outline.
  float miss = -disc / a;
  float perPixel = max(fwidth(miss), 1e-12);

  if (disc > 0.0 && near > 0.0) {
    vec3 n = normalize(o + near * d);
    vec3 nEC = normalize((czm_view * vec4(n, 0.0)).xyz);
    // soft light from the upper left: never a black side
    float lit = clamp(dot(nEC, u_light), 0.0, 1.0);
    float shade = mix(1.0, 0.42 + 0.72 * lit, u_whole);
    rgb *= shade;
    // a lift of the lit side, so land and water part on the dark map from far away
    rgb += u_rim * 0.035 * lit * lit * u_whole;
  }
  // a hairline along the Earth's outline, about a CSS pixel wide, where the ray grazes it
  float dist = abs(miss) / perPixel;
  float line = 1.0 - smoothstep(0.5 * u_pixel - 0.5, 0.5 * u_pixel + 0.5, dist);
  if (b < 0.0) rgb = mix(rgb, u_line, line * 0.6 * u_whole);
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
  const line = new Cartesian3();
  const apply = (p: GlobePalette) => {
    const [r, g, b] = hexRgb(p.accent);
    const [wr, wg, wb] = hexRgb(p.water);
    // the lift of the lit side leans to the map's water blue, the outline to the accent
    Cartesian3.fromElements(
      0.5 * r + 2.2 * wr + 0.08,
      0.55 * g + 2.2 * wg + 0.12,
      0.6 * b + 2.2 * wb + 0.2,
      rim,
    );
    Cartesian3.fromElements(0.55 * r + 0.06, 0.8 * g + 0.08, 0.95 * b + 0.2, line);
  };
  apply(palette);
  // towards the upper left and the viewer, in eye coordinates
  const light = Cartesian3.normalize(new Cartesian3(-0.52, 0.5, 0.69), new Cartesian3());
  const stage = new PostProcessStage({
    name: 'aio_globe_aura',
    fragmentShader: SHADER,
    uniforms: {
      u_rim: () => rim,
      u_line: () => line,
      u_light: () => light,
      u_whole: () => wholeEarthAmount(scene.camera.positionCartographic.height),
      u_pixel: () => pixelRatio,
    },
  });
  stage.enabled = false;
  scene.postProcessStages.add(stage);
  return { stage, setPalette: apply };
}

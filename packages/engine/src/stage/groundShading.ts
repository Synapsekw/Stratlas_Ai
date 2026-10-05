import {
  Color,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  RGBAFormat,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';

/** Camera layer of meshes that stand on land (mesh layers): drawn into the land mask. */
export const MASK_LAYER = 7;
/** Camera layer of ground imagery (ortho tiles): classified land or sea into the land mask. */
export const GROUND_LAYER = 6;

/**
 * Uniforms shared by every ground imagery material (orthomosaic tiles) and the terrain of mesh
 * layers: daylight factors in sun and in shadow, and the land mask that lets animated water show
 * through photographed sea.
 */
export interface GroundUniforms {
  uGroundLit: { value: Color };
  uGroundShade: { value: Color };
  uLandMask: { value: Texture | null };
  /** World to mask clip space (the mask camera's view projection). */
  uMaskMatrix: { value: Matrix4 };
  /** 1 while water is shown and a mask exists: sea is cut out of imagery and terrain. */
  uMaskOn: { value: number };
  /** 1 while the land mask is drawn: imagery writes land (white) or sea (black). */
  uMaskPass: { value: number };
}

export function createGroundUniforms(): GroundUniforms {
  return {
    uGroundLit: { value: new Color(1, 1, 1) },
    uGroundShade: { value: new Color(0.6, 0.6, 0.6) },
    uLandMask: { value: null },
    uMaskMatrix: { value: new Matrix4() },
    uMaskOn: { value: 0 },
    uMaskPass: { value: 0 },
  };
}

const VERT_HEAD = /* glsl */ `
varying vec3 vAioWorld;`;
const VERT_BODY = /* glsl */ `
#include <project_vertex>
vAioWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;
const MASK_HEAD = /* glsl */ `
varying vec3 vAioWorld;
uniform sampler2D uLandMask;
uniform mat4 uMaskMatrix;
uniform float uMaskOn;
uniform float uMaskPass;
bool aioIsSea( vec3 w ) {
  vec4 mc = uMaskMatrix * vec4( w, 1.0 );
  vec2 muv = mc.xy * 0.5 + 0.5;
  return muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0 && texture2D( uLandMask, muv ).r < 0.4;
}`;
const FRAG_HEAD = /* glsl */ `${MASK_HEAD}
uniform vec3 uGroundLit;
uniform vec3 uGroundShade;`;
const FRAG_MASK = /* glsl */ `
#include <clipping_planes_fragment>
if ( uMaskOn > 0.5 && uMaskPass < 0.5 && aioIsSea( vAioWorld ) ) discard;`;
/**
 * In the mask pass, imagery says what it shows: sea (cyan dominant: green and blue well above
 * red and close to each other, unlike blue roofs or vegetation) or land; no data (transparent or
 * black) leaves the meshes' answer in place.
 */
const FRAG_CLASSIFY = /* glsl */ `
#include <map_fragment>
if ( uMaskPass > 0.5 ) {
  if ( diffuseColor.a < 0.5 ) discard;
  vec3 s = pow( max( diffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  if ( s.r + s.g + s.b < 0.06 ) discard;
  bool sea = s.g - s.r > 0.06 && s.b - s.r > 0.07 && abs( s.b - s.g ) < 0.12;
  gl_FragColor = vec4( vec3( sea ? 0.0 : 1.0 ), 1.0 );
  return;
}`;
const FRAG_OUT = /* glsl */ `
float aioShadow = 1.0;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  aioShadow = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
#endif
outgoingLight = diffuseColor.rgb * mix( uGroundShade, uGroundLit, aioShadow );
#include <opaque_fragment>`;

/**
 * A material for photographed ground (orthomosaic): the photo as it is, scaled by the time of
 * day, darkened where the sun's shadow falls, and cut away over the sea while water is shown.
 * Unlit otherwise: the photo already holds the light it was taken in.
 */
export function groundImageryMaterial(
  map: Texture | null,
  uniforms: GroundUniforms,
  opts: { masked: boolean },
): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ map, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERT_HEAD}`)
      .replace('#include <project_vertex>', VERT_BODY);
    let frag = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}`)
      .replace('#include <opaque_fragment>', FRAG_OUT);
    if (opts.masked)
      frag = frag
        .replace('#include <clipping_planes_fragment>', FRAG_MASK)
        .replace('#include <map_fragment>', FRAG_CLASSIFY);
    shader.fragmentShader = frag;
  };
  m.customProgramCacheKey = () => (opts.masked ? 'aio-ground-masked' : 'aio-ground');
  return m;
}

/**
 * Cut modelled terrain where the imagery shows sea while water is drawn: plot-plan outlines are
 * indicative and often wider than the real shore. Chains any existing `onBeforeCompile`.
 */
export function maskTerrainMaterial(m: Material, uniforms: GroundUniforms): void {
  if (m.userData.aioTerrainMask === true) return;
  m.userData.aioTerrainMask = true;
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    if (!shader.vertexShader.includes('#include <project_vertex>')) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERT_HEAD}`)
      .replace('#include <project_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${MASK_HEAD}`)
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif ( uMaskOn > 0.5 && uMaskPass < 0.5 && aioIsSea( vAioWorld ) ) discard;',
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}|aio-terrain-mask`;
  m.needsUpdate = true;
}

/**
 * Where the land is, seen from straight above: the meshes on `MASK_LAYER` between a floor and a
 * top, then overwritten by what the ground imagery on `GROUND_LAYER` shows (land or sea), which
 * is the truth wherever there is imagery.
 */
export class LandMask {
  readonly target: WebGLRenderTarget;
  private readonly cam = new OrthographicCamera();
  private readonly white = new MeshBasicMaterial({ color: 0xffffff, fog: false });

  constructor(size: number) {
    this.target = new WebGLRenderTarget(size, size, {
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      generateMipmaps: false,
    });
    this.target.texture.name = 'aio:landMask';
    this.cam.up.set(0, 0, -1);
  }

  /**
   * Draw the mask over the rectangle `[minX, maxX] x [minZ, maxZ]`; writes the world to mask
   * matrix into `uniforms.uMaskMatrix`.
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    rect: { minX: number; maxX: number; minZ: number; maxZ: number },
    floor: number,
    top: number,
    uniforms: GroundUniforms,
  ): void {
    const cx = (rect.minX + rect.maxX) / 2;
    const cz = (rect.minZ + rect.maxZ) / 2;
    const hw = (rect.maxX - rect.minX) / 2;
    const hh = (rect.maxZ - rect.minZ) / 2;
    const cam = this.cam;
    cam.left = -hw;
    cam.right = hw;
    cam.top = hh;
    cam.bottom = -hh;
    cam.near = 0;
    cam.far = Math.max(0.1, top - floor);
    cam.position.set(cx, top, cz);
    cam.lookAt(new Vector3(cx, floor, cz));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    uniforms.uMaskMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevShadows = renderer.shadowMap.enabled;
    const prevAutoClear = renderer.autoClear;
    const prevBg = scene.background;
    const prevOverride = scene.overrideMaterial;
    try {
      renderer.shadowMap.enabled = false;
      renderer.autoClear = false;
      scene.background = null;
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
      // the meshes standing on land, white
      scene.overrideMaterial = this.white;
      cam.layers.set(MASK_LAYER);
      renderer.render(scene, cam);
      // then the imagery's own answer on top, wherever it has data
      scene.overrideMaterial = null;
      renderer.clear(false, true, false);
      cam.far = Math.max(0.1, top - floor + 50);
      cam.updateProjectionMatrix();
      cam.layers.set(GROUND_LAYER);
      uniforms.uMaskPass.value = 1;
      // never sample the mask while drawing it (a feedback loop)
      uniforms.uLandMask.value = null;
      renderer.render(scene, cam);
    } finally {
      uniforms.uMaskPass.value = 0;
      uniforms.uLandMask.value = this.target.texture;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.enabled = prevShadows;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.white.dispose();
  }
}

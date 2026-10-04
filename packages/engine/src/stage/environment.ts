import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BackSide,
  Box3,
  Color,
  DataTexture,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PMREMGenerator,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type ToneMapping,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { PALETTE } from '../palette';
import { daylight, DESERT_SKY, SKY_GAIN, type Daylight } from './daylight';
import { createGroundUniforms, LandMask, type GroundUniforms } from './groundShading';
import { fitShadow } from './shadowFit';
import { waterNormalPixels } from './waterNormals';

/** The stage backdrop: a lit sky with a sun, or the neutral dark Mission studio. */
export type EnvironmentMode = 'sky' | 'studio';

/** Water detail per graphics tier: animated layered waves, or one still layer. */
export type WaterQuality = 'full' | 'simple';

export interface EnvironmentQuality {
  shadowMapSize: number;
  /** Shadow edge softness, texels (PCF radius). */
  shadowSoftness: number;
  water: WaterQuality;
  /** Frames per second the water animates at while nothing else redraws (0: still). */
  waterFps: number;
  /** Edge of the land mask that cuts photographed sea away, texels. */
  maskSize: number;
}

const STUDIO_SUN = new Vector3(-0.45, 0.8, 0.35).normalize();

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // on the far plane, behind everything
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunCol;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.42));
  c = mix(c, uHorizon * 0.8, clamp(-d.y * 6.0, 0.0, 1.0));
  float s = max(dot(d, uSun), 0.0);
  c += uSunCol * (pow(s, 1400.0) * 6.0 + pow(s, 24.0) * 0.06 + pow(s, 4.0) * 0.02);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** three's Sky with a gain into the stage's light units and a deep blue night floor. */
function createSky(sunDisc: boolean): Sky {
  const sky = new Sky();
  const mat = sky.material;
  mat.fragmentShader = mat.fragmentShader
    .replace(
      'uniform float time;',
      'uniform float time;\nuniform float uSkyGain;\nuniform vec3 uNightSky;',
    )
    .replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'texColor = texColor * uSkyGain + uNightSky * mix( 1.6, 0.6, clamp( direction.y * 3.0, 0.0, 1.0 ) );\n\t\t\tgl_FragColor = vec4( texColor, 1.0 );',
    );
  const u = mat.uniforms;
  u.uSkyGain = { value: SKY_GAIN };
  u.uNightSky = { value: new Vector3() };
  const set = (k: string, v: number) => {
    const uni = u[k];
    if (uni) uni.value = v;
  };
  set('turbidity', DESERT_SKY.turbidity);
  set('rayleigh', DESERT_SKY.rayleigh);
  set('mieCoefficient', DESERT_SKY.mieCoefficient);
  set('mieDirectionalG', DESERT_SKY.mieDirectionalG);
  set('cloudCoverage', 0.18);
  set('cloudDensity', 0.35);
  set('showSunDisc', sunDisc ? 1 : 0);
  mat.fog = false;
  sky.frustumCulled = false;
  sky.raycast = () => undefined;
  return sky;
}

const WATER_HEAD_V = /* glsl */ `
varying vec3 vAioW;`;
const WATER_BODY_V = /* glsl */ `
#include <project_vertex>
vAioW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;
const WATER_HEAD_F = /* glsl */ `
varying vec3 vAioW;
uniform sampler2D uWaterNormals;
uniform float uWaterTime;
uniform float uWaterLayers;`;
/** Layered scrolling normals in world space (the water is a flat, level plane). */
const WATER_NORMAL = /* glsl */ `
{
  vec2 p = vAioW.xz;
  float t = uWaterTime;
  // rotated, differently scaled layers so the tile never lines up; a slow broad swell layer
  // modulates the chop so the surface does not read as a repeated pattern
  const mat2 R1 = mat2( 0.8, 0.6, -0.6, 0.8 );
  const mat2 R2 = mat2( 0.28, -0.96, 0.96, 0.28 );
  vec2 swell = texture2D( uWaterNormals, p / 233.0 + t * vec2( 0.0011, -0.0007 ) ).xy * 2.0 - 1.0;
  vec2 g = ( texture2D( uWaterNormals, R1 * p / 47.0 + t * vec2( 0.0083, 0.0049 ) ).xy * 2.0 - 1.0 );
  float chop = 0.55 + 0.45 * ( swell.x * 0.5 + 0.5 );
  if ( uWaterLayers > 1.5 ) {
    g += ( texture2D( uWaterNormals, R2 * p / 17.0 + t * vec2( -0.0141, 0.0153 ) ).xy * 2.0 - 1.0 ) * 0.7;
    g += ( texture2D( uWaterNormals, p / 5.3 + t * vec2( 0.0402, -0.0287 ) ).xy * 2.0 - 1.0 ) * 0.35;
  }
  g = g * chop + swell * 0.5;
  float dist = length( cameraPosition - vAioW );
  g *= clamp( 1.0 - dist / 4000.0, 0.1, 1.0 ) * 0.2;
  vec3 nW = normalize( vec3( g.x, 1.0, -g.y ) );
  normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
}`;

function waterNormalTexture(): DataTexture {
  const size = 256;
  const tex = new DataTexture(waterNormalPixels(size), size, size, RGBAFormat);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  tex.name = 'aio:waterNormals';
  return tex;
}

const lin = (hex: number) => new Color(hex);

/** Tone mapping and base exposure per backdrop. */
const TONE: Record<EnvironmentMode, { mapping: ToneMapping; exposure: number }> = {
  studio: { mapping: ACESFilmicToneMapping, exposure: 1 },
  sky: { mapping: AgXToneMapping, exposure: 1.35 },
};

/**
 * Backdrop, lights, shadows and water of the stage. `studio` is the dark Mission look: a gradient
 * dome, a fixed sun and a grey image-based light. `sky` is a physically based sky (three's
 * Preetham `Sky`) whose sun follows the time of day; the sky also lights the scene through a
 * PMREM environment map, rebuilt (throttled) only when the sun moves. Fog, ground and water scale
 * with the content so a 10 m tank and a 2.5 km plant both look right.
 */
export class Environment {
  readonly sun: DirectionalLight;
  readonly ground: Mesh;
  readonly groundUniforms: GroundUniforms = createGroundUniforms();
  private readonly hemi: HemisphereLight;
  private readonly dome: Mesh;
  private readonly domeMat: ShaderMaterial;
  private readonly sky: Sky;
  private readonly envSky: Sky;
  private readonly envScene = new Scene();
  private readonly grid: GridHelper;
  private readonly fog: Fog;
  private readonly normals: DataTexture;
  private readonly waterTime = { value: 0 };
  private readonly waterLayers = { value: 3 };
  private water: Mesh | null = null;
  private waterMat: MeshStandardMaterial | null = null;
  private waterLevel: number | null = null;
  private landMask: LandMask | null = null;
  private pmrem: PMREMGenerator | null = null;
  private studioEnv: Texture | null = null;
  private skyEnv: WebGLRenderTarget | null = null;
  private envDirty = true;
  private envAt = -Infinity;
  private _mode: EnvironmentMode = 'studio';
  private light = new Vector3().copy(STUDIO_SUN);
  private skySun = new Vector3(0, 1, 0);
  private skyElevation = 45;
  private day: Daylight | null = null;
  private radius = 50;
  private readonly centre = new Vector3();
  private readonly shadowBox = new Box3(new Vector3(-50, -1, -50), new Vector3(50, 50, 50));
  private readonly lastShadowTarget = new Vector3(Infinity, 0, 0);
  private lastShadowDist = 0;
  private shadowForced = true;
  private maxShadow = 4096;
  private lastWaterFrame = 0;
  private q: EnvironmentQuality = {
    shadowMapSize: 4096,
    shadowSoftness: 2.5,
    water: 'full',
    waterFps: 30,
    maskSize: 2048,
  };

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
  ) {
    this.fog = new Fog(lin(PALETTE.skyHorizon), 2000, 12000);
    scene.fog = this.fog;

    this.domeMat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: lin(PALETTE.skyZenith) },
        uHorizon: { value: lin(PALETTE.skyHorizon) },
        uSun: { value: STUDIO_SUN },
        uSunCol: { value: lin(PALETTE.sun) },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
    });
    this.dome = new Mesh(new SphereGeometry(1, 32, 16), this.domeMat);
    this.dome.name = 'env:sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.raycast = () => undefined;
    scene.add(this.dome);

    this.sky = createSky(true);
    this.sky.name = 'env:physicalSky';
    this.sky.renderOrder = -10;
    this.sky.visible = false;
    scene.add(this.sky);
    this.envSky = createSky(false);
    this.envSky.scale.setScalar(100);
    this.envScene.add(this.envSky);

    this.hemi = new HemisphereLight(0xdfe8f4, 0x3a3730, 0.9);
    this.sun = new DirectionalLight(PALETTE.sun, 2.4);
    this.sun.name = 'env:sun';
    this.sun.castShadow = true;
    const caps = renderer.capabilities as Partial<WebGLRenderer['capabilities']> | undefined;
    this.maxShadow = Math.min(8192, caps?.maxTextureSize ?? 4096);
    const size = Math.min(4096, this.maxShadow);
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.radius = this.q.shadowSoftness;
    scene.add(this.hemi, this.sun, this.sun.target);

    this.ground = new Mesh(
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: PALETTE.ground, roughness: 1, metalness: 0 }),
    );
    this.ground.name = 'env:ground';
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -6;
    scene.add(this.ground);
    this.grid = new GridHelper(1, 10, PALETTE.groundLine, PALETTE.groundLine);
    this.grid.name = 'env:grid';
    this.grid.raycast = () => undefined;
    const gm = this.grid.material as { transparent: boolean; opacity: number; depthWrite: boolean };
    gm.transparent = true;
    gm.opacity = 0.55;
    gm.depthWrite = false;
    scene.add(this.grid);

    this.normals = waterNormalTexture();
    try {
      this.pmrem = new PMREMGenerator(renderer);
    } catch {
      this.pmrem = null; // no WebGL (tests)
    }
    this.buildStudioEnv();
    this.applyMode();
    this.setContentRadius(50);
  }

  /* --------------------------------------------------------------------- settings */

  get mode(): EnvironmentMode {
    return this._mode;
  }

  /** Edge of the sun's shadow map, texels. */
  get shadowMapSize(): number {
    return this.sun.shadow.mapSize.x;
  }

  /** Light levels of the current sky (sky mode), for tests and the UI. */
  get daylight(): Daylight | null {
    return this._mode === 'sky' ? this.day : null;
  }

  /** Direction toward the light that casts shadows (sun, moon, or the studio light). */
  get lightDirection(): Vector3 {
    return this.light;
  }

  /** Graphics tier settings; true when the shadow map must be redrawn. */
  setQuality(q: Partial<EnvironmentQuality>): boolean {
    this.q = { ...this.q, ...q };
    this.sun.shadow.radius = this.q.shadowSoftness;
    this.waterLayers.value = this.q.water === 'full' ? 3 : 1;
    if (this.landMask && this.landMask.target.width !== this.q.maskSize) {
      this.landMask.dispose();
      this.landMask = null;
    }
    const s = Math.max(256, Math.min(this.maxShadow, this.q.shadowMapSize));
    if (s === this.sun.shadow.mapSize.x) return false;
    this.sun.shadow.mapSize.set(s, s);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.shadowForced = true;
    return true;
  }

  /** Change the shadow map edge (quality preset); true when it changed. */
  setShadowMapSize(size: number): boolean {
    return this.setQuality({ shadowMapSize: size });
  }

  setMode(mode: EnvironmentMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.applyMode();
  }

  /**
   * The sun for sky mode: unit direction toward it in the local frame (may be below the horizon)
   * and its elevation. At night a dim moonlight takes over, opposite the sun's bearing.
   */
  setSun(direction: Vector3, elevationDeg: number): void {
    this.skySun.copy(direction).normalize();
    this.skyElevation = elevationDeg;
    this.day = daylight([this.skySun.x, this.skySun.y, this.skySun.z], elevationDeg);
    this.envDirty = true;
    if (this._mode === 'sky') this.applySky();
  }

  private applyMode() {
    const sky = this._mode === 'sky';
    this.dome.visible = !sky;
    this.sky.visible = sky;
    this.scene.background = sky ? null : lin(PALETTE.bg0);
    const t = TONE[this._mode];
    this.renderer.toneMapping = t.mapping;
    const gmat = this.ground.material as MeshStandardMaterial;
    gmat.color.set(sky ? 0x8a8070 : PALETTE.ground);
    (this.grid.material as { opacity: number }).opacity = sky ? 0.25 : 0.55;
    if (sky) {
      this.day ??= daylight([this.skySun.x, this.skySun.y, this.skySun.z], this.skyElevation);
      this.applySky();
      this.envDirty = true;
    } else {
      this.light.copy(STUDIO_SUN);
      this.sun.color.set(PALETTE.sun);
      this.sun.intensity = 2.4;
      this.hemi.color.set(0xdfe8f4);
      this.hemi.groundColor.set(0x3a3730);
      this.hemi.intensity = 0.9;
      this.fog.color.set(PALETTE.skyHorizon);
      this.scene.environment = this.studioEnv;
      this.scene.environmentIntensity = 0.55;
      this.renderer.toneMappingExposure = t.exposure;
      this.groundUniforms.uGroundLit.value.setRGB(1, 1, 1);
      this.groundUniforms.uGroundShade.value.setRGB(0.62, 0.62, 0.62);
      this.shadowForced = true;
    }
    this.setContentRadius(this.radius, this.centre);
    if (this.waterMat) this.waterMat.needsUpdate = true;
  }

  private applySky() {
    const d = this.day;
    if (!d) return;
    const u = this.sky.material.uniforms;
    const eu = this.envSky.material.uniforms;
    for (const uni of [u, eu]) {
      (uni.sunPosition?.value as Vector3 | undefined)?.copy(this.skySun);
      (uni.uNightSky?.value as Vector3 | undefined)?.set(...d.nightSky);
    }
    if (d.moon) {
      // moonlight from high in the sky opposite the sun's bearing
      const h = new Vector3(-this.skySun.x, 0, -this.skySun.z);
      if (h.lengthSq() < 1e-6) h.set(0, 0, 1);
      h.normalize();
      this.light.copy(h).multiplyScalar(0.62).setY(0.78).normalize();
    } else this.light.copy(this.skySun);
    if (this.light.y < 0.02) this.light.setY(0.02).normalize();
    this.sun.color.setRGB(...d.lightColour);
    this.sun.intensity = d.lightIntensity;
    this.hemi.color.setRGB(...d.hemiColour);
    this.hemi.groundColor.setRGB(...d.hemiColour).multiplyScalar(0.5);
    this.hemi.intensity = d.hemiIntensity;
    this.fog.color.setRGB(...d.fog);
    this.renderer.toneMappingExposure = TONE.sky.exposure * d.exposure;
    // ground imagery is not tone mapped: carry the exposure in its factors
    this.groundUniforms.uGroundLit.value.setRGB(...d.groundLit);
    this.groundUniforms.uGroundShade.value.setRGB(...d.groundShade);
    this.scene.environmentIntensity = d.envIntensity;
    if (this.skyEnv) this.scene.environment = this.skyEnv.texture;
    this.shadowForced = true;
  }

  /** Image-based light for the studio: a brighter copy of the gradient dome, built once. */
  private buildStudioEnv() {
    if (!this.pmrem) return;
    try {
      const scene = new Scene();
      const mat = this.domeMat.clone();
      mat.uniforms.uZenith = { value: new Color(0.32, 0.38, 0.46) };
      mat.uniforms.uHorizon = { value: new Color(0.62, 0.64, 0.66) };
      scene.add(new Mesh(new SphereGeometry(100, 32, 16), mat));
      this.studioEnv = this.pmrem.fromScene(scene, 0, 1, 500).texture;
      mat.dispose();
    } catch {
      this.studioEnv = null;
    }
  }

  /** Rebuild the sky light map from the sky dome; at most a few times a second while dragging. */
  private rebuildSkyEnv(now: number): boolean {
    if (!this.pmrem || !this.envDirty || this._mode !== 'sky') return false;
    if (now - this.envAt < 150) return true; // still pending
    this.envDirty = false;
    this.envAt = now;
    try {
      const next = this.pmrem.fromScene(this.envScene, 0, 1, 1000, { size: 128 });
      this.skyEnv?.dispose();
      this.skyEnv = next;
      this.scene.environment = next.texture;
    } catch {
      // keep the previous map
    }
    return false;
  }

  /* --------------------------------------------------------------------- content */

  /** Rescale fog, ground, grid and water to the content (radius of its bounding sphere). */
  setContentRadius(radius: number, centre = new Vector3()) {
    this.radius = Math.max(radius, 5);
    this.centre.copy(centre);
    const r = this.radius;
    if (this._mode === 'sky') {
      // haze is about the air, not the asset: kilometres, whatever the content
      this.fog.near = Math.max(r * 3, 1500);
      this.fog.far = Math.max(r * 25, 22000);
    } else {
      this.fog.near = r * 4;
      this.fog.far = r * 24;
    }
    const groundSize = r * 60;
    this.ground.scale.set(groundSize, 1, groundSize);
    this.ground.position.set(centre.x, 0, centre.z);
    // grid cell: 1, 10 or 100 m depending on scale; 40 cells across the content
    const cell = Math.pow(10, Math.max(0, Math.round(Math.log10(r / 4))));
    const cells = Math.ceil((r * 8) / cell);
    this.grid.scale.setScalar(cells * cell);
    this.grid.position.set(
      Math.round(centre.x / cell) * cell,
      0.002 * cell,
      Math.round(centre.z / cell) * cell,
    );
    (this.grid.geometry as { dispose(): void }).dispose();
    const fresh = new GridHelper(1, cells, PALETTE.groundLine, PALETTE.groundLine);
    this.grid.geometry = fresh.geometry;
    fresh.material.dispose();
    if (this.water && this.waterLevel !== null) this.placeWater(this.waterLevel);
    this.shadowForced = true;
  }

  /** Everything that casts or receives shadows, for fitting the shadow frustum. */
  setShadowBounds(box: Box3) {
    if (box.isEmpty()) return;
    this.shadowBox.copy(box);
    this.shadowForced = true;
  }

  setGroundVisible(v: boolean) {
    this.ground.visible = v;
    this.grid.visible = v;
  }

  /* --------------------------------------------------------------------- water */

  /** Animated water at height `level` (local y), replacing a modelled sea. Null removes it. */
  setWater(level: number | null) {
    this.waterLevel = level;
    if (level === null) {
      if (this.water) {
        this.scene.remove(this.water);
        this.water.geometry.dispose();
        this.waterMat?.dispose();
        this.water = null;
        this.waterMat = null;
      }
      return;
    }
    if (!this.water) {
      const mat = new MeshStandardMaterial({
        color: 0x0f4a4d,
        roughness: 0.1,
        metalness: 0,
        envMapIntensity: 1,
      });
      mat.name = 'aio:water';
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uWaterNormals = { value: this.normals };
        shader.uniforms.uWaterTime = this.waterTime;
        shader.uniforms.uWaterLayers = this.waterLayers;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>${WATER_HEAD_V}`)
          .replace('#include <project_vertex>', WATER_BODY_V);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>${WATER_HEAD_F}`)
          .replace('#include <normal_fragment_maps>', WATER_NORMAL);
      };
      mat.customProgramCacheKey = () => 'aio-water';
      this.waterMat = mat;
      this.water = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
      this.water.name = 'env:water';
      this.water.renderOrder = -5;
      this.water.receiveShadow = true;
      this.water.raycast = () => undefined;
      this.scene.add(this.water);
    }
    this.placeWater(level);
  }

  private placeWater(level: number) {
    if (!this.water) return;
    const size = this.radius * 60;
    this.water.scale.set(size, 1, size);
    this.water.position.set(this.centre.x, level, this.centre.z);
    this.water.updateMatrixWorld();
  }

  get hasWater() {
    return this.water !== null;
  }

  /** Water level shown now (local y), or null. */
  get waterY(): number | null {
    return this.water ? this.waterLevel : null;
  }

  /**
   * Draw the land mask over `rect` (the ortho) from the meshes on the mask layer above the water,
   * so ground imagery cuts its photographed sea away and the animated water shows there.
   */
  renderLandMask(
    rect: { minX: number; maxX: number; minZ: number; maxZ: number },
    top: number,
    floor: number,
  ): boolean {
    if (this.waterLevel === null) return false;
    try {
      this.landMask ??= new LandMask(this.q.maskSize);
      this.landMask.render(this.renderer, this.scene, rect, floor, top, this.groundUniforms);
      this.groundUniforms.uLandMask.value = this.landMask.target.texture;
      return true;
    } catch {
      return false;
    }
  }

  /** Cut photographed sea out of ground imagery (only meaningful after `renderLandMask`). */
  setMaskOn(on: boolean) {
    this.groundUniforms.uMaskOn.value = on && this.groundUniforms.uLandMask.value ? 1 : 0;
  }

  /** The idle loop should draw a frame (water animation, a pending sky light map). */
  wantsFrame(now: number): boolean {
    if (this.envDirty && this._mode === 'sky' && this.pmrem) return true;
    if (!this.water || this.q.water !== 'full' || this.q.waterFps <= 0) return false;
    return now - this.lastWaterFrame >= 1000 / this.q.waterFps;
  }

  /* --------------------------------------------------------------------- per frame */

  /**
   * Per rendered frame. Keeps the sky around the camera, adjusts near/far, rebuilds the sky
   * light when the sun moved, and re-aims the shadow frustum (`fitShadow`) when the view moved
   * enough. Returns true when the shadow map must be redrawn.
   */
  update(camera: PerspectiveCamera, target: Vector3, timeS: number, now = timeS * 1000): boolean {
    this.dome.position.copy(camera.position);
    this.sky.position.copy(camera.position);
    if (this.water) {
      if (this.q.water === 'full') this.waterTime.value = timeS;
      this.lastWaterFrame = now;
    }
    this.rebuildSkyEnv(now);
    const d = camera.position.distanceTo(target);
    const near = Math.min(Math.max(d * 0.004, 0.01), 20);
    const far = Math.max(this.radius * 40, d * 8, this._mode === 'sky' ? 30000 : 0);
    if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    if (
      this.shadowForced ||
      this.lastShadowTarget.distanceTo(target) > d * 0.02 ||
      Math.abs(this.lastShadowDist - d) > d * 0.05
    ) {
      this.shadowForced = false;
      this.lastShadowTarget.copy(target);
      this.lastShadowDist = d;
      return this.placeShadow(target, d);
    }
    return false;
  }

  private readonly lastFit = { pos: new Vector3(), ext: 0, near: 0, far: 0 };

  private placeShadow(t: Vector3, d: number): boolean {
    const fit = fitShadow(this.light, this.shadowBox, this.radius, t, d, this.sun.shadow.mapSize.x);
    const last = this.lastFit;
    const changed =
      !fit.position.equals(last.pos) ||
      fit.halfExtent !== last.ext ||
      fit.near !== last.near ||
      fit.far !== last.far;
    if (!changed) return false;
    last.pos.copy(fit.position);
    last.ext = fit.halfExtent;
    last.near = fit.near;
    last.far = fit.far;
    this.sun.position.copy(fit.position);
    this.sun.target.position.copy(fit.target);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    sc.left = -fit.halfExtent;
    sc.right = fit.halfExtent;
    sc.top = fit.halfExtent;
    sc.bottom = -fit.halfExtent;
    sc.near = fit.near;
    sc.far = fit.far;
    sc.updateProjectionMatrix();
    // acne: offset along the normal by about a texel, plus a little depth (in map depth units)
    this.sun.shadow.normalBias = fit.texel * 1.2;
    this.sun.shadow.bias = -(fit.texel * 0.6) / Math.max(fit.far - fit.near, 1);
    return true;
  }

  dispose() {
    this.setWater(null);
    this.scene.remove(
      this.dome,
      this.sky,
      this.hemi,
      this.sun,
      this.sun.target,
      this.ground,
      this.grid,
    );
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.envSky.geometry.dispose();
    this.envSky.material.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as MeshStandardMaterial).dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.sun.shadow.map?.dispose();
    this.studioEnv?.dispose();
    this.skyEnv?.dispose();
    this.landMask?.dispose();
    this.normals.dispose();
    this.pmrem?.dispose();
  }
}

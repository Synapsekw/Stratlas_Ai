import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { PALETTE } from '../palette';

const SUN_DIR = new Vector3(-0.45, 0.8, 0.35).normalize();

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // on the far plane, behind everything
}`;

const SKY_FRAG = /* glsl */ `
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

const WATER_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** Cheap animated water: analytic wave normals, Fresnel sky reflection, sun glitter, fog. */
const WATER_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uZenith; uniform vec3 uHorizon;
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec2 uFog;
varying vec3 vW;
vec2 waves(vec2 p, float t) {
  vec2 g = vec2(cos(p.x * 0.050 + t * 0.6), cos(p.y * 0.043 + t * 0.5)) * 0.50;
  g += vec2(cos((p.x + p.y) * 0.11 + t * 1.1), cos((p.x - p.y) * 0.097 + t * 0.9)) * 0.30;
  g += vec2(cos(p.x * 0.31 + p.y * 0.17 - t * 1.7), cos(p.y * 0.27 - p.x * 0.13 + t * 1.5)) * 0.15;
  return g * 0.10;
}
void main() {
  float dist = length(cameraPosition - vW);
  vec2 g = waves(vW.xz, uTime) * clamp(1.0 - dist / 4000.0, 0.25, 1.0);
  vec3 N = normalize(vec3(g.x, 1.0, g.y));
  vec3 V = normalize(cameraPosition - vW);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  float fr = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.42));
  float sd = max(dot(R, uSun), 0.0);
  vec3 spec = uSunCol * (pow(sd, 900.0) * 4.0 + pow(sd, 90.0) * 0.15);
  vec3 body = mix(uDeep, uShallow, 0.35 + 0.3 * clamp(g.x * 4.0 + 0.5, 0.0, 1.0));
  vec3 col = mix(body, sky, clamp(fr, 0.0, 1.0)) + spec;
  col = mix(col, uHorizon, smoothstep(uFog.x, uFog.y, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const lin = (hex: number) => new Color(hex);

/**
 * Sky dome, image-based light, sun with a snapped shadow frustum, optional water and a ground
 * plane with a grid. Scaled to the content so a 10 m tank and a 2.5 km plant both look right.
 */
export class Environment {
  readonly sun: DirectionalLight;
  readonly ground: Mesh;
  private readonly hemi: HemisphereLight;
  private readonly sky: Mesh;
  private readonly skyMat: ShaderMaterial;
  private readonly grid: GridHelper;
  private water: Mesh | null = null;
  private waterMat: ShaderMaterial | null = null;
  private envMap: Texture | null = null;
  private radius = 50;
  private shExt = 0;
  private readonly lx = new Vector3().crossVectors(new Vector3(0, 1, 0), SUN_DIR).normalize();
  private readonly ly = new Vector3().crossVectors(SUN_DIR, this.lx);
  private readonly snapped = new Vector3();
  private readonly lastShadowTarget = new Vector3(Infinity, 0, 0);
  private lastShadowDist = 0;

  constructor(
    private readonly scene: Scene,
    renderer: WebGLRenderer,
  ) {
    scene.background = lin(PALETTE.bg0);
    scene.fog = new Fog(lin(PALETTE.skyHorizon), 2000, 12000);

    this.skyMat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: lin(PALETTE.skyZenith) },
        uHorizon: { value: lin(PALETTE.skyHorizon) },
        uSun: { value: SUN_DIR },
        uSunCol: { value: lin(PALETTE.sun) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new Mesh(new SphereGeometry(1, 32, 16), this.skyMat);
    this.sky.name = 'env:sky';
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.sky.raycast = () => undefined;
    scene.add(this.sky);

    this.hemi = new HemisphereLight(0xdfe8f4, 0x3a3730, 0.9);
    this.sun = new DirectionalLight(PALETTE.sun, 2.4);
    this.sun.name = 'env:sun';
    this.sun.castShadow = true;
    const size = Math.min(
      4096,
      (renderer.capabilities as Partial<WebGLRenderer['capabilities']> | undefined)
        ?.maxTextureSize ?? 4096,
    );
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.bias = -0.0004;
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

    this.buildEnvMap(renderer);
    this.setContentRadius(50);
  }

  /** Image-based light from a brighter copy of the sky; skipped where WebGL is unavailable. */
  private buildEnvMap(renderer: WebGLRenderer) {
    try {
      const pm = new PMREMGenerator(renderer);
      const envScene = new Scene();
      const mat = this.skyMat.clone();
      mat.uniforms.uZenith = { value: new Color(0.32, 0.38, 0.46) };
      mat.uniforms.uHorizon = { value: new Color(0.62, 0.64, 0.66) };
      envScene.add(new Mesh(new SphereGeometry(100, 32, 16), mat));
      this.envMap = pm.fromScene(envScene, 0, 1, 500).texture;
      this.scene.environment = this.envMap;
      this.scene.environmentIntensity = 0.55;
      pm.dispose();
      mat.dispose();
    } catch {
      this.envMap = null;
    }
  }

  /** Rescale fog, ground, grid and shadows to the content (radius of its bounding sphere). */
  setContentRadius(radius: number, centre = new Vector3()) {
    this.radius = Math.max(radius, 5);
    const r = this.radius;
    const fog = this.scene.fog as Fog;
    fog.near = r * 4;
    fog.far = r * 24;
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
    this.shExt = 0;
    this.lastShadowTarget.set(Infinity, 0, 0);
  }

  setGroundVisible(v: boolean) {
    this.ground.visible = v;
    this.grid.visible = v;
  }

  /** Animated water at height `level`, replacing a modelled sea. Null removes it. */
  setWater(level: number | null, centre: Vector3) {
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
      this.waterMat = new ShaderMaterial({
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uSun: { value: SUN_DIR },
          uSunCol: { value: lin(PALETTE.sun) },
          uZenith: { value: lin(PALETTE.skyZenith) },
          uHorizon: { value: lin(PALETTE.skyHorizon) },
          uDeep: { value: lin(PALETTE.water.deep) },
          uShallow: { value: lin(PALETTE.water.shallow) },
          uFog: { value: new Vector2(2000, 12000) },
        },
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
      });
      this.water = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.waterMat);
      this.water.name = 'env:water';
      this.water.renderOrder = -5;
      this.scene.add(this.water);
    }
    const size = this.radius * 60;
    this.water.scale.set(size, 1, size);
    this.water.position.set(centre.x, level, centre.z);
    const fog = this.scene.fog as Fog;
    (this.waterMat?.uniforms.uFog?.value as Vector2 | undefined)?.set(fog.near, fog.far);
  }

  get hasWater() {
    return this.water !== null;
  }

  /**
   * Per rendered frame. Keeps the sky around the camera, adjusts near/far, and re-aims the
   * shadow frustum in fixed steps snapped to whole texels so shadows stay still while orbiting
   * (port of the Al-Zour `placeShadow`). Returns true when the shadow map must be redrawn.
   */
  update(camera: PerspectiveCamera, target: Vector3, timeS: number): boolean {
    this.sky.position.copy(camera.position);
    if (this.waterMat?.uniforms.uTime) this.waterMat.uniforms.uTime.value = timeS;
    const d = camera.position.distanceTo(target);
    const near = Math.min(Math.max(d * 0.004, 0.01), 20);
    const far = Math.max(this.radius * 40, d * 8);
    if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    if (
      this.lastShadowTarget.distanceTo(target) > d * 0.02 ||
      Math.abs(this.lastShadowDist - d) > d * 0.05
    ) {
      this.lastShadowTarget.copy(target);
      this.lastShadowDist = d;
      return this.placeShadow(target, d);
    }
    return false;
  }

  private placeShadow(t: Vector3, d: number): boolean {
    const r = this.radius;
    const steps = [r / 16, r / 8, r / 4, r / 2, r * 1.1];
    const want = d * 0.85;
    const ext = steps.find((e) => e >= want) ?? r * 1.1;
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    const a = Math.round(t.dot(this.lx) / texel) * texel;
    const b = Math.round(t.dot(this.ly) / texel) * texel;
    const c = t.dot(SUN_DIR);
    this.snapped
      .set(0, 0, 0)
      .addScaledVector(this.lx, a)
      .addScaledVector(this.ly, b)
      .addScaledVector(SUN_DIR, c);
    const moved = !this.snapped.equals(this.sun.target.position);
    this.sun.target.position.copy(this.snapped);
    this.sun.position.copy(this.snapped).addScaledVector(SUN_DIR, r * 3);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    const changed = ext !== this.shExt;
    if (changed) {
      this.shExt = ext;
      sc.left = -ext;
      sc.right = ext;
      sc.top = ext;
      sc.bottom = -ext;
      sc.near = r * 0.05;
      sc.far = r * 6;
      sc.updateProjectionMatrix();
      this.sun.shadow.normalBias = texel * 1.5;
    }
    return moved || changed;
  }

  dispose() {
    this.setWater(null, new Vector3());
    this.scene.remove(this.sky, this.hemi, this.sun, this.sun.target, this.ground, this.grid);
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as MeshStandardMaterial).dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.sun.shadow.map?.dispose();
    this.envMap?.dispose();
  }
}

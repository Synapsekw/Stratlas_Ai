import {
  Color,
  DepthTexture,
  FloatType,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three';

/** Eight unit-circle neighbour offsets, as in Potree's EDL. */
export function edlNeighbours(n = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push(Math.round(Math.cos(a) * 1e6) / 1e6, Math.round(Math.sin(a) * 1e6) / 1e6);
  }
  return out;
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Port of Potree's edl.fs (BSD-2-Clause) reading a depth texture instead of log depth in alpha.
const fragmentShader = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uStrength;
uniform float uNear;
uniform float uFar;
uniform vec2 uNeighbours[8];
varying vec2 vUv;

float viewDepth(float d) {
#ifdef LOG_DEPTH
  return exp2(d * log2(uFar + 1.0)) - 1.0;
#else
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
#endif
}

float logDepthAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return d >= 1.0 ? 0.0 : log2(max(1e-6, viewDepth(d)));
}

void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 1.0) discard;
  float depth = log2(max(1e-6, viewDepth(d)));
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    float n = logDepthAt(vUv + uTexel * uRadius * uNeighbours[i]);
    if (n != 0.0) sum += max(0.0, depth - n);
  }
  float shade = exp(-(sum / 8.0) * 300.0 * uStrength);
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb * shade, 1.0);
  gl_FragDepth = d;
}
`;

/**
 * Eye-Dome Lighting without an engine post-process hook. The clouds live in a private scene. A
 * full-screen quad placed in the main scene renders that scene into a colour + depth target from
 * its `onBeforeRender` (nested render, the pattern three's Reflector uses), then composites the
 * shaded colour and writes the cloud depth to `gl_FragDepth`, so meshes and points occlude
 * correctly in the engine's own pass.
 */
export class EdlPass {
  readonly cloudScene = new Scene();
  readonly quad: Mesh<PlaneGeometry, ShaderMaterial>;
  private target: WebGLRenderTarget | null = null;
  private readonly size = new Vector2();
  private readonly prevClear = new Color();

  constructor(logDepth: boolean) {
    this.cloudScene.name = 'PointCloudEDL';
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: logDepth ? { LOG_DEPTH: '' } : {},
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uTexel: { value: new Vector2(1, 1) },
        uRadius: { value: 1.4 },
        uStrength: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uNeighbours: {
          value: edlNeighbours().reduce<Vector2[]>((acc, v, i, all) => {
            if (i % 2 === 0) acc.push(new Vector2(v, all[i + 1] ?? 0));
            return acc;
          }, []),
        },
      },
      depthTest: true,
      depthWrite: true,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), material);
    this.quad.name = 'PointCloudEDLComposite';
    this.quad.frustumCulled = false;
    this.quad.userData.helper = true;
    // the perf HUD (engine) counts the GPU memory of scenes rendered from here
    this.quad.userData.offscreen = [this.cloudScene];
    this.quad.raycast = () => undefined;
    this.quad.onBeforeRender = (renderer, _scene, camera) => {
      this.renderClouds(renderer, camera);
    };
  }

  set strength(v: number) {
    const u = this.quad.material.uniforms.uStrength;
    if (u) u.value = v;
  }

  private renderClouds(renderer: WebGLRenderer, camera: Camera): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    if (this.target?.width !== w || this.target.height !== h) {
      this.target?.dispose();
      const depthTexture = new DepthTexture(w, h);
      depthTexture.type = FloatType;
      this.target = new WebGLRenderTarget(w, h, { depthTexture, depthBuffer: true });
    }
    const u = this.quad.material.uniforms;
    const set = (k: string, v: unknown) => {
      const x = u[k];
      if (x) x.value = v;
    };
    set('tColor', this.target.texture);
    set('tDepth', this.target.depthTexture);
    (u.uTexel?.value as Vector2 | undefined)?.set(1 / w, 1 / h);
    const cam = camera as Camera & { near?: number; far?: number };
    set('uNear', cam.near ?? 0.1);
    set('uFar', cam.far ?? 1000);

    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClear);
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(this.cloudScene, camera);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.quad.geometry.dispose();
    this.quad.material.dispose();
    this.quad.removeFromParent();
  }
}

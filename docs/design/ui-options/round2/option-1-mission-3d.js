// Option 1: Mission. Fusion stages: real GLBs, real ortho, real clips projected from real poses.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const NS = 'http://www.w3.org/2000/svg';
const S = (tag, a = {}, p) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); p && p.appendChild(e); return e; };
const ACC = 'oklch(0.79 0.115 172)', OV = 'oklch(0.96 0.008 250)', OVD = 'oklch(0.96 0.008 250 / .55)', OVF = 'oklch(0.96 0.008 250 / .22)';
const SEVC = { 5: 'oklch(0.66 0.19 25)', 4: 'oklch(0.74 0.155 55)', 3: 'oklch(0.84 0.14 92)' };
const DEG = Math.PI / 180;

/* ---------- projective texturing (pinhole or f-theta) with depth-map occlusion ---------- */
const PROJ_GLSL = `
uniform float uProjOn; uniform sampler2D uVid; uniform mat4 uView; uniform mat4 uPinVP; uniform vec3 uCamPos;
uniform float uLens; uniform float uHalfH; uniform float uAspect; uniform sampler2D uDepth; uniform float uUseDepth;
uniform float uNear; uniform float uFar; uniform float uBias; uniform float uAlpha; uniform vec3 uEdge; uniform float uMaxD;
varying vec3 vPW; varying vec3 vNW;
float linD(float d){ float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
vec4 projSample(vec3 pw, vec3 nw){
  if (uProjOn < 0.5) return vec4(0.0);
  vec4 pv = uPinVP * vec4(pw, 1.0);
  vec3 pn = pv.xyz / pv.w;
  vec3 pc = (uView * vec4(pw, 1.0)).xyz;
  vec2 uv;
  if (uLens > 0.5) {
    float th = acos(clamp(-pc.z / length(pc), -1.0, 1.0));
    vec2 d = normalize(pc.xy + vec2(1e-6, 0.0));
    float r = th / uHalfH;
    uv = vec2(0.5 + 0.5 * r * d.x, 0.5 + 0.5 * r * d.y * uAspect);
  } else {
    if (pv.w <= 0.0) return vec4(0.0);
    uv = pn.xy * 0.5 + 0.5;
  }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  float dist = length(pc);
  if (dist > uMaxD) return vec4(0.0);
  float facing = dot(normalize(nw), normalize(uCamPos - pw));
  if (facing <= 0.0) return vec4(0.0);

  if (uUseDepth > 0.5 && pv.w > 0.0 && abs(pn.x) < 1.0 && abs(pn.y) < 1.0) {
    float sd = linD(texture2D(uDepth, pn.xy * 0.5 + 0.5).r);
    if (-pc.z - uBias > sd) return vec4(0.0);
  }
  vec3 vc = texture2D(uVid, uv).rgb;
  float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float edge = max(1.0 - smoothstep(0.0, 0.006, e), 1.0 - smoothstep(0.0, uMaxD * 0.004, uMaxD - dist));
  return vec4(mix(vc, uEdge, edge), uAlpha * smoothstep(0.08, 0.32, facing));
}`;

function makeProjUniforms(near, far, bias) {
  const dt = new THREE.DepthTexture(1024, 576); dt.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(1024, 576, { depthTexture: dt, depthBuffer: true });
  return {
    rt,
    U: {
      uProjOn: { value: 0 }, uVid: { value: null }, uView: { value: new THREE.Matrix4() }, uPinVP: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uLens: { value: 0 }, uHalfH: { value: 57 * DEG }, uAspect: { value: 16 / 9 },
      uDepth: { value: dt }, uUseDepth: { value: 1 }, uNear: { value: near }, uFar: { value: far }, uBias: { value: bias },
      uAlpha: { value: 0.94 }, uMaxD: { value: 1e6 }, uEdge: { value: new THREE.Vector3(0.36, 0.84, 0.70) },
    },
  };
}
function injectProj(mat, U) {
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPW; varying vec3 vNW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvPW = (modelMatrix * vec4(transformed, 1.0)).xyz; vNW = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PROJ_GLSL)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n{ vec4 pj = projSample(vPW, gl_FrontFacing ? vNW : -vNW); gl_FragColor.rgb = mix(gl_FragColor.rgb, pj.rgb, pj.a); }');
  };
  mat.customProgramCacheKey = () => 'proj1';
  mat.needsUpdate = true;
}
const GROUND_VS = `varying vec2 vUv; varying vec3 vPW; varying vec3 vNW;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vPW = w.xyz; vNW = vec3(0.0, 1.0, 0.0); gl_Position = projectionMatrix * viewMatrix * w; }`;

/* ---------- helpers ---------- */
function makeStage(canvas, host, near, far) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color().setRGB(0.058, 0.069, 0.082, THREE.SRGBColorSpace));
  const camera = new THREE.PerspectiveCamera(38, 1, near, far);
  camera.layers.enable(1);
  const scene = new THREE.Scene();
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  const size = { w: 1, h: 1 };
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    size.w = w; size.h = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host); resize();
  return { renderer, camera, scene, controls, size };
}
// blob URLs keep clips seekable and loopable even when the static server ignores Range requests
const blobCache = {};
function setVideoSrc(v, src) {
  (blobCache[src] ||= fetch(src).then(r => r.blob()).then(b => URL.createObjectURL(b)))
    .then(u => { v.addEventListener('canplay', () => { if (v.dataset.want === 'play') v.play().catch(() => {}); }, { once: true }); v.src = u; });
}
function makeVideo(vframe, src, poster) {
  let v = vframe.querySelector('video');
  if (!v) { v = document.createElement('video'); vframe.prepend(v); }
  Object.assign(v, { muted: true, loop: true, playsInline: true, autoplay: false, preload: 'auto', crossOrigin: 'anonymous' });
  v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
  v.poster = poster; setVideoSrc(v, src);
  const tex = new THREE.VideoTexture(v); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  // paused seeks do not always present a new frame callback; push the frame explicitly
  for (const ev of ['seeked', 'loadeddata', 'canplay']) v.addEventListener(ev, () => { tex.needsUpdate = true; });
  return { v, tex };
}
// the current frame shown on the frustum's image plane, as photogrammetry tools draw camera stations
function makeFramePlane(v, dist, hfov, aspect) {
  const t2 = new THREE.VideoTexture(v); t2.colorSpace = THREE.SRGBColorSpace; t2.minFilter = THREE.LinearFilter; t2.generateMipmaps = false;
  for (const ev of ['seeked', 'loadeddata', 'canplay']) v.addEventListener(ev, () => { t2.needsUpdate = true; });
  const w = 2 * dist * Math.tan(hfov / 2 * DEG), h = w / aspect;
  const geo = new THREE.PlaneGeometry(w, h);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t2, transparent: true, opacity: 0.94, side: THREE.DoubleSide, depthWrite: false }));
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(0.36, 0.84, 0.70, THREE.SRGBColorSpace) }));
  m.add(edge); m.layers.set(1); edge.layers.set(1); m.renderOrder = 3;
  m.userData = { dist, w, h };
  m.place = (pos, q) => { m.position.copy(pos).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(q), dist); m.quaternion.copy(q); m.updateMatrixWorld(); };
  m.corners = (pos, q) => [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]].map(([x, y]) => new THREE.Vector3(x, y, -dist).applyQuaternion(q).add(pos));
  return m;
}
function samplePose(samples, t) {
  const f = Math.max(0, Math.min(samples.length - 1.001, t * 10)); const i = Math.floor(f), k = f - i;
  const a = samples[i], b = samples[i + 1] || a;
  const pos = new THREE.Vector3().fromArray(a.pos).lerp(new THREE.Vector3().fromArray(b.pos), k);
  const q = new THREE.Quaternion().fromArray(a.q).slerp(new THREE.Quaternion().fromArray(b.q), k);
  return { pos, q, a, b, k };
}
const toScreen = (v, cam, size) => {
  const p = v.clone().applyMatrix4(cam.matrixWorldInverse); if (p.z > -cam.near) return null;
  const n = v.clone().project(cam); return [(n.x + 1) / 2 * size.w, (1 - n.y) / 2 * size.h];
};
function drawCompass(svg, headingDeg, label = 'N') {
  svg.innerHTML = '';
  S('circle', { cx: 32, cy: 32, r: 27, fill: 'oklch(0.13 0.01 250 / .78)', stroke: 'oklch(0.96 0.008 250 / .28)' }, svg);
  const g = S('g', { transform: `rotate(${-headingDeg} 32 32)` }, svg);
  for (let a = 0; a < 360; a += 15) {
    const maj = a % 90 === 0, r1 = maj ? 20 : 23;
    S('line', { x1: 32, y1: 32 - 27, x2: 32, y2: 32 - r1, stroke: maj ? OV : OVF, 'stroke-width': 1, transform: `rotate(${a} 32 32)` }, g);
  }
  S('path', { d: 'M32 9 L36 19 L32 17 L28 19 Z', fill: ACC }, g);
  const t = S('text', { x: 32, y: 30, 'text-anchor': 'middle', fill: OV, style: 'font:600 9px var(--f-mono)', transform: `rotate(${headingDeg} 32 27)` }, g); t.textContent = label;
  const h = S('text', { x: 32, y: 44, 'text-anchor': 'middle', fill: OVD, style: 'font:500 9px var(--f-mono)' }, svg);
  h.textContent = String(Math.round((headingDeg % 360 + 360) % 360)).padStart(3, '0') + '°';
}
function labelStack(svg, x, y, lines, opts = {}) {
  // tactical entity label: leader up-right, then a stacked readout
  const dx = opts.dx ?? 34, dy = opts.dy ?? -40, w = opts.w ?? 150, lh = 14;
  const lx = x + dx, ly = y + dy;
  S('path', { d: `M${x + 6},${y - 6} L${lx},${ly} L${lx + 8},${ly}`, stroke: opts.color || OV, 'stroke-width': 1, fill: 'none', opacity: 0.8 }, svg);
  const h = lines.length * lh + 10;
  S('rect', { x: lx + 8, y: ly - 12, width: w, height: h, fill: 'oklch(0.13 0.01 250 / .82)', stroke: 'oklch(0.96 0.008 250 / .25)' }, svg);
  S('rect', { x: lx + 8, y: ly - 12, width: 2, height: h, fill: opts.color || OV }, svg);
  lines.forEach((ln, i) => {
    const t = S('text', { x: lx + 16, y: ly + 2 + i * lh, fill: i === 0 ? (opts.color || OV) : OV, style: `font:${i === 0 ? 600 : 400} 10.5px var(--f-mono);letter-spacing:.02em` }, svg);
    if (Array.isArray(ln)) { const a = S('tspan', { fill: OVD }, t); a.textContent = ln[0] + ' '; const b = S('tspan', {}, t); b.textContent = ln[1]; }
    else t.textContent = ln;
  });
}
function droneGlyph(svg, x, y, color = ACC) {
  S('circle', { cx: x, cy: y, r: 10, fill: 'none', stroke: color, 'stroke-opacity': 0.35 }, svg);
  S('rect', { x: x - 5, y: y - 5, width: 10, height: 10, fill: 'oklch(0.13 0.01 250)', stroke: color, 'stroke-width': 1.5, transform: `rotate(45 ${x} ${y})` }, svg);
  S('circle', { cx: x, cy: y, r: 1.8, fill: color }, svg);
}
const polyD = pts => pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
function niceScale(mpp, target = 100) { const raw = mpp * target; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = [1, 2, 5, 10].map(k => k * p).reduce((a, b) => Math.abs(b - raw) < Math.abs(a - raw) ? b : a); return [n, n / mpp]; }

/* UTM zone 39N inverse, for cursor readouts */
function utmToLL(E, N, zone = 39) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N, M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6) / Math.cos(p1);
  return [lat / DEG, (zone * 6 - 183) + lon / DEG];
}
const PL2UTM = (E, N) => [244338.07 + E * 0.951057 + N * 0.309017, 3179515.72 - E * 0.309017 + N * 0.951057];

/* =====================================================================================
   AL-ZOUR: plant GLB on real ortho + dark street map, DJI_0789 projected from its path
   ===================================================================================== */
export function initAlZour(o) {
  const { renderer, camera, scene, controls, size } = makeStage(o.canvas, o.stage, 2, 9000);
  renderer.localClippingEnabled = false;
  camera.position.set(0, 690, 450); controls.target.set(20, 0, -90); controls.update();
  controls.maxPolarAngle = 85 * DEG;
  scene.add(new THREE.HemisphereLight(0xe6eef8, 0x262a30, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.1); sun.position.set(-600, 900, 500); scene.add(sun);

  const { rt, U } = makeProjUniforms(5, 4000, 1.5);
  U.uMaxD.value = 560;
  const depthCam = new THREE.PerspectiveCamera(48.9, 16 / 9, 5, 4000);
  const depthMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

  const L = new THREE.TextureLoader();
  // dark-styled OSM street map (recoloured in shader)
  const street = L.load(o.assets + 'streetmap.jpg'); street.anisotropy = 8;
  const streetMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uMap: { value: street }, uBg: { value: new THREE.Vector3(0.058, 0.069, 0.082) } },
    vertexShader: GROUND_VS,
    fragmentShader: PROJ_GLSL + `
      uniform sampler2D uMap; uniform vec3 uBg; varying vec2 vUv;
      void main(){
        vec3 c = texture2D(uMap, vUv).rgb; float lum = dot(c, vec3(.3, .59, .11)); float bl = c.b - c.r;
        float sea = smoothstep(.10, .28, bl);
        vec3 col = mix(vec3(.118, .128, .142), vec3(.142, .152, .168), smoothstep(.0, .05, bl) * (1. - sea));
        col = mix(col, vec3(.062, .082, .106), sea);
        col = mix(col, vec3(.25, .27, .30), smoothstep(.955, .995, lum) * (1. - sea));
        float d = length(vPW.xz - vec2(150., -60.)); col = mix(col, uBg, smoothstep(1300., 3000., d));
        vec4 pj = projSample(vPW, vNW); col = mix(col, pj.rgb, pj.a);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  const sm = new THREE.Mesh(new THREE.PlaneGeometry(6600, 6540), streetMat);
  sm.rotation.x = -Math.PI / 2; sm.position.set(200, -0.5, -230); scene.add(sm);

  // real orthomosaic, placed by its 4 corners
  const ortho = L.load(o.assets + 'ortho.jpg'); ortho.anisotropy = 8;
  const C = { tl: [-1030.75, -212.79], tr: [1044.35, -886.99], br: [1447.85, 354.92], bl: [-627.25, 1029.13] };
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.Float32BufferAttribute([...[C.tl[0], 0.3, C.tl[1]], ...[C.tr[0], 0.3, C.tr[1]], ...[C.br[0], 0.3, C.br[1]], ...[C.bl[0], 0.3, C.bl[1]]], 3));
  og.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  og.setIndex([0, 3, 1, 1, 3, 2]);
  const orthoMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uMap: { value: ortho } }, vertexShader: GROUND_VS,
    fragmentShader: PROJ_GLSL + `
      uniform sampler2D uMap; varying vec2 vUv;
      void main(){
        vec3 c = texture2D(uMap, vUv).rgb;
        if (distance(c, vec3(38., 44., 52.) / 255.) < .035) discard;
        vec3 col = mix(vec3(dot(c, vec3(.3, .59, .11))), c, .82) * .86;
        vec4 pj = projSample(vPW, vNW); col = mix(col, pj.rgb, pj.a);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  scene.add(new THREE.Mesh(og, orthoMat));

  // subtle 100 m coordinate grid, true-north aligned (plant grid is rotated 18 deg)
  {
    const pts = []; const R = 1600;
    for (let i = -R; i <= R; i += 100) { pts.push(i, 0, -R, i, 0, R, -R, 0, i, R, 0, i); }
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }));
    grid.position.set(150, 1.2, -60); grid.rotation.y = 18 * DEG; grid.layers.set(1); scene.add(grid);
  }

  // video + path
  const { v, tex } = makeVideo(o.vframe, o.assets + 'clip_dji0789_tanks.mp4', o.assets + 'clip_dji0789_tanks_poster.jpg');
  U.uVid.value = tex;
  const framePlane = makeFramePlane(v, 52, 78, 16 / 9); scene.add(framePlane);
  let path = null, ghost = null;
  fetch(o.assets + 'clip_dji0789_tanks_path.json').then(r => r.json()).then(j => { path = j; U.uProjOn.value = 1; });
  fetch(o.assets + 'clip_dji0665_overview_path.json').then(r => r.json()).then(j => { ghost = j; });

  // plant model
  const callouts = [];
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(o.assets + 'plant.glb', g => {
    const root = g.scene;
    root.traverse(n => {
      if (n.name === 'Site_Terrain') n.visible = false;
      if (n.isMesh) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        if (mats.some(m => /^(Sea|Ground|Ground_Mainland|Slope|Water_Pit)$/.test(m.name))) { n.visible = false; return; }
        mats.forEach(m => { if (!m.userData.pj) { m.userData.pj = 1; if (m.name === 'Zone_Line') m.visible = false; injectProj(m, U); } });
      }
    });
    scene.add(root);
    const tags = [['20-T-0001', 'LNG storage tank'], ['20-T-0002', 'LNG storage tank', true], ['20-T-0003', 'LNG storage tank'], ['60-A-0001', 'Flare package'], ['10-Z-0001A', 'Jetty I unloading arm']];
    for (const [tag, name, sel] of tags) {
      const node = root.getObjectByName(tag); if (!node) continue;
      const b = new THREE.Box3().setFromObject(node); const c = b.getCenter(new THREE.Vector3());
      callouts.push({ tag, name, sel, top: new THREE.Vector3(c.x, b.max.y, c.z), base: new THREE.Vector3(c.x, 0.3, c.z), r: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 });
    }
    o.loading.classList.add('done');
  }, undefined, e => { console.error(e); o.loading.textContent = 'plant.glb failed to load'; });

  // cursor readout via ground plane
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  o.canvas.addEventListener('pointermove', e => {
    const r = o.canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    const E = hit.x + 1300, N = 450 - hit.z; const [ue, un] = PL2UTM(E, N); const [lat, lon] = utmToLL(ue, un);
    o.onCursor && o.onCursor(`${lat.toFixed(5)} N  ${lon.toFixed(5)} E<br>Plant E ${E.toFixed(1)}  N ${N.toFixed(1)}`);
  });

  const ovl = o.ovl; let active = false, raf = 0, playing = true;
  const rangeCentre = new THREE.Vector3(146, 0.5, -105.4);
  const groundCircle = (c, r, n = 96) => { const a = []; for (let i = 0; i <= n; i++) { const t = i / n * Math.PI * 2; a.push(new THREE.Vector3(c.x + Math.cos(t) * r, c.y, c.z + Math.sin(t) * r)); } return a; };
  const trueDir = az => new THREE.Vector3(Math.sin((az - 18) * DEG), 0, -Math.cos((az - 18) * DEG)); // az clockwise from true north

  function overlay(pose) {
    ovl.innerHTML = '';
    const P = v3 => toScreen(v3, camera, size);
    // range rings + bearing ticks around the selected tank
    const sel = callouts.find(c => c.sel);
    if (sel) {
      const c = sel.base;
      S('path', { d: polyD(groundCircle(c, 46.75).map(P)), fill: 'oklch(0.79 0.115 172 / .06)', stroke: ACC, 'stroke-width': 1.25 }, ovl);
      S('path', { d: polyD(groundCircle(c, 86.75).map(P)), fill: 'none', stroke: ACC, 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.85 }, ovl);
      for (const r of [250]) S('path', { d: polyD(groundCircle(c, r, 160).map(P)), fill: 'none', stroke: OVF, 'stroke-width': 1 }, ovl);
      for (let a = 0; a < 360; a += 10) {
        const d = trueDir(a), maj = a % 30 === 0;
        const p1 = P(c.clone().addScaledVector(d, 250)), p2 = P(c.clone().addScaledVector(d, maj ? 262 : 256));
        if (p1 && p2) S('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: maj ? OVD : OVF }, ovl);
        if (maj) { const pl = P(c.clone().addScaledVector(d, 276)); if (pl) { const t = S('text', { x: pl[0], y: pl[1] + 3, 'text-anchor': 'middle', fill: a === 0 ? ACC : OVD, style: 'font:500 9.5px var(--f-mono)' }, ovl); t.textContent = a === 0 ? 'TN' : String(a).padStart(3, '0'); } }
      }
      const lb = P(c.clone().addScaledVector(trueDir(205), 86.75));
      if (lb) { const t = S('text', { x: lb[0] - 6, y: lb[1] + 14, 'text-anchor': 'end', fill: ACC, style: 'font:500 10px var(--f-mono)' }, ovl); t.textContent = '40 m BUFFER'; }
      for (const r of [250]) { const p = P(c.clone().addScaledVector(trueDir(160), r)); if (p) { const t = S('text', { x: p[0] + 5, y: p[1] + 12, fill: OVD, style: 'font:400 9.5px var(--f-mono)' }, ovl); t.textContent = `${r} m`; } }
    }
    // ghost path of the overview clip
    if (ghost) S('path', { d: polyD(ghost.samples.map(s => P(new THREE.Vector3().fromArray(s.pos)))), fill: 'none', stroke: OVF, 'stroke-width': 1.25, 'stroke-dasharray': '6 4' }, ovl);
    // callouts with leader lines
    callouts.forEach((c, i) => {
      const a = P(c.top); if (!a || a[0] < -50 || a[0] > size.w + 50 || a[1] < 40 || a[1] > size.h) return;
      const col = c.sel ? ACC : OV;
      const up = c.sel ? 64 : 34 + (i % 3) * 10, lx = a[0] + (c.sel ? 22 : 14), ly = a[1] - up;
      S('path', { d: `M${a[0]},${a[1]} L${lx},${ly} L${lx + 10},${ly}`, stroke: col, 'stroke-width': 1, fill: 'none', opacity: c.sel ? 1 : 0.6 }, ovl);
      S('rect', { x: a[0] - 3, y: a[1] - 3, width: 6, height: 6, fill: c.sel ? ACC : 'oklch(0.13 0.01 250)', stroke: col, 'stroke-width': 1.25 }, ovl);
      const w = c.sel ? 168 : 132, h = c.sel ? 46 : 30;
      S('rect', { x: lx + 10, y: ly - 15, width: w, height: h, fill: 'oklch(0.13 0.01 250 / .84)', stroke: c.sel ? ACC : 'oklch(0.96 0.008 250 / .22)' }, ovl);
      const t1 = S('text', { x: lx + 18, y: ly - 1, fill: c.sel ? ACC : OV, style: 'font:600 10.5px var(--f-mono)' }, ovl); t1.textContent = c.tag;
      const t2 = S('text', { x: lx + 18, y: ly + 11, fill: OVD, style: 'font:400 10px var(--f-ui)' }, ovl); t2.textContent = c.name;
      if (c.sel) { const t3 = S('text', { x: lx + 18, y: ly + 24, fill: OV, style: 'font:400 10px var(--f-mono)' }, ovl); t3.textContent = '3 ISSUES · 4/25 CLIPS'; }
    });
    if (!path || !pose) return;
    // ground track, flight path with time ticks
    const sp = path.samples.map(s => new THREE.Vector3().fromArray(s.pos));
    S('path', { d: polyD(sp.map(p => P(new THREE.Vector3(p.x, 0.5, p.z)))), fill: 'none', stroke: OVD, 'stroke-width': 1, 'stroke-dasharray': '2 3' }, ovl);
    S('path', { d: polyD(sp.map(P)), fill: 'none', stroke: OV, 'stroke-width': 1.5, opacity: 0.9 }, ovl);
    for (let i = 0; i < sp.length; i += 10) {
      const a = P(sp[i]), b = P(sp[Math.min(i + 1, sp.length - 1)]); if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, len = i % 50 === 0 ? 7 : 4;
      S('line', { x1: a[0] - nx * len, y1: a[1] - ny * len, x2: a[0] + nx * len, y2: a[1] + ny * len, stroke: OV, 'stroke-width': 1 }, ovl);
      if (i % 50 === 0) { const t = S('text', { x: a[0] + nx * 12, y: a[1] + ny * 12 + 3, fill: OVD, 'text-anchor': 'middle', style: 'font:400 9.5px var(--f-mono)' }, ovl); t.textContent = `11:${String(16 + i / 10).padStart(2, '0')}`; }
    }
    // frustum to ground footprint
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      const d = new THREE.Vector3(x, y, 0.5).unproject(depthCam).sub(depthCam.position).normalize();
      if (d.y >= -0.01) return null; const t = -depthCam.position.y / d.y; return depthCam.position.clone().addScaledVector(d, Math.min(t, U.uMaxD.value));
    });
    const dp = P(pose.pos);
    const pc = framePlane.corners(pose.pos, pose.q);
    corners.forEach((c, i) => { if (!c) return; const a = P(pc[i]), q = P(c); if (a && q) S('line', { x1: a[0], y1: a[1], x2: q[0], y2: q[1], stroke: ACC, 'stroke-width': 1, opacity: 0.35, 'stroke-dasharray': '3 3' }, ovl); });
    pc.forEach(c => { const q = P(c); if (q && dp) S('line', { x1: dp[0], y1: dp[1], x2: q[0], y2: q[1], stroke: ACC, 'stroke-width': 1, opacity: 0.8 }, ovl); });
    // altitude stalk + drone entity + label stack
    const gp = P(new THREE.Vector3(pose.pos.x, 0.5, pose.pos.z));
    if (dp && gp) {
      S('line', { x1: dp[0], y1: dp[1], x2: gp[0], y2: gp[1], stroke: ACC, 'stroke-width': 1, 'stroke-dasharray': '2 2' }, ovl);
      S('path', { d: `M${gp[0] - 5},${gp[1]} h10 M${gp[0]},${gp[1] - 3} v6`, stroke: ACC }, ovl);
      droneGlyph(ovl, dp[0], dp[1]);
      const s = pose.a, spd = pose.spd;
      labelStack(ovl, dp[0], dp[1], ['UAV-1 · M3 CINE', ['ALT', `${(pose.pos.y).toFixed(1)} m AGL`], ['SPD', `${spd.toFixed(1)} m/s`], ['GBL', `${s.gimbal_pitch_deg.toFixed(1)}° / ${String(Math.round((s.az_deg + 18) % 360)).padStart(3, '0')}°`], ['TC', pose.tc]], { color: ACC, dx: 30, dy: -64, w: 152 });
    }
  }

  let last = performance.now(), hdgPrev = -1;
  function frame(now) {
    raf = active ? requestAnimationFrame(frame) : 0;
    controls.update();
    let pose = null;
    if (path) {
      const t = v.currentTime || 0;
      const p = samplePose(path.samples, t);
      depthCam.position.copy(p.pos); depthCam.quaternion.copy(p.q); depthCam.updateMatrixWorld(); depthCam.updateProjectionMatrix();
      U.uView.value.copy(depthCam.matrixWorldInverse);
      U.uPinVP.value.multiplyMatrices(depthCam.projectionMatrix, depthCam.matrixWorldInverse);
      U.uCamPos.value.copy(p.pos);
      framePlane.place(p.pos, p.q);
      const nb = samplePose(path.samples, Math.min(t + 0.2, 10.9)).pos;
      const ct = 15 * 3600 + 11 * 60 + 11 + 5 + t;
      const tc = `${String(Math.floor(ct / 3600)).padStart(2, '0')}:${String(Math.floor(ct % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(ct % 60)).padStart(2, '0')}:${String(Math.floor((t % 1) * 30)).padStart(2, '0')}`;
      pose = { ...p, spd: nb.distanceTo(p.pos) / 0.2, tc };
      // depth pass from the drone camera
      scene.overrideMaterial = depthMat; renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, depthCam);
      scene.overrideMaterial = null; renderer.setRenderTarget(null);
      o.onTime && o.onTime(t, { alt: p.pos.y, pitch: p.a.gimbal_pitch_deg, az: (p.a.az_deg + 18) % 360 });
    }
    renderer.render(scene, camera);
    overlay(pose);
    // compass and scale
    const dir = controls.target.clone().sub(camera.position);
    const hdg = (Math.atan2(dir.x, -dir.z) / DEG + 18 + 360) % 360;
    if (Math.abs(hdg - hdgPrev) > 0.2) { drawCompass(o.compass, hdg, 'N'); hdgPrev = hdg; }
    const mpp = 2 * camera.position.distanceTo(controls.target) * Math.tan(camera.fov * DEG / 2) / size.h;
    const [m, px] = niceScale(mpp, 100); o.onScale && o.onScale(m, Math.round(px));
  }
  function setActive(on) {
    active = on;
    v.dataset.want = on && playing ? 'play' : '';
    if (on) { if (playing) v.play().catch(() => {}); if (!raf) raf = requestAnimationFrame(frame); }
    else { v.pause(); }
  }
  return { setActive, togglePlay() { playing = !playing; playing ? v.play().catch(() => {}) : v.pause(); return playing; } };
}

/* =====================================================================================
   HCl TANK: tank GLB, LiDAR cloud, Elios clip projected with the f-theta model
   ===================================================================================== */
export function initHCl(o) {
  const { renderer, camera, scene, controls, size } = makeStage(o.canvas, o.stage, 0.05, 400);
  renderer.localClippingEnabled = true;
  camera.fov = 40; camera.position.set(8.4, 15.4, -8.4); controls.target.set(0.3, 7.4, -0.3); controls.update();
  scene.add(new THREE.HemisphereLight(0xe8eef6, 0x2a2e34, 1.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(8, 14, 10); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.5); fill.position.set(-6, 3, -8); scene.add(fill);

  const section = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.05); // keep the west half (z <= 0.05)
  let clips = [];

  const { rt, U } = makeProjUniforms(0.05, 60, 0.04);
  U.uLens.value = 1; U.uHalfH.value = 57 * DEG; U.uAspect.value = 16 / 9;
  // pinhole frustum that encloses the f-theta image, used only for the occlusion depth map
  const depthCam = new THREE.PerspectiveCamera(2 * Math.atan(1.12) / DEG, 1.95 / 1.12, 0.05, 60);
  const depthMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, clippingPlanes: clips });

  // polar grid around the tank axis: 1 m rings, 30 degree spokes
  const polar = new THREE.PolarGridHelper(6, 12, 6, 96, 0x8a96a8, 0x5a6472);
  polar.material.transparent = true; polar.material.opacity = 0.22; polar.material.depthWrite = false; polar.position.y = -0.31; polar.layers.set(1); scene.add(polar);

  const tankMeshes = []; let cloudPts = null;
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(o.assets + 'tank.glb', g => {
    g.scene.traverse(n => {
      if (!n.isMesh) return; tankMeshes.push(n);
      const m = n.material;
      // see-through access steel must not occlude the projection: keep it out of the depth pass
      if (/Grating|Handrail|Ladder/.test(m.name)) n.layers.set(1); if (m.userData.pj) return; m.userData.pj = 1;
      m.clippingPlanes = clips; m.clipShadows = true; m.side = THREE.DoubleSide;
      if (m.name === 'Rubber_Lining' || m.name === 'Weld_Seam_Lined') m.color.setRGB(0.045, 0.048, 0.055);
      // graphite CAD shading, so the draped video frame reads as imagery, not paint
      if (/Paint_Shell|Reinforcing_Pad|Base_Plate|Steel_Flange|Blind_Flange|Weld_Seam$/.test(m.name)) { m.color.setRGB(0.050, 0.056, 0.066); m.metalness = 0.2; m.roughness = 0.7; }
      injectProj(m, U);
    });
    scene.add(g.scene);
    loaded.glb = true; checkLoaded(); computeF12();
  }, undefined, e => { console.error(e); o.loading.textContent = 'tank.glb failed to load'; });

  // LiDAR cloud
  fetch(o.assets + 'cloud.bin').then(r => r.arrayBuffer()).then(buf => {
    const N = 280000, q = new Int16Array(buf, 0, N * 3), inten = new Uint8Array(buf, N * 6, N);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const lo = new THREE.Color().setRGB(0.02, 0.05, 0.06), hi = new THREE.Color().setRGB(0.20, 0.55, 0.48), c = new THREE.Color();
    for (let k = 0; k < N; k++) {
      pos[k * 3] = q[k * 3] * 0.001; pos[k * 3 + 1] = q[k * 3 + 1] * 0.001; pos[k * 3 + 2] = q[k * 3 + 2] * 0.001;
      c.copy(lo).lerp(hi, Math.pow(inten[k] / 255, 0.8)); col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // x-ray: the interior LiDAR shows through the shell until a section cut opens the tank
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.012, vertexColors: true, sizeAttenuation: true, clippingPlanes: clips, transparent: true, opacity: 0.11, depthWrite: false, depthTest: false }));
    pts.layers.set(1); pts.renderOrder = 2; scene.add(pts); cloudPts = pts;
    loaded.cloud = true; checkLoaded();
  });
  const loaded = {};
  const checkLoaded = () => { if (loaded.glb && loaded.cloud) o.loading.classList.add('done'); };

  // clips and poses
  const CLIPS = { f110: { mp4: 'clip_f110_external.mp4', pose: 'clip_f110_external_pose.json', poster: 'clip_f110_external_poster.jpg', freeze: 5.6 },
                  f108: { mp4: 'clip_f108_roof.mp4', pose: 'clip_f108_roof_pose.json', poster: 'clip_f108_roof_poster.jpg' } };
  let clipKey = 'f110', poses = {}, playing = false;
  const { v, tex } = makeVideo(o.vframe, o.assets + CLIPS.f110.mp4, o.assets + CLIPS.f110.poster);
  U.uVid.value = tex;
  const framePlane = makeFramePlane(v, 0.6, 96, 16 / 9); scene.add(framePlane);
  Promise.all(Object.entries(CLIPS).map(([k, c]) => fetch(o.assets + c.pose).then(r => r.json()).then(j => { poses[k] = j; }))).then(() => { U.uProjOn.value = 1; computeF12(); });
  const freezeAt = t => { v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true }); };
  freezeAt(CLIPS.f110.freeze);

  // the box being drawn on the video frame (normalised image coords, v from top)
  const BOX = { u0: 0.406, v0: 0.208, u1: 0.516, v1: 0.347 };
  let f12 = null;
  function computeF12() {
    if (f12 || !tankMeshes.length || !poses.f110) return;
    const p = samplePose(poses.f110.samples, CLIPS.f110.freeze);
    const uc = (BOX.u0 + BOX.u1) / 2, vc = (BOX.v0 + BOX.v1) / 2;
    const xn = (uc - 0.5) * 2, yn = (0.5 - vc) * 2 / (16 / 9), r = Math.hypot(xn, yn), th = r * 57 * DEG;
    const d = new THREE.Vector3(Math.sin(th) * xn / r, Math.sin(th) * yn / r, -Math.cos(th)).applyQuaternion(p.q).normalize();
    const rc = new THREE.Raycaster(p.pos, d, 0, 30); const hits = rc.intersectObjects(tankMeshes, false);
    if (!hits.length) return;
    const h = hits[0]; const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    f12 = { pos: h.point.clone(), n };
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.95, 0.55, 0.2), side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
    ring.position.copy(h.point).addScaledVector(n, 0.01); ring.lookAt(h.point.clone().add(n)); ring.layers.set(1); ring.renderOrder = 5; scene.add(ring);
      }

  // issue anchors (real for F01, F02, F04, F05, F06, F09; others placed from bearing and height)
  const REAL = { F01: [1.165, 0.035, -0.38], F02: [1.564, 8.477, -0.342], F04: [-0.131, 8.693, -0.029], F05: [-0.759, 8.559, 0.393], F06: [-1.067, 8.282, 1.332], F09: [1.972, 4.738, 0.26] };
  const anchors = o.issues.filter(i => i.id !== 'F12').map(i => {
    let p = REAL[i.id]; if (!p) { const b = +i.brg * DEG, r = +i.el < 0.5 ? 1.92 : 1.99; p = [Math.cos(b) * r, +i.el, Math.sin(b) * r]; }
    return { id: i.id, sev: i.sev, pos: new THREE.Vector3().fromArray(p) };
  });
  let focus = 'F12';

  // drone eye toggle
  let eye = false; const saved = { p: new THREE.Vector3(), t: new THREE.Vector3() };
  const eyeBtn = document.getElementById('hcEyeBtn');
  eyeBtn && eyeBtn.addEventListener('click', () => {
    eye = !eye; eyeBtn.setAttribute('aria-pressed', eye);
    if (eye) { saved.p.copy(camera.position); saved.t.copy(controls.target); camera.fov = 75; controls.enabled = false; }
    else { camera.position.copy(saved.p); controls.target.copy(saved.t); camera.fov = 40; controls.enabled = true; camera.quaternion.identity(); controls.update(); }
    camera.updateProjectionMatrix();
  });
  const secBtn = document.getElementById('hcSectionBtn');
  secBtn && secBtn.addEventListener('click', () => {
    const on = secBtn.getAttribute('aria-pressed') !== 'true'; secBtn.setAttribute('aria-pressed', on);
    clips.length = 0; if (on) clips.push(section);
    if (cloudPts) { const m = cloudPts.material; m.depthTest = on; m.opacity = on ? 0.85 : 0.11; m.needsUpdate = true; }
    scene.traverse(n => { if (n.material) n.material.needsUpdate = true; }); depthMat.needsUpdate = true;
  });
  const cloudBtn = document.getElementById('hcCloudBtn');
  cloudBtn && cloudBtn.addEventListener('click', () => { const on = cloudBtn.getAttribute('aria-pressed') !== 'true'; cloudBtn.setAttribute('aria-pressed', on); scene.traverse(n => { if (n.isPoints) n.visible = on; }); });

  // annotation drawing on the video frame
  const draw = o.draw; let drawStart = 0; // drawStart kept for play/clip resets
  function renderDraw() {
    if (clipKey !== 'f110') { if (draw.innerHTML) draw.innerHTML = ''; if (o.strip) o.strip.innerHTML = ''; draw.dataset.k = ''; return; }
    const W = o.vframe.clientWidth, H = o.vframe.clientHeight;
    const show = Math.abs((v.currentTime || 0) - CLIPS.f110.freeze) < 0.08 && v.paused;
    if (!show) { if (draw.innerHTML) draw.innerHTML = ''; if (o.strip) o.strip.innerHTML = ''; draw.dataset.k = ''; return; }
    const key = `${W}|${H}`; if (draw.dataset.k === key) return; draw.dataset.k = key;
    // drawn once per size: the box just released at its corner handle, with the new-issue form attached
    const x0 = BOX.u0 * W, y0 = BOX.v0 * H, x1 = BOX.u1 * W, y1 = BOX.v1 * H;
    const pxW = Math.round((BOX.u1 - BOX.u0) * 3840), pxH = Math.round((BOX.v1 - BOX.v0) * 2160);
    draw.style.cssText = 'position:absolute;inset:0';
    const handles = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2]];
    draw.innerHTML = `
      <div class="box" style="left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"></div>
      ${handles.map(([x, y]) => `<i class="h" style="left:${x}px;top:${y}px"></i>`).join('')}
      <svg style="position:absolute;left:${x1 + 1}px;top:${y1 + 1}px;width:16px;height:16px;overflow:visible"><path d="M2 2 L2 14 L5.5 10.5 L8.5 16 L10.5 15 L7.5 9.5 L12 9.5 Z" fill="white" stroke="black" stroke-width="1"/></svg>
      <span class="dim" style="left:${x0}px;top:${y0 - 20}px">F12 · ${pxW} × ${pxH} px</span>
`;
    if (o.strip) o.strip.innerHTML = `
      <b>F12</b>
      <select class="input" style="height:24px;width:auto;font-size:11.5px" aria-label="Class"><option>Coating breakdown</option></select>
      <div class="sevpick" role="group" aria-label="Severity">${[1, 2, 3, 4, 5].map(s => `<button class="${s === 4 ? 'on' : ''}" style="${s === 4 ? 'background:var(--s4)' : ''}">${s}</button>`).join('')}</div>
      <span class="sp"></span>
      <button class="btn icon sm ghost" title="Discard"><svg class="i s14"><use href="#i-x"/></svg></button><button class="btn sm primary">Save draft</button>`;
  }

  // overlay in the 3D stage
  const ovl = o.ovl;
  function overlay(p, path) {
    ovl.innerHTML = '';
    const P = x => toScreen(x, camera, size);
    // bearing labels on the polar grid
    for (let a = 0; a < 360; a += 30) {
      const b = a * DEG, q = P(new THREE.Vector3(Math.cos(b) * 6.45, -0.3, Math.sin(b) * 6.45));
      if (q) { const t = S('text', { x: q[0], y: q[1] + 3, 'text-anchor': 'middle', fill: a === 0 ? ACC : OVD, style: 'font:500 9.5px var(--f-mono)' }, ovl); t.textContent = a === 0 ? 'PN' : String(a).padStart(3, '0'); }
    }
    // elevation ruler on the axis
    for (let y = 0; y <= 10; y += 2) {
      const q = P(new THREE.Vector3(0, y, 2.6)); if (!q) continue;
      S('line', { x1: q[0] - 4, y1: q[1], x2: q[0] + 4, y2: q[1], stroke: OVD }, ovl);
      const t = S('text', { x: q[0] + 8, y: q[1] + 3, fill: OVD, style: 'font:400 9.5px var(--f-mono)' }, ovl); t.textContent = `${y.toFixed(1)} m`;
    }
    { const a = P(new THREE.Vector3(0, 0, 2.6)), b = P(new THREE.Vector3(0, 10, 2.6)); if (a && b) S('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: OVF }, ovl); }
    // issue pins
    anchors.forEach(an => {
      const q = P(an.pos); if (!q) return;
      const cut = an.pos.z > 0.08; const col = SEVC[an.sev]; const isF = an.id === focus;
      const g = S('g', { opacity: cut ? 0.4 : 1 }, ovl);
      S('rect', { x: q[0] - 4, y: q[1] - 4, width: 8, height: 8, fill: cut ? 'none' : col, stroke: col, 'stroke-width': 1.5, transform: `rotate(45 ${q[0]} ${q[1]})` }, g);
      if (isF) S('circle', { cx: q[0], cy: q[1], r: 9, fill: 'none', stroke: col }, g);
      const t = S('text', { x: q[0] + 8, y: q[1] - 6, fill: OV, style: 'font:600 10px var(--f-mono)' }, g); t.textContent = an.id;
    });
    if (f12) {
      const q = P(f12.pos);
      if (q) {
        S('rect', { x: q[0] - 5, y: q[1] - 5, width: 10, height: 10, fill: 'none', stroke: SEVC[4], 'stroke-width': 1.5, 'stroke-dasharray': '2 1.5', transform: `rotate(45 ${q[0]} ${q[1]})` }, ovl);
        labelStack(ovl, q[0], q[1], ['F12 · DRAFT', ['SEV', '4 High'], ['EL', '8.79 m'], ['SRC', 'video 110 · 0:56.4']], { color: SEVC[4], dx: -150, dy: 40, w: 140 });
      }
    }
    if (!p || !path) return;
    // flight path with 1 s ticks
    const sp = path.samples.map(s => new THREE.Vector3().fromArray(s.pos));
    S('path', { d: polyD(sp.map(P)), fill: 'none', stroke: OV, 'stroke-width': 1.25, opacity: 0.85 }, ovl);
    for (let i = 0; i < sp.length; i += 10) {
      const a = P(sp[i]), b = P(sp[Math.min(i + 1, sp.length - 1)]); if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      S('line', { x1: a[0] - nx * 4, y1: a[1] - ny * 4, x2: a[0] + nx * 4, y2: a[1] + ny * 4, stroke: OV }, ovl);
    }
    // frustum to the image plane
    const dp = P(p.pos);
    framePlane.corners(p.pos, p.q).forEach(c => { const q = P(c); if (q && dp) S('line', { x1: dp[0], y1: dp[1], x2: q[0], y2: q[1], stroke: ACC, opacity: 0.8 }, ovl); });
    if (dp) {
      droneGlyph(ovl, dp[0], dp[1]);
      const rad = Math.hypot(p.pos.x, p.pos.z), brg = (Math.atan2(p.pos.z, p.pos.x) / DEG + 360) % 360;
      labelStack(ovl, dp[0], dp[1], [`ELIOS 3 · F${path.flight_id}`, ['Z', `${p.pos.y.toFixed(2)} m`], ['R', `${rad.toFixed(2)} m · ${String(Math.round(brg)).padStart(3, '0')}°`], ['TILT', `${p.a.servo_deg.toFixed(1)}°`], ['TC', `00:${String(Math.floor((path.clip_start_flight_video_s + (v.currentTime || 0)) / 60)).padStart(2, '0')}:${((path.clip_start_flight_video_s + (v.currentTime || 0)) % 60).toFixed(1).padStart(4, '0')}`]], { color: ACC, dx: 26, dy: -58, w: 148 });
    }
  }

  let active = false, raf = 0, hdgPrev = -1;
  function frame(now) {
    raf = active ? requestAnimationFrame(frame) : 0;
    const path = poses[clipKey]; let p = null;
    if (path) {
      const t = v.currentTime || 0; p = samplePose(path.samples, t);
      depthCam.position.copy(p.pos); depthCam.quaternion.copy(p.q); depthCam.updateMatrixWorld(); depthCam.updateProjectionMatrix();
      U.uView.value.copy(depthCam.matrixWorldInverse);
      U.uPinVP.value.multiplyMatrices(depthCam.projectionMatrix, depthCam.matrixWorldInverse);
      U.uCamPos.value.copy(p.pos);
      framePlane.place(p.pos, p.q); framePlane.visible = !eye;
      scene.overrideMaterial = depthMat; renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, depthCam);
      scene.overrideMaterial = null; renderer.setRenderTarget(null);
      if (eye) { camera.position.copy(p.pos); camera.quaternion.copy(p.q); }
      o.onTime && o.onTime(t, p.a);
    }
    if (!eye) controls.update();
    renderer.render(scene, camera);
    overlay(eye ? null : p, path);
    renderDraw();
    const dir = controls.target.clone().sub(camera.position);
    const hdg = (Math.atan2(dir.z, dir.x) / DEG + 360) % 360;
    if (Math.abs(hdg - hdgPrev) > 0.2) { drawCompass(o.compass, hdg, 'PN'); hdgPrev = hdg; }
  }
  function setActive(on) {
    active = on;
    if (on) { if (playing) v.play().catch(() => {}); if (!raf) raf = requestAnimationFrame(frame); }
    else v.pause();
  }
  return {
    setActive,
    togglePlay() { playing = !playing; if (playing) { draw.dataset.k = ''; v.play().catch(() => {}); } else v.pause(); document.getElementById('hcRec').textContent = playing ? 'PLAY' : 'PAUSED'; return playing; },
    setClip(k) {
      clipKey = k; const c = CLIPS[k]; v.poster = o.assets + c.poster; setVideoSrc(v, o.assets + c.mp4); drawStart = 0;
      v.dataset.want = playing ? 'play' : ''; if (!playing) freezeAt(c.freeze != null ? c.freeze : 2.0);
    },
    focusIssue(id) { focus = id; },
  };
}

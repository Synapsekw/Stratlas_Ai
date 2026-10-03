// Option 3: Studio. three.js viewports, video sync, sequencers.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ASSETS, HCL_ISSUES, makeSeq, captureFrames, FILM, ic } from './option-3-app.js';

const A = '../../assets/';
const views = {};
let active = null;

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function cssColor(name) {
  // resolve an oklch token to a THREE.Color through a canvas
  const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d');
  g.fillStyle = css(name); g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
}

export function setActive(s) { active = s; Object.entries(views).forEach(([k, v]) => { if (v.video) { if (k === s && v.autoplay) v.video.play().catch(() => {}); else if (k !== s) v.video.pause(); } }); }
export function setViewMode(id, mode) { const v = views[id === 'az' ? 'alzour' : 'hcl']; if (v && v.setMode) v.setMode(mode); }

function baseView(host, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', logarithmicDepthBuffer: !!opts.logDepth });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure || 1.0;
  renderer.localClippingEnabled = true;
  renderer.domElement.className = 'gl';
  renderer.domElement.tabIndex = 0;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const bg = cssColor('--vp');
  scene.background = bg;
  const camera = new THREE.PerspectiveCamera(opts.fov || 40, 1, opts.near || 0.1, opts.far || 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  const labels = document.createElement('div'); labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  host.appendChild(labels);
  const v = { renderer, scene, camera, controls, host, labels };
  v.renderNow = () => { if (v.tick) v.tick(); renderer.render(scene, camera); v.lastRender = performance.now(); };
  v.resize = () => {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    if (v.w === w && v.h === h) return; v.w = w; v.h = h;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    v.renderNow(); // setSize clears the drawing buffer: redraw in the same task
  };
  new ResizeObserver(v.resize).observe(host); v.resize();
  return v;
}

function label(v, html, cls = 'vlabel') { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; v.labels.appendChild(el); return el; }
const _p = new THREE.Vector3();
function placeLabel(v, el, pos) {
  _p.copy(pos).project(v.camera);
  const vis = _p.z < 1 && Math.abs(_p.x) < 1.2 && Math.abs(_p.y) < 1.2;
  el.style.display = vis ? '' : 'none';
  if (!vis) return;
  const w = v.host.clientWidth, h = v.host.clientHeight;
  el.style.transform = `translate(${((_p.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_p.y * 0.5 + 0.5) * h).toFixed(1)}px)` + (el.classList.contains('pinl') ? '' : ' translate(-50%, -100%)');
}

function gizmo(v, id) {
  const g = document.querySelector(`[data-gizmo="${id}"] [data-axes]`); if (!g) return () => {};
  const ax = [['X', new THREE.Vector3(1, 0, 0), css('--ax-x')], ['Y', new THREE.Vector3(0, 1, 0), css('--ax-y')], ['Z', new THREE.Vector3(0, 0, 1), css('--ax-z')]];
  const qi = new THREE.Quaternion(); const t = new THREE.Vector3();
  return () => {
    qi.copy(v.camera.quaternion).invert();
    const items = [];
    ax.forEach(([n, d, c]) => {
      t.copy(d).applyQuaternion(qi); items.push({ n, c, x: t.x * 27, y: -t.y * 27, z: t.z, pos: 1 });
      t.copy(d).negate().applyQuaternion(qi); items.push({ n, c, x: t.x * 27, y: -t.y * 27, z: t.z, pos: 0 });
    });
    items.sort((a, b) => a.z - b.z);
    g.innerHTML = items.map(i => i.pos
      ? `<line x1="0" y1="0" x2="${i.x.toFixed(1)}" y2="${i.y.toFixed(1)}" stroke="${i.c}" stroke-width="2" stroke-linecap="round"/><circle cx="${i.x.toFixed(1)}" cy="${i.y.toFixed(1)}" r="7.5" fill="${i.c}"/><text x="${i.x.toFixed(1)}" y="${(i.y + 3.3).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700" font-family="Geist, sans-serif" fill="oklch(0.16 0.01 255)">${i.n}</text>`
      : `<circle cx="${i.x.toFixed(1)}" cy="${i.y.toFixed(1)}" r="6" fill="oklch(0.2 0.006 255)" stroke="${i.c}" stroke-opacity=".7" stroke-width="1.5"/>`).join('');
  };
}

function tween(v, target) {
  if (!target) return;
  const p0 = v.camera.position.clone(), t0 = v.controls.target.clone();
  const p1 = new THREE.Vector3(...target[0]), t1 = new THREE.Vector3(...target[1]);
  const start = performance.now(), dur = 650;
  v.anim = now => { const k = Math.min(1, (now - start) / dur); const e = 1 - Math.pow(1 - k, 4);
    v.camera.position.lerpVectors(p0, p1, e); v.controls.target.lerpVectors(t0, t1, e); if (k >= 1) v.anim = null; };
}
export function bookmark(id, name) { const v = views[id === 'az' ? 'alzour' : 'hcl']; if (v && v.bookmark) v.bookmark(name); }

/* ---------- projector materials ---------- */
function pinholeProjector(tex) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, projVP: { value: new THREE.Matrix4() }, projPos: { value: new THREE.Vector3() }, opacity: { value: 0.92 }, fadeNear: { value: 520 }, fadeFar: { value: 820 } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform sampler2D map; uniform mat4 projVP; uniform vec3 projPos; uniform float opacity, fadeNear, fadeFar; varying vec3 vW;
      void main(){
        #include <logdepthbuf_fragment>
        vec4 c = projVP*vec4(vW,1.); if(c.w<=0.) discard; vec3 n=c.xyz/c.w; if(abs(n.x)>1.||abs(n.y)>1.) discard;
        vec2 uv=n.xy*.5+.5; vec4 col=texture2D(map,uv);
        float e = max(abs(n.x),abs(n.y)); float a = opacity*(1.-smoothstep(.93,1.,e))*(1.-smoothstep(fadeNear,fadeFar,distance(vW,projPos)));
        float edge = smoothstep(.985,.995,e); col.rgb = mix(col.rgb, vec3(.55,.92,.82), edge*.9); a = max(a, edge*.9*(1.-smoothstep(fadeNear,fadeFar,distance(vW,projPos))));
        gl_FragColor = vec4(col.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}
function fthetaProjector(tex) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, projView: { value: new THREE.Matrix4() }, projPos: { value: new THREE.Vector3() }, opacity: { value: 0.96 }, halfFov: { value: THREE.MathUtils.degToRad(57) }, aspect: { value: 16 / 9 } },
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform sampler2D map; uniform mat4 projView; uniform vec3 projPos; uniform float opacity, halfFov, aspect; varying vec3 vW; varying vec3 vN;
      void main(){ vec3 toP = projPos - vW; if(dot(-normalize(vN), normalize(toP)) < 0.08) discard;
        vec3 p = (projView*vec4(vW,1.)).xyz; vec3 d = normalize(p); float th = acos(clamp(-d.z,-1.,1.)); float ph = atan(d.y,d.x);
        float r = th/halfFov; vec2 uv = vec2(.5+.5*r*cos(ph), .5+.5*r*sin(ph)*aspect);
        if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.) discard;
        vec4 col = texture2D(map, uv);
        float e = max(abs(uv.x-.5),abs(uv.y-.5))*2.; float a = opacity*(1.-smoothstep(.9,1.,e))*(1.-smoothstep(5.,7.5,length(toP)));
        float edge = smoothstep(.975,.99,e); col.rgb = mix(col.rgb, vec3(.55,.92,.82), edge); a = max(a, edge*.85);
        gl_FragColor = vec4(col.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
  });
}

function droneMarker(color, s = 1) {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, 0.18 * s, 0.5 * s), m); g.add(body);
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9 * s, 0.06 * s, 0.08 * s), m); arm.position.set(a * 0.3 * s, 0, b * 0.3 * s); arm.rotation.y = a * b > 0 ? -Math.PI / 4 : Math.PI / 4; g.add(arm);
    const rot = new THREE.Mesh(new THREE.TorusGeometry(0.22 * s, 0.03 * s, 6, 24), m); rot.rotation.x = Math.PI / 2; rot.position.set(a * 0.6 * s, 0.05 * s, b * 0.6 * s); g.add(rot);
  });
  g.renderOrder = 10; g.traverse(o => o.renderOrder = 10);
  return g;
}
function frustumLines(color) {
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
  const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }));
  l.renderOrder = 9; l.frustumCulled = false; return l;
}
function setFrustum(line, origin, corners) {
  const a = line.geometry.attributes.position.array; let k = 0;
  const put = v => { a[k++] = v.x; a[k++] = v.y; a[k++] = v.z; };
  corners.forEach(c => { put(origin); put(c); });
  for (let i = 0; i < 4; i++) { put(corners[i]); put(corners[(i + 1) % 4]); }
  line.geometry.attributes.position.needsUpdate = true;
}
function interp(samples, t) {
  const f = Math.max(0, Math.min(samples.length - 1.001, t * 10)); const i = Math.floor(f); const u = f - i;
  const a = samples[i], b = samples[i + 1] || a;
  const pos = new THREE.Vector3().fromArray(a.pos).lerp(new THREE.Vector3().fromArray(b.pos), u);
  const q = new THREE.Quaternion().fromArray(a.q).slerp(new THREE.Quaternion().fromArray(b.q), u);
  return { pos, q, a };
}
const fmtClock = s => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s % 60); return [h, m, x].map(n => String(n).padStart(2, '0')).join(':'); };
const fmtSec = s => { const m = Math.floor(s / 60), x = s - m * 60; return String(m).padStart(2, '0') + ':' + x.toFixed(1).padStart(4, '0'); };

/* ======================================================================== Al-Zour */
async function initAlzour() {
  const host = document.getElementById('vp-az');
  const v = baseView(host, { fov: 38, near: 2, far: 30000, exposure: 1.05, logDepth: true });
  views.alzour = v; v.autoplay = true;
  const { scene, camera, controls } = v;
  scene.fog = new THREE.Fog(scene.background, 2600, 6200);
  scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x3a3630, 1.4));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.4); sun.position.set(-600, 900, 500); scene.add(sun);
  camera.position.set(-300, 420, 400); controls.target.set(90, 0, -80);
  controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 60; controls.maxDistance = 4000;

  const tl = new THREE.TextureLoader();
  const accent = cssColor('--ac');
  // street map base
  const [smJ, orJ, path89, path65] = await Promise.all([
    fetch(A + 'alzour/streetmap.json').then(r => r.json()), fetch(A + 'alzour/ortho.json').then(r => r.json()),
    fetch(A + 'alzour/clip_dji0789_tanks_path.json').then(r => r.json()), fetch(A + 'alzour/clip_dji0665_overview_path.json').then(r => r.json()),
  ]);
  const smTex = tl.load(A + 'alzour/streetmap.jpg'); smTex.colorSpace = THREE.SRGBColorSpace; smTex.anisotropy = 8;
  const sm = new THREE.Mesh(new THREE.PlaneGeometry(6600, 6540), new THREE.MeshBasicMaterial({ map: smTex, color: 0x9aa3ad }));
  sm.rotation.x = -Math.PI / 2; sm.position.set(200, -0.5, -230); scene.add(sm);
  // ortho quad from four corners
  const pc = orJ.placement_xz; const y0 = 0.3;
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.Float32BufferAttribute([pc.top_left[0], y0, pc.top_left[1], pc.top_right[0], y0, pc.top_right[1], pc.bottom_right[0], y0, pc.bottom_right[1], pc.bottom_left[0], y0, pc.bottom_left[1]], 3));
  og.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  og.setIndex([0, 3, 1, 1, 3, 2]); og.computeVertexNormals();
  const orTex = tl.load(A + 'alzour/ortho.jpg'); orTex.colorSpace = THREE.SRGBColorSpace; orTex.anisotropy = 8;
  const ortho = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ map: orTex, side: THREE.DoubleSide })); scene.add(ortho);

  // plant
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(A + 'alzour/plant.glb');
  const plant = gltf.scene; scene.add(plant);
  const terrain = plant.getObjectByName('Site_Terrain'); if (terrain) terrain.visible = false;
  plant.traverse(o => { if (o.isMesh) { o.material.envMapIntensity = 0.6; if (o.material.name === 'Zone_Line') o.visible = false; } });
  host.querySelector('[data-loading]')?.remove();

  // selection: 20-T-0002
  const t2 = plant.getObjectByName('20-T-0002');
  let t2Top = new THREE.Vector3(146, 52, -105.4);
  if (t2) {
    const box = new THREE.Box3().setFromObject(t2); t2Top.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    const outlineMat = new THREE.MeshBasicMaterial({ color: accent, side: THREE.BackSide, transparent: true, opacity: 0.95 });
    t2.updateMatrixWorld(true);
    const c = new THREE.Vector3(); box.getCenter(c);
    t2.traverse(o => {
      if (!o.isMesh) return;
      const m = new THREE.Mesh(o.geometry, outlineMat); m.matrixAutoUpdate = false;
      const s = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(1.03, 1.015, 1.03)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      m.matrix.copy(s.multiply(o.matrixWorld)); scene.add(m);
    });
    const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.98, r * 1.06, 128), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 1.0, c.z); scene.add(ring);
  }
  const tagT2 = label(v, `<div class="tag3d"><div class="box">20-T-0002<span>T-02 · LNG tank</span></div><div class="stem"></div></div>`);
  const otherTags = [['20-T-0001', [1.1, 0, -105.4]], ['20-T-0003', [290.7, 0, -105.4]]].map(([n, p]) => {
    const o = plant.getObjectByName(n); let top = new THREE.Vector3(p[0], 50, p[2]);
    if (o) { const b = new THREE.Box3().setFromObject(o); top.set((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2); }
    return [label(v, `<div class="tag3d muted"><div class="box">${n}</div><div class="stem"></div></div>`), top];
  });

  // flight paths
  const mkPath = (samples, color, op) => {
    const pts = samples.map(s => new THREE.Vector3().fromArray(s.pos));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthTest: false })); l.renderOrder = 8; scene.add(l);
    // drop lines to ground every 2 s
    const drops = []; for (let i = 0; i < samples.length; i += 20) { const p = pts[i]; drops.push(p.x, p.y, p.z, p.x, 0.5, p.z); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(drops, 3));
    const dl = new THREE.LineSegments(dg, new THREE.LineDashedMaterial({ color, transparent: true, opacity: op * 0.45, dashSize: 4, gapSize: 4 })); dl.computeLineDistances(); scene.add(dl);
    return l;
  };
  mkPath(path65.samples, 0x9fb3c8, 0.55);
  mkPath(path89.samples, 0xe8eef4, 0.95);
  const traveled = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: accent, depthTest: false, linewidth: 2 })); traveled.renderOrder = 9; scene.add(traveled);

  const drone = droneMarker(accent, 9); scene.add(drone);
  const fr = frustumLines(accent); scene.add(fr);
  const droneTag = label(v, `<div class="tag3d muted"><div class="box" style="font-family:var(--f-mono);font-size:10.5px">DJI_0789 · 104 m</div><div class="stem"></div></div>`);

  // pano markers (real positions)
  const panos = await fetch(A + 'alzour/panos.json').then(r => r.json());
  const panoEls = panos.panos.map(p => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.85, depthTest: false })); s.renderOrder = 8;
    s.position.fromArray(p.pos); scene.add(s);
    return [label(v, `<div class="pin3d"><span class="l" style="background:oklch(0.15 0.005 255 / .8)">${ic('pano', 's12').replace('class="i', 'style="display:inline-block;vertical-align:-2px;width:11px;height:11px" class="i')} ${p.id}</span></div>`, 'vlabel pinl'), new THREE.Vector3().fromArray(p.pos)];
  });

  // video + projection
  const video = document.getElementById('az-video'); v.video = video;
  video.src = A + 'alzour/clip_dji0789_tanks.mp4'; video.poster = A + 'alzour/clip_dji0789_tanks_poster.jpg';
  const vtex = new THREE.VideoTexture(video); vtex.colorSpace = THREE.SRGBColorSpace;
  const proj = pinholeProjector(vtex);
  const recv = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), proj); recv.rotation.x = -Math.PI / 2; recv.position.y = 0.6; recv.renderOrder = 5; scene.add(recv);
  const projCam = new THREE.PerspectiveCamera(47.3, 1280 / 720, 1, 5000);
  const vfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(83) / 2) / (1280 / 720));
  projCam.fov = THREE.MathUtils.radToDeg(vfov) * 0.94; projCam.updateProjectionMatrix();
  const vp = new THREE.Matrix4();
  const ray = new THREE.Ray(); const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);

  // sequencer
  const T0 = 15 * 3600 + 11 * 60 + 16; // DJI_0789 clip start in flight 4 (local time)
  const seq = makeSeq(document.getElementById('seq-az'), {
    subtitle: 'Flight 4, 21 Feb 2023', filterNote: 'Agent filter: 4 clips over T-02',
    t0: T0 - 8, t1: T0 + 32, playhead: T0, maxSpan: 4 * 3600,
    range: [T0 + 6.2, T0 + 11],
    fmt: t => fmtClock(t).slice(3) === '00:00' ? fmtClock(t) : fmtClock(t).slice(0, 8),
    tc: t => `${fmtClock(t)}<small>:${String(Math.floor((t % 1) * 30)).padStart(2, '0')}</small>`,
    tracks: [
      { name: 'DJI_0789', sub: 'F4 · tanks', icon: 'video', active: 1, items: [{ a: T0, b: T0 + 11, label: 'DJI_0789', on: 1, film: 'az89' }], keys: [6.4, 7.2, 8.1, 8.8, 9.6, 10.4].map(k => ({ t: T0 + k, ac: 1 })) },
      { name: 'DJI_0791', sub: 'F4 · jetty', icon: 'video', items: [{ a: T0 + 14.5, b: T0 + 46, label: 'DJI_0791' }], keys: [18.2, 19.4, 21.0].map(k => ({ t: T0 + k, ac: 1 })) },
      { name: 'DJI_0665', sub: 'F1 · overview', icon: 'video', items: [{ a: T0 - 5935, b: T0 - 5924, label: 'DJI_0665', film: 'az65' }] },
      { name: 'Flight log F4', sub: 'AGL', icon: 'path', kind: 'flight', graph: t => 0.62 + 0.18 * Math.sin((t - T0) / 9) + 0.05 * Math.sin((t - T0) / 2.3) },
      { name: 'Photos and panos', sub: 'P1', icon: 'photo', ticks: Array.from({ length: 30 }, (_, i) => T0 - 6 + i * 1.6), keys: [{ t: T0 + 26.4, c: 'var(--sev2)' }] },
      { name: 'Annotations', sub: '9 issues', icon: 'pin', keys: [{ t: T0 + 3.1, c: 'var(--sev4)' }, { t: T0 + 9.2, c: 'var(--sev3)' }, { t: T0 + 24, c: 'var(--sev3)' }] },
    ],
  });
  views.alzour.seq = seq;

  // film strips + agent frames from the real clips
  captureFrames(A + 'alzour/clip_dji0789_tanks.mp4', [0.3, 1.6, 2.9, 4.2, 5.5, 6.8, 8.1, 9.4, 10.6], 128, 72).then(fr89 => {
    FILM.az89 = fr89; seq.refreshFilm();
    const grid = document.getElementById('az-frames');
    const times = [6.4, 7.2, 8.1, 8.8, 9.6, 10.4];
    captureFrames(A + 'alzour/clip_dji0789_tanks.mp4', times, 192, 108).then(fs => {
      captureFrames(A + 'alzour/clip_dji0665_overview.mp4', [9.2, 10.6], 192, 102).then(f65 => {
        FILM.az65 = f65;
        const all = fs.map((s, i) => [s, 'DJI_0789', times[i]]).concat(f65.map((s, i) => [s, 'DJI_0665', [9.2, 10.6][i]]));
        grid.innerHTML = all.map(([s, c, t], i) => `<button style="position:relative;border-radius:3px;overflow:hidden;aspect-ratio:16/9;background:url(${s}) center/cover;${i === 2 ? 'box-shadow:0 0 0 1.5px var(--ac)' : 'box-shadow:inset 0 0 0 1px oklch(1 0 0 / .06)'}" data-seek="${c === 'DJI_0789' ? t : ''}" aria-label="${c} at ${t}s"><span style="position:absolute;left:3px;bottom:2px;font:500 9.5px var(--f-mono);color:white;text-shadow:0 1px 2px #000">${c.slice(4)} · ${t.toFixed(1)}</span></button>`).join('');
        grid.querySelectorAll('[data-seek]').forEach(b => b.addEventListener('click', () => { if (b.dataset.seek) video.currentTime = +b.dataset.seek; }));
        requestAnimationFrame(() => { const c = document.getElementById('az-convo'); if (c) c.scrollTop = c.scrollHeight; });
        document.getElementById('az-results').innerHTML = [['DJI_0789', 'F4', '14 frames', '6–11 s', fs[2]], ['DJI_0665', 'F1', '9 frames', '8–11 s', f65[1]]]
          .map(([c, f, n, r, img]) => `<div class="res-row"><span class="th" style="background:url(${img}) center/cover"></span><span><b>${c}</b> <span class="m">${f} · ${r}</span></span><span class="m">${n}</span></div>`).join('') ;
      });
    });
  });

  // video UI
  const scrub = document.getElementById('az-scrub');
  scrub.addEventListener('pointerdown', e => { const r = scrub.getBoundingClientRect(); video.currentTime = (e.clientX - r.left) / r.width * (video.duration || 11); });
  document.querySelector('#seq-az [data-play]').addEventListener('click', e => { if (video.paused) { v.userPaused = false; video.play(); } else { v.userPaused = true; video.pause(); } e.currentTarget.innerHTML = ic(video.paused ? 'play' : 'pause', 's14'); });
  video.addEventListener('loadedmetadata', () => { document.getElementById('az-dur').textContent = fmtSec(video.duration); });
  video.play().catch(() => {});

  const t2c = new THREE.Vector3(146, 20, -105.4);
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ndcs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const upd = gizmo(v, 'az');
  v.tick = () => {
    const t = video.currentTime || 0;
    const { pos, q, a } = interp(path89.samples, t);
    projCam.position.copy(pos); projCam.quaternion.copy(q); projCam.updateMatrixWorld(); projCam.matrixWorldInverse.copy(projCam.matrixWorld).invert();
    vp.multiplyMatrices(projCam.projectionMatrix, projCam.matrixWorldInverse);
    proj.uniforms.projVP.value.copy(vp); proj.uniforms.projPos.value.copy(pos);
    drone.position.copy(pos); drone.rotation.set(0, -THREE.MathUtils.degToRad(a.az_deg), 0);
    // frustum to ground (clamped)
    ndcs.forEach(([x, y], i) => {
      const p = new THREE.Vector3(x, y, 0.5).unproject(projCam); ray.set(pos, p.sub(pos).normalize());
      const hit = ray.intersectPlane(plane, corners[i]);
      if (!hit || corners[i].distanceTo(pos) > 420) corners[i].copy(pos).addScaledVector(ray.direction, 420);
    });
    setFrustum(fr, pos, corners);
    const n = Math.max(2, Math.round(t * 10) + 1);
    traveled.geometry.setFromPoints(path89.samples.slice(0, n).map(s => new THREE.Vector3().fromArray(s.pos)));
    placeLabel(v, tagT2, t2Top); otherTags.forEach(([el, p]) => placeLabel(v, el, p));
    placeLabel(v, droneTag, pos.clone().add(new THREE.Vector3(0, 6, 0)));
    panoEls.forEach(([el, p]) => placeLabel(v, el, p));
    declutter([{ el: tagT2, pri: 10 }, { el: droneTag, pri: 8 }, ...otherTags.map(([el]) => ({ el, pri: 5 })), ...panoEls.map(([el]) => ({ el, pri: 2 }))]);
    // HUD + telemetry
    const d = pos.distanceTo(t2c);
    setTxt('az-hud-t', fmtSec(t)); setTxt('az-tc', fmtSec(t));
    setTxt('az-alt', (pos.y).toFixed(1) + ' m'); setTxt('az-gmb', a.gimbal_pitch_deg.toFixed(1) + '°'); setTxt('az-hdg', String(Math.round(a.az_deg)).padStart(3, '0') + '°');
    setHtml('az-d', Math.round(d) + '<small>m</small>');
    const fpw = corners[0].distanceTo(corners[1]); setHtml('az-fp', Math.round(fpw) + ' × ' + Math.round(corners[1].distanceTo(corners[2])) + '<small>m</small>');
    setHtml('az-gsd', (pos.distanceTo(corners[0]) / 1280 * 100 * 0.9).toFixed(1) + '<small>cm</small>');
    const roof = t > 6.2;
    const re = document.getElementById('az-roof'); if (re) { re.textContent = roof ? 'Yes' : 'Not yet'; re.style.color = roof ? 'var(--ac)' : 'var(--t3)'; }
    const sp = scrub.querySelector('.p'), sh = scrub.querySelector('.h'); const f = t / (video.duration || 11) * 100; sp.style.width = f + '%'; sh.style.left = f + '%';
    seq.setPlayhead(T0 + t);
    upd();
  };
  const BM = { 'Overview': [[-300, 420, 400], [90, 0, -80]], 'T-02 roof': [[10, 230, 120], [146, 30, -105]] };
  v.bookmark = name => tween(v, BM[name]);
  v.setMode = mode => {
    plant.traverse(o => { if (o.isMesh && o.material && 'wireframe' in o.material) o.material.wireframe = mode === 'Wireframe'; });
    ortho.visible = mode !== 'Wireframe';
    if (mode === 'Ortho texture') { camera.position.set(controls.target.x + 1, 1500, controls.target.z + 1); }
    if (mode === 'Lit') { camera.position.set(-430, 540, 560); controls.target.set(70, 0, -70); }
  };
}
const setTxt = (id, t) => { const e = document.getElementById(id); if (e && e.textContent !== t) e.textContent = t; };
const setHtml = (id, t) => { const e = document.getElementById(id); if (e && e.innerHTML !== t) e.innerHTML = t; };

/* ======================================================================== HCl */
async function initHcl() {
  const host = document.getElementById('vp-hcl');
  const v = baseView(host, { fov: 34, near: 0.05, far: 400, exposure: 1.0 });
  views.hcl = v; v.autoplay = false;
  const { scene, camera, controls } = v;
  scene.add(new THREE.HemisphereLight(0xe6edf5, 0x2c2a28, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(8, 14, -6); scene.add(sun);
  camera.position.set(8.8, 15.6, -10.6); controls.target.set(0.2, 6.9, -0.4);
  controls.minDistance = 2; controls.maxDistance = 60;
  const accent = cssColor('--ac');

  // ground grid
  const grid = new THREE.GridHelper(24, 24, 0x3a3f47, 0x2b2f35); grid.position.y = -0.2; grid.material.transparent = true; grid.material.opacity = 0.6; scene.add(grid);

  const loader = new GLTFLoader();
  const [gltf, buf, pose] = await Promise.all([
    loader.loadAsync(ASSETS.hcl.glb),
    fetch(ASSETS.hcl.cloud).then(r => r.arrayBuffer()),
    fetch(ASSETS.hcl.poseExt).then(r => r.json()),
  ]);
  const tank = gltf.scene; scene.add(tank);
  const projTargets = [];
  tank.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (/Handrail|Ladder|Grating/.test(o.material.name || '')) { o.material = o.material.clone(); o.material.color.set(0x7d858f); o.material.transparent = true; o.material.opacity = 0.55; }
    const n = o.name || ''; const mat = o.material.name || '';
    if (/Lining|_In$|Rubber/.test(n) || mat === 'Rubber_Lining' || mat === 'Weld_Seam_Lined') { o.visible = false; return; }
    if (mat === 'Paint_Shell' || /Shell_Course|Roof_Head|Roof_Straight/.test(n)) {
      o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.3; o.material.depthWrite = false; o.material.side = THREE.DoubleSide;
      o.renderOrder = 2;
    }
    if (/Shell_Course|Roof_Head|Roof_Straight|Seam_.*_Out|_Neck|_Pad|_Flange/.test(n)) projTargets.push(o);
  });
  host.querySelector('[data-loading]')?.remove();

  // point cloud
  const N = ASSETS.hcl.cloudN; const q = new Int16Array(buf, 0, N * 3); const inten = new Uint8Array(buf, N * 6, N);
  const pos = new Float32Array(N * 3); for (let k = 0; k < N * 3; k++) pos[k] = q[k] * 0.001;
  const col = new Float32Array(N * 3);
  const ramp = [[0.18, 0.2, 0.26], [0.34, 0.44, 0.55], [0.62, 0.72, 0.78], [0.93, 0.9, 0.82]];
  for (let i = 0; i < N; i++) {
    const t = inten[i] / 255 * 3; const k = Math.min(2, Math.floor(t)); const u = t - k;
    for (let c = 0; c < 3; c++) col[i * 3 + c] = ramp[k][c] + (ramp[k + 1][c] - ramp[k][c]) * u;
  }
  const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); cg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const cloudMat = new THREE.PointsMaterial({ size: 0.022, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95 });
  const cloud = new THREE.Points(cg, cloudMat); cloud.renderOrder = 1; scene.add(cloud);

  // flight path f110
  const pts = pose.samples.map(s => new THREE.Vector3().fromArray(s.pos));
  const pl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xe8eef4, transparent: true, opacity: 0.9, depthTest: false })); pl.renderOrder = 8; scene.add(pl);
  const drone = droneMarker(accent, 0.32); scene.add(drone);
  const fr = frustumLines(accent); scene.add(fr);

  // video projection (f-theta)
  const video = document.getElementById('hcl-video'); v.video = video;
  video.src = ASSETS.hcl.clipExt; video.poster = ASSETS.hcl.posterExt;
  const PAUSE_T = 4.27;
  video.addEventListener('loadeddata', () => { video.currentTime = PAUSE_T; }, { once: true });
  const vtex = new THREE.VideoTexture(video); vtex.colorSpace = THREE.SRGBColorSpace;
  const proj = fthetaProjector(vtex);
  tank.updateMatrixWorld(true);
  projTargets.forEach(o => { const m = new THREE.Mesh(o.geometry, proj); m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); m.renderOrder = 6; scene.add(m); });

  // issue pins
  const pins = HCL_ISSUES.map(f => [label(v, `<div class="pin3d"><span class="d sev${f.sev}"></span><span class="l">${f.id}</span></div>`, 'vlabel pinl'), new THREE.Vector3().fromArray(f.pos)]);

  // F12: back-project the drawn box from the paused frame pose onto the mesh
  const raycaster = new THREE.Raycaster();
  const shellMeshes = projTargets.filter(o => /Roof_Head|Shell_Course|Roof_Straight/.test(o.name));
  const frameDir = (u, vv, qq) => {
    const dx = (u - 0.5) * 2, dy = -(vv - 0.5) * 2 * (9 / 16);
    const r = Math.hypot(dx, dy); const th = r * THREE.MathUtils.degToRad(57); const ph = Math.atan2(dy, dx);
    return new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th)).applyQuaternion(qq).normalize();
  };
  const box = { x0: 0.515, y0: 0.35, x1: 0.685, y1: 0.515 };
  const pz = interp(pose.samples, PAUSE_T);
  const outline = []; let center = null;
  const edge = (a, b, n) => { for (let i = 0; i < n; i++) { const t = i / n; outline.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } };
  edge([box.x0, box.y0], [box.x1, box.y0], 12); edge([box.x1, box.y0], [box.x1, box.y1], 12); edge([box.x1, box.y1], [box.x0, box.y1], 12); edge([box.x0, box.y1], [box.x0, box.y0], 12);
  const hitPts = [];
  outline.forEach(([u, w]) => { raycaster.set(pz.pos, frameDir(u, w, pz.q)); const h = raycaster.intersectObjects(shellMeshes, false)[0]; if (h) hitPts.push(h.point.clone().addScaledVector(h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(), 0.012)); });
  raycaster.set(pz.pos, frameDir((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, pz.q));
  const ch = raycaster.intersectObjects(shellMeshes, false)[0]; if (ch) center = ch.point.clone();
  const sev3 = cssColor('--sev3');
  if (hitPts.length > 8) {
    hitPts.push(hitPts[0].clone());
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(hitPts), new THREE.LineBasicMaterial({ color: sev3, depthTest: false })); l.renderOrder = 12; scene.add(l);
    // filled patch (fan)
    if (center) {
      const tri = []; for (let i = 0; i < hitPts.length - 1; i++) { tri.push(center.x, center.y, center.z, hitPts[i].x, hitPts[i].y, hitPts[i].z, hitPts[i + 1].x, hitPts[i + 1].y, hitPts[i + 1].z); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: sev3, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false })); m.renderOrder = 11; scene.add(m);
    }
  }
  const f12 = label(v, `<div class="pin3d draft"><span class="d sev3"></span><span class="l" style="color:var(--sev3)">F12 draft</span></div>`, 'vlabel pinl');
  const f12pos = center || new THREE.Vector3(1.2, 9.6, -0.9);

  // F12 across frames: re-project the back-projected patch into neighbouring frames
  const projectTo = (X, t) => {
    const { pos: cp, q: cq } = interp(pose.samples, t);
    const d = X.clone().sub(cp).applyQuaternion(cq.clone().invert()).normalize();
    const th = Math.acos(Math.max(-1, Math.min(1, -d.z))); const ph = Math.atan2(d.y, d.x); const r = th / THREE.MathUtils.degToRad(57);
    return { u: 0.5 + 0.5 * r * Math.cos(ph), v: 0.5 - 0.5 * r * Math.sin(ph) * 16 / 9, dist: X.distanceTo(cp) };
  };
  const keyTimes = [3.2, PAUSE_T, 5.1, 5.8];
  captureFrames(ASSETS.hcl.clipExt, keyTimes, 240, 135).then(imgs => {
    const host2 = document.getElementById('hcl-keys'); if (!host2) return;
    const ref = projectTo(f12pos, PAUSE_T);
    host2.innerHTML = imgs.map((src, i) => {
      const t = keyTimes[i]; const pr = projectTo(f12pos, t); const k = ref.dist / pr.dist;
      const w = (box.x1 - box.x0) * k * 100, h = (box.y1 - box.y0) * k * 100;
      const key = t === PAUSE_T;
      return `<div class="kfr ${key ? 'key' : ''}" style="background-image:url(${src})"><i class="bx" style="left:${(pr.u * 100 - w / 2).toFixed(1)}%;top:${(pr.v * 100 - h / 2).toFixed(1)}%;width:${w.toFixed(1)}%;height:${h.toFixed(1)}%"></i>${key ? '' : '<em>Proposed</em>'}<span>${t.toFixed(2)} s</span></div>`;
    }).join('');
  });
  // sighting thumbnail from the actual frame
  captureFrames(ASSETS.hcl.clipExt, [PAUSE_T], 160, 90).then(([s]) => { const el = document.getElementById('sight-frame'); if (el && s) { el.style.background = `url(${s}) 62% 40% / 260% auto`; } });

  // sequencer: flight time of F110
  const S0 = pose.clip_start_flight_video_s; // 50 s
  const seq = makeSeq(document.getElementById('seq-hcl'), {
    subtitle: 'Flight 110, external · 22 Nov 2023', filterNote: 'Flight 110',
    t0: S0 - 4, t1: S0 + 16, playhead: S0 + PAUSE_T, maxSpan: 900,
    fmt: t => fmtSec(t).slice(0, 5), tc: t => `00:${fmtSec(t).slice(0, 5)}<small>:${String(Math.floor((t % 1) * 30)).padStart(2, '0')}</small>`,
    range: [S0 + 3.2, S0 + 5.8],
    tracks: [
      { name: 'F110 external', sub: 'video', icon: 'video', active: 1, items: [{ a: S0, b: S0 + 11, label: 'F110 · 110_0262', on: 1, film: 'h110' }] },
      { name: 'F110 log', sub: 'standoff', icon: 'path', kind: 'flight', graph: t => 0.55 + 0.25 * Math.cos((t - S0) / 3.2) },
      { name: 'F12 coating breakdown', sub: 'box track', icon: 'box', keys: [{ t: S0 + PAUSE_T, ac: 1 }, { t: S0 + 3.2, c: 'transparent;border:1.5px dashed var(--sev3)' }, { t: S0 + 5.1, c: 'transparent;border:1.5px dashed var(--sev3)' }, { t: S0 + 5.8, c: 'transparent;border:1.5px dashed var(--sev3)' }] },
      { name: 'Photo captures', sub: 'Elios', icon: 'photo', ticks: [S0 - 2, S0 + 1.5, S0 + 4.9, S0 + 8.4, S0 + 12] },
      { name: 'F108 roof', sub: 'video', icon: 'video', items: [{ a: S0 + 175, b: S0 + 186, label: 'F108' }] },
    ],
  });
  captureFrames(ASSETS.hcl.clipExt, [0.5, 2, 3.5, 5, 6.5, 8, 9.5, 10.8], 128, 72).then(f => { FILM.h110 = f; seq.refreshFilm(); });

  const playBtn = document.getElementById('hcl-play');
  const drawEls = ['drawbox', 'cursorx'].map(id => document.getElementById(id)).concat([document.querySelector('#hcl-vwrap .qpop')]);
  const togglePlay = () => {
    if (video.paused) { video.play(); } else { video.pause(); video.currentTime = PAUSE_T; }
  };
  playBtn.addEventListener('click', togglePlay);
  document.querySelector('#seq-hcl [data-play]').addEventListener('click', togglePlay);
  video.addEventListener('play', () => { drawEls.forEach(e => e && (e.style.visibility = 'hidden')); playBtn.innerHTML = ic('pause', 's14'); document.querySelector('#seq-hcl [data-play]').innerHTML = ic('pause', 's14'); });
  video.addEventListener('pause', () => { drawEls.forEach(e => e && (e.style.visibility = '')); playBtn.innerHTML = ic('play', 's14'); document.querySelector('#seq-hcl [data-play]').innerHTML = ic('play', 's14'); });
  video.addEventListener('ended', () => { video.currentTime = PAUSE_T; });
  document.querySelector('#seq-hcl [data-play]').innerHTML = ic('play', 's14');

  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const upd = gizmo(v, 'hcl');
  const projView = new THREE.Matrix4(); const scrub = document.getElementById('hcl-scrub');
  v.tick = () => {
    const t = video.currentTime || PAUSE_T;
    const { pos: p, q: qq, a } = interp(pose.samples, t);
    projView.compose(p, qq, new THREE.Vector3(1, 1, 1)).invert();
    proj.uniforms.projView.value.copy(projView); proj.uniforms.projPos.value.copy(p);
    drone.position.copy(p); if (a.q_drone) drone.quaternion.fromArray(a.q_drone);
    [[0.08, 0.1], [0.92, 0.1], [0.92, 0.9], [0.08, 0.9]].forEach(([u, w], i) => corners[i].copy(p).addScaledVector(frameDir(u, w, qq), 1.4));
    setFrustum(fr, p, corners);
    pins.forEach(([el, pp]) => placeLabel(v, el, pp));
    placeLabel(v, f12, f12pos);
    setTxt('hcl-tc', fmtSec(t).replace(/(\d\d)\.(\d)$/, '$1.$2') ); setTxt('hcl-hud-t', fmtSec(t));
    const f = t / 11 * 100; scrub.querySelector('.p').style.width = f + '%'; scrub.querySelector('.h').style.left = f + '%';
    seq.setPlayhead(S0 + t);
    upd();
  };
  const BM = { 'Roof NE': [[8.8, 15.6, -10.6], [0.2, 6.9, -0.4]], 'F12 close': [[3.2, 12.6, -4.6], [0.1, 8.6, -1.3]] };
  v.bookmark = name => tween(v, BM[name]);
  v.setMode = mode => {
    tank.traverse(o => { if (o.isMesh && o.material && 'wireframe' in o.material) o.material.wireframe = mode === 'Wireframe'; });
    cloud.visible = mode !== 'Lit';
    cloudMat.size = mode === 'Point cloud EDL' ? 0.022 : 0.016;
  };
}

/* ======================================================================== loop */
let last = performance.now(), frames = 0, acc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const v = views[active]; if (!v || !v.host.clientWidth) return;
  if (v.anim) v.anim(now);
  v.controls.update();
  v.renderNow();
  frames++; acc += now - last; last = now;
  if (acc > 500) { const f = Math.round(frames * 1000 / acc); const e = document.getElementById('fps'); if (e && f >= 15) e.textContent = Math.min(60, f) + ' fps'; frames = 0; acc = 0; }
  if (v.autoplay && v.video && v.video.paused && !v.userPaused && v.video.readyState > 2 && now - (v.lastKick || 0) > 1000) { v.lastKick = now; v.video.play().catch(() => {}); }
}
requestAnimationFrame(loop);
// Watchdog: if rAF is throttled (hidden pane, background tab, long layout transition) keep the active view drawn.
setInterval(() => {
  const v = views[active]; if (!v || !v.host.clientWidth) return;
  v.resize();
  if (performance.now() - (v.lastRender || 0) > 250) { v.controls.update(); v.renderNow(); }
}, 120);
document.getElementById('app')?.addEventListener('transitionend', () => Object.values(views).forEach(v => { v.resize(); v.renderNow(); }));

/* label declutter: higher priority first, overlapping labels collapse to a dot that expands on hover */
function declutter(list) {
  const placed = [];
  list.sort((a, b) => b.pri - a.pri).forEach(L => {
    const el = L.el; if (el.style.display === 'none') return;
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform); if (!m) return;
    const x = +m[1], y = +m[2];
    if (!el._w) { el.classList.remove('dot'); el._w = el.offsetWidth || 90; el._h = el.offsetHeight || 40; }
    const r = el.classList.contains('pinl') ? { l: x - 6, r: x + el._w, t: y - 8, b: y + 8 } : { l: x - el._w / 2, r: x + el._w / 2, t: y - el._h, b: y };
    const hit = placed.some(p => r.l < p.r + 4 && r.r > p.l - 4 && r.t < p.b + 2 && r.b > p.t - 2);
    el.classList.toggle('dot', hit && L.pri < 10);
    if (!hit || L.pri >= 10) placed.push(r);
  });
}

export function init(which) {
  const fn = which === 'alzour' ? initAlzour : initHcl;
  fn().catch(err => {
    console.error(err);
    const host = document.getElementById(which === 'alzour' ? 'vp-az' : 'vp-hcl');
    const l = host && host.querySelector('[data-loading]'); if (l) l.innerHTML = `<span style="color:var(--sev4)">Could not load the scene: ${err.message}</span>`;
  });
}

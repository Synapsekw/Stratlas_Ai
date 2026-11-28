import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const assets = '../assets/fusion/';
const light = document.body.dataset.direction === 'atlas';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const stage = $('.reality-stage');
const video = $('.source-video');
const status = $('.load-status');
let mode = 'fusion',
  overlay = 'model',
  orbit = light,
  split = light ? 100 : 54,
  targetSplit = split;
let flight,
  model,
  cloud,
  map,
  ready = false,
  playing = false,
  drag = false,
  pointerX = 0,
  pointerY = 0;
let lastStamp = 0,
  frameCount = 0;
const views = {
  video: [
    '01 / CAPTURED REALITY',
    'The view you captured.',
    'Original drone footage. Every frame retains its place along the flight.',
  ],
  model: [
    '02 / STRUCTURAL REALITY',
    'See what the camera cannot.',
    'Fly the same route through the engineering model. Read the structure beneath the surface.',
  ],
  cloud: [
    '03 / MEASURED REALITY',
    'Reality, point by point.',
    'The actual survey point cloud, seen from the recorded drone position.',
  ],
  map: [
    '04 / GEOGRAPHIC REALITY',
    'The wider context.',
    'The orthomosaic becomes the ground beneath your flight. One viewpoint, a different layer.',
  ],
  fusion: [
    '05 / AUGMENTED REALITY',
    'Move between worlds.',
    'Drag the boundary. The footage and spatial view follow the same recorded camera path.',
  ],
};
const renderer = new THREE.WebGLRenderer({
  alpha: false,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = light ? 1 : 1.05;
renderer.setClearColor(light ? 0xe7e7df : 0x0a1419);
renderer.domElement.setAttribute('aria-label', 'Live 3D view aligned with the drone flight');
$('.spatial-canvas').append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 15000);
scene.add(new THREE.HemisphereLight(light ? 0xf8ffff : 0xd8f2ff, 0x4d514d, 2.5));
const sun = new THREE.DirectionalLight(0xffead0, 3.8);
sun.position.set(-400, 950, 200);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9ecfd7, 2.0);
rim.position.set(350, 300, -500);
scene.add(rim);
const p1 = new THREE.Vector3(),
  p2 = new THREE.Vector3(),
  q1 = new THREE.Quaternion(),
  q2 = new THREE.Quaternion();
const orbitPosition = new THREE.Vector3(-350, 650, 820),
  orbitTarget = new THREE.Vector3(300, 0, -30);

function resize() {
  const w = stage.clientWidth,
    h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const aspect = flight?.aspect || 16 / 9;
  camera.fov = THREE.MathUtils.radToDeg(
    2 *
      Math.atan(
        Math.tan(THREE.MathUtils.degToRad((flight?.hfov || 70.9) / 2)) /
          Math.max(camera.aspect, aspect),
      ),
  );
  if (orbit) camera.fov = 43;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function selectMode(next, manual = true) {
  if (orbit && next === 'fusion' && manual) setOrbit(false);
  mode = next;
  if (next !== 'video' && next !== 'fusion') overlay = next;
  if (next === 'fusion' && overlay === 'map') overlay = 'model';
  if (orbit && next === 'video') setOrbit(false);
  targetSplit = next === 'video' ? 0 : next === 'fusion' ? 54 : 100;
  if (reduced.matches) split = targetSplit;
  $$('.mode-button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === next)),
  );
  $('.mode-index').textContent = views[next][0];
  $('.view-title').textContent = views[next][1];
  $('.view-description').textContent = views[next][2];
  $('.layer-label').textContent =
    overlay === 'model'
      ? 'Engineering model'
      : overlay === 'cloud'
        ? 'Survey point cloud'
        : 'Orthomosaic';
  $('.wipe-control').hidden = next !== 'fusion' || orbit;
  $('.left-label').hidden = next === 'video';
  $('.right-label').hidden = next !== 'fusion' && next !== 'video';
  $('.mode-description').textContent = orbit
    ? 'Move your cursor to explore'
    : next === 'fusion'
      ? 'Drag to change reality'
      : views[next][0].slice(5).toLowerCase();
  stage.dataset.mode = next;
  if (manual) stage.dataset.interacted = 'true';
}
function setOrbit(value) {
  orbit = value;
  $$('.perspective-button').forEach((b) =>
    b.setAttribute('aria-pressed', String((b.dataset.perspective === 'orbit') === orbit)),
  );
  stage.dataset.perspective = orbit ? 'orbit' : 'drone';
  $('.wipe-control').hidden = mode !== 'fusion' || orbit;
  $('.camera-label').textContent = orbit ? 'Free spatial view' : 'Drone eye / pose linked';
  $('.fusion-label').hidden = orbit;
  $('.mode-description').textContent = orbit
    ? 'Move your cursor to explore'
    : mode === 'fusion'
      ? 'Drag to change reality'
      : views[mode][0].slice(5).toLowerCase();
  resize();
}
function setPlayback(value) {
  if (value) {
    video
      .play()
      .then(() => {
        playing = true;
        syncPlay();
      })
      .catch(() => {
        playing = false;
        syncPlay();
      });
  } else {
    video.pause();
    playing = false;
    syncPlay();
  }
}
function syncPlay() {
  $$('.play-toggle').forEach((b) => {
    b.setAttribute('aria-label', playing ? 'Pause flight' : 'Play flight');
    b.innerHTML = playing
      ? '<span aria-hidden="true">Ⅱ</span><span>Pause flight</span>'
      : '<span aria-hidden="true">▷</span><span>Play flight</span>';
  });
}
$$('.play-toggle').forEach((b) => b.addEventListener('click', () => setPlayback(!playing)));
$$('.mode-button').forEach((b) => b.addEventListener('click', () => selectMode(b.dataset.mode)));
$$('.perspective-button').forEach((b) =>
  b.addEventListener('click', () => setOrbit(b.dataset.perspective === 'orbit')),
);
$('.fusion-range').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  if (mode !== 'fusion') selectMode('fusion');
  targetSplit = split = value;
});
$('.timeline-input').addEventListener('input', (e) => {
  video.currentTime = Number(e.target.value);
});
stage.addEventListener('pointermove', (e) => {
  if (!orbit || reduced.matches) return;
  const r = stage.getBoundingClientRect();
  pointerX = (e.clientX - r.left) / r.width - 0.5;
  pointerY = (e.clientY - r.top) / r.height - 0.5;
});
const handle = $('.wipe-handle');
handle.tabIndex = 0;
handle.setAttribute('role', 'slider');
handle.setAttribute('aria-label', 'Fusion boundary');
handle.setAttribute('aria-valuemin', '0');
handle.setAttribute('aria-valuemax', '100');
handle.addEventListener('keydown', (e) => {
  const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!delta && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  split = targetSplit =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? 100
        : THREE.MathUtils.clamp(targetSplit + delta, 0, 100);
  $('.fusion-range').value = String(split);
  handle.setAttribute('aria-valuenow', String(Math.round(split)));
});
handle.addEventListener('pointerdown', (e) => {
  drag = true;
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = stage.getBoundingClientRect();
  split = targetSplit = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
  $('.fusion-range').value = String(split);
});
handle.addEventListener('pointerup', () => (drag = false));
handle.addEventListener('pointercancel', () => (drag = false));
$('.enter-flight')?.addEventListener('click', () => {
  setOrbit(false);
  selectMode('fusion');
  setPlayback(true);
  stage.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
});

function updateCamera() {
  if (orbit) {
    camera.position.copy(orbitPosition);
    camera.position.x += pointerX * 80;
    camera.position.y += pointerY * 40;
    camera.lookAt(orbitTarget);
  } else if (flight) {
    const t = Math.min(video.currentTime, 10.999) * 10;
    const a = flight.samples[Math.floor(t)],
      b = flight.samples[Math.min(Math.floor(t) + 1, flight.samples.length - 1)];
    camera.position.copy(p1.fromArray(a.pos).lerp(p2.fromArray(b.pos), t % 1));
    camera.quaternion.copy(q1.fromArray(a.q).slerp(q2.fromArray(b.q), t % 1));
  }
}
function animate(stamp) {
  requestAnimationFrame(animate);
  if (document.hidden) return;
  // Throttle the idle hero to 30 fps; the data remains coupled to video.currentTime.
  if (stamp - lastStamp < 30) return;
  lastStamp = stamp;
  const r = stage.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  split += (targetSplit - split) * (reduced.matches ? 1 : 0.13);
  const effectiveSplit = orbit ? 100 : split;
  $('.spatial-canvas').style.clipPath = `inset(0 ${100 - effectiveSplit}% 0 0)`;
  $('.wipe-control').style.left = `${split}%`;
  handle.setAttribute('aria-valuenow', String(Math.round(split)));
  if (model) model.visible = overlay === 'model';
  if (cloud) cloud.visible = overlay === 'cloud';
  if (map) map.visible = overlay === 'map';
  updateCamera();
  renderer.render(scene, camera);
  frameCount++;
  if (frameCount % 5 === 0) {
    const sec = video.currentTime || 0;
    $('.timecode').textContent = `00:${sec.toFixed(1).padStart(4, '0')}`;
    $('.timeline-input').value = String(sec);
    $('.altitude').textContent = flight ? `${camera.position.y.toFixed(1)} m` : '...';
  }
}
requestAnimationFrame(animate);

try {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [gltf, pathData, placement, xyz, rgb, texture] = await Promise.all([
    loader.loadAsync(assets + 'site.glb'),
    fetch(assets + 'flight.json').then((r) => r.json()),
    fetch(assets + 'survey.json').then((r) => r.json()),
    fetch(assets + 'cloud.xyz').then((r) => r.arrayBuffer()),
    fetch(assets + 'cloud.rgb').then((r) => r.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(assets + 'survey.jpg'),
  ]);
  flight = pathData;
  model = gltf.scene;
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (/sea|mainland/i.test(o.name)) o.visible = false;
    if (/sea|land|terrain/i.test(o.name)) {
      o.material = new THREE.MeshStandardMaterial({
        color: light ? 0x82958a : 0x263e47,
        roughness: 1,
      });
    } else {
      o.material = new THREE.MeshStandardMaterial({
        color: light ? 0x607f78 : 0x84a4a6,
        metalness: 0.25,
        roughness: 0.6,
        side: THREE.DoubleSide,
      });
    }
  });
  scene.add(model);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(xyz), 3));
  const colorBytes = new Uint8Array(rgb);
  const colors = new Float32Array(colorBytes.length);
  const c = new THREE.Color();
  for (let i = 0; i < colorBytes.length; i += 3) {
    c.setRGB(
      colorBytes[i] / 255,
      colorBytes[i + 1] / 255,
      colorBytes[i + 2] / 255,
      THREE.SRGBColorSpace,
    );
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  cloud = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: orbit ? 1.6 : 1.25,
      sizeAttenuation: false,
      vertexColors: true,
    }),
  );
  scene.add(cloud);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const quad = new THREE.BufferGeometry();
  const corners = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];
  quad.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      corners.flatMap((k) => [placement[k][0], 0.3, placement[k][1]]),
      3,
    ),
  );
  quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  quad.setIndex([0, 2, 1, 0, 3, 2]);
  quad.computeVertexNormals();
  map = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
  scene.add(map);
  ready = true;
  stage.dataset.ready = 'true';
  status.textContent = 'Spatial layers ready';
  status.classList.add('loaded');
  setOrbit(orbit);
  selectMode(light ? 'model' : 'fusion', false);
  resize();
  if (!reduced.matches) setPlayback(true);
} catch (error) {
  console.error(error);
  status.textContent = 'Spatial preview unavailable. Drone footage remains available.';
  stage.dataset.ready = 'error';
  $('.spatial-canvas').hidden = true;
  $('.wipe-control').hidden = true;
  setPlayback(!reduced.matches);
}

// A native scroll sequence changes the visible layer without stealing wheel/touch input.
const chapters = $$('.chapter');
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        const id = entry.target.dataset.chapter;
        $$('.chapter-marker').forEach((b) => b.classList.toggle('active', b.dataset.for === id));
        entry.target.classList.add('revealed');
      }
  },
  { threshold: 0.45 },
);
chapters.forEach((c) => observer.observe(c));
window.addEventListener(
  'scroll',
  () => {
    const hero = $('.hero');
    const y = Math.min(scrollY / Math.max(hero.offsetHeight, 1), 1);
    if (!reduced.matches) {
      $('.hero-copy').style.transform = `translateY(${-y * 70}px)`;
      $('.hero-copy').style.opacity = String(Math.max(0, 1 - y * 1.6));
    }
    document.body.classList.toggle('scrolled', scrollY > 80);
    const stack = $('.layer-stack');
    const rect = stack.getBoundingClientRect();
    if (!reduced.matches && rect.bottom > 0 && rect.top < innerHeight) {
      const progress = THREE.MathUtils.clamp(
        (innerHeight - rect.top) / (innerHeight + rect.height),
        0,
        1,
      );
      stack.style.transform = `translateY(${(progress - 0.5) * -50}px)`;
      $$('.stack-layer').forEach((layer, i) => {
        layer.style.translate = `0 ${(progress - 0.5) * (i - 1.5) * 55}px`;
      });
    }
  },
  { passive: true },
);
$$('[data-jump-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    setOrbit(false);
    selectMode(b.dataset.jumpMode);
    stage.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
  }),
);
const dialog = $('#product-dialog');
$$('[data-product]').forEach((b) =>
  b.addEventListener('click', () => {
    dialog.showModal();
    setPlayback(false);
  }),
);
$('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
// Deliberately small, read-only hook for verifying camera linkage and viewport behavior.
window.fusionPreview = {
  getState: () => ({
    ready,
    mode,
    overlay,
    orbit,
    split: targetSplit,
    time: video.currentTime,
    playing,
    position: camera.position.toArray(),
    pointCount: cloud?.geometry.attributes.position.count,
    frameCount,
  }),
};

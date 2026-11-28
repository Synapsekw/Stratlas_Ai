import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const root = '../assets/corrosion/';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  ready: false,
  selected: 'F04',
  view: 'whole',
  masks: true,
  opacity: 0.85,
  classFilter: 'all',
  isolated: false,
};
let data,
  scene,
  camera,
  renderer,
  controls,
  model,
  photoPixels,
  sceneVisible = true,
  transition = null,
  lastFrame = 0,
  photoRequest = 0;
const patches = [],
  modelMeshes = [],
  ray = new THREE.Raycaster();
const host = $('.corrosion-canvas');
const loadingControls = $$(
  '.corrosion-controls button,.corrosion-controls input,#corrosion-finding,.previous-finding,.next-finding,.reset-corrosion,[data-finding]',
);
loadingControls.forEach((e) => (e.disabled = true));
$('.menu-toggle')?.addEventListener('click', () => {
  const open = $('.menu-toggle').getAttribute('aria-expanded') !== 'true';
  $('.menu-toggle').setAttribute('aria-expanded', String(open));
  $('#site-navigation').dataset.open = String(open);
});
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load inspection image'));
    image.src = src;
  });
function pixels(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return {
    canvas,
    context,
    original: context.getImageData(0, 0, canvas.width, canvas.height),
  };
}
function keepClass(value) {
  return (
    state.classFilter === 'all' ||
    (state.classFilter === 'light' && value === 1) ||
    (state.classFilter === 'moderate' && value === 2)
  );
}
function textureClass(r, g, b) {
  if (r > 180 && g > 175 && b < 140) return 1;
  if (r > 180 && g < 175 && b < 140) return 2;
  return 0;
}
function paintPhoto() {
  if (!photoPixels) return;
  const canvas = $('.corrosion-photo-mask');
  canvas.width = photoPixels.width;
  canvas.height = photoPixels.height;
  const context = canvas.getContext('2d');
  const target = context.createImageData(canvas.width, canvas.height);
  const palette = { 1: [250, 211, 75], 2: [255, 122, 45] };
  for (let i = 0; i < target.data.length; i += 4) {
    const value = photoPixels.data[i],
      color = palette[value];
    if (color && keepClass(value)) {
      target.data.set(color, i);
      target.data[i + 3] = 255;
    }
  }
  context.putImageData(target, 0, 0);
  canvas.style.opacity = state.masks ? state.opacity : 0;
}
function paintMasks() {
  for (const p of patches) {
    const bytes = new Uint8ClampedArray(p.original.data);
    for (let i = 0; i < bytes.length; i += 4) {
      if (!keepClass(textureClass(bytes[i], bytes[i + 1], bytes[i + 2]))) bytes[i + 3] = 0;
    }
    p.context.putImageData(new ImageData(bytes, p.canvas.width, p.canvas.height), 0, 0);
    p.texture.needsUpdate = true;
  }
  paintPhoto();
}
function updateVisibility() {
  for (const p of patches) {
    p.mesh.visible = state.masks && (!state.isolated || p.record.id === state.selected);
    p.mesh.material.opacity = state.opacity;
    p.mesh.renderOrder = p.record.id === state.selected ? 3 : 2;
  }
  $('.visible-patches').textContent = state.masks
    ? `${state.isolated ? '1 SELECTED' : patches.length + ' MAPPED'} ${state.isolated ? 'PATCH' : 'PATCHES'}`
    : 'MASKS HIDDEN';
  $('.corrosion-photo-mask').style.opacity = state.masks ? state.opacity : 0;
}
function setView(view, animate = true) {
  state.view = view;
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (!camera) return;
  const r = data.records.find((r) => r.id === state.selected);
  const target = new THREE.Vector3(...r.center);
  let position,
    fov = 42;
  if (view === 'whole') {
    target.set(0, 40, 0);
    position = new THREE.Vector3(57, 53, 106);
  } else if (view === 'photo') {
    position = new THREE.Vector3(...r.camera.pos);
    fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(
          Math.tan(THREE.MathUtils.degToRad(r.camera.lens.hfovDeg / 2)) /
            Math.min(camera.aspect, r.camera.lens.aspect),
        ),
    );
  } else {
    const direction = new THREE.Vector3(r.camera.pos[0] - target.x, 0, r.camera.pos[2] - target.z)
      .normalize()
      .setY(0.23)
      .normalize();
    const p = patches.find((p) => p.record.id === r.id);
    const size = p.mesh.geometry.boundingSphere.radius;
    position = target.clone().addScaledVector(direction, Math.max(6.8, Math.min(14, size * 4.8)));
  }
  controls.enabled = view !== 'photo';
  if (view === 'photo' || !animate || reduced.matches) {
    transition = null;
    camera.position.copy(position);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    if (view === 'photo') {
      camera.quaternion.fromArray(r.camera.q).normalize();
    } else {
      camera.lookAt(target);
      controls.update();
    }
  } else
    transition = {
      start: performance.now(),
      from: camera.position.clone(),
      to: position,
      fromTarget: controls.target.clone(),
      target,
      fromFov: camera.fov,
      fov,
    };
}
async function selectFinding(id, move = true) {
  const r = data.records.find((r) => r.id === id);
  if (!r) return;
  state.selected = id;
  $('#corrosion-finding').value = id;
  $('.selected-component').textContent = r.component;
  $('.selected-coordinate').textContent = `${r.id} · ${r.center[1].toFixed(1)} m above datum`;
  $('.source-photo-id').textContent = r.photoId;
  $('.corrosion-title').textContent = r.title.split(',')[0];
  $('.corrosion-description').textContent = r.description;
  $('.corrosion-zone').textContent = r.zone;
  $('.corrosion-grade').textContent = `${r.severity} / ${r.severity === 1 ? 'Light' : 'Moderate'}`;
  $('.corrosion-coverage').textContent = `${r.coverage.toFixed(2)}%`;
  $('.scene-height-rail i').style.top = `${100 - Math.min(100, (r.center[1] / 80) * 100)}%`;
  $('.corrosion-source').alt = `Source photo ${r.photoId}: ${r.description}`;
  updateVisibility();
  if (move) setView(state.view);
  const request = ++photoRequest;
  photoPixels = null;
  $('.corrosion-photo-mask')
    .getContext('2d')
    .clearRect(0, 0, $('.corrosion-photo-mask').width, $('.corrosion-photo-mask').height);
  $('.corrosion-source').src = root + r.photo;
  try {
    const image = await loadImage(root + r.mask);
    if (request !== photoRequest) return;
    photoPixels = pixels(image).original;
    paintPhoto();
  } catch {
    if (request === photoRequest) $('.photo-mask-caption').textContent = 'SOURCE MASK UNAVAILABLE';
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  if (!sceneVisible || document.hidden || now - lastFrame < 32) return;
  lastFrame = now;
  if (transition) {
    const t = Math.min(1, (now - transition.start) / 850),
      e = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(transition.from, transition.to, e);
    controls.target.lerpVectors(transition.fromTarget, transition.target, e);
    camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.fov, e);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    if (t === 1) transition = null;
  }
  if (state.view !== 'photo') controls.update();
  renderer.render(scene, camera);
}
function resize() {
  if (!renderer) return;
  const { width, height } = host.getBoundingClientRect();
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (state.view === 'photo' && data) setView('photo', false);
}
function pick(event) {
  if (!state.masks || !state.opacity) return;
  const rect = host.getBoundingClientRect();
  ray.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  const surface = ray.intersectObjects(modelMeshes, false)[0];
  for (const hit of ray.intersectObjects(
    patches.filter((p) => p.mesh.visible).map((p) => p.mesh),
    false,
  )) {
    if (surface && hit.distance > surface.distance + 0.1) continue;
    const p = patches.find((p) => p.mesh === hit.object);
    const x = Math.min(p.canvas.width - 1, Math.max(0, Math.floor(hit.uv.x * p.canvas.width)));
    const y = Math.min(
      p.canvas.height - 1,
      Math.max(0, Math.floor((1 - hit.uv.y) * p.canvas.height)),
    );
    const i = (y * p.canvas.width + x) * 4;
    if (
      p.original.data[i + 3] > 20 &&
      keepClass(textureClass(...p.original.data.slice(i, i + 3)))
    ) {
      selectFinding(p.record.id, false);
      break;
    }
  }
}
async function init() {
  try {
    const response = await fetch(root + 'data.json');
    if (!response.ok) throw new Error('Inspection data unavailable');
    data = await response.json();
    $('#corrosion-finding').innerHTML = data.records
      .map((r) => `<option value="${r.id}">${r.id} / ${r.component}</option>`)
      .join('');
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0f13');
    camera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    host.append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 1.2;
    controls.maxDistance = 200;
    controls.addEventListener('start', () => {
      transition = null;
    });
    scene.add(new THREE.HemisphereLight(0xe1f0dd, 0x617073, 2.6));
    const key = new THREE.DirectionalLight(0xfff3df, 3.3);
    key.position.set(20, 100, 35);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc4e0ed, 2.8);
    rim.position.set(-20, 55, -20);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 1.6);
    fill.position.set(-15, 65, 45);
    scene.add(fill);
    const [gltf, binary] = await Promise.all([
      new GLTFLoader().loadAsync(root + 'stack.glb'),
      fetch(root + 'patches.bin').then((r) => {
        if (!r.ok) throw new Error('Surface geometry unavailable');
        return r.arrayBuffer();
      }),
    ]);
    model = gltf.scene;
    model.applyMatrix4(new THREE.Matrix4().fromArray(data.transform));
    model.traverse((n) => {
      if (n.isMesh) {
        modelMeshes.push(n);
        for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
          m.metalness = Math.min(m.metalness, 0.3);
          m.roughness = Math.max(m.roughness, 0.65);
        }
      }
    });
    scene.add(model);
    const grid = new THREE.GridHelper(45, 30, 0x395450, 0x203c3e);
    grid.position.y = -0.35;
    scene.add(grid);
    await Promise.all(
      data.records.map(async (r) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(binary, r.offset, r.vertexCount * 3), 3),
        );
        geometry.setAttribute(
          'uv',
          new THREE.BufferAttribute(
            new Float32Array(binary, r.offset + r.vertexCount * 12, r.vertexCount * 2),
            2,
          ),
        );
        geometry.computeBoundingSphere();
        const image = await loadImage(root + r.texture);
        const p = pixels(image);
        const texture = new THREE.CanvasTexture(p.canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: state.opacity,
          depthWrite: false,
          depthTest: true,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          toneMapped: false,
          alphaTest: 0.025,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 2;
        scene.add(mesh);
        patches.push({ ...p, texture, mesh, record: r });
      }),
    );
    new ResizeObserver(resize).observe(host);
    new IntersectionObserver(
      ([entry]) => {
        sceneVisible = entry.isIntersecting;
      },
      { rootMargin: '150px' },
    ).observe(host);
    resize();
    await selectFinding('F04', false);
    setView('whole', false);
    state.ready = true;
    loadingControls.forEach((e) => (e.disabled = false));
    $('.corrosion-status').textContent = 'REAL MODEL + MAPPED CORROSION MASKS';
    requestAnimationFrame(frame);
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => {
      down = [e.clientX, e.clientY];
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) pick(e);
      down = null;
    });
  } catch (error) {
    $('.corrosion-status').textContent = '3D VIEW UNAVAILABLE';
    host.innerHTML =
      '<p class="corrosion-unavailable">The interactive model could not load. Reload the page in a browser with WebGL enabled to explore the mapped masks.</p>';
    console.error(error);
    $$('.corrosion-controls button,.corrosion-controls input').forEach((e) => (e.disabled = true));
  }
}
$$('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    setView(b.dataset.view);
    if (innerWidth <= 760)
      $('.corrosion-viewport').scrollIntoView({
        behavior: reduced.matches ? 'instant' : 'smooth',
        block: 'start',
      });
  }),
);
$('.reset-corrosion').addEventListener('click', () => setView('detail'));
$('.toggle-masks').addEventListener('click', () => {
  state.masks = !state.masks;
  $('.toggle-masks').setAttribute('aria-pressed', String(state.masks));
  $('.toggle-masks').textContent = state.masks ? 'Masks on' : 'Masks off';
  updateVisibility();
});
$('#mask-opacity').addEventListener('input', (e) => {
  state.opacity = Number(e.target.value) / 100;
  $('.mask-opacity-value').textContent = `${e.target.value}%`;
  updateVisibility();
});
$$('[data-class]').forEach((b) =>
  b.addEventListener('click', () => {
    state.classFilter = b.dataset.class;
    $$('[data-class]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paintMasks();
  }),
);
$('#isolate-finding').addEventListener('change', (e) => {
  state.isolated = e.target.checked;
  updateVisibility();
});
$('#corrosion-finding').addEventListener('change', (e) => selectFinding(e.target.value));
function step(direction) {
  if (!data) return;
  const index = data.records.findIndex((r) => r.id === state.selected);
  selectFinding(data.records[(index + direction + data.records.length) % data.records.length].id);
}
$('.previous-finding').addEventListener('click', () => step(-1));
$('.next-finding').addEventListener('click', () => step(1));
$$('[data-finding]').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = 'detail';
    selectFinding(b.dataset.finding);
    $('.corrosion-workspace').scrollIntoView({
      behavior: reduced.matches ? 'instant' : 'smooth',
      block: 'start',
    });
  }),
);
window.corrosionPreview = {
  getState: () => ({
    ...state,
    patchCount: patches.length,
    visibleCount: patches.filter((p) => p.mesh.visible).length,
    photoReady: !!photoPixels,
    camera: camera?.position.toArray(),
    quaternion: camera?.quaternion.toArray(),
    target: controls?.target.toArray(),
    vertexCount: patches.reduce((n, p) => n + p.record.vertexCount, 0),
  }),
  projectSelected: () => {
    if (!camera) return null;
    const r = data.records.find((r) => r.id === state.selected);
    const v = new THREE.Vector3(...r.center).project(camera);
    const rect = host.getBoundingClientRect();
    return {
      x: rect.x + ((v.x + 1) * rect.width) / 2,
      y: rect.y + ((1 - v.y) * rect.height) / 2,
    };
  },
};
init();

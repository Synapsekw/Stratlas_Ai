import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// Use the desktop app's actual projection, lens mapping and depth-occlusion code.
import { Projector } from '../../../packages/video/src/projector.ts';

const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const assets = '../assets/fusion/',
  stage = $('.atlas-scene'),
  host = $('.atlas-canvas'),
  video = $('.atlas-video-source');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  ready: false,
  projecting: true,
  cloudReady: false,
  tourStep: 0,
  touring: false,
  manual: false,
  cloud: false,
  video: false,
  rotating: !reduced.matches,
  view: 'plant',
  pointCount: 0,
  frames: 0,
};
let renderer,
  scene,
  camera,
  controls,
  model,
  cloud,
  flight,
  projector,
  drone,
  frustum,
  flightPath,
  transition;
let layerTransition = null;
let orbitLeveling = null;
const worldUp = new THREE.Vector3(0, 1, 0);
const layerAmounts = { cloud: 0, model: 1, flight: 0, projection: 0 };
let layerTargets = { ...layerAmounts };
const flightMaterials = new Map();
const smoothStep = (t) => t * t * (3 - 2 * t);
let cloudPromise = null;
let lastStamp = 0,
  lastPose = -1,
  visible = true,
  resumePlayback = false,
  playRequest = 0;
const receivers = [],
  materials = [],
  p1 = new THREE.Vector3(),
  p2 = new THREE.Vector3(),
  q1 = new THREE.Quaternion(),
  q2 = new THREE.Quaternion();
const pose = { pos: new THREE.Vector3(), q: new THREE.Quaternion() };
const defaultTarget = new THREE.Vector3(150, 0, -65),
  flightTarget = new THREE.Vector3(240, 20, -50);
const inputs = $$(
  '#atlas-cloud,#atlas-video,.atlas-launch,.atlas-rotation,.atlas-reset,.atlas-play,.atlas-flight-view,.atlas-drone-eye,.atlas-seek',
);
inputs.forEach((b) => (b.disabled = true));
function syncUI() {
  $('#atlas-cloud').checked = state.cloud;
  $('#atlas-video').checked = state.video;
  $('.atlas-flight-panel').hidden = !state.video;
  $('.atlas-height-legend').hidden = !state.cloud;
  $('.atlas-layer-count').textContent = `0${1 + Number(state.cloud) + Number(state.video)} / 03`;
  $('.atlas-current-view').textContent = state.video
    ? state.cloud
      ? 'Elevation + projected footage'
      : 'Drone footage on the model'
    : state.cloud
      ? 'Survey points coloured by height'
      : 'Engineering geometry';
  $('.atlas-rotation').setAttribute('aria-pressed', String(state.rotating));
  $('.atlas-rotation').textContent = state.rotating ? 'Ⅱ Pause rotation' : '↻ Rotate model';
  $('.atlas-play').textContent = video.paused ? 'Play' : 'Pause';
  $('.atlas-play').setAttribute(
    'aria-label',
    video.paused ? 'Play drone flight' : 'Pause drone flight',
  );
  $('.atlas-drone-eye').setAttribute('aria-pressed', String(state.view === 'drone'));
  $('.atlas-flight-view').setAttribute('aria-pressed', String(state.view === 'flight'));
  $('.atlas-hero').dataset.eye = String(state.view === 'drone');
  if (state.manual && $('.q-tour-caption')) {
    $('.q-tour-caption strong').textContent = 'Explore your view.';
    $('.q-tour-caption span').textContent =
      $('.atlas-current-view').textContent + '. Replay the tour to return to the guided sequence.';
  }
}
function syncLayers() {
  const showCloud = state.cloud && state.cloudReady;
  const next = {
    cloud: showCloud ? (state.video ? 0.42 : 1) : 0,
    model: showCloud && !state.video ? 0.25 : 1,
    flight: state.video && state.view !== 'drone' ? 1 : 0,
    projection: state.video && state.projecting && video.readyState >= 2 ? 1 : 0,
  };
  if (reduced.matches || !state.ready) {
    Object.assign(layerAmounts, next);
    layerTransition = null;
  } else if (Object.keys(next).some((key) => next[key] !== layerTargets[key])) {
    layerTransition = { elapsed: 0, from: { ...layerAmounts }, to: next };
  }
  layerTargets = next;
  applyLayers();
  if (controls) controls.autoRotate = state.rotating && state.view !== 'drone';
  syncUI();
}
function applyLayers() {
  if (cloud) {
    cloud.visible = layerAmounts.cloud > 0;
    cloud.material.opacity = layerAmounts.cloud;
    cloud.material.transparent = layerAmounts.cloud < 1;
    cloud.material.depthWrite = layerAmounts.cloud === 1;
  }
  for (const m of materials) {
    m.opacity = layerAmounts.model;
    m.transparent = layerAmounts.model < 1;
    m.depthWrite = layerAmounts.model === 1;
  }
  for (const object of [drone, frustum, flightPath])
    if (object) object.visible = layerAmounts.flight > 0;
  for (const [material, opacity] of flightMaterials) {
    material.opacity = opacity * layerAmounts.flight;
  }
  // Opacity alone must not recalibrate the lens or invalidate its depth map.
  if (projector) projector.uniforms.aioProjOpacity.value = 0.97 * layerAmounts.projection;
  projector?.setEnabled(layerAmounts.projection > 0 && video.readyState >= 2);
}
function animateLayers(dt) {
  if (!layerTransition) return;
  layerTransition.elapsed += dt;
  const t = Math.min(1, layerTransition.elapsed / 0.85);
  const eased = smoothStep(t);
  for (const key of Object.keys(layerAmounts)) {
    layerAmounts[key] = THREE.MathUtils.lerp(
      layerTransition.from[key],
      layerTransition.to[key],
      eased,
    );
  }
  if (t === 1) layerTransition = null;
  applyLayers();
}
function timePose() {
  if (!flight) return;
  const value = THREE.MathUtils.clamp(video.currentTime, 0, 11) * 10;
  const a = flight.samples[Math.min(Math.floor(value), flight.samples.length - 1)],
    b = flight.samples[Math.min(Math.floor(value) + 1, flight.samples.length - 1)];
  pose.pos.copy(p1.fromArray(a.pos).lerp(p2.fromArray(b.pos), value % 1));
  pose.q.copy(q1.fromArray(a.q).slerp(q2.fromArray(b.q), value % 1));
}
function updateFlight() {
  timePose();
  if (!flight || !drone) return;
  drone.position.copy(pose.pos);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.q);
  drone.rotation.y = Math.atan2(-forward.x, -forward.z);
  projector.setPose(pose.pos, pose.q);
  const tanH = Math.tan(THREE.MathUtils.degToRad(flight.hfov / 2)),
    tanV = tanH / flight.aspect;
  const corners = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ].map(([x, y]) => {
    const dir = new THREE.Vector3(x * tanH, y * tanV, -1).normalize().applyQuaternion(pose.q);
    const d = dir.y < -0.01 ? Math.min(1800, -pose.pos.y / dir.y) : 1800;
    return pose.pos.clone().addScaledVector(dir, d);
  });
  const positions = frustum.geometry.attributes.position;
  for (let i = 0; i < 4; i++) {
    pose.pos.toArray(positions.array, i * 12);
    corners[i].toArray(positions.array, i * 12 + 3);
    corners[i].toArray(positions.array, i * 12 + 6);
    corners[(i + 1) % 4].toArray(positions.array, i * 12 + 9);
  }
  positions.needsUpdate = true;
  frustum.geometry.computeBoundingSphere();
  if (state.view === 'drone' && !transition) {
    camera.position.copy(pose.pos);
    camera.quaternion.copy(pose.q);
  }
  const t = video.currentTime;
  $('.atlas-time').textContent = `00:${t.toFixed(1).padStart(4, '0')}`;
  $('.atlas-seek').value = String(t);
  $('.atlas-drone-label b').textContent = `${pose.pos.y.toFixed(1)} m`;
  lastPose = t;
}
function viewFov(view) {
  return view === 'drone' && flight
    ? THREE.MathUtils.radToDeg(
        2 *
          Math.atan(
            Math.tan(THREE.MathUtils.degToRad(flight.hfov / 2)) /
              Math.min(camera.aspect, flight.aspect),
          ),
      )
    : innerWidth <= 760
      ? 49
      : 43;
}
function moveView(view, animate = true, force = false) {
  const previousView = state.view;
  state.view = view;
  state.rotating = false;
  syncLayers();
  if (!camera) return;
  if (previousView === view && !force) return;
  // Drain any orbit inertia without allowing it to change the displayed pose.
  const from = camera.position.clone(),
    quaternion = camera.quaternion.clone(),
    fromTarget = controls.target.clone();
  controls.enableDamping = false;
  controls.update(0);
  controls.enableDamping = true;
  camera.position.copy(from);
  camera.quaternion.copy(quaternion);
  controls.target.copy(fromTarget);
  orbitLeveling = null;
  camera.up.copy(worldUp);
  controls.enabled = view !== 'drone';
  const target = (view === 'flight' ? flightTarget : defaultTarget).clone();
  const mobile = innerWidth <= 760;
  const offset =
    view === 'flight' ? new THREE.Vector3(-530, 540, 730) : new THREE.Vector3(-800, 1020, 1430);
  if (mobile) offset.multiplyScalar(view === 'flight' ? 1.1 : 1.2);
  timePose();
  const end = view === 'drone' ? pose.pos.clone() : target.clone().add(offset),
    endQuaternion =
      view === 'drone'
        ? pose.q.clone()
        : new THREE.Quaternion().setFromRotationMatrix(
            new THREE.Matrix4().lookAt(end, target, camera.up),
          ),
    fov = viewFov(view);
  if (!animate || reduced.matches) {
    transition = null;
    camera.position.copy(end);
    controls.target.copy(target);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.quaternion.copy(endQuaternion);
  } else
    transition = {
      elapsed: 0,
      duration: view === 'drone' || previousView === 'drone' ? 2.2 : 1.5,
      from,
      to: end,
      quaternion,
      endQuaternion,
      fromTarget,
      target,
      fromFov: camera.fov,
      fov,
    };
}
async function playback(on) {
  const request = ++playRequest;
  if (!on) {
    video.pause();
    syncUI();
    return;
  }
  try {
    await video.play();
    if (request !== playRequest || !state.video) video.pause();
  } catch {
    if (request === playRequest)
      $('.atlas-projection-note').textContent = 'Press Play to start the recorded flight.';
  }
  syncUI();
}
function videoLayer(on, play = true, view = on ? 'flight' : 'plant') {
  state.video = on;
  lastPose = -1;
  if (on) {
    if (play) playback(true);
  } else {
    playback(false);
  }
  moveView(view);
  syncLayers();
}
function showScene() {
  if (innerWidth <= 760)
    stage.scrollIntoView({
      behavior: reduced.matches ? 'instant' : 'smooth',
      block: 'center',
    });
}
function resize() {
  if (!renderer) return;
  const w = host.clientWidth,
    h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  if (transition) transition.fov = viewFov(state.view);
  else camera.fov = viewFov(state.view);
  camera.updateProjectionMatrix();
}
function animate(now) {
  requestAnimationFrame(animate);
  if (!visible || document.hidden) {
    lastStamp = now;
    return;
  }
  const elapsed = lastStamp ? (now - lastStamp) / 1000 : 0;
  const dt = Math.min(0.1, elapsed);
  lastStamp = now;
  tourTick(dt);
  animateLayers(dt);
  if (state.video && (video.currentTime !== lastPose || lastPose < 0)) {
    updateFlight();
  }
  if (transition) {
    transition.elapsed += dt;
    const t = Math.min(1, transition.elapsed / transition.duration),
      e = smoothStep(t);
    if (state.view === 'drone') {
      transition.to.copy(pose.pos);
      transition.endQuaternion.copy(pose.q);
    }
    camera.position.lerpVectors(transition.from, transition.to, e);
    controls.target.lerpVectors(transition.fromTarget, transition.target, e);
    camera.quaternion.copy(transition.quaternion).slerp(transition.endQuaternion, e);
    camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.fov, e);
    camera.updateProjectionMatrix();
    if (t === 1) transition = null;
  } else if (state.view !== 'drone') {
    if (orbitLeveling) {
      orbitLeveling.elapsed += dt;
      const t = Math.min(1, orbitLeveling.elapsed / 0.25);
      camera.up.lerpVectors(orbitLeveling.from, worldUp, smoothStep(t)).normalize();
      if (t === 1) orbitLeveling = null;
    }
    controls.update(dt);
  }
  if (layerAmounts.projection > 0) {
    projector.updateDepth(renderer, scene);
  }
  renderer.render(scene, camera);
  state.frames++;
  const label = $('.atlas-drone-label');
  if (state.video && state.view !== 'drone') {
    const point = pose.pos.clone().project(camera);
    label.hidden = point.z > 1 || point.z < 0 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
    label.style.left = `${((point.x + 1) * host.clientWidth) / 2}px`;
    label.style.top = `${((1 - point.y) * host.clientHeight) / 2}px`;
  } else label.hidden = true;
}
function buildDrone() {
  const group = new THREE.Group(),
    mat = new THREE.MeshBasicMaterial({ color: 0x5ed1b3, toneMapped: false });
  const body = new THREE.Mesh(new THREE.BoxGeometry(6, 2.3, 9), mat);
  group.add(body);
  for (const x of [-1, 1])
    for (const z of [-1, 1]) {
      const end = new THREE.Vector3(x * 8, 0, z * 8);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, end.length(), 5), mat);
      arm.position.copy(end).multiplyScalar(0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize());
      group.add(arm);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.35, 4, 24), mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(end);
      group.add(ring);
    }
  // Enlarged display marker; its position, rather than its dimensions, comes from the flight.
  group.renderOrder = 3;
  return group;
}

async function ensureCloud() {
  if (state.cloudReady) return true;
  if (cloudPromise) return cloudPromise;
  const note = $('#atlas-cloud').closest('label').querySelector('small');
  note.textContent = 'Loading measured points…';
  cloudPromise = (async () => {
    try {
      const response = await fetch(assets + 'cloud.xyz');
      if (!response.ok) throw Error('Point cloud unavailable');
      const points = await response.arrayBuffer();
      const xyz = new Float32Array(points);
      let low = Infinity,
        high = -Infinity;
      for (let i = 1; i < xyz.length; i += 3) {
        low = Math.min(low, xyz[i]);
        high = Math.max(high, xyz[i]);
      }
      state.pointCount = xyz.length / 3;
      state.heightRange = [low, high];
      const colors = new Float32Array(xyz.length),
        ramp = [0x316b8e, 0x3fb9b5, 0xa3d578, 0xedca61, 0xee9861].map((c) => new THREE.Color(c));
      const colour = new THREE.Color();
      for (let i = 0; i < xyz.length; i += 3) {
        const value = THREE.MathUtils.clamp((xyz[i + 1] - low) / (high - low), 0, 1) * 4,
          index = Math.min(3, Math.floor(value)),
          c = colour.copy(ramp[index]).lerp(ramp[index + 1], value - index);
        c.toArray(colors, i);
        if (i > 0 && i % (65536 * 3) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      cloud = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: 1.65,
          sizeAttenuation: false,
          vertexColors: true,
          toneMapped: false,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      cloud.visible = false;
      scene.add(cloud);
      $('.height-max').textContent = `${high.toFixed(0)} m`;
      $('.height-mid').textContent = `${((high + low) / 2).toFixed(0)} m`;
      $('.height-min').textContent = `${low.toFixed(0)} m`;

      state.cloudReady = true;
      note.textContent = '757,579 measured points · height';
      syncLayers();
      return true;
    } catch (error) {
      state.cloud = false;
      note.textContent = 'Cloud unavailable. Toggle to retry.';
      syncLayers();
      return false;
    } finally {
      cloudPromise = null;
    }
  })();
  return cloudPromise;
}

async function init() {
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.setClearColor(0x0b0f13);
    host.append(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(43, 1, 0.5, 13000);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.autoRotateSpeed = 0.55;
    controls.minDistance = 55;
    controls.maxDistance = 6500;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.addEventListener('start', () => {
      stopTour();
      if (transition) {
        // Match the displayed gaze and roll before handing this pose to orbit controls.
        const distance = THREE.MathUtils.clamp(
          camera.position.distanceTo(controls.target),
          controls.minDistance,
          controls.maxDistance,
        );
        controls.target
          .copy(camera.position)
          .addScaledVector(camera.getWorldDirection(p1), distance);
        camera.up.copy(worldUp).applyQuaternion(camera.quaternion);
        orbitLeveling = { from: camera.up.clone(), elapsed: 0 };
      }
      transition = null;
      state.rotating = false;
      controls.autoRotate = false;
      syncUI();
    });
    scene.add(new THREE.HemisphereLight(0xdceee6, 0x173536, 2));
    const sun = new THREE.DirectionalLight(0xecf4da, 3.2);
    sun.position.set(-500, 1400, 700);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x87bdd2, 2.2);
    rim.position.set(500, 400, -800);
    scene.add(rim);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [gltf, path] = await Promise.all([
      loader.loadAsync(assets + 'site.glb'),
      fetch(assets + 'flight.json').then((r) => r.json()),
    ]);
    flight = path;
    model = gltf.scene;
    const palette = {
      structure: 0x72998e,
      tank: 0x829b91,
      steel: 0x4c7c77,
      ground: 0x1d373c,
      road: 0x102a30,
    };
    const surface = Object.fromEntries(
      Object.entries(palette).map(([k, color]) => [
        k,
        new THREE.MeshStandardMaterial({
          color,
          metalness: k === 'steel' ? 0.3 : 0.1,
          roughness: 0.8,
          side: THREE.DoubleSide,
        }),
      ]),
    );
    materials.push(...Object.values(surface));
    model.traverse((o) => {
      if (/^(Sea|Mainland)$/.test(o.name)) o.visible = false;
      if (!o.isMesh) return;
      let ancestor = o;
      while (ancestor) {
        if (!ancestor.visible) return;
        ancestor = ancestor.parent;
      }
      const style = (m) => {
        const name = m.name || '';
        return /Asphalt|Paving/i.test(name)
          ? surface.road
          : /Ground|Rock_Armour|Slope|Laydown/i.test(name)
            ? surface.ground
            : /Concrete_Tank/i.test(name)
              ? surface.tank
              : /Steel|Pipe|Grating|Handrail|Fence/i.test(name)
                ? surface.steel
                : surface.structure;
      };
      o.material = Array.isArray(o.material) ? o.material.map(style) : style(o.material);
      receivers.push(o);
    });
    // Bake static world transforms and batch by material. Preserve all source triangles
    // while reducing the hero and projector depth pass from 1,756 draws to five.
    model.updateMatrixWorld(true);
    const batches = new Map();
    state.sourceTriangleCount = 0;
    for (const mesh of receivers) {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(g.attributes))
        if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      for (const name of ['position', 'normal']) {
        const a = g.attributes[name],
          values = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) {
          values[i * 3] = a.getX(i);
          values[i * 3 + 1] = a.getY(i);
          values[i * 3 + 2] = a.getZ(i);
        }
        g.setAttribute(name, new THREE.BufferAttribute(values, 3));
      }
      if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
      state.sourceTriangleCount += g.index.count / 3;
      if (!batches.has(mesh.material)) batches.set(mesh.material, []);
      batches.get(mesh.material).push(g);
    }
    receivers.length = 0;
    model = new THREE.Group();
    for (const [material, geometries] of batches) {
      const merged = mergeGeometries(geometries, false);
      if (!merged) throw new Error('Unable to prepare the plant geometry');
      const mesh = new THREE.Mesh(merged, material);
      model.add(mesh);
      receivers.push(mesh);
      geometries.forEach((g) => g.dispose());
    }
    scene.add(model);
    state.renderTriangleCount = receivers.reduce((n, m) => n + m.geometry.index.count / 3, 0);
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    projector = new Projector({
      opacity: 0.97,
      vignette: 0.035,
      maxDistance: 1600,
      occlusion: true,
      depthSize: 1024,
    });
    projector.setTexture(tex);
    projector.setLens({
      model: 'pinhole',
      hfovDeg: flight.hfov,
      aspect: flight.aspect,
    });
    projector.attach(receivers);
    projector.setEnabled(false);
    // Three decodes VideoTexture in its built-in map shader, not custom samplers.
    // Supply the same decode for the projector's sampler to keep source colours accurate.
    for (const material of materials) {
      const compile = material.onBeforeCompile.bind(material),
        key = material.customProgramCacheKey.bind(material);
      material.onBeforeCompile = (shader, renderer) => {
        compile(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec3 aioC = texture2D(aioProjTex, aioUv).rgb;',
          'vec3 aioC = sRGBTransferEOTF(texture2D(aioProjTex, aioUv)).rgb;',
        );
      };
      material.customProgramCacheKey = () => key() + '|atlas-video-srgb';
      material.needsUpdate = true;
    }
    drone = buildDrone();
    scene.add(drone);
    frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(48), 3),
      ),
      new THREE.LineBasicMaterial({
        color: 0x5ed1b3,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    scene.add(frustum);
    flightPath = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        flight.samples.map((s) => new THREE.Vector3(...s.pos)),
      ),
      new THREE.LineDashedMaterial({
        color: 0x5ed1b3,
        dashSize: 4,
        gapSize: 3,
        transparent: true,
        opacity: 0.65,
        toneMapped: false,
      }),
    );
    flightPath.computeLineDistances();
    scene.add(flightPath);
    for (const object of [drone, frustum, flightPath]) {
      object.traverse((child) => {
        if (!child.material || flightMaterials.has(child.material)) return;
        flightMaterials.set(child.material, child.material.opacity);
        child.material.transparent = true;
        child.material.depthWrite = false;
      });
    }
    const initialRotate = state.rotating;
    moveView('plant', false, true);
    state.rotating = initialRotate;
    syncLayers();
    updateFlight();
    new ResizeObserver(resize).observe(host);
    resize();
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (!visible && !video.paused) {
          resumePlayback = true;
          video.pause();
        } else if (visible && resumePlayback && state.video) {
          resumePlayback = false;
          playback(true);
        }
      },
      { threshold: 0.05 },
    ).observe(stage);
    state.ready = true;
    inputs.forEach((b) => (b.disabled = false));
    $('.atlas-load').dataset.ready = 'true';
    $('.atlas-load').textContent = 'Plant model ready. Optional layers load as you explore.';
    stage.dataset.rendered = 'true';
    tourReady();
    requestAnimationFrame(animate);
  } catch (error) {
    console.error(error);
    $('.atlas-load').textContent =
      'The live model could not load. The source-model preview remains visible. Reload to try again.';
    $('.atlas-load').style.maxWidth = '240px';
    $('.atlas-load').style.lineHeight = '1.8';
  }
}
$('#atlas-cloud').addEventListener('change', async (e) => {
  stopTour();
  state.cloud = e.target.checked;
  if (state.cloud) await ensureCloud();
  syncLayers();
  showScene();
});
$('#atlas-video').addEventListener('change', (e) => {
  stopTour();
  state.projecting = true;
  videoLayer(e.target.checked);
  showScene();
});
$('.atlas-launch').addEventListener('click', () => {
  startTour();
  showScene();
});
$('.atlas-rotation').addEventListener('click', () => {
  if (state.view === 'drone') moveView('flight');
  state.rotating = !state.rotating;
  syncLayers();
});
$('.atlas-reset').addEventListener('click', () => {
  stopTour();
  state.tourStep = 0;
  state.manual = false;
  tourComplete = false;
  paintTour();
  state.projecting = true;
  state.cloud = false;
  videoLayer(false);
  moveView('plant', true, true);
  state.rotating = !reduced.matches;
  syncLayers();
  showScene();
});
$('.atlas-play').addEventListener('click', () => playback(video.paused));
$('.atlas-seek').addEventListener('input', (e) => {
  video.currentTime = Number(e.target.value);
  lastPose = -1;
});
$('.atlas-flight-view').addEventListener('click', () => {
  moveView('flight', true, true);
  showScene();
});
$('.atlas-drone-eye').addEventListener('click', () => {
  moveView('drone');
  showScene();
});
video.addEventListener('play', syncUI);
video.addEventListener('pause', syncUI);
video.addEventListener('loadeddata', () => {
  lastPose = -1;
  syncLayers();
});
video.addEventListener('seeking', () => {
  // Both timeline scrubbing and the clip's native loop can jump to a distant pose.
  if (state.ready && state.view === 'drone') moveView('drone', true, true);
});
video.addEventListener('seeked', () => {
  lastPose = -1;
  syncLayers();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !video.paused) {
    resumePlayback = true;
    video.pause();
  } else if (!document.hidden && visible && resumePlayback && state.video) {
    resumePlayback = false;
    playback(true);
  }
});
reduced.addEventListener('change', () => {
  if (reduced.matches) {
    stopTour();
    playback(false);
    state.rotating = false;
    if (camera) moveView(state.view, false, true);
    syncLayers();
  }
});
$$('[data-jump-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!state.ready) return;
    const mode = b.dataset.jumpMode;
    if (mode === 'cloud') {
      state.cloud = true;
      syncLayers();
    } else if (mode === 'model') {
      state.cloud = false;
      videoLayer(false);
      moveView('plant');
    } else videoLayer(true);
    $('#experience').scrollIntoView({
      behavior: reduced.matches ? 'instant' : 'smooth',
    });
  }),
);
const dialog = $('#product-dialog');
let rotationBeforeDialog = false;
$$('[data-product]').forEach((b) =>
  b.addEventListener('click', () => {
    rotationBeforeDialog = state.rotating;
    state.rotating = false;
    syncLayers();
    playback(false);
    dialog.showModal();
  }),
);
$('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  state.rotating = rotationBeforeDialog && !reduced.matches;
  syncLayers();
});
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add('revealed');
  },
  { threshold: 0.25 },
);
$$('.chapter').forEach((c) => observer.observe(c));
window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', scrollY > 80), {
  passive: true,
});
window.atlasPreview = {
  getState: () => ({
    ...state,
    time: video.currentTime,
    playing: !video.paused,
    camera: camera?.position.toArray(),
    cameraQuaternion: camera?.quaternion.toArray(),
    target: controls?.target.toArray(),
    dronePosition: drone?.position.toArray(),
    droneVisible: drone?.visible,
    projectorPosition: projector?.uniforms.aioProjPos.value.toArray(),
    projectorEnabled: projector?.enabled,
    occlusion: projector?.uniforms.aioDepthOn.value,
    receiverCount: receivers.length,
    patchedMaterials: projector?.patchedCount,
    cloudVisible: cloud?.visible,
    cloudOpacity: cloud?.material.opacity,
    projectionOpacity: projector?.uniforms.aioProjOpacity.value,
    cameraFov: camera?.fov,
    cameraTransition: Boolean(transition),
    layerTransition: Boolean(layerTransition),
  }),
};
const tourChapters = [
  ['Start with the structure.', 'Engineering geometry establishes the shared spatial frame.', 5],
  [
    'Reveal the measured world.',
    'Captured survey points bring height and surface detail into view.',
    6,
  ],
  ['Give the flight a place.', 'The drone follows its recorded position and orientation.', 5],
  [
    'Let the footage meet the model.',
    'Original video projects onto the surfaces the camera sees.',
    7,
  ],
  [
    'See from the drone’s perspective.',
    'The same camera. The same moment. A different understanding.',
    7,
  ],
];
let tourElapsed = 0,
  tourWaiting = false,
  tourGeneration = 0,
  tourComplete = false;
function paintTour() {
  const chapter = tourChapters[state.tourStep];
  const caption = $('.q-tour-caption');
  if (!caption) return;
  caption.querySelector('strong').textContent = chapter[0];
  caption.querySelector('span').textContent = chapter[1];
  $$('[data-tour-step]').forEach((b) =>
    b.setAttribute(
      'aria-current',
      Number(b.dataset.tourStep) === state.tourStep ? 'step' : 'false',
    ),
  );
  $('.q-tour-play').textContent = state.touring
    ? 'Pause tour'
    : tourComplete
      ? 'Replay tour'
      : 'Play tour';
  $('.q-tour-play').setAttribute(
    'aria-label',
    state.touring ? 'Pause guided transformation' : 'Play guided transformation',
  );
  $('.atlas-hero').dataset.tourActive = String(state.touring);
  $('.atlas-hero').dataset.chapter = String(state.tourStep);
}
function manualMode() {
  stopTour();
  state.manual = true;
  syncUI();
}
function stopTour() {
  state.touring = false;
  tourGeneration++;
  tourWaiting = false;
  paintTour();
}
async function selectChapter(index, playing = false) {
  if (!state.ready) return;
  const generation = ++tourGeneration;
  state.tourStep = index;
  state.manual = false;
  state.touring = playing;
  tourElapsed = 0;
  tourComplete = false;
  tourWaiting = true;
  state.cloud = index === 1;
  state.projecting = index >= 3;
  if (index <= 1) {
    videoLayer(false);
    if (index === 0) moveView('plant', true, true);
    state.rotating = !reduced.matches;
  } else {
    if (index === 2) video.currentTime = 0;
    videoLayer(true, playing || !reduced.matches, index === 4 ? 'drone' : 'flight');
  }
  syncLayers();
  paintTour();
  if (index === 1) await ensureCloud();
  if (generation !== tourGeneration) return;
  tourWaiting = false;
  if (index === 1 && !state.cloudReady)
    $('.q-tour-caption span').textContent =
      'Measured points are unavailable. The plant and recorded flight remain ready to explore.';
}
function startTour() {
  selectChapter(0, true);
}
function tourReady() {
  paintTour();
  $$('.q-tour button').forEach((b) => (b.disabled = false));
  if (!reduced.matches && innerWidth > 760) startTour();
}
function tourTick(dt) {
  if (!state.touring || tourWaiting) return;
  tourElapsed += dt;
  const duration = tourChapters[state.tourStep][2];
  $('.q-tour-steps').style.setProperty(
    '--tour-progress',
    String(Math.min(1, tourElapsed / duration)),
  );
  if (tourElapsed < duration) return;
  if (state.tourStep < tourChapters.length - 1) selectChapter(state.tourStep + 1, true);
  else {
    state.touring = false;
    tourComplete = true;
    playback(false);
    paintTour();
  }
}
$$('.q-tour button').forEach((b) => (b.disabled = true));
$$('[data-tour-step]').forEach((b) =>
  b.addEventListener('click', () => {
    selectChapter(Number(b.dataset.tourStep), false);
    $('.q-tour-steps').style.setProperty('--tour-progress', '1');
  }),
);
$('.q-tour-play')?.addEventListener('click', () => {
  if (state.touring) {
    stopTour();
    playback(false);
    state.rotating = false;
    syncLayers();
  } else if (tourComplete || state.manual) startTour();
  else {
    state.touring = true;
    if (state.video) playback(true);
    paintTour();
  }
});
$('.q-tour-reset')?.addEventListener('click', () => selectChapter(0, false));
$$('.atlas-layer-panel button,.atlas-layer-panel input').forEach((b) =>
  b.addEventListener('pointerdown', manualMode),
);
$$('.atlas-layer-panel button,.atlas-layer-panel input').forEach((b) =>
  b.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) manualMode();
  }),
);
stage.addEventListener('pointerdown', manualMode);
init();

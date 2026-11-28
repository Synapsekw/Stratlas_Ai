import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export async function createInspectionScene(root, findings, onSelect) {
  const assets = "../assets/inspection/";
  const canvasHost = root.querySelector(".tank-canvas");
  const status = root.querySelector(".scene-status");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    status.textContent =
      "The 3D view needs WebGL. The source photos and explanations are still available.";
    root.dataset.ready = "unavailable";
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x0b0f13, 1);
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  canvasHost.append(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive tank model and spatial inspection evidence",
  );
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(43, 1, 0.015, 250);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.3;
  controls.maxDistance = 40;
  controls.target.set(0, 4.4, 0);
  camera.position.set(10, 7.6, 13);
  scene.add(new THREE.HemisphereLight(0xdbeae8, 0x3e4942, 2.4));
  const sun = new THREE.DirectionalLight(0xffe7cb, 3.2);
  sun.position.set(3, 11, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x78a7b5, 2);
  rim.position.set(-6, 5, -4);
  scene.add(rim);
  const grid = new THREE.GridHelper(18, 18, 0x395654, 0x223c40);
  grid.position.y = -0.36;
  scene.add(grid);
  const plane = new THREE.Plane(new THREE.Vector3(-0.6, 0, -0.8), 0);
  let surface = "cutaway",
    direction = "vertical",
    section = 37,
    view = "orbit",
    scanOn = false,
    scanColour = "intensity",
    modelOn = true,
    pinsOn = true,
    pathOn = true,
    selected = findings[0].id;
  const [gltf, buffer, flight] = await Promise.all([
    new GLTFLoader().loadAsync(assets + "vessel.glb"),
    fetch(assets + "scan.bin").then((r) => r.arrayBuffer()),
    fetch(assets + "flight.json").then((r) => r.json()),
  ]);
  const model = gltf.scene,
    materials = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    const original = o.material;
    let color = original.color?.clone() || new THREE.Color(0x8aacaa);
    color.lerp(new THREE.Color(0xa3c0b6), 0.45);
    o.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.72,
      metalness: 0.12,
      side: THREE.DoubleSide,
      clippingPlanes: [plane],
    });
    materials.push(o.material);
  });
  scene.add(model);
  const raw = new Int16Array(buffer, 0, 280000 * 3),
    intensities = new Uint8Array(buffer, 280000 * 6, 280000);
  const positions = new Float32Array(raw.length),
    colors = new Float32Array(raw.length);
  for (let i = 0; i < 280000; i++) {
    for (let a = 0; a < 3; a++) positions[i * 3 + a] = raw[i * 3 + a] * 0.001;
    const v = 0.2 + (intensities[i] / 255) * 0.8;
    colors[i * 3] = v * 0.55;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const cloud = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      vertexColors: true,
      size: 1.5,
      sizeAttenuation: false,
      clippingPlanes: [plane],
    }),
  );
  cloud.visible = false;
  scene.add(cloud);
  const path = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      flight.samples.map((s) => new THREE.Vector3().fromArray(s.pos)),
    ),
    new THREE.LineBasicMaterial({
      color: 0xdafa7b,
      transparent: true,
      opacity: 0.85,
    }),
  );
  scene.add(path);
  const drone = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.1),
    new THREE.MeshBasicMaterial({ color: 0xe5fd87 }),
  );
  scene.add(drone);
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  const pinHost = root.querySelector(".spatial-pins");
  const leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  leaders.classList.add("pin-leaders");
  pinHost.append(leaders);
  const pins = findings.map((f) => {
    const position = new THREE.Vector3().fromArray(f.position);
    const color =
      f.severity === 5 ? 0xf87866 : f.severity === 4 ? 0xf0b877 : 0xe4da8a;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    marker.position.copy(position);
    marker.renderOrder = 10;
    markerGroup.add(marker);
    const button = document.createElement("button");
    button.className = "spatial-pin";
    button.textContent = f.id;
    button.setAttribute("aria-label", `${f.id}: ${f.title}`);
    button.addEventListener("click", () => onSelect(f.id));
    pinHost.append(button);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    leaders.append(line);
    return { position, marker, button, line, id: f.id };
  });
  const measure = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xf6e494, depthTest: false }),
  );
  measure.visible = false;
  measure.renderOrder = 11;
  scene.add(measure);
  const video = document.querySelector(".inspection-video");
  const posePosition = new THREE.Vector3(),
    poseQuaternion = new THREE.Quaternion(),
    tempPos = new THREE.Vector3(),
    tempQ = new THREE.Quaternion();
  let last = 0,
    frames = 0;
  function resize() {
    const w = canvasHost.clientWidth,
      h = canvasHost.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvasHost);
  resize();
  function apply() {
    const angle = (section * Math.PI) / 180;
    if (direction === "vertical")
      plane.set(new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle)), 0);
    else plane.set(new THREE.Vector3(0, -1, 0), section);
    const clipping = surface === "cutaway" && view !== "drone" ? [plane] : [];
    for (const m of materials) {
      m.clippingPlanes = clipping;
      m.transparent = surface === "transparent" && view !== "drone";
      m.opacity = m.transparent ? 0.2 : 1;
      m.depthWrite = !m.transparent;
      m.needsUpdate = true;
    }
    cloud.material.clippingPlanes = clipping;
    cloud.visible = scanOn;
    model.visible = modelOn;
    markerGroup.visible = pinsOn;
    path.visible = pathOn && view !== "drone";
    drone.visible = view !== "drone";
  }
  function reset() {
    view = "orbit";
    camera.fov = 43;
    camera.position.set(10, 7.6, 13);
    controls.target.set(0, 4.4, 0);
    controls.enabled = true;
    camera.updateProjectionMatrix();
    apply();
  }
  function setView(next) {
    view = next;
    controls.enabled = view === "orbit";
    camera.fov = view === "drone" ? 75 : 43;
    camera.updateProjectionMatrix();
    apply();
  }
  function focus(id) {
    selected = id;
    const f = findings.find((f) => f.id === id);
    if (!f) return;
    pins.forEach((p) => {
      p.button.setAttribute("aria-pressed", String(p.id === id));
      p.marker.scale.setScalar(p.id === id ? 1.7 : 1);
    });
  }
  function animate(stamp) {
    requestAnimationFrame(animate);
    if (document.hidden || stamp - last < 32) return;
    last = stamp;
    const bounds = root.getBoundingClientRect();
    if (bounds.bottom < 0 || bounds.top > innerHeight) return;
    const t = Math.min(video?.currentTime || 0, 10.999) * 10,
      a = flight.samples[Math.floor(t)],
      b =
        flight.samples[Math.min(Math.floor(t) + 1, flight.samples.length - 1)];
    posePosition.fromArray(a.pos).lerp(tempPos.fromArray(b.pos), t % 1);
    poseQuaternion.fromArray(a.q).slerp(tempQ.fromArray(b.q), t % 1);
    drone.position.copy(posePosition);
    if (view === "drone") {
      camera.position.copy(posePosition);
      camera.quaternion.copy(poseQuaternion);
    } else if (view === "follow") {
      camera.position.copy(posePosition).add(tempPos.set(6, 3, 7));
      camera.lookAt(posePosition);
    } else controls.update();
    renderer.render(scene, camera);
    frames++;
    const occupied = [];
    const w = canvasHost.clientWidth,
      h = canvasHost.clientHeight;
    for (const p of [...pins].sort(
      (a, b) => Number(b.id === selected) - Number(a.id === selected),
    )) {
      const v = p.position.clone().project(camera);
      const visible =
        pinsOn &&
        view !== "drone" &&
        v.z < 1 &&
        Math.abs(v.x) < 0.94 &&
        Math.abs(v.y) < 0.95;
      p.button.hidden = !visible;
      p.line.style.display = visible ? "" : "none";
      if (!visible) continue;
      const x = (v.x * 0.5 + 0.5) * w,
        y = (-v.y * 0.5 + 0.5) * h;
      let label = { x, y };
      for (const [dx, dy] of [
        [0, 0],
        [-35, -32],
        [35, 32],
        [-65, 0],
        [65, 0],
        [-35, 40],
        [35, -40],
        [0, 68],
        [0, -68],
      ]) {
        const next = {
          x: Math.max(26, Math.min(w - 26, x + dx)),
          y: Math.max(55, Math.min(h - 45, y + dy)),
        };
        label = next;
        if (
          !occupied.some(
            (o) => Math.abs(o.x - next.x) < 47 && Math.abs(o.y - next.y) < 32,
          )
        )
          break;
      }
      occupied.push(label);
      p.button.style.transform = `translate(${label.x}px,${label.y}px) translate(-50%,-50%)`;
      p.line.setAttribute("x1", x);
      p.line.setAttribute("y1", y);
      p.line.setAttribute("x2", label.x);
      p.line.setAttribute("y2", label.y);
    }
    root.querySelector(".pose-height").textContent =
      `${posePosition.y.toFixed(2)} m`;
  }
  apply();
  focus(selected);
  requestAnimationFrame(animate);
  root.dataset.ready = "true";
  status.textContent = "REAL MODEL + RECORDED INSPECTION DATA";
  return {
    focus,
    reset,
    setView,
    setSurface(value) {
      surface = value;
      apply();
    },
    setSection(axis, value) {
      direction = axis;
      section = value;
      apply();
    },
    setScanColour(mode) {
      scanColour = mode;
      const rampLow = new THREE.Color("#326cac"),
        rampHigh = new THREE.Color("#d9f99b");
      const c = new THREE.Color();
      let lo = Infinity,
        hi = -Infinity;
      for (let i = 1; i < positions.length; i += 3) {
        lo = Math.min(lo, positions[i]);
        hi = Math.max(hi, positions[i]);
      }
      for (let i = 0; i < 280000; i++) {
        const v = 0.2 + (intensities[i] / 255) * 0.8;
        if (mode === "height")
          c.copy(rampLow).lerp(
            rampHigh,
            (positions[i * 3 + 1] - lo) / (hi - lo || 1),
          );
        else if (mode === "flight") c.set(i < 140000 ? "#6cc9d1" : "#d9f99b");
        else c.setRGB(v * 0.55, v, v * 0.9);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.attributes.color.needsUpdate = true;
    },
    setLayer(layer, on) {
      if (layer === "scan") scanOn = on;
      if (layer === "model") modelOn = on;
      if (layer === "pins") pinsOn = on;
      if (layer === "path") pathOn = on;
      apply();
    },
    clearMeasurement() {
      measure.visible = false;
    },
    measure(a, b) {
      const p1 = new THREE.Vector3().fromArray(a.position),
        p2 = new THREE.Vector3().fromArray(b.position);
      measure.geometry.dispose();
      measure.geometry = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      measure.visible = true;
      return p1.distanceTo(p2);
    },
    getState() {
      return {
        surface,
        direction,
        section,
        view,
        scanOn,
        scanColour,
        modelOn,
        pinsOn,
        pathOn,
        selected,
        position: camera.position.toArray(),
        time: video?.currentTime || 0,
        pointCount: 280000,
        frames,
      };
    },
  };
}

const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const assets = '../assets/use-cases/';
const number = (n, d = 1) =>
  Number(n).toLocaleString('en', {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  });
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const facts = (items) =>
  items.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('');
const get = async (file) => {
  const r = await fetch(assets + file);
  if (!r.ok) throw Error('Could not load ' + file);
  return r.json();
};
const state = { page: document.body.dataset.page, ready: false };
window.useCasePreview = { getState: () => ({ ...state }) };

async function roads() {
  const data = await get('roads.json'),
    svg = $('#road-route');
  const pts = data.centreline.points,
    kms = data.centreline.chainageKm;
  const bounds = [
    Math.min(...pts.map((p) => p[0])),
    Math.max(...pts.map((p) => p[0])),
    Math.min(...pts.map((p) => p[2])),
    Math.max(...pts.map((p) => p[2])),
  ];
  const scale = Math.min(740 / (bounds[1] - bounds[0]), 450 / (bounds[3] - bounds[2]));
  const xy = (p) => [
    430 + (p[0] - (bounds[0] + bounds[1]) / 2) * scale,
    295 + (p[2] - (bounds[2] + bounds[3]) / 2) * scale,
  ];
  const rating = (score) =>
    [...data.ratings].sort((a, b) => b.min - a.min).find((r) => Math.round(score) >= r.min);
  let current = 0,
    assumption = 'medium';
  const path = (points) => points.map((p, i) => (i ? 'L' : 'M') + xy(p).join(',')).join(' ');
  const sections = data.sections.map((section) => {
    let from = kms.findIndex((k) => k >= section.fromKm),
      to = kms.findIndex((k) => k >= section.toKm);
    if (to < 0) to = pts.length - 1;
    return path(pts.slice(Math.max(0, from - 1), to + 1));
  });
  function selectSection(index) {
    current = index;
    const section = data.sections[index],
      score = section.pci[assumption];
    $('#road-chainage').value = (section.fromKm + section.toKm) / 2;
    $('#road-km-label').textContent = number(Number($('#road-chainage').value), 2) + ' km';
    $('.road-section-title').textContent =
      number(section.fromKm, 2) + '—' + number(section.toKm, 2) + ' km';
    $('#road-score').textContent = number(score);
    $('#road-rating').textContent = rating(score)?.label || 'Unrated';
    $('.road-section-note').textContent =
      number(section.pavementM2, 0) + ' m² of assessed pavement in this section.';
    $('#road-network').textContent = number(data.network[assumption]);
    svg.innerHTML =
      `<path class="road-track" d="${path(pts)}"/>` +
      sections
        .map(
          (d, i) =>
            `<path class="road-segment ${i === index ? 'selected' : ''}" d="${d}" stroke="${rating(data.sections[i].pci[assumption])?.color || '#888'}" data-section="${i}" role="button" tabindex="0" aria-label="Section ${number(data.sections[i].fromKm, 2)} to ${number(data.sections[i].toKm, 2)} kilometres, PCI ${number(data.sections[i].pci[assumption])}" aria-pressed="${i === index}"/>`,
        )
        .join('') +
      `<text x="${xy(pts[0])[0] + 16}" y="${xy(pts[0])[1] - 12}">START / 0.00 KM</text><text x="${xy(pts.at(-1))[0] + 16}" y="${xy(pts.at(-1))[1] + 20}">END / 7.55 KM</text>`;
    $$('[data-section]').forEach((el) => {
      el.addEventListener('click', () => selectSection(Number(el.dataset.section)));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectSection(Number(el.dataset.section));
        }
      });
    });
    $('.road-profile').innerHTML = data.sections
      .map(
        (s, i) =>
          `<button style="--score:${s.pci[assumption]}%;--rating:${rating(s.pci[assumption])?.color}" data-pci="${i}" aria-label="Go to section ${number(s.fromKm, 2)} kilometres" aria-pressed="${i === index}"><i></i></button>`,
      )
      .join('');
    $$('[data-pci]').forEach((b) => (b.onclick = () => selectSection(Number(b.dataset.pci))));
    const midpoint = (section.fromKm + section.toKm) / 2;
    const nearest = [...data.defects].sort(
      (a, b) => Math.abs(a.km - midpoint) - Math.abs(b.km - midpoint),
    )[0];
    let context = $('.q-road-context');
    if (!context) {
      context = document.createElement('button');
      context.className = 'q-road-context';
      $('.road-corridor').append(context);
    }
    context.innerHTML =
      '<img src="' +
      assets +
      nearest.photo +
      '" alt="Nearest sampled road observation"><span>NEAREST SAMPLED OBSERVATION<strong>' +
      esc(nearest.type) +
      '</strong><small>' +
      nearest.id +
      ' · ' +
      number(nearest.km, 3) +
      ' km ↗</small></span>';
    context.onclick = () => {
      $('#road-type').value = 'all';
      filter();
      $('#road-defect').value = nearest.id;
      showDefect();
      $('.road-photo').scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'center',
      });
    };
    Object.assign(state, {
      section: index,
      assumption,
      score,
      network: data.network[assumption],
    });
  }
  $('.road-legend').innerHTML = data.ratings
    .slice(0, 5)
    .map((r) => `<span><i style="background:${r.color}"></i>${r.label}</span>`)
    .join('');
  $('#road-assumption').onchange = (e) => {
    assumption = e.target.value;
    selectSection(current);
  };
  $('#road-chainage').oninput = (e) => {
    const km = Number(e.target.value),
      index = data.sections.findIndex((s) => km >= s.fromKm && km < s.toKm);
    selectSection(index < 0 ? data.sections.length - 1 : index);
    e.target.value = km;
    $('#road-km-label').textContent = number(km, 2) + ' km';
  };
  function showDefect() {
    const defect = data.defects.find((d) => d.id === $('#road-defect').value);
    if (!defect) return;
    $('.road-photo img').src = assets + defect.photo;
    $('.road-photo img').alt = defect.type + ' / original road survey image';
    $('.road-photo svg').setAttribute('viewBox', '0 0 ' + defect.size.join(' '));
    $('.road-photo svg').innerHTML =
      `<polygon points="${defect.polygon.map((p) => p.join(',')).join(' ')}"/>`;
    $('.road-photo-caption').textContent = defect.id + ' / ' + defect.type.toUpperCase();
    $('.road-defect-facts').innerHTML = facts([
      ['CHAINAGE', number(defect.km, 3) + ' km'],
      ['MAPPED AREA', number(defect.area, 2) + ' m²'],
      ['EXTENT', number(defect.extent) + ' m'],
      ['RECORDED SEVERITY', ['', 'Low', 'Medium', 'High'][defect.severity] || defect.severity],
    ]);
    const index = data.sections.findIndex((s) => defect.km >= s.fromKm && defect.km < s.toKm);
    selectSection(index < 0 ? data.sections.length - 1 : index);
    state.defect = defect.id;
    state.type = defect.type;
  }
  function filter() {
    const type = $('#road-type').value;
    const rows = data.defects.filter((d) => type === 'all' || d.type === type);
    $('#road-defect').innerHTML = rows
      .map(
        (d) => `<option value="${d.id}">${d.id} / ${esc(d.type)} / ${number(d.km, 3)} km</option>`,
      )
      .join('');
    state.filtered = rows.length;
    showDefect();
  }
  $('#road-type').insertAdjacentHTML(
    'beforeend',
    [...new Set(data.defects.map((d) => d.type))]
      .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
      .join(''),
  );
  $('#road-type').onchange = filter;
  $('#road-defect').onchange = showDefect;
  $('#road-outlines').onchange = (e) => {
    $('.road-photo svg').toggleAttribute('hidden', !e.target.checked);
    state.outlines = e.target.checked;
  };
  filter();
  state.outlines = true;
}

async function facades() {
  const data = await get('facades.json');
  let photo = data.photos[0];
  $('.facade-thumbnails').innerHTML = data.photos
    .map(
      (p) =>
        `<button data-photo="${p.id}" aria-pressed="${p.id === photo.id}"><img src="${assets + p.photo}" alt=""><span>${esc(p.findings[0].component)}</span><small>${p.id === 'p2736' ? 'THERMAL' : 'VISUAL'} / ${p.findings.length} OBSERVATIONS</small></button>`,
    )
    .join('');
  $('.facade-thumbnails').insertAdjacentHTML(
    'beforebegin',
    '<nav class="q-elevation-nav" aria-label="Source elevation navigator">' +
      [
        ['All captures', 'all'],
        ['East', 'East elevation'],
        ['West', 'West elevation'],
        ['South', 'South elevation'],
        ['North', 'North elevation'],
        ['Roof / unplaced', 'Not placed'],
      ]
        .map(
          ([label, value]) =>
            '<button data-elevation="' +
            value +
            '" aria-pressed="' +
            (value === 'all') +
            '">' +
            label +
            '</button>',
        )
        .join('') +
      '</nav>',
  );
  $$('[data-elevation]').forEach((b) =>
    b.addEventListener('click', () => {
      const side = b.dataset.elevation;
      $$('[data-elevation]').forEach((n) => n.setAttribute('aria-pressed', String(n === b)));
      $$('[data-photo]').forEach((n) => {
        n.hidden =
          side !== 'all' &&
          data.photos.find((p) => p.id === n.dataset.photo).findings[0].side !== side;
      });
      if (side !== 'all') choose(data.photos.find((p) => p.findings[0].side === side).id);
    }),
  );
  function finding() {
    const f = photo.findings.find((f) => f.id === $('#facade-finding').value);
    if (!f) return;
    $('.facade-observation').innerHTML =
      `<span class="severity-badge">${esc(f.grade).toUpperCase()} / ${f.severity}</span><h3>${esc(f.class)}</h3><p>${esc(f.note)}</p>`;
    $('.facade-facts').innerHTML = facts([
      ['SOURCE FINDING', f.id],
      ['DEFECT GROUP', f.defect],
      ['APPROX. HEIGHT', number(f.height, 2) + ' m'],
      ['ZONE', f.zone],
    ]);
    state.finding = f.id;
  }
  function choose(id) {
    photo = data.photos.find((p) => p.id === id);
    const selectedThumb = $('[data-photo="' + id + '"]');
    if (selectedThumb?.hidden) {
      $$('[data-photo]').forEach((n) => (n.hidden = false));
      $$('[data-elevation]').forEach((n) =>
        n.setAttribute('aria-pressed', String(n.dataset.elevation === 'all')),
      );
    }
    $$('[data-photo]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.photo === id)),
    );
    $('.facade-original').src = assets + photo.photo;
    $('.facade-original').alt =
      'Original ' +
      photo.findings[0].component +
      ' inspection ' +
      (id === 'p2736' ? 'thermal' : 'photo');
    $('.facade-overlay').src = assets + photo.overlay;
    $('.facade-elevation').textContent = photo.findings[0].side;
    $('.facade-component').textContent = photo.findings[0].component;
    $('.facade-image-caption').textContent =
      id.toUpperCase() + ' / ' + (id === 'p2736' ? 'THERMAL' : 'VISUAL');
    $('#facade-finding').innerHTML = photo.findings
      .map((f) => `<option value="${f.id}">${f.id} / ${esc(f.class)}</option>`)
      .join('');
    $('.facade-outlines').setAttribute('viewBox', '0 0 ' + photo.size.join(' '));
    $('.facade-outlines').innerHTML = photo.boxes
      .map((box, i) => {
        const p = box.polygon || [
          [box.bbox[0], box.bbox[1]],
          [box.bbox[2], box.bbox[1]],
          [box.bbox[2], box.bbox[3]],
          [box.bbox[0], box.bbox[3]],
        ];
        return `<polygon data-box="${i}" points="${p.map((a) => a.join(',')).join(' ')}" stroke="${data.legend[box.class_value]?.colour || '#d9f99b'}"><title>${esc(box.class)}</title></polygon>`;
      })
      .join('');
    $$('[data-box]').forEach(
      (el) =>
        (el.onclick = () => {
          const box = photo.boxes[Number(el.dataset.box)],
            f =
              photo.findings.find((f) => f.note === box.note) ||
              photo.findings.find((f) => f.class === box.class);
          if (f) {
            $('#facade-finding').value = f.id;
            finding();
          }
        }),
    );
    $('.facade-legend').innerHTML = [...new Set(photo.boxes.map((b) => b.class_value))]
      .map(
        (k) =>
          `<span><i style="background:${data.legend[k].colour}"></i>${esc(data.legend[k].class)}</span>`,
      )
      .join('');
    $('.facade-photo').dataset.zoom = 'false';
    $('#facade-zoom').setAttribute('aria-pressed', 'false');
    $('#facade-zoom').textContent = 'Inspect at 2×';
    Object.assign(state, { photo: id, zoom: false });
    finding();
  }
  $$('[data-photo]').forEach((b) => (b.onclick = () => choose(b.dataset.photo)));
  $('#facade-finding').onchange = finding;
  $('#facade-masks').onchange = (e) => {
    $('.facade-overlay').hidden = !e.target.checked;
    state.masks = e.target.checked;
  };
  $('#facade-opacity').oninput = (e) => {
    $('.facade-overlay').style.opacity = Number(e.target.value) / 100;
    $('#facade-opacity-label').textContent = e.target.value + '%';
    state.opacity = Number(e.target.value) / 100;
  };
  $('#facade-boxes').onchange = (e) => {
    $('.facade-outlines').toggleAttribute('hidden', !e.target.checked);
    state.boxes = e.target.checked;
  };
  $('#facade-zoom').onclick = () => {
    const zoom = $('.facade-photo').dataset.zoom !== 'true';
    $('.facade-photo').dataset.zoom = String(zoom);
    $('#facade-zoom').setAttribute('aria-pressed', String(zoom));
    $('#facade-zoom').textContent = zoom ? 'Fit image' : 'Inspect at 2×';
    state.zoom = zoom;
  };
  $('.facade-photo').onpointermove = (e) => {
    if (!state.zoom) return;
    const r = e.currentTarget.getBoundingClientRect();
    $('.facade-photo-inner').style.transformOrigin =
      `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  };
  $('.facade-overlay').style.opacity = 0.65;
  Object.assign(state, { masks: true, boxes: true, opacity: 0.65 });
  choose(photo.id);
}

async function volumes() {
  const data = await get('volumes.json');
  let epoch = 'e2',
    base = 'tin',
    pile = 'P02',
    viewer;
  $('#volume-date').innerHTML = data.captures
    .map(
      (c) =>
        `<option value="${c.epoch}" ${c.epoch === epoch ? 'selected' : ''}>${c.label}</option>`,
    )
    .join('');
  $('#volume-base').innerHTML = data.bases
    .map((b) => `<option value="${b.id}">${b.label}</option>`)
    .join('');
  $('#volume-pile').innerHTML = data.piles
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === pile ? 'selected' : ''}>${p.id} / ${p.name}</option>`,
    )
    .join('');
  $('.volume-workspace').insertAdjacentHTML(
    'beforebegin',
    '<div class="q-date-compare" aria-label="Compare captured survey dates">' +
      data.captures
        .map(
          (c) =>
            '<button data-epoch="' +
            c.epoch +
            '" aria-pressed="' +
            (c.epoch === epoch) +
            '">' +
            esc(c.label) +
            '</button>',
        )
        .join('') +
      '<span>Same camera. Two captured surfaces.</span></div>',
  );
  $$('[data-epoch]').forEach((b) =>
    b.addEventListener('click', () => {
      epoch = b.dataset.epoch;
      $('#volume-date').value = epoch;
      update(false);
    }),
  );
  const notes = {
    tin: 'A triangulated surface across the recorded toe.',
    plane: 'A best-fit plane through the toe points.',
    avg: 'A level base at the mean toe height.',
    low: 'A level base at the lowest toe point.',
  };
  function update(focus = true) {
    const p = data.piles.find((p) => p.id === pile),
      ep = p.epochs[epoch],
      v = ep.volumes[base];
    $$('[data-epoch]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.epoch === epoch)),
    );
    $('.volume-net').textContent = number(v.net, 0);
    $('.volume-name').textContent = p.id + ' / ' + p.name;
    $('.volume-base-note').textContent = notes[base];
    $('.volume-date-caption').textContent = data.captures.find((c) => c.epoch === epoch).label;
    $('.volume-facts').innerHTML = facts([
      ['FILL', number(v.fill) + ' m³'],
      ['CUT', number(v.cut) + ' m³'],
      ['FOOTPRINT', number(ep.areaM2) + ' m²'],
      ['HEIGHT', number(ep.heightM, 2) + ' m'],
    ]);
    const max = Math.max(
      ...data.captures.map((c) => Math.abs(p.epochs[c.epoch].volumes[base].net)),
      1,
    );
    $('.volume-bars').innerHTML = data.captures
      .map(
        (c) =>
          `<div><span>${c.label}<b>${number(p.epochs[c.epoch].volumes[base].net, 0)} m³</b></span><i style="width:${(Math.abs(p.epochs[c.epoch].volumes[base].net) / max) * 100}%"></i></div>`,
      )
      .join('');
    $('.pile-buttons').innerHTML = data.piles
      .map(
        (p) =>
          `<button data-pile="${p.id}" aria-pressed="${p.id === pile}"><span>${p.id}</span><strong>${number(p.epochs[epoch].volumes[base].net, 0)}</strong><small>m³</small></button>`,
      )
      .join('');
    $$('[data-pile]').forEach(
      (b) =>
        (b.onclick = () => {
          $('#volume-pile').value = pile = b.dataset.pile;
          update();
        }),
    );
    $('.inventory-total strong').textContent = number(data.totals[epoch][base], 0) + ' m³';
    Object.assign(state, {
      epoch,
      base,
      pile,
      net: v.net,
      fill: v.fill,
      cut: v.cut,
      total: data.totals[epoch][base],
    });
    viewer?.select(epoch, pile, focus);
  }
  $('.change-values').innerHTML = [
    ['FILL', data.pileChange.fill],
    ['CUT', data.pileChange.cut],
    ['NET CHANGE', data.pileChange.net],
  ]
    .map(
      ([label, v]) =>
        `<div><span>${label}</span><strong>${number(v, 0)} <small>m³</small></strong></div>`,
    )
    .join('');
  $('#volume-date').onchange = (e) => {
    epoch = e.target.value;
    update(false);
  };
  $('#volume-base').onchange = (e) => {
    base = e.target.value;
    update(false);
  };
  $('#volume-pile').onchange = (e) => {
    pile = e.target.value;
    update();
  };
  update();
  try {
    viewer = await createVolumeScene(data);
    viewer.select(epoch, pile, true);
    $('.case-reset').onclick = () => viewer.reset();
  } catch (e) {
    console.error(e);
    $('.volume-status').textContent = '3D unavailable. Source quantities remain available below.';
    state.sceneReady = false;
  }
}

async function createVolumeScene(data) {
  const THREE = await import('three'),
    { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'),
    { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const host = $('.volume-canvas'),
    renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x0b0f13);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Original stockyard survey terrain');
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(43, 1, 0.1, 5000),
    controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 5;
  controls.maxDistance = 1100;
  controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x87979b, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(150, 300, 100);
  scene.add(sun);
  const models = {};
  for (const epoch of ['e2', 'e1']) {
    const gltf = await new GLTFLoader().loadAsync(assets + 'survey-' + epoch + '.glb');
    models[epoch] = gltf.scene;
    gltf.scene.visible = epoch === 'e2';
    scene.add(gltf.scene);
  }
  const allBox = new THREE.Box3().setFromObject(models.e2),
    center = allBox.getCenter(new THREE.Vector3()),
    size = allBox.getSize(new THREE.Vector3());
  let active = 'e2',
    selected = 'P02';
  function frame(box) {
    const target = box.getCenter(new THREE.Vector3()),
      s = box.getSize(new THREE.Vector3()),
      distance = Math.max(s.x, s.z, s.y) * 1.25 + 12;
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(distance * 0.72, distance, distance * 0.72));
    controls.update();
  }
  function reset() {
    frame(allBox);
    state.wholeSurvey = true;
  }
  function select(epoch, pile, focus) {
    active = epoch;
    selected = pile;
    for (const [key, model] of Object.entries(models)) {
      model.visible = key === epoch;
      model.traverse((o) => {
        if (/^P\d+_e[12]$/.test(o.name))
          o.traverse((child) => {
            if (child.isLine) child.visible = o.name === pile + '_' + epoch;
          });
      });
    }
    const node = models[epoch].getObjectByName(pile + '_' + epoch);
    if (focus) {
      const p = data.piles.find((p) => p.id === pile),
        ring = p.epochs[epoch].ring;
      const pileBox = new THREE.Box3();
      for (const [x, z] of ring) pileBox.expandByPoint(new THREE.Vector3(x, center.y, z));
      if (node) {
        const nodeBox = new THREE.Box3().setFromObject(node);
        if (!nodeBox.isEmpty()) pileBox.union(nodeBox);
      }
      frame(pileBox);
      state.wholeSurvey = false;
    }
    state.sceneEpoch = active;
    state.scenePile = selected;
  }
  const resize = () => {
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();
  reset();
  let last = 0;
  function draw(t) {
    requestAnimationFrame(draw);
    if (document.hidden || t - last < 32) return;
    const r = host.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    last = t;
    controls.update();
    renderer.render(scene, camera);
    state.frames = (state.frames || 0) + 1;
  }
  requestAnimationFrame(draw);
  $('.volume-status').textContent = 'ORIGINAL SURVEY TERRAIN / RECORDED TOE BOUNDARY';
  state.sceneReady = true;
  state.modelCount = 2;
  state.terrainSize = [size.x, size.y, size.z];
  return { select, reset };
}

try {
  if (state.page === 'roads') await roads();
  if (state.page === 'facades') await facades();
  if (state.page === 'volumetric') await volumes();
  state.ready = true;
  document.body.dataset.ready = 'true';
} catch (error) {
  console.error(error);
  document.body.dataset.ready = 'error';
  const lab = $('.case-lab');
  lab?.insertAdjacentHTML(
    'afterbegin',
    '<p role="alert">The source preview could not load. Reload this page to try again.</p>',
  );
}

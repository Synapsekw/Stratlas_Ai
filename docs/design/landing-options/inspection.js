import { createInspectionScene } from './inspection-scene.js';
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const assets = '../assets/inspection/';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const page = document.body.dataset.page;
const menu = $('.menu-toggle');
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  $('#site-navigation').dataset.open = String(open);
});
let findings = [],
  scene = null,
  selected = 'F01',
  reportIndex = 0;
let annotationMode = null,
  annotationStart = null,
  draftBox = null;
const draftMarks = new Map();
function paintAnnotations() {
  if (!$('.draft-annotations')) return;
  const marks = draftMarks.get(selected) || [];
  const all = draftBox ? [...marks, draftBox] : marks;
  $('.draft-annotations').innerHTML = all
    .map((m, i) =>
      m.kind === 'point'
        ? `<circle cx="${m.x * 1000}" cy="${m.y * 750}" r="9"/><text x="${m.x * 1000 + 15}" y="${m.y * 750 - 13}">D${i + 1}</text>`
        : `<rect x="${m.x * 1000}" y="${m.y * 750}" width="${m.w * 1000}" height="${m.h * 750}"/><text x="${m.x * 1000 + 6}" y="${m.y * 750 + 20}">D${i + 1}</text>`,
    )
    .join('');
  $('.undo-annotation').disabled = !marks.length;
  $('.annotation-note').textContent = marks.length
    ? `${marks.length} draft ${marks.length === 1 ? 'annotation' : 'annotations'} in this preview. Source records and report evidence are unchanged.`
    : 'Try a point or a box on the source photo. Draft marks stay in this preview.';
}
let session;
try {
  session = JSON.parse(sessionStorage.getItem('stratlas-inspection-preview') || 'null');
} catch {}
const reviewed = new Set(session?.reviewed || []),
  included = new Set(session?.included || ['F01', 'F02', 'F05']);
const save = () => {
  try {
    sessionStorage.setItem(
      'stratlas-inspection-preview',
      JSON.stringify({ reviewed: [...reviewed], included: [...included] }),
    );
  } catch {}
  updateCounts();
};
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clock = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
function updateCounts() {
  if ($('.reviewed-total')) $('.reviewed-total').textContent = reviewed.size;
  if ($('.report-total')) $('.report-total').textContent = included.size;
}
function chooseFinding(id) {
  const f = findings.find((f) => f.id === id);
  if (!f) return;
  selected = id;
  scene?.focus(id);
  if ($('.selected-title')) {
    $('.selected-title').textContent = `${f.id} / ${f.title}`;
    $('.selected-location').textContent = `${f.area} · ${f.height.toFixed(2)} m`;
    $('.selected-evidence').href = `evidence.html?finding=${f.id}`;
  }
  if ($('.interior-photo')) {
    $$('.interior-register button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.insideFinding === id)),
    );
    $('.interior-photo').src = assets + f.photo;
    $('.interior-photo').alt = 'Original interior inspection: ' + f.title;
    $('.interior-source-id').textContent = 'SOURCE / ' + f.sourceImage;
    $('.interior-title').textContent = f.title;
    $('.interior-description').textContent = f.description;
    $('.interior-zone').textContent = f.area.toUpperCase();
    $('.interior-facts').innerHTML = [
      ['FINDING', f.id],
      ['SEVERITY', f.severity],
      ['HEIGHT', f.height.toFixed(2) + ' m'],
      ['CLASS', f.class],
    ]
      .map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + escape(v) + '</dd></div>')
      .join('');
    $('.interior-open').href = 'evidence.html?finding=' + f.id;
  }
  if (!$('.evidence-reader')) return;
  $$('.finding-item').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.finding === id)),
  );
  $('.finding-code').textContent = f.id;
  $('.finding-title').textContent = f.title;
  $('.severity-badge').textContent = `SEVERITY ${f.severity}`;
  $('.finding-description').textContent = f.description;
  $('.finding-photo').src = assets + f.photo;
  $('.finding-photo').alt = `Source inspection image: ${f.title}`;
  $('.photo-stage').dataset.zoom = 'false';
  $('.finding-photo').style.transformOrigin = '50% 50%';
  $('.zoom-photo').setAttribute('aria-pressed', 'false');
  $('.zoom-photo').textContent = 'Inspect at 2× ⌕';
  $('.photo-source').textContent = `SOURCE ${f.sourceImage}`;
  $('.spatial-selection').textContent = f.id;
  $('.finding-status').textContent = reviewed.has(id)
    ? 'Reviewed in preview'
    : 'Not marked in preview';
  $('.mark-reviewed').textContent = reviewed.has(id)
    ? 'Remove preview review mark ↶'
    : 'Mark reviewed in preview ✓';
  $('.mark-reviewed').setAttribute('aria-pressed', String(reviewed.has(id)));
  $('.include-report').checked = included.has(id);
  const facts = [
    ['CLASS', f.class],
    ['ASSET ZONE', f.area],
    ['FLIGHT / FRAME TIME', `${f.sourceFlight} / ${clock(f.sourceTime)}`],
    ['SOURCE REPORT', `Page ${f.reportPage}`],
    ['HEIGHT IN MODEL', `${f.height.toFixed(2)} m`],
    ['CAMERA TO FINDING', `${f.cameraDistance.toFixed(2)} m`],
  ];
  $('.finding-facts').innerHTML = facts
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`)
    .join('');
  $('.location-text').textContent =
    `X ${f.position[0].toFixed(3)} / Y ${f.position[1].toFixed(3)} / Z ${f.position[2].toFixed(3)} m`;
  const prior = $('.measure-target').value;
  $('.measure-target').innerHTML =
    '<option value="">Choose another finding</option>' +
    findings
      .filter((f) => f.id !== id)
      .map((f) => `<option value="${f.id}">${f.id} / ${escape(f.area)}</option>`)
      .join('');
  if (prior && prior !== id) $('.measure-target').value = prior;
  draftBox = null;
  annotationStart = null;
  paintAnnotations();
  updateMeasurement();
  updateCounts();
}
function renderRegister() {
  const query = ($('#finding-search')?.value || '').trim().toLowerCase();
  const severity = Number($('#severity-filter')?.value || 0);
  const filtered = findings.filter(
    (f) =>
      f.severity >= severity &&
      `${f.id} ${f.title} ${f.class} ${f.area}`.toLowerCase().includes(query),
  );
  $('.register-count').textContent = `${filtered.length} of ${findings.length} findings`;
  $('.finding-list').innerHTML = filtered.length
    ? filtered
        .map(
          (f) =>
            `<button class="finding-item" data-finding="${f.id}" aria-pressed="${f.id === selected}"><span>${f.id}</span><strong>${escape(f.title)}</strong><small>${escape(f.area)} · SEVERITY ${f.severity}</small></button>`,
        )
        .join('')
    : '<p class="empty-results">No findings match. Try a different word or lower the severity filter.</p>';
  $$('.finding-item').forEach((b) =>
    b.addEventListener('click', () => chooseFinding(b.dataset.finding)),
  );
}
function updateMeasurement() {
  if (!$('.measure-target')) return;
  const other = findings.find((f) => f.id === $('.measure-target').value),
    current = findings.find((f) => f.id === selected);
  if (other && current) {
    const distance =
      scene?.measure(current, other) ??
      Math.hypot(...current.position.map((p, i) => p - other.position[i]));
    $('.measurement-result').textContent = `${distance.toFixed(3)} m`;
  } else {
    $('.measurement-result').textContent = 'Select a second finding';
    scene?.clearMeasurement();
  }
}
function setSurface(value) {
  scene?.setSurface(value);
  $$('[data-surface]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.surface === value)),
  );
  $('.section-settings').hidden = value !== 'cutaway';
}
const cameraCopy = {
  orbit: 'Explore the whole asset. Drag the scene to orbit and use the wheel or pinch to zoom.',
  follow: 'Move with the recorded drone while keeping its surrounding structure in view.',
  drone:
    'Look from the recorded camera position. Turn on the model or LiDAR to change what the drone sees. Section clipping is suspended in this view.',
};
function setCamera(value) {
  scene?.setView(value);
  $$('[data-camera]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.camera === value)),
  );
  if ($('.camera-description')) $('.camera-description').textContent = cameraCopy[value];
}
function setLayer(layer, value) {
  scene?.setLayer(layer, value);
  const input = $(`[data-layer=${layer}]`);
  if (input) input.checked = value;
}
function renderReport() {
  const chosen = findings.filter((f) => included.has(f.id));
  if (reportIndex >= chosen.length) reportIndex = 0;
  $('.report-page-count').textContent =
    `${chosen.length} ${chosen.length === 1 ? 'FINDING' : 'FINDINGS'}`;
  $('.report-empty').hidden = chosen.length > 0;
  $$('[data-section]').forEach((input) => {
    $(`[data-report-section=${input.dataset.section}]`).hidden = !input.checked || !chosen.length;
  });
  $('.severity-chart').innerHTML = [5, 4, 3]
    .map((level) => {
      const count = chosen.filter((f) => f.severity === level).length;
      return `<div class="severity-bar"><span><span>SEVERITY ${level}</span><span>${count}</span></span><i><b style="width:${chosen.length ? (count / chosen.length) * 100 : 0}%"></b></i></div>`;
    })
    .join('');
  const zones = [...new Set(chosen.map((f) => f.area))];
  $('.report-summary-copy').textContent = chosen.length
    ? `${chosen.length} source observations across ${zones.length} asset ${zones.length === 1 ? 'zone' : 'zones'}. ${chosen.filter((f) => reviewed.has(f.id)).length} marked reviewed in this browser preview.`
    : '';
  $('.report-rows').innerHTML = chosen
    .map(
      (f) =>
        `<tr><td>${f.id}</td><td>${escape(f.title)}</td><td>${f.severity}</td><td>${escape(f.area)}</td></tr>`,
    )
    .join('');
  $('.evidence-page-number').textContent = chosen.length
    ? `${reportIndex + 1} / ${chosen.length}`
    : '0 / 0';
  $('.previous-evidence').disabled = reportIndex === 0;
  $('.next-evidence').disabled = reportIndex >= chosen.length - 1;
  const f = chosen[reportIndex];
  $('.report-evidence-content').innerHTML = f
    ? `<h3>${f.id} / ${escape(f.title)}</h3><img src="${assets + f.photo}" alt="Source evidence: ${escape(f.title)}"><p>${escape(f.description)}</p><p class="source-line">${escape(f.area)} · SEVERITY ${f.severity} · HEIGHT ${f.height.toFixed(2)} m<br>SOURCE IMAGE ${f.sourceImage} · FLIGHT ${f.sourceFlight} · ${clock(f.sourceTime)}<br>SOURCE REPORT PAGE ${f.reportPage}</p>`
    : '';
  $('.download-csv').disabled = !chosen.length;
}
function downloadCsv() {
  const selectedFindings = findings.filter((f) => included.has(f.id));
  const rows = [
    [
      'Finding',
      'Observation',
      'Severity',
      'Class',
      'Zone',
      'Height (m)',
      'X (m)',
      'Y (m)',
      'Z (m)',
      'Source image',
      'Source flight',
      'Source time (s)',
      'Source report page',
      'Reviewed in preview',
    ],
    ...selectedFindings.map((f) => [
      f.id,
      f.title,
      f.severity,
      f.class,
      f.area,
      f.height,
      ...f.position,
      f.sourceImage,
      f.sourceFlight,
      f.sourceTime,
      f.reportPage,
      reviewed.has(f.id) ? 'Yes' : 'No',
    ]),
  ];
  const csv =
    '\ufeff' +
    rows
      .map((r) => r.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(','))
      .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'quadrion-sample-findings.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('.download-status').textContent =
    `Downloaded ${selectedFindings.length} selected findings. The original project has not been changed.`;
}
function packageScope() {
  const layers = $$('[data-package]:checked').map((i) => i.dataset.package);
  $('.package-result').textContent =
    `SAMPLE READ-ONLY SCOPE: ${layers.length ? layers.join(' + ') + ' + ' : ''}finding records, photos and report. Local review, no cloud required.`;
}

try {
  const response = await fetch(assets + 'findings.json');
  if (!response.ok) throw new Error('Inspection records could not be loaded');
  findings = await response.json();
  const queryId = new URL(location.href).searchParams.get('finding');
  if (findings.some((f) => f.id === queryId)) selected = queryId;
  if ($('.interior-register')) {
    $('.interior-register').innerHTML = findings
      .map(
        (f) =>
          '<button data-inside-finding="' +
          f.id +
          '" aria-pressed="' +
          (f.id === selected) +
          '"><small>' +
          f.id +
          ' / ' +
          escape(f.area).toUpperCase() +
          '</small><span>' +
          escape(f.title) +
          '</span></button>',
      )
      .join('');
    $$('[data-inside-finding]').forEach((b) =>
      b.addEventListener('click', () => chooseFinding(b.dataset.insideFinding)),
    );
    $('.interior-locate').addEventListener('click', () => {
      setCamera('orbit');
      setLayer('pins', true);
      scene?.focus(selected);
      $('.inspection-scene').scrollIntoView({
        behavior: reduced.matches ? 'instant' : 'smooth',
        block: 'center',
      });
    });
    chooseFinding(selected);
  }
  if ($('.finding-list')) {
    renderRegister();
    chooseFinding(selected);
    $('#finding-search').addEventListener('input', renderRegister);
    $('#severity-filter').addEventListener('change', renderRegister);
    $('.zoom-photo').addEventListener('click', () => {
      const zoom = $('.photo-stage').dataset.zoom !== 'true';
      $('.photo-stage').dataset.zoom = String(zoom);
      $('.zoom-photo').setAttribute('aria-pressed', String(zoom));
      $('.zoom-photo').textContent = zoom ? 'Fit photo ↙' : 'Inspect at 2× ⌕';
    });
    $('.photo-stage').addEventListener('pointermove', (e) => {
      if ($('.photo-stage').dataset.zoom !== 'true') return;
      const r = e.currentTarget.getBoundingClientRect();
      $('.finding-photo').style.transformOrigin =
        `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
    });
    const photoStage = $('.photo-stage');
    photoStage.tabIndex = 0;
    photoStage.setAttribute('role', 'group');
    photoStage.setAttribute(
      'aria-label',
      'Source photo. Select Point or Box and press Enter to add a centered draft annotation.',
    );
    photoStage.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !annotationMode || e.target !== photoStage) return;
      e.preventDefault();
      const marks = draftMarks.get(selected) || [];
      marks.push(
        annotationMode === 'point'
          ? { kind: 'point', x: 0.5, y: 0.5 }
          : { kind: 'box', x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
      );
      draftMarks.set(selected, marks);
      paintAnnotations();
    });
    const coords = (e) => {
      const r = photoStage.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      };
    };
    $$('[data-annotation]').forEach((b) =>
      b.addEventListener('click', () => {
        annotationMode = annotationMode === b.dataset.annotation ? null : b.dataset.annotation;
        $$('[data-annotation]').forEach((x) =>
          x.setAttribute('aria-pressed', String(x.dataset.annotation === annotationMode)),
        );
        photoStage.dataset.drawing = String(!!annotationMode);
        if (annotationMode && photoStage.dataset.zoom === 'true') $('.zoom-photo').click();
      }),
    );
    $('.zoom-photo').addEventListener('click', () => {
      if (photoStage.dataset.zoom === 'true') {
        annotationMode = null;
        photoStage.dataset.drawing = 'false';
        $$('[data-annotation]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      }
    });
    photoStage.addEventListener('pointerdown', (e) => {
      if (!annotationMode || e.target.closest('button') || e.target.closest('.photo-toolbar'))
        return;
      e.preventDefault();
      annotationStart = coords(e);
      photoStage.setPointerCapture(e.pointerId);
    });
    photoStage.addEventListener('pointermove', (e) => {
      if (!annotationStart || annotationMode !== 'box') return;
      const p = coords(e);
      draftBox = {
        kind: 'box',
        x: Math.min(p.x, annotationStart.x),
        y: Math.min(p.y, annotationStart.y),
        w: Math.abs(p.x - annotationStart.x),
        h: Math.abs(p.y - annotationStart.y),
      };
      paintAnnotations();
    });
    photoStage.addEventListener('pointerup', () => {
      if (!annotationStart) return;
      const marks = draftMarks.get(selected) || [];
      if (annotationMode === 'point') marks.push({ kind: 'point', ...annotationStart });
      else if (draftBox && draftBox.w > 0.005 && draftBox.h > 0.005) marks.push(draftBox);
      draftMarks.set(selected, marks);
      annotationStart = null;
      draftBox = null;
      paintAnnotations();
    });
    photoStage.addEventListener('pointercancel', () => {
      annotationStart = null;
      draftBox = null;
      paintAnnotations();
    });
    $('.undo-annotation').addEventListener('click', () => {
      draftMarks.get(selected)?.pop();
      paintAnnotations();
    });
    $('.mark-reviewed').addEventListener('click', () => {
      reviewed.has(selected) ? reviewed.delete(selected) : reviewed.add(selected);
      save();
      chooseFinding(selected);
    });
    $('.include-report').addEventListener('change', (e) => {
      e.target.checked ? included.add(selected) : included.delete(selected);
      save();
    });
    $('.measure-target').addEventListener('change', updateMeasurement);
  }
  if ($('.report-findings')) {
    $('.report-findings').innerHTML = findings
      .map(
        (f) =>
          `<label><input type="checkbox" data-include="${f.id}" ${included.has(f.id) ? 'checked' : ''}><span>${f.id} / ${escape(f.title)}<small>${escape(f.area)} · SEVERITY ${f.severity}</small></span></label>`,
      )
      .join('');
    $$('[data-include]').forEach((i) =>
      i.addEventListener('change', () => {
        i.checked ? included.add(i.dataset.include) : included.delete(i.dataset.include);
        save();
        renderReport();
      }),
    );
    $$('[data-section]').forEach((i) => i.addEventListener('change', renderReport));
    $('.previous-evidence').addEventListener('click', () => {
      reportIndex--;
      renderReport();
    });
    $('.next-evidence').addEventListener('click', () => {
      reportIndex++;
      renderReport();
    });
    $('.download-csv').addEventListener('click', downloadCsv);
    $$('[data-package]').forEach((i) => i.addEventListener('change', packageScope));
    renderReport();
    packageScope();
  }
  const sceneRoot = $('.inspection-scene');
  if (sceneRoot) {
    const spatialInputs = $$('.scene-controls button,.scene-controls input,.scene-controls select');
    spatialInputs.forEach((i) => (i.disabled = true));
    scene = await createInspectionScene(sceneRoot, findings, chooseFinding);
    if (scene) {
      spatialInputs.forEach((i) => (i.disabled = false));
      scene.focus(selected);
      updateMeasurement();
    }
    $('.reset-scene').addEventListener('click', () => {
      scene?.reset();
      if ($('.camera-description')) setCamera('orbit');
    });
  }
  if ($('.scene-controls')) {
    $$('[data-surface]').forEach((b) =>
      b.addEventListener('click', () => setSurface(b.dataset.surface)),
    );
    $$('[data-camera]').forEach((b) =>
      b.addEventListener('click', () => {
        setCamera(b.dataset.camera);
        if (innerWidth <= 760)
          $('.inspection-scene').scrollIntoView({
            behavior: reduced.matches ? 'instant' : 'smooth',
            block: 'center',
          });
      }),
    );
    $$('[data-layer]').forEach((i) =>
      i.addEventListener('change', () => setLayer(i.dataset.layer, i.checked)),
    );
    $('.cut-direction').addEventListener('change', (e) => {
      const horizontal = e.target.value === 'horizontal',
        range = $('.section-range');
      range.min = '0';
      range.max = horizontal ? '9.5' : '359';
      range.step = horizontal ? '0.1' : '1';
      range.value = horizontal ? '5' : '37';
      range.setAttribute(
        'aria-label',
        horizontal ? 'Section height in metres' : 'Section bearing in degrees',
      );
      $('.section-label').textContent = horizontal ? 'Cut height' : 'Cut bearing';
      range.dispatchEvent(new Event('input'));
    });
    $('.section-range').addEventListener('input', (e) => {
      const axis = $('.cut-direction').value,
        value = Number(e.target.value);
      $('.cut-value').textContent = axis === 'horizontal' ? `${value.toFixed(1)} m` : `${value}°`;
      scene?.setSection(axis, value);
    });
    $$('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        const preset = b.dataset.preset;
        setCamera(preset === 'flight' ? 'drone' : 'orbit');
        setSurface(preset === 'scan' ? 'transparent' : 'cutaway');
        setLayer('scan', preset === 'scan');
        setLayer('model', true);
        $('#interactive-tank').scrollIntoView({
          behavior: reduced.matches ? 'instant' : 'smooth',
          block: 'start',
        });
      }),
    );
    $('.scan-colour')?.addEventListener('change', (e) => {
      setLayer('scan', true);
      scene?.setScanColour(e.target.value);
      $('.scan-colour-note').textContent =
        e.target.value === 'height'
          ? 'Blue to lime: low to high in the local tank frame.'
          : e.target.value === 'flight'
            ? 'Cyan: shell pass · lime: roof pass.'
            : 'Brightness follows the captured return intensity.';
    });
    const video = $('.inspection-video'),
      button = $('.inspection-play');
    function sync() {
      button.innerHTML = video.paused
        ? 'Play inspection <span>▷</span>'
        : 'Pause inspection <span>Ⅱ</span>';
    }
    button.addEventListener('click', () => {
      if (video.paused)
        video.play().catch(() => {
          button.textContent = 'Playback unavailable';
        });
      else video.pause();
    });
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('timeupdate', () => {
      $('.inspection-seek').value = video.currentTime;
      $('.inspection-time').textContent = clock(video.currentTime);
    });
    $('.inspection-seek').addEventListener('input', (e) => {
      video.currentTime = Number(e.target.value);
      $('.inspection-time').textContent = clock(video.currentTime);
    });
  }
  document.body.dataset.ready = 'true';
} catch (error) {
  console.error(error);
  const status = $('.scene-status') || $('.download-status');
  if (status)
    status.textContent = 'The preview data could not be loaded. Reload this page to try again.';
  document.body.dataset.ready = 'error';
}
window.inspectionPreview = {
  getState: () => ({
    ready: document.body.dataset.ready,
    page,
    selected,
    reviewed: [...reviewed],
    included: [...included],
    draftCount: (draftMarks.get(selected) || []).length,
    scene: scene?.getState() || null,
  }),
};

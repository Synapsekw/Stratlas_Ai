import { useCaseMenu } from './use-case-shell.mjs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderAtlas } from './render-atlas.mjs';
import { requiredEnv } from './private-sources.mjs';
const directory = new URL('./', import.meta.url);
// Two application screenshots in the private docs/design/assets/landing-2026-10-05 folder.
const workspaceShot = requiredEnv(
  'WORKSPACE_SHOT',
  'the file name of the workspace screenshot in docs/design/assets/landing-2026-10-05',
);
const inspectionShot = requiredEnv(
  'INSPECTION_SHOT',
  'the file name of the inspection screenshot in docs/design/assets/landing-2026-10-05',
);
const brand = `<a class="brand" href="index.html" aria-label="Stratlas home"><img src="brand.svg" alt=""/><span>stratlas</span></a>`;
function page(light) {
  const name = light ? 'atlas' : 'reality';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Stratlas / ${light ? 'Spatial Atlas' : 'Change reality'}</title><link rel="icon" href="brand.svg" type="image/svg+xml"><link rel="stylesheet" href="atlas-theme.css"><link rel="stylesheet" href="fusion.css"></head>
<body data-direction="${name}">
<a class="skip" href="#experience">Skip to interactive experience</a>
<header class="site-header">${brand}<nav aria-label="Main">${useCaseMenu()}<a href="confined-spaces.html">Confined spaces</a><a href="corrosion.html">Corrosion in 3D</a><a href="evidence.html">Findings & evidence</a><a href="reporting.html">Reports & handover</a><button data-product>Explore the product <span>↗</span></button></nav></header><nav class="product-subnav" aria-label="Inspection pages">${useCaseMenu()}<a href="confined-spaces.html">Confined spaces ↗</a><a href="corrosion.html">Corrosion ↗</a><a href="evidence.html">Evidence ↗</a><a href="reporting.html">Reports ↗</a></nav>
<main>
<section class="hero" id="experience" aria-label="Interactive data fusion demonstration">
 <div class="reality-stage" data-perspective="${light ? 'orbit' : 'drone'}">
  <video class="source-video" src="../assets/fusion/flight.mp4" poster="../assets/fusion/flight.jpg" loop muted playsinline preload="auto" aria-label="Original drone survey footage"></video>
  <div class="spatial-canvas"></div><div class="scene-shade"></div>
  <div class="load-status" role="status">Loading real spatial layers</div>
  <div class="scene-coordinate"><span class="crosshair">+</span><span class="camera-label">Drone eye / pose linked</span><span class="altitude">103.8 m</span></div>
  <div class="wipe-control"><button class="wipe-handle" aria-label="Drag boundary between spatial layer and footage" tabindex="-1"><span>‹</span><span>›</span></button><span class="wipe-caption">CHANGE REALITY</span></div>
  <div class="scene-label left-label"><i></i><span class="layer-label">Engineering model</span></div><div class="scene-label right-label"><i></i>Drone footage</div>
 </div>
 <div class="hero-copy"><p class="eyebrow"><span class="signal"></span> SPATIAL INTELLIGENCE, FUSED.</p>
  <h1>${light ? 'Reality has<br>more than<br><em>one layer.</em>' : 'One flight.<br><em>Every reality.</em>'}</h1>
  <p class="hero-intro">${light ? 'The world you capture. The structure beneath it. The intelligence between them.' : 'Go beyond the camera. Move through video, 3D models, point clouds and maps from the very same drone view.'}</p>
  ${light ? '<button class="enter-flight">Enter the drone view <span>↗</span></button>' : '<a class="hero-link" href="#fusion-story">A new way to see <span>↓</span></a>'}
 </div>
 <div class="hero-side"><span class="micro">REAL DATA / LIVE 3D</span><p>Change the layer.<br>Keep the perspective.</p><span class="orbit-ring" aria-hidden="true">+</span></div>
 <div class="experience-console">
  <div class="console-top"><span class="mode-description">Drag to change reality</span><div class="perspective-switch" aria-label="Camera perspective"><button class="perspective-button" data-perspective="drone" aria-pressed="${!light}">Drone eye</button><button class="perspective-button" data-perspective="orbit" aria-pressed="${light}">Spatial view</button></div></div>
  <div class="mode-switch" role="group" aria-label="Choose a reality layer">${[
    ['video', 'Video'],
    ['model', '3D model'],
    ['cloud', 'Point cloud'],
    ['map', 'Map'],
    ['fusion', 'Fuse views'],
  ]
    .map(
      ([key, label], i) =>
        `<button class="mode-button" data-mode="${key}" aria-pressed="${key === 'fusion'}"><span class="mode-number">0${i + 1}</span><span>${label}</span>${key === 'fusion' ? '<b>◈</b>' : ''}</button>`,
    )
    .join('')}</div>
  <div class="flight-controls"><button class="play-toggle" aria-label="Play flight"><span>▷</span><span>Play flight</span></button><span class="timecode">00:00.0</span><input class="timeline-input" aria-label="Flight time in seconds" type="range" min="0" max="10.9" step="0.1" value="0"><span class="micro">00:11</span><label class="fusion-label">FUSION<input class="fusion-range" aria-label="Spatial layer percentage" type="range" min="0" max="100" value="54"></label></div>
 </div>
 <div class="hero-foot"><span>01 / A DIFFERENT PERSPECTIVE</span><span>Scroll to uncover <span>↓</span></span><span>VIDEO × GEOMETRY × GEOGRAPHY</span></div>
</section>
<section class="perspective-note" aria-live="polite"><span class="mode-index">05 / AUGMENTED REALITY</span><h2 class="view-title">Move between worlds.</h2><p class="view-description">Drag the boundary. The footage and spatial view follow the same recorded camera path.</p></section>
<section class="fusion-story chapter" id="fusion-story" data-chapter="fusion">
 <div class="section-heading"><span class="eyebrow">02 / DATA FUSION</span><h2>A frame shows you a moment.<br><em>Fusion gives it a world.</em></h2></div>
 <div class="fusion-composition"><div class="layer-stack" aria-label="Video, model and survey layers in a shared spatial frame">
  <button class="stack-layer stack-map" data-jump-mode="map"><img src="../assets/fusion/survey.jpg" alt="Actual orthomosaic survey"><span>04 / ORTHOMOSAIC</span></button>
  <button class="stack-layer stack-cloud" data-jump-mode="cloud"><img src="../assets/fusion/cloud-preview.jpg" alt="Actual survey point cloud"><span>03 / POINT CLOUD</span></button>
  <button class="stack-layer stack-model" data-jump-mode="model"><img src="../assets/fusion/model-preview.jpg" alt="Actual engineering model"><span>02 / 3D MODEL</span></button>
  <button class="stack-layer stack-video" data-jump-mode="video"><img src="../assets/fusion/flight.jpg" alt="Recorded drone view"><span>01 / DRONE VIDEO</span></button>
  <div class="stack-axis" aria-hidden="true"></div>
 </div><div class="fusion-explanation"><span class="large-plus">+</span><h3>Different sources.<br>Shared reality.</h3><p>Bring the captured, the measured and the designed into the same spatial frame. Move between layers while retaining the drone's position and direction.</p><div class="numbered-line"><span>01</span>Follow the recorded flight</div><div class="numbered-line"><span>02</span>Change the visible world</div><div class="numbered-line"><span>03</span>Keep the evidence in context</div><button class="text-link" data-jump-mode="fusion">Try the transformation <span>↗</span></button></div></div>
</section>
<section class="workspace-section chapter" id="workspace" data-chapter="workspace"><div class="workspace-heading"><span class="eyebrow">03 / THE WORKSPACE</span><h2>Everything connects.<br><em>Nothing loses its place.</em></h2><p>Video follows the flight. Photos belong to positions. Findings point back to evidence. Explore them together in the real Stratlas workspace.</p></div><div class="product-frame"><div class="product-caption"><span><i></i> STRATLAS / FUSED WORKSPACE</span><button data-product>Inspect the interface ↗</button></div><div class="product-crop"><img src="../assets/landing-2026-10-05/${workspaceShot}" alt="Stratlas workspace with fused model, survey points, flight video, asset labels and timeline" loading="lazy"></div></div><div class="workspace-legend"><span><b>01</b> Spatially located assets</span><span><b>02</b> Synchronized video</span><span><b>03</b> One shared timeline</span></div></section>
<section class="detail-story"><div><span class="eyebrow">WITHIN THE ASSET</span><h2>Go inside.<br><em>Bring the context.</em></h2><p>Cut through the model. Follow the inspection flight. Locate a finding and see the image that proves it, all within the same spatial workspace.</p><div class="detail-points"><span>MODEL CUTAWAYS</span><span>FLIGHT TELEMETRY</span><span>LINKED EVIDENCE</span></div><a class="text-link" href="confined-spaces.html">Explore confined-space inspections ↗</a></div><div class="detail-visual"><div class="inspection-crop"><img src="../assets/landing-2026-10-05/${inspectionShot}" alt="Actual tank inspection workspace, showing a model cutaway, spatial findings and drone flight" loading="lazy"></div><div class="evidence-crop"><img src="../assets/landing-2026-10-05/${inspectionShot}" alt="Actual finding panel and image evidence for a bottom plate crack" loading="lazy"></div><div class="detail-caption">ACTUAL WORKSPACE / CONNECTED INSPECTION VIEWS</div></div></section>
<section class="capabilities chapter" data-chapter="intelligence"><span class="eyebrow">04 / AUGMENTED UNDERSTANDING</span><div class="capability-intro"><h2>Seeing is the start.<br><em>Understanding is the point.</em></h2><p>Go from a view of an asset to a view of what matters.</p></div><div class="capability-rows"><div><span class="row-no">01</span><h3>See beneath the surface</h3><p>Model cutaways reveal internal structure. Drone-eye and follow modes put the camera inside the scene.</p><span class="row-symbol">⌖</span></div><div><span class="row-no">02</span><h3>Anchor the evidence</h3><p>Connect photos, annotations and findings to the physical asset. Follow an observation back to its source.</p><span class="row-symbol">⊕</span></div><div><span class="row-no">03</span><h3>Read the change</h3><p>Compare survey dates, inspect elevation and cut or fill, and measure stockpile volumes in context.</p><span class="row-symbol">∆</span></div><div><span class="row-no">04</span><h3>Work beyond the network</h3><p>Keep maps, models, imagery and reports in the local workspace. Enable connected intelligence when needed.</p><span class="row-symbol">↗</span></div></div></section>
<section class="inspection-pages"><span class="eyebrow">EXPLORE THE INSPECTION PLATFORM</span><h2>Go deeper.<br><em>Keep the connection.</em></h2><a href="confined-spaces.html"><span>01</span><h3>Inside the asset</h3><p>Move the section plane, compare LiDAR and fly through the tank.</p><b>↗</b></a><a href="evidence.html"><span>02</span><h3>Behind the finding</h3><p>Explore source photos, spatial locations, severity and review.</p><b>↗</b></a><a href="reporting.html"><span>03</span><h3>Into the deliverable</h3><p>Build a report preview and explore the handover options.</p><b>↗</b></a><a href="corrosion.html"><span>04</span><h3>Across the surface</h3><p>Orbit the flare stack with real corrosion masks mapped onto its geometry.</p><b>↗</b></a>
<a href="roads.html"><span>05</span><h3>Along the corridor</h3><p>Inspect road distress, move by chainage and compare source PCI assessments.</p><b>↗</b></a><a href="volumetric.html"><span>06</span><h3>Across survey dates</h3><p>Explore 19 stockpiles, four base methods and source cut-and-fill results.</p><b>↗</b></a><a href="facades.html"><span>07</span><h3>On every elevation</h3><p>Review facade photos, classified masks and visual or thermal observations.</p><b>↗</b></a></section><section class="closing"><span class="eyebrow">STRATLAS / SPATIAL INTELLIGENCE</span><h2>Reality is the<br><em>starting point.</em></h2><button data-jump-mode="fusion">Change your perspective <span>↗</span></button><div class="closing-foot">${brand}<span>A SYNAPSE SOLUTIONS PRODUCT</span><a href="#experience">Back to the flight ↑</a></div></section>
</main>
<aside class="direction-switch" aria-label="Design direction"><span>CONCEPT</span><a href="index.html" ${!light ? 'aria-current="page"' : ''}>01 Reality</a><a href="atlas.html" ${light ? 'aria-current="page"' : ''}>02 Atlas</a></aside>
<dialog id="product-dialog"><div class="dialog-head"><span>STRATLAS / THE REAL WORKSPACE</span><button class="close-dialog" aria-label="Close product view">Close ×</button></div><div class="product-crop"><img src="../assets/landing-2026-10-05/${workspaceShot}" alt="Actual Stratlas spatial workspace, with the project header excluded"></div><p>Actual application capture. The interactive landing experience above uses the real model, survey points, imagery and recorded camera poses. Survey registration is approximate.</p></dialog>
<script type="module" src="../assets/fusion/fusion.bundle.js"></script>
</body></html>`;
}
await writeFile(new URL('index.html', directory), page(false));
await writeFile(new URL('atlas.html', directory), renderAtlas(page(true)));
// Old review URLs now open the revised concepts, with no legacy customer copy.
for (const [file, destination] of [
  ['mission.html', 'index.html'],
  ['precision.html', 'atlas.html'],
])
  await writeFile(
    new URL(file, directory),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${destination}"><title>Stratlas</title></head><body><a href="${destination}">Open the new data fusion direction</a></body></html>`,
  );
console.log('Rendered Reality and Atlas design directions.');

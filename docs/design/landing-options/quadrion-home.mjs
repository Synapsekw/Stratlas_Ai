import { disciplines } from './quadrion-site.mjs';
export function refineHome(html) {
  html = html
    .replace(
      'Reality has<br>more than<br><em>one layer.</em>',
      'Four dimensions.<br><em>One view.</em>',
    )
    .replace('THE CONNECTED VIEW OF YOUR ASSET', 'QUADRION AI / SPATIAL INTELLIGENCE')
    .replace(
      'The plant. The measured world.<br>The flight that brings them together.',
      'Fuse drone footage, 3D models and measured reality.<br>Keep every observation connected.',
    )
    .replace('See the flight in 3D', 'Play the transformation')
    .replace('Explore the inspection platform', 'Explore the software')
    .replace(
      '<div class="atlas-canvas"></div>',
      '<img class="atlas-fallback" src="../assets/fusion/model-preview.jpg" alt="Engineering model of the inspected plant"><div class="atlas-canvas"></div>',
    )
    .replace('BUILD YOUR VIEW', 'EXPLORE FREELY')
    .replace('ATLAS / LIVE SPATIAL VIEW', 'REAL DATA / LIVE SPATIAL VIEW');
  const tour = `<div class="q-tour" aria-label="Guided spatial transformation"><div class="q-tour-caption" aria-live="polite"><strong>Start with the structure.</strong><span>One real plant. Five connected ways to understand it.</span></div><div class="q-tour-actions"><button class="q-tour-play" aria-label="Play guided transformation">Play tour</button><button class="q-tour-reset" aria-label="Restart guided transformation">↺</button></div><div class="q-tour-steps" aria-label="Transformation chapters">${['The model', 'Measured reality', 'The flight', 'Projected video', 'Drone perspective'].map((name, i) => `<button data-tour-step="${i}" aria-current="${i === 0 ? 'step' : 'false'}"><small>0${i + 1}</small>${name}</button>`).join('')}</div></div>`;
  html = html.replace('<div class="atlas-hero-foot">', tour + '<div class="atlas-hero-foot">');
  const heroEnd =
    html.indexOf('</section>', html.indexOf('<section class="atlas-hero')) + '</section>'.length;
  const descriptions = {
    'confined-spaces': [
      'Reveal what the shell conceals.',
      'Section the tank, inspect the measured interior and follow the recorded flight. Move directly from a spatial finding to its original photograph.',
      'MODEL + INTERIOR LIDAR + RECORDED FLIGHT',
    ],
    corrosion: [
      'Condition belongs on the asset.',
      'Explore 78 original surface patches on a real flare-stack model. Isolate a region, read its class and return to the photograph that supports it.',
      'SOURCE MASKS / MAPPED IN 3D',
    ],
    roads: [
      'From kilometres to the smallest detail.',
      'Move along a real corridor, inspect pavement condition and follow mapped defects into their source imagery. Keep the assessment tied to its location.',
      'CORRIDOR + CHAINAGE + SOURCE EVIDENCE',
    ],
    volumetric: [
      'See the terrain behind the total.',
      'Compare two captured surveys and 19 stockpiles. Explore recorded toe boundaries, four base methods and the source cut-and-fill results.',
      'TWO SURVEY DATES / ONE SHARED WORKSPACE',
    ],
    facades: [
      'Read the whole envelope.',
      'Connect component and elevation metadata with visual and thermal photographs. Inspect classified regions and the observations behind them.',
      'VISUAL + THERMAL / ORIGINAL CAPTURES',
    ],
  };
  const body = `<section class="q-product-story" id="fusion-story"><div class="q-story-intro"><div><span class="q-label">FROM REALITY TO A REVIEWABLE ANSWER</span><h2>A finding is more than<br>a mark on an image.</h2></div><p>Its location, source and context belong together. Quadrion connects the scene you explore to the evidence you review and the deliverable you share.</p></div><div class="q-evidence-flow"><a class="q-flow-image" href="evidence.html?finding=F05"><img src="../assets/inspection/F05.jpg" alt="Original interior inspection photograph of a recorded top-plate finding" loading="lazy"><span>F05 / ORIGINAL INSPECTION EVIDENCE ↗</span></a><div class="q-flow-copy"><div><span class="q-label">01 / LOCATE</span><strong>Know where it belongs.</strong><p>Find the observation in the asset's spatial frame.</p></div><div><span class="q-label">02 / REVIEW</span><strong>Keep the proof in view.</strong><p>Inspect the original photograph, classification and notes.</p></div><div><span class="q-label">03 / DELIVER</span><strong>Carry the context forward.</strong><p>Build a register and report from the same connected findings.</p></div><a class="q-link" href="evidence.html?finding=F05">Follow this finding <span>↗</span></a></div></div></section>
  <section class="q-solutions" id="solutions"><div class="q-section-heading"><div><span class="q-label">ONE SOFTWARE PLATFORM. DIFFERENT PERSPECTIVES.</span><h2>Built around the<br>way you inspect.</h2></div><p>Explore original data from five inspection and survey workflows. Each experience is connected by the same spatial foundation.</p></div>${disciplines
    .map(([id, title, , image], i) => {
      const [heading, copy, label] = descriptions[id];
      return `<article class="q-feature"><a class="q-feature-visual" href="${id}.html"><img src="../assets/${image}" alt="${title}: original inspection or survey data" loading="lazy"><span>${label}</span></a><div><span class="q-label">0${i + 1} / ${title}</span><h3>${heading}</h3><p>${copy}</p><a class="q-link" href="${id}.html">Explore ${title.toLowerCase()} <span>↗</span></a></div></article>`;
    })
    .join('')}</section>
  <section class="q-intelligence" id="intelligence"><div><span class="q-label">THE WORKSPACE BEHIND THE VIEW</span><h2>Your data.<br>Your context.<br>Your control.</h2><p>A desktop inspection platform that keeps source data and spatial context together, with optional AI assistance where you work.</p><a class="q-link" href="confined-spaces.html#capabilities">Explore the inspection capabilities <span>↗</span></a></div><div><article><h3>Assistance with the evidence in view.</h3><p>The desktop agent can work with the current photo, video frame, 3D view or findings context. Review proposed actions through the configured permissions and approval controls.</p></article><article><h3>Review locally. Connect when you choose.</h3><p>Models, scans, media and findings stay available in the local project. Optional cloud AI uses your configured provider and project sharing policy.</p></article><article><h3>Share an answer with its sources.</h3><p>Generate reports and structured exports, or deliver a portable project that retains the selected layers and original evidence.</p><a class="q-link" href="reporting.html">Explore deliverables <span>↗</span></a></article></div></section>
  <section class="q-product-end"><h2>See more.<br>Keep the connection.</h2><a href="#experience">Replay the transformation <span>↑</span></a></section>`;
  // The hero engine retains its optional workspace dialog hooks; the source images are unbranded data views.
  const dialog = `<dialog id="product-dialog"><div class="dialog-head"><span>QUADRION AI / CONNECTED WORKSPACE</span><button class="close-dialog" aria-label="Close product view">Close ×</button></div><img src="../assets/fusion/model-preview.jpg" alt="Engineering model from the source project"></dialog>`;
  return (
    html.slice(0, heroEnd) +
    body +
    '</main><footer></footer>' +
    dialog +
    '<script type="module" src="../assets/fusion/atlas.bundle.js"></script></body></html>'
  );
}

export function renderAtlas(base) {
  const hero = `<section class="atlas-hero" id="experience" aria-label="Interactive plant model with fused survey data">
  <div class="atlas-scene" tabindex="0" aria-label="Interactive 3D plant. Drag to orbit and scroll to zoom. Use the layer and view controls to explore with a keyboard."><div class="atlas-canvas"></div><div class="atlas-scene-fade"></div><span class="atlas-load" role="status">Preparing the spatial view</span><span class="atlas-drone-label" hidden>DRONE / <b>103.8 m</b></span></div>
  <div class="atlas-hero-copy"><p class="eyebrow"><span class="signal"></span> THE CONNECTED VIEW OF YOUR ASSET</p><h1>Reality has<br>more than<br><em>one layer.</em></h1><p class="atlas-deck">The plant. The measured world.<br>The flight that brings them together.</p><button class="atlas-launch">See the flight in 3D <span>↗</span></button><a class="atlas-secondary" href="confined-spaces.html">Explore the inspection platform <span>→</span></a></div>
  <div class="atlas-scene-caption"><span class="micro">ATLAS / LIVE SPATIAL VIEW</span><span class="atlas-current-view">Engineering geometry</span></div>
  <div class="atlas-height-legend" hidden><span>HEIGHT ABOVE SITE DATUM</span><div><i></i><div><b class="height-max">80 m</b><b class="height-mid">40 m</b><b class="height-min">0 m</b></div></div><small>757,579 captured points</small></div>
  <aside class="atlas-layer-panel" aria-label="Plant display controls"><div class="atlas-panel-title"><span>BUILD YOUR VIEW</span><span class="atlas-layer-count">01 / 03</span></div><div class="atlas-model-row"><span><i class="atlas-model-icon"></i>3D plant model</span><small>BASE LAYER</small></div>
  <label class="atlas-layer-toggle"><span><i class="atlas-cloud-icon"></i><span>Point cloud<small>Read the height of the site</small></span></span><input type="checkbox" id="atlas-cloud"><span class="atlas-toggle" aria-hidden="true"></span></label>
  <label class="atlas-layer-toggle"><span><i class="atlas-video-icon"></i><span>Drone video<small>Project the flight onto the model</small></span></span><input type="checkbox" id="atlas-video"><span class="atlas-toggle" aria-hidden="true"></span></label>
  <div class="atlas-flight-panel" hidden><div class="atlas-feed"><video class="atlas-video-source" src="../assets/fusion/flight.mp4" poster="../assets/fusion/flight.jpg" muted loop playsinline preload="metadata" aria-label="Source footage projected onto the plant"></video><span>SOURCE FOOTAGE / POSE LINKED</span></div><div class="atlas-playback"><button class="atlas-play" aria-label="Play drone flight">Play</button><input class="atlas-seek" type="range" min="0" max="10.9" step="0.1" value="0" aria-label="Drone flight time in seconds"><output class="atlas-time">00:00</output></div><div class="atlas-flight-actions"><button class="atlas-flight-view" aria-pressed="true">Flight overview</button><button class="atlas-drone-eye" aria-pressed="false">Drone eye ↗</button></div><p class="atlas-projection-note">Footage mapped onto the 3D surfaces.<br>Registration follows the source calibration.</p></div>
  <div class="atlas-panel-foot"><button class="atlas-rotation" aria-pressed="true">Ⅱ Pause rotation</button><button class="atlas-reset">Reset view ↺</button></div></aside>
  <div class="atlas-hero-foot"><span>REAL DATA. SHARED COORDINATES.</span><a href="#fusion-story">Explore the layers <span>↓</span></a><span class="atlas-gesture">DRAG TO ORBIT / SCROLL TO ZOOM</span></div>
</section>`;
  return base
    .replace('data-direction="atlas"', 'data-direction="atlas-dark"')
    .replace(
      '<title>Stratlas / Spatial Atlas</title>',
      '<title>Stratlas / Atlas</title>',
    )
    .replace(
      '<link rel="stylesheet" href="fusion.css">',
      '<link rel="stylesheet" href="fusion.css"><link rel="stylesheet" href="atlas-dark.css">',
    )
    .replace(/<section class="hero"[\s\S]*?<\/section>/, hero)
    .replace(
      /<section class="perspective-note"[\s\S]*?<\/section>/,
      '<section class="perspective-note atlas-perspective-note"><span class="mode-index">ONE ASSET / CONNECTED LAYERS</span><h2>Every source adds a dimension.</h2><p>Explore the model, reveal measured elevations, then watch a recorded flight paint its perspective onto the asset.</p></section>',
    )
    .replace(/<aside class="direction-switch"[\s\S]*?<\/aside>/, '')
    .replace(/<button class="stack-layer stack-map"[\s\S]*?<\/button>/, (m) =>
      m
        .replace('<button', '<div')
        .replace('</button>', '</div>')
        .replace(' data-jump-mode="map"', ''),
    )
    .replaceAll(
      'class="brand" href="index.html"',
      'class="brand" href="atlas.html"',
    )
    .replace(
      'src="../assets/fusion/fusion.bundle.js"',
      'src="../assets/fusion/atlas.bundle.js"',
    )
    .replace(
      "Move between layers while retaining the drone's position and direction.",
      'Combine layers in one view. The video follows its recorded camera pose and falls onto the surfaces it sees.',
    )
    .replace('Try the transformation', 'Watch the projected flight')
    .replace('Back to the flight ↑', 'Back to the plant ↑');
}

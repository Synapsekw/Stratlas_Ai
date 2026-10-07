// Quadrion AI launch screen prototype ("gate"), v2: animated Time steps mark that
// reacts to the pointer (spring parallax, plates separating in depth), a point-cloud
// terrain the cursor scans, the Split entry layout, a live date line, and Enter to open
// the app. No real auth. Writes ../gate/index.html. Run: node gate.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, '..', 'kit');
const out = join(here, '..', 'gate');
mkdirSync(out, { recursive: true });

const wmFile = readFileSync(join(kit, 'wordmark/quadrion-wordmark-on-dark.svg'), 'utf8');
const wmViewBox = wmFile.match(/viewBox="([^"]+)"/)[1];
const wmInner = wmFile.replace(/^[\s\S]*?<\/title>/, '').replace(/<\/svg>\s*$/, '');

// Time steps plates on the 64 grid, bottom first (same geometry as kit.mjs)
const CENTRES = [[26, 50], [30, 40], [34, 30], [38, 20]];
const plate = ([cx, cy]) => `M${cx} ${cy - 8} L${cx + 21} ${cy} L${cx} ${cy + 8} L${cx - 21} ${cy}Z`;
// Each lower plate is cut by copies of the plates above it. The copies carry
// data-plate so the script moves them with their plate and the cuts stay true.
const masks = CENTRES.slice(0, 3)
  .map((_, i) =>
    `<mask id="cut${i}" maskUnits="userSpaceOnUse" x="-24" y="-24" width="112" height="112"><rect x="-24" y="-24" width="112" height="112" fill="#fff"/>` +
    CENTRES.slice(i + 1).map((a, j) => `<path data-plate="${i + 1 + j}" d="${plate(a)}" fill="#000" stroke="#000" stroke-width="5"/>`).join('') +
    `</mask>`)
  .join('');
const plates = CENTRES.map((c, i) =>
  `<g${i < 3 ? ` mask="url(#cut${i})"` : ''}><path class="plate p${i + 1}" data-plate="${i}" d="${plate(c)}"/></g>`).join('\n      ');
const tbMasks = masks.replace(/id="cut/g, 'id="tbcut').replace(/ data-plate="\d"/g, '');
const tbPlates = CENTRES.map((c, i) => `<g${i < 3 ? ` mask="url(#tbcut${i})"` : ''}><path d="${plate(c)}" fill="${i === 3 ? '#5ED1B3' : '#EEF2F5'}"/></g>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quadrion Launch Screen</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: one full-window launch screen in the app's dark Mission look (single theme
   by choice: it is the app's splash). Split layout: the horizontal lockup on the left, the welcome on the right,
   a point-cloud terrain behind that the pointer scans. */
:root{
  color-scheme:dark;
  --ground:#11161C; --deep:#0B0F13; --panel:#1E2630; --line:#2A3340;
  --ink:#EEF2F5; --ink-2:#C5CDD6; --ink-3:#8E99A6; --mint:#5ED1B3;
  --f-ui:'IBM Plex Sans','Segoe UI',system-ui,sans-serif; --f-mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;
  --ease-out:cubic-bezier(.23,1,.32,1); --ease-io:cubic-bezier(.77,0,.175,1);
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--deep);color:var(--ink-2);font:15px/1.5 var(--f-ui);-webkit-font-smoothing:antialiased;overflow:hidden}
#bg{position:fixed;inset:0;width:100%;height:100%;display:block}
.vignette{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 58% 52% at 50% 40%,rgba(17,22,28,.94) 0%,rgba(17,22,28,.6) 46%,rgba(11,15,19,0) 76%)}
.gate{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 16px calc(24px + env(safe-area-inset-bottom,0px));transition:opacity .28s var(--ease-out),filter .28s var(--ease-out),transform .28s var(--ease-out)}

/* mark: plates drop in, the top one lights; afterwards the script moves them with the pointer */
.mark{width:clamp(100px,17vh,156px);height:auto;overflow:visible}
.plate{fill:var(--ink);opacity:0;transform-box:fill-box;animation:drop .52s var(--ease-out) forwards}
.p1{animation-delay:.05s}.p2{animation-delay:.11s}.p3{animation-delay:.17s}
.p4{animation:drop .52s var(--ease-out) .23s forwards, light .45s ease .55s forwards}
@keyframes drop{from{opacity:0;transform:translateY(-22px)}to{opacity:1;transform:none}}
@keyframes light{to{fill:var(--mint)}}
.glow{filter:drop-shadow(0 0 7px rgba(94,209,179,.45))}

/* wordmark: revealed behind a scan line */
.brand{display:flex;flex-direction:column;align-items:center;gap:20px}
.wm{position:relative;width:min(540px,78vw)}
.wm svg{display:block;width:100%;height:auto;clip-path:inset(0 100% 0 0);animation:reveal .6s var(--ease-out) .5s forwards}
.wm::after{content:"";position:absolute;top:-8%;bottom:-8%;left:0;width:2px;background:var(--mint);box-shadow:0 0 14px 2px rgba(94,209,179,.55);opacity:0;animation:scan .6s var(--ease-out) .5s forwards}
@keyframes reveal{to{clip-path:inset(0 0 0 0)}}
@keyframes scan{0%{left:0;opacity:1}80%{opacity:1}100%{left:100%;opacity:0}}
.tag{margin:-4px 0 4px;font:500 12.5px var(--f-mono);letter-spacing:.24em;text-transform:uppercase;color:var(--ink-3);opacity:0;animation:rise .45s var(--ease-out) .85s forwards}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* entry: who is entering and the Enter button. Four layouts (data-layout on body). */
.entry{opacity:0;filter:blur(6px);transform:translateY(8px);animation:focus .5s var(--ease-out) .95s forwards}
@keyframes focus{to{opacity:1;filter:none;transform:none}}
.who{display:flex;align-items:center;gap:12px}
.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--mint);font:600 14px var(--f-ui);background:rgba(94,209,179,.1);box-shadow:inset 0 0 0 1px rgba(94,209,179,.38)}
.hello{color:var(--ink-3)}
.who b{color:var(--ink);font-weight:600}
.who small{display:block;color:var(--ink-3);font-size:12px;margin-top:1px}
#enter{position:relative;overflow:hidden;appearance:none;border:0;border-radius:8px;background:var(--mint);color:#08201A;font:600 14.5px var(--f-ui);height:42px;padding:0 18px;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;transition:transform .16s var(--ease-out),box-shadow .2s ease,background-color .2s ease,color .2s ease}
#enter:active{transform:scale(.97)}
#enter:focus-visible{outline:2px solid rgba(238,242,245,.6);outline-offset:3px}
#enter::after{content:"";position:absolute;top:0;bottom:0;left:-40%;width:30%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-18deg);opacity:0}
@media (hover:hover) and (pointer:fine){
  #enter:hover{box-shadow:0 0 0 4px rgba(94,209,179,.14),0 10px 28px -10px rgba(94,209,179,.6)}
  #enter:hover::after{opacity:1;left:120%;transition:left .7s var(--ease-out),opacity .1s}
}
kbd{font:500 10.5px var(--f-mono);border:1px solid rgba(8,32,26,.28);border-radius:4px;padding:1px 5px;background:rgba(255,255,255,.22)}
.status{display:flex;align-items:center;gap:8px;font:500 11px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);opacity:0;animation:rise .45s var(--ease-out) 1.1s forwards;white-space:nowrap}
.status .sep{opacity:.5}
.in-split{display:none}
[data-layout="b"] .in-split{display:flex}
[data-layout="b"] .out-split{display:none}
.dot{width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 3px rgba(94,209,179,.14);flex:none}

/* A · Inline: no container; a greeting line and a slim button under the tagline */
[data-layout="a"] .entry{display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:6px}
[data-layout="a"] .avatar,[data-layout="a"] .who small{display:none}
[data-layout="a"] .who{font-size:15px}
[data-layout="a"] #enter{min-width:220px;border-radius:999px}
[data-layout="a"] .out-split{position:fixed;left:0;right:0;justify-content:center;bottom:calc(40px + env(safe-area-inset-bottom,0px));z-index:1}

/* B · Split: brand on the left, entry on the right, a hairline between */
[data-layout="b"] .gate{flex-direction:row;gap:0}
[data-layout="b"] .brand{display:grid;grid-template-columns:auto auto;grid-template-areas:"mark wm" ". tag";column-gap:20px;row-gap:12px;align-items:center;padding-right:56px}
[data-layout="b"] .mark{grid-area:mark;width:clamp(62px,7vw,84px)}
[data-layout="b"] .wm{grid-area:wm;width:min(420px,34vw)}
[data-layout="b"] .tag{grid-area:tag;margin:0;letter-spacing:.2em}
[data-layout="b"] .entry{border-left:1px solid var(--line);padding-left:56px;display:flex;flex-direction:column;gap:18px;min-width:260px}
[data-layout="b"] .who{flex-direction:column;align-items:flex-start;gap:4px}
[data-layout="b"] .avatar{display:none}
[data-layout="b"] .hello{font:500 11px var(--f-mono);letter-spacing:.16em;text-transform:uppercase}
[data-layout="b"] .who b{display:block;font-size:28px;font-weight:600;letter-spacing:-.01em;line-height:1.15}
[data-layout="b"] #enter{width:100%}
@media (max-width:900px){
  [data-layout="b"] .gate{flex-direction:column;gap:20px}
  [data-layout="b"] .brand{padding-right:0;justify-content:center}
  [data-layout="b"] .wm{width:min(420px,62vw)}
  [data-layout="b"] .entry{border-left:0;padding-left:0;align-items:center;text-align:center;min-width:0}
  [data-layout="b"] .in-split{justify-content:center}
  [data-layout="b"] .who{align-items:center}
}

/* C · Corner: the brand alone in the centre; identity and Enter bottom-left, status bottom-right */
[data-layout="c"] .mark{width:clamp(110px,19vh,172px)}
[data-layout="c"] .wm{width:min(600px,80vw)}
[data-layout="c"] .entry{position:fixed;left:28px;bottom:calc(28px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:18px;z-index:2}
[data-layout="c"] .hello{display:none}
[data-layout="c"] #enter{height:38px;background:transparent;color:var(--mint);box-shadow:inset 0 0 0 1px rgba(94,209,179,.55)}
[data-layout="c"] #enter kbd{color:var(--mint);border-color:rgba(94,209,179,.4);background:rgba(94,209,179,.08)}
@media (hover:hover) and (pointer:fine){
  [data-layout="c"] #enter:hover{background:var(--mint);color:#08201A}
  [data-layout="c"] #enter:hover kbd{color:#08201A;border-color:rgba(8,32,26,.28);background:rgba(255,255,255,.22)}
}
[data-layout="c"] .out-split{position:fixed;right:28px;bottom:calc(40px + env(safe-area-inset-bottom,0px));z-index:1}
[data-layout="c"] footer.f,[data-layout="d"] footer.f{display:none}
@media (max-width:760px){[data-layout="c"] .out-split{display:none}}

/* D · Dock: one slim glass bar along the bottom */
[data-layout="d"] .entry{position:fixed;left:24px;right:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 12px 0 16px;border-radius:14px;background:rgba(20,26,34,.72);backdrop-filter:blur(14px);box-shadow:inset 0 0 0 1px var(--line),0 20px 40px -20px rgba(0,0,0,.6);z-index:2}
[data-layout="d"] .hello{display:none}
[data-layout="d"] .out-split{position:fixed;left:0;right:0;justify-content:center;bottom:calc(50px + env(safe-area-inset-bottom,0px));z-index:3;pointer-events:none}
@media (max-width:760px){[data-layout="d"] .out-split{display:none}}

.leaving .status{opacity:0 !important;transition:opacity .18s ease}
.clock{position:fixed;top:calc(16px + env(safe-area-inset-top,0px));left:18px;z-index:1;font:500 11.5px var(--f-mono);letter-spacing:.08em;color:var(--ink-3);opacity:0;animation:rise .45s var(--ease-out) 1.1s forwards;font-variant-numeric:tabular-nums}
.clock b{color:var(--ink-2);font-weight:500}
footer.f{position:fixed;left:0;right:0;bottom:calc(14px + env(safe-area-inset-bottom,0px));text-align:center;font:11px var(--f-mono);letter-spacing:.08em;color:var(--ink-3);opacity:0;animation:rise .45s var(--ease-out) 1.1s forwards;z-index:1}
.skip{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:16px;z-index:2;font:500 12px var(--f-ui);color:var(--ink-3);background:transparent;border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;transition:color .15s ease,border-color .15s ease,opacity .2s ease}
.skip:hover{color:var(--ink-2);border-color:#3A4553}
.skip:focus-visible{outline:2px solid var(--mint);outline-offset:2px}
.done .skip{opacity:0;pointer-events:none}

/* leaving: quick. The gate blurs back, the app comes forward. */
.leaving .gate{opacity:0;filter:blur(8px);transform:scale(1.03)}
.leaving .clock,.leaving footer.f,.leaving .skip{opacity:0 !important;transition:opacity .18s ease}
.leaving #bg{opacity:0;transition:opacity .35s var(--ease-out)}
.app{position:fixed;inset:0;z-index:4;background:var(--ground);display:flex;flex-direction:column;opacity:0;transform:scale(.985);transition:opacity .3s var(--ease-out),transform .3s var(--ease-out)}
.app.on{opacity:1;transform:none}
.app[hidden]{display:none}
.tb{height:34px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#0D1116;border-bottom:1px solid var(--panel);font-size:12.5px;color:var(--ink-2)}
.tb svg{width:16px;height:16px}
.app-body{flex:1;display:grid;place-items:center;text-align:center;padding:24px}
.app-body h1{color:var(--ink);font-size:20px;margin:0 0 6px}
.app-body p{margin:0 0 16px;color:var(--ink-3)}
#replay{font:500 13px var(--f-ui);color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 14px;cursor:pointer;transition:transform .16s var(--ease-out)}
#replay:active{transform:scale(.97)}
#replay:focus-visible{outline:2px solid var(--mint);outline-offset:2px}

/* skip: jump every intro animation to its end state */
.instant .plate{animation:none !important;opacity:1}
.instant .wm svg,.instant .wm::after,.instant .tag,.instant .entry,.instant .status,.instant footer.f,.instant .clock{animation:none !important;opacity:1;filter:none;transform:none;clip-path:none}
.instant .wm::after{opacity:0}
.instant .p4{fill:var(--mint)}
@media (prefers-reduced-motion: reduce){
  .plate,.wm svg,.wm::after,.tag,footer.f,.clock,.status{animation:none !important;opacity:1;filter:none;transform:none}
  .wm svg{clip-path:none}.wm::after{opacity:0}.p4{fill:var(--mint)}
  .entry{animation:fade .3s ease forwards !important;filter:none;transform:none}
  @keyframes fade{to{opacity:1}}
  .leaving .gate{filter:none;transform:none}
  .app{transform:none}
}
@media (max-height:560px){.gate{gap:12px}.mark{width:84px}[data-layout="b"] .mark{width:56px}}
@media (max-width:520px){[data-layout="b"] .brand{column-gap:12px}[data-layout="b"] .mark{width:48px}[data-layout="b"] .tag{font-size:10.5px;letter-spacing:.14em}}
</style>
</head>
<body data-layout="b">
<canvas id="bg" aria-hidden="true"></canvas>
<div class="vignette" aria-hidden="true"></div>
<div class="clock" id="clock" aria-hidden="true"></div>
<button class="skip" id="skip" type="button">Skip intro</button>
<main class="gate" id="gate">
  <div class="brand">
  <svg class="mark" id="mark" viewBox="0 0 64 64" role="img" aria-label="Quadrion AI">
    <defs>${masks}</defs>
    ${plates}
  </svg>
  <div class="wm" aria-hidden="true"><svg viewBox="${wmViewBox}">${wmInner}</svg></div>
  <p class="tag">Four dimensions. One view.</p>
  </div>
  <section class="entry" id="entry" aria-label="Open Quadrion AI">
    <div class="who"><span class="avatar" aria-hidden="true">D</span><div><span class="hello">Welcome back, </span><b>Danijel</b><small>Synapse Solutions · this computer</small></div></div>
    <button id="enter" type="button">Enter <kbd>↵</kbd></button>
    <div class="status in-split"><span class="dot" aria-hidden="true"></span>Offline<span class="sep">·</span>stays on this machine</div>
  </section>
</main>
<div class="status out-split"><span class="dot" aria-hidden="true"></span>Offline<span class="sep">·</span>projects stay on this machine<span class="sep">·</span>team sign-in later</div>
<footer class="f">QUADRION AI 0.9.0 · SYNAPSE SOLUTIONS</footer>
<div class="app" id="app" hidden>
  <div class="tb"><svg viewBox="0 0 64 64" aria-hidden="true"><defs>${tbMasks}</defs>${tbPlates}</svg><span>Quadrion AI</span></div>
  <div class="app-body"><div><h1>The app opens here</h1><p>In the real app, Enter goes straight to your projects.</p><button id="replay" type="button">Replay the launch screen</button></div></div>
</div>
<script>
(function(){
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var root = document.documentElement, body = document.body;
  var app = document.getElementById('app'), enter = document.getElementById('enter');
  var leaving = false, introDone = false;

  // ---- live date line: the product is about time ----
  var clock = document.getElementById('clock');
  function tick(){
    var d = new Date();
    var day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    var t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    clock.innerHTML = day.toUpperCase() + ' · <b>' + t + '</b>';
  }
  tick(); setInterval(tick, 1000);

  body.setAttribute('data-layout', 'b');   // Split, chosen 7 Oct 2026

  // ---- intro ----
  var p4 = document.querySelector('.p4');
  setTimeout(finishIntro, reduce ? 0 : 1300);
  function finishIntro(){
    if (introDone) return; introDone = true;
    body.classList.add('done');
    // hand the plates from CSS keyframes to the pointer springs
    document.querySelectorAll('.plate').forEach(function(p){ p.style.animation = 'none'; p.style.opacity = '1'; });
    p4.style.fill = 'var(--mint)';
    if (!reduce) p4.classList.add('glow');
  }
  function skip(){ root.classList.add('instant'); finishIntro(); }
  document.getElementById('skip').addEventListener('click', function(e){ skip(); e.currentTarget.blur(); });

  // ---- open the app: fast, because people see this every launch ----
  function open(){
    if (leaving) return; leaving = true;
    body.classList.add('leaving');
    app.hidden = false;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ app.classList.add('on'); }); });
    setTimeout(function(){ document.getElementById('replay').focus(); }, 320);
  }
  enter.addEventListener('click', open);
  addEventListener('keydown', function(e){
    if (e.key === 'Enter' && app.hidden && document.activeElement && document.activeElement.id !== 'skip') { e.preventDefault(); open(); }
    if (e.key === 'Escape' && app.hidden) skip();
  });
  document.getElementById('replay').addEventListener('click', function(){ location.reload(); });

  // ---- pointer, smoothed by springs so motion has weight ----
  // target: pointer position in -1..1 from the centre; it drifts back to centre when idle
  var tx = 0, ty = 0, lastMove = 0, px = -9999, py = -9999;
  function spring(k, d){ return { x: 0, v: 0, step: function(target, dt){ var a = (target - this.x) * k - this.v * d; this.v += a * dt; this.x += this.v * dt; } }; }
  var sx = spring(90, 14), sy = spring(90, 14);           // mark and terrain parallax
  var lx = spring(160, 22), ly = spring(160, 22);         // scan light, a little quicker
  lx.x = -9999; ly.x = -9999;
  if (finePointer && !reduce){
    addEventListener('pointermove', function(e){
      tx = (e.clientX / innerWidth) * 2 - 1; ty = (e.clientY / innerHeight) * 2 - 1;
      if (px < -9000){ lx.x = e.clientX; ly.x = e.clientY; }   // first move: start the light under the cursor
      px = e.clientX; py = e.clientY; lastMove = performance.now();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', function(){ tx = 0; ty = 0; px = py = -9999; lx.x = ly.x = -9999; });
  }

  // plates separate in depth toward the pointer: the top plate travels furthest,
  // and the stack opens a little as the pointer moves away from the centre
  var plateEls = [0,1,2,3].map(function(i){ return document.querySelectorAll('[data-plate="' + i + '"]'); });
  var DEPTH = [1, 2.2, 3.5, 5];   // grid units at full deflection
  var SPREAD = [1.2, 0.4, -0.4, -1.2];
  function placePlates(){
    var mx = sx.x, my = sy.x, opened = Math.min(1, Math.hypot(mx, my));
    for (var i = 0; i < 4; i++){
      var dx = mx * DEPTH[i], dy = my * DEPTH[i] * 0.6 + SPREAD[i] * opened * 2;
      var tf = 'translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) + ')';
      plateEls[i].forEach(function(el){ el.setAttribute('transform', tf); });
    }
  }

  // ---- terrain: a drifting point cloud the pointer scans ----
  var cv = document.getElementById('bg'), ctx = cv.getContext('2d');
  var W = 0, H = 0, DPR = 1, t0 = performance.now(), lastDraw = 0, lastT = t0, running = true;
  function size(){ DPR = Math.min(devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR,0,0,DPR,0,0); }
  addEventListener('resize', function(){ size(); if (reduce) draw(0); });
  size();
  var COLS = 96, ROWS = 48;
  function height(x, z, t){ return Math.sin(x * 0.11 + t * 0.00012) * 1.6 + Math.cos(z * 0.17 - t * 0.00009) * 1.2 + Math.sin((x + z) * 0.05) * 2.2; }
  function draw(t){
    ctx.clearRect(0, 0, W, H);
    var horizon = H * 0.47 - sy.x * 18, fov = Math.min(W, H) * 0.9, camH = 9;
    var scanZ = ((t * 0.006) % (ROWS + 20)) - 10;
    var lpx = lx.x, lpy = ly.x, R = Math.max(110, Math.min(W, H) * 0.16);
    for (var r = 0; r < ROWS; r++){
      var z = ROWS - r + 4 + ((t * 0.0012) % 1);
      var near = 1 - z / (ROWS + 6);
      for (var c = 0; c < COLS; c++){
        var x = (c - COLS / 2) * 1.12;
        var y = height(c, r + t * 0.0012, t);
        var X = W / 2 + (x / z) * fov * 0.55 - sx.x * 70 * near;
        var Y = horizon + ((camH - y) / z) * fov * 0.32;
        if (X < -4 || X > W + 4 || Y < 0 || Y > H + 4) continue;
        var d = Math.abs((ROWS - r) - scanZ);
        var lit = d < 1.6 ? 1 - d / 1.6 : 0;
        var dl = Math.hypot(X - lpx, Y - lpy), torch = dl < R ? 1 - dl / R : 0;
        torch = torch * torch;
        var glow = Math.max(lit, torch);
        var a = 0.05 + near * 0.3;
        ctx.fillStyle = glow > 0.02 ? 'rgba(94,209,179,' + (0.18 + glow * 0.7).toFixed(3) + ')' : 'rgba(238,242,245,' + a.toFixed(3) + ')';
        var s = (0.6 + near * 1.6) * (1 + glow * 0.6);
        ctx.fillRect(X - s / 2, Y - s / 2, s, s);
      }
    }
  }

  // one loop drives the springs (every frame) and the terrain (about 30 fps)
  function frame(now){
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    var idle = now - lastMove > 4000;
    sx.step(idle ? 0 : tx, dt); sy.step(idle ? 0 : ty, dt);
    if (px > -9000){ lx.step(px, dt); ly.step(py, dt); }
    if (introDone) placePlates();
    if (now - lastDraw > 33){ draw(now - t0); lastDraw = now; }
    requestAnimationFrame(frame);
  }
  if (reduce) draw(0); else requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', function(){
    running = !document.hidden && !reduce;
    if (running){ lastT = performance.now(); requestAnimationFrame(frame); }
  });
})();
</script>
</body>
</html>
`;
writeFileSync(join(out, 'index.html'), html);
console.log('wrote gate/index.html', html.length);

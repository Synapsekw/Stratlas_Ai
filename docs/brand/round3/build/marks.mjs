// Round 3 brand marks: geometry for the three finalists, the wordmark glyph set,
// and SVG builders. Everything is hand-placed on a 64-unit grid (symbols) or a
// 10-unit cap-height grid (wordmarks). No fonts are needed for the wordmarks.

// ---------- colour ----------
function oklchToHex(L, C, h) {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (x) => {
    x = Math.max(0, Math.min(1, x));
    x = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(x * 255).toString(16).padStart(2, '0');
  };
  return '#' + enc(r) + enc(g) + enc(bb);
}

export const C = {
  ground: '#0b0f14',                         // brief: dark ground
  bg0: oklchToHex(0.145, 0.008, 250),
  bg1: oklchToHex(0.175, 0.009, 250),
  bg2: oklchToHex(0.205, 0.010, 250),
  bg3: oklchToHex(0.240, 0.011, 250),
  chrome: oklchToHex(0.160, 0.009, 250),
  line: oklchToHex(0.275, 0.011, 250),
  lineStrong: oklchToHex(0.360, 0.012, 250),
  fg0: oklchToHex(0.945, 0.006, 250),
  fg1: oklchToHex(0.800, 0.010, 250),
  fg2: oklchToHex(0.640, 0.012, 250),
  fg3: oklchToHex(0.500, 0.012, 250),
  acc: oklchToHex(0.790, 0.115, 172),
  accStrong: oklchToHex(0.860, 0.120, 172),
  accInk: oklchToHex(0.200, 0.030, 172),
  // light ground
  paper: '#f4f6f8',
  ink: '#15181d',
  accLight: '#16866a',
  s5: oklchToHex(0.660, 0.190, 25),
  s4: oklchToHex(0.740, 0.155, 55),
  s3: oklchToHex(0.840, 0.140, 92),
};

// palettes a mark is drawn in
export const PAL = {
  dark: { ink: C.fg0, acc: C.acc, ground: C.ground },
  light: { ink: C.ink, acc: C.accLight, ground: C.paper },
  monoBlack: { ink: '#000000', acc: '#000000', ground: '#ffffff' },
  monoWhite: { ink: '#ffffff', acc: '#ffffff', ground: '#000000' },
};

const f = (n) => +n.toFixed(2);
const pts = (a) => a.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');

// ---------- symbols (64 x 64) ----------
// Each returns inner SVG markup. `small` = the hinted favicon cut (heavier, fewer parts).

let uid = 0;
const id = (p) => `${p}${++uid}`;

const SYMBOLS = {
  // ALMAGEST alternate: "Bearing". Two sight lines rise from two ground stations and stop
  // short; the accent point sits where they would meet: the fix, the star, the asset.
  // Reads as an A.
  'almagest-bearing': ({ ink, acc }, small) => {
    const sw = small ? 8.5 : 6.5, base = small ? 55 : 54;
    const L = [12, base + 6], R = [52, base + 6], T = [32, 8];
    const stopAt = (from, frac) => [from[0] + (T[0] - from[0]) * frac, from[1] + (T[1] - from[1]) * frac];
    const fr = small ? 0.66 : 0.68;
    const a = stopAt(L, fr), b = stopAt(R, fr);
    const cid = id('o');
    const d = small ? 8.5 : 7.5, cy = small ? 15.5 : 15;
    return `<defs><clipPath id="${cid}"><rect x="0" y="0" width="64" height="${base}"/></clipPath></defs>`
      + `<g clip-path="url(#${cid})" stroke="${ink}" stroke-width="${sw}"><line x1="${L[0]}" y1="${L[1]}" x2="${f(a[0])}" y2="${f(a[1])}"/><line x1="${R[0]}" y1="${R[1]}" x2="${f(b[0])}" y2="${f(b[1])}"/></g>`
      + `<polygon points="${pts([[32, cy - d], [32 + d, cy], [32, cy + d], [32 - d, cy]])}" fill="${acc}"/>`;
  },
  // ALMAGEST primary: "Quadrant". The graduated quadrant Ptolemy used to measure the
  // height of the sun and stars: a sector, a sight line and the sighted point. It also
  // reads as a sensor sweep with one contact, which is the operating-picture idea.
  'almagest-quadrant': ({ ink, acc }, small) => {
    const P = [13, 51.5], R = small ? 39 : 38, sw = small ? 7 : 5;
    const end0 = [P[0] + R, P[1]], end90 = [P[0], P[1] - R];
    const a45 = Math.PI / 4, D = [P[0] + R * Math.cos(a45), P[1] - R * Math.sin(a45)];
    const d = small ? 8.5 : 7;
    const mid = id('q');
    const ticks = small ? "" : [15, 75].map((deg) => {
      const a = (deg * Math.PI) / 180;
      const o = [P[0] + (R - 1) * Math.cos(a), P[1] - (R - 1) * Math.sin(a)], i = [P[0] + (R - 8) * Math.cos(a), P[1] - (R - 8) * Math.sin(a)];
      return `<line x1="${f(o[0])}" y1="${f(o[1])}" x2="${f(i[0])}" y2="${f(i[1])}" stroke-width="3"/>`;
    }).join('');
    const sightEnd = [P[0] + (R - d - 4) * Math.cos(a45), P[1] - (R - d - 4) * Math.sin(a45)];
    return `<defs><mask id="${mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>`
      + `<polygon points="${pts([[D[0], D[1] - d - 3.5], [D[0] + d + 3.5, D[1]], [D[0], D[1] + d + 3.5], [D[0] - d - 3.5, D[1]]])}" fill="#000"/></mask></defs>`
      + `<g mask="url(#${mid})" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="miter" stroke-linecap="butt">`
      + `<path d="M${f(end90[0])} ${f(end90[1] - sw / 2)} L${P[0]} ${P[1]} L${f(end0[0] + sw / 2)} ${P[1]}"/>`
      + `<path d="M${f(end0[0])} ${P[1]} A${R} ${R} 0 0 0 ${f(end90[0])} ${f(end90[1])}"/>${ticks}`
      + `<line x1="${P[0]}" y1="${P[1]}" x2="${f(sightEnd[0])}" y2="${f(sightEnd[1])}" stroke-width="${small ? 4.5 : 3}"/></g>`
      + `<polygon points="${pts([[D[0], D[1] - d], [D[0] + d, D[1]], [D[0], D[1] + d], [D[0] - d, D[1]]])}" fill="${acc}"/>`;
  },
  // AKKAD alternate: "Triangulate". Three cuneiform wedges, the first strokes of written
  // record, close on one accent point from three bearings.
  'akkad-triangulate': ({ ink, acc }, small) => {
    const cx = 32, cy = small ? 36 : 36.5;
    // A cuneiform wedge: a broad triangular head, then a tail that tapers away.
    const tip = small ? 8 : 7.5, head = small ? 13 : 11, half = small ? 9 : 8;
    const neck = small ? 2.6 : 1.9, tail = small ? 27 : 29;
    let out = '';
    for (const ang of [-90, 30, 150]) {
      const a = (ang * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const P = (r, o = 0) => [cx + ux * r + px * o, cy + uy * r + py * o];
      out += `<polygon points="${pts([P(tip), P(tip + head, half), P(tip + head, neck), P(tail, 0.6), P(tail, -0.6), P(tip + head, -neck), P(tip + head, -half)])}" fill="${ink}"/>`;
    }
    const d = small ? 4.6 : 4;
    return out + `<polygon points="${pts([[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]])}" fill="${acc}"/>`;
  },
  // AKKAD primary: "Stylus K". A stem and two wedge impressions make a K; the lower
  // wedge is the accent, the mark a reed stylus leaves in clay.
  'akkad-stylus': ({ ink, acc }, small) => {
    const s = small ? 1.12 : 1;
    const stem = small ? `<rect x="11" y="10" width="10" height="44" fill="${ink}"/>` : `<rect x="12" y="10" width="8" height="44" fill="${ink}"/>`;
    const up = [[small ? 25 : 24.5, 31], [54, 10], [54, small ? 23 : 21.5]];
    const lo = [[small ? 25 : 24.5, 35], [54, small ? 41 : 42.5], [54, 54]];
    void s;
    return stem + `<polygon points="${pts(up)}" fill="${ink}"/>` + `<polygon points="${pts(lo)}" fill="${acc}"/>`;
  },
  // ZIGGURAT primary: "Tiers". Four stepped terraces with the stair cut through them;
  // the shrine on top, where the sky was watched, is the accent.
  'ziggurat-tiers': ({ ink, acc }, small) => {
    if (small) {
      return `<rect x="6" y="44" width="52" height="11" fill="${ink}"/>`
        + `<rect x="15" y="30" width="34" height="11" fill="${ink}"/>`
        + `<rect x="24" y="16" width="16" height="11" fill="${acc}"/>`;
    }
    const tiers = [[8, 45, 48, 9], [15, 34, 34, 8], [22, 24, 20, 7]];
    let out = '';
    const cid = id('z');
    out += `<defs><mask id="${cid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><rect x="30" y="34" width="4" height="22" fill="#000"/></mask></defs><g mask="url(#${cid})">`;
    for (const [x, y, w, h] of tiers) out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${ink}"/>`;
    out += `</g><rect x="27" y="13" width="10" height="8" fill="${acc}"/>`;
    return out;
  },
  // ZIGGURAT alternate: "Stair Z". A Z whose diagonal is a flight of steps; the top
  // bar is the accent.
  'ziggurat-stair': ({ ink, acc }, small) => {
    const sw = small ? 7 : 5;
    const stair = small
      ? [[50, 14], [50, 26], [32, 26], [32, 38], [14, 38], [14, 50]]
      : [[52, 14], [52, 23], [42, 23], [42, 32], [32, 32], [32, 41], [22, 41], [22, 50], [12, 50]];
    return `<polyline points="${pts(stair)}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="miter" stroke-linecap="square"/>`
      + `<line x1="${small ? 14 : 12}" y1="50" x2="${small ? 50 : 52}" y2="50" stroke="${ink}" stroke-width="${sw}" stroke-linecap="square"/>`
      + `<line x1="${small ? 14 : 12}" y1="14" x2="${small ? 50 : 52}" y2="14" stroke="${acc}" stroke-width="${sw}" stroke-linecap="square"/>`;
  },
};

function dirExt(from, to, ext) {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
  return [to[0] + (dx / len) * ext, to[1] + (dy / len) * ext];
}

export function symbolInner(key, pal, small = false) {
  return SYMBOLS[key](pal, small);
}

export function symbolSVG(key, pal, { small = false, size = 64, title = '', bg = null } = {}) {
  const bgRect = bg ? `<rect width="64" height="64" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">${title ? `<title>${title}</title>` : ''}${bgRect}${symbolInner(key, pal, small)}</svg>`;
}

// App icon: rounded tile with the symbol. 1024 master grid.
export function appIconSVG(key, { small = false, size = 1024, variant = 'dark', title = '' } = {}) {
  const dark = variant === 'dark';
  const tile = dark ? C.bg1 : '#ffffff';
  const edge = dark ? C.lineStrong : '#d5dbe2';
  const pal = dark ? PAL.dark : PAL.light;
  const r = small ? 180 : 228;
  const inset = small ? 96 : 176; // symbol box inset
  const sc = (1024 - inset * 2) / 64;
  const grad = dark
    ? `<linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg2}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>`
    : `<linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f4"/></linearGradient>`;
  void tile;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${title ? `<title>${title}</title>` : ''}<defs>${grad}</defs>`
    + `<rect x="${small ? 0 : 40}" y="${small ? 0 : 40}" width="${small ? 1024 : 944}" height="${small ? 1024 : 944}" rx="${r}" fill="url(#tg)"/>`
    + (small ? '' : `<rect x="40.5" y="40.5" width="943" height="943" rx="${r}" fill="none" stroke="${edge}" stroke-width="${dark ? 4 : 4}"/>`)
    + `<g transform="translate(${inset} ${inset}) scale(${f(sc)})">${symbolInner(key, pal, small)}</g></svg>`;
}

// ---------- wordmark glyphs (cap height 10) ----------
// Monoline, 0/45/90-degree construction with chamfered corners. Centre-line polylines;
// stroked at 1.5 units with square caps and clipped to the cap band.
const CH = 1.6; // chamfer
const G = {
  A: { w: 8, p: [[[0, 11.5], [4, 0], [8, 11.5]], [[1.7, 6.9], [6.3, 6.9]]] },
  L: { w: 5.6, p: [[[0, 0], [0, 10], [5.6, 10]]] },
  M: { w: 9, p: [[[0, 10], [0, 0], [4.5, 6.2], [9, 0], [9, 10]]] },
  G: { w: 7.4, p: [[[7.4, CH + 0.3], [7.4 - CH, 0], [CH, 0], [0, CH], [0, 10 - CH], [CH, 10], [7.4 - CH, 10], [7.4, 10 - CH], [7.4, 5.4], [4.2, 5.4]]] },
  E: { w: 6, p: [[[6, 0], [0, 0], [0, 10], [6, 10]], [[0, 5], [5, 5]]] },
  S: { w: 7, p: [[[7, 0], [CH, 0], [0, CH], [0, 5 - CH + 0.2], [CH - 0.2, 5], [7 - CH + 0.2, 5], [7, 5 + CH - 0.2], [7, 10 - CH], [7 - CH, 10], [0, 10]]] },
  T: { w: 7.4, p: [[[0, 0], [7.4, 0]], [[3.7, 0], [3.7, 10]]] },
  K: { w: 7, p: [[[0, 0], [0, 10]], [[7, 0], [0, 6.3]], [[2.6, 4], [7.4, 10.6]]] },
  D: { w: 7.4, p: [[[0, 0], [7.4 - CH * 1.4, 0], [7.4, CH * 1.4], [7.4, 10 - CH * 1.4], [7.4 - CH * 1.4, 10], [0, 10], [0, 0]]] },
  Z: { w: 7, p: [[[0, 0], [7, 0], [0, 10], [7, 10]]] },
  I: { w: 0, p: [[[0, 0], [0, 10]]] },
  U: { w: 7, p: [[[0, 0], [0, 10 - CH], [CH, 10], [7 - CH, 10], [7, 10 - CH], [7, 0]]] },
  R: { w: 7, p: [[[0, 10], [0, 0], [7 - CH, 0], [7, CH], [7, 5.4 - CH], [7 - CH, 5.4], [0, 5.4]], [[4.4, 5.4], [7.4, 10.6]]] },
};
export const SW = 1.5;
export function wordmarkGeom(word, { track = 3.4 } = {}) {
  let x = SW / 2, paths = [];
  for (const ch of word) {
    const g = G[ch];
    for (const pl of g.p) paths.push('M' + pl.map(([px, py]) => `${f(px + x)} ${py}`).join(' L'));
    x += g.w + track;
  }
  const width = x - track + SW / 2; // outer extent
  return { d: paths.join(' '), width, height: 10 + SW };
}

// wordmark as standalone group at given cap height, origin = top-left of the stroke band
export function wordmarkGroup(word, color, capPx, { track } = {}) {
  const g = wordmarkGeom(word, { track });
  const s = capPx / 10;
  const cid = id('w');
  const svg = `<defs><clipPath id="${cid}"><rect x="-1" y="${-SW / 2}" width="${f(g.width + 2)}" height="${10 + SW}"/></clipPath></defs>`
    + `<g transform="scale(${f(s)}) translate(0 ${SW / 2})"><g clip-path="url(#${cid})"><path d="${g.d}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10"/></g></g>`;
  return { svg, width: g.width * s, height: (10 + SW) * s };
}

export function wordmarkSVG(word, color, capPx = 40, { title = '', track } = {}) {
  const w = wordmarkGroup(word, color, capPx, { track });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(w.width)} ${f(w.height)}" width="${f(w.width)}" height="${f(w.height)}">${title ? `<title>${title}</title>` : ''}${w.svg}</svg>`;
}

// Horizontal lockup: symbol + wordmark (+ optional Arabic line as live text).
export function lockupSVG(key, word, pal, { capPx = 30, arabic = '', bg = null, title = '', small = false, track } = {}) {
  const symSize = capPx * 2.35;
  const gap = capPx * 0.75;
  const w = wordmarkGroup(word, pal.ink, capPx, { track });
  const pad = capPx * 0.6;
  const width = pad + symSize + gap + w.width + pad;
  const height = symSize + pad * 2;
  const wy = pad + (symSize - w.height) / 2 - (arabic ? capPx * 0.42 : 0);
  const ar = arabic
    ? `<text x="${f(pad + symSize + gap)}" y="${f(wy + w.height + capPx * 0.98)}" font-family="'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif" font-size="${f(capPx * 0.62)}" font-weight="500" fill="${pal.ink}" fill-opacity=".7">${arabic}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(width)} ${f(height)}" width="${f(width)}" height="${f(height)}">${title ? `<title>${title}</title>` : ''}`
    + (bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : '')
    + `<g transform="translate(${f(pad)} ${f(pad)}) scale(${f(symSize / 64)})">${symbolInner(key, pal, small)}</g>`
    + `<g transform="translate(${f(pad + symSize + gap)} ${f(wy)})">${w.svg}</g>${ar}</svg>`;
}

export const FINALISTS = [
  { slug: 'almagest', word: 'ALMAGEST', display: 'Almagest', arabic: 'المجسطي', primary: 'almagest-quadrant', alt: 'almagest-bearing', primaryName: 'Quadrant', altName: 'Bearing' },
  { slug: 'akkad', word: 'AKKAD', display: 'Akkad', arabic: 'أكّاد', primary: 'akkad-stylus', alt: 'akkad-triangulate', primaryName: 'Stylus K', altName: 'Triangulate' },
  { slug: 'ziggurat', word: 'ZIGGURAT', display: 'Ziggurat', arabic: 'زقورة', primary: 'ziggurat-tiers', alt: 'ziggurat-stair', primaryName: 'Tiers', altName: 'Stair Z' },
];

// Saros mark concepts. 64-unit grid, two colours: ink (structure) and acc
// (accent). Each also works in one colour (pass the same value twice).

const f = (n) => +n.toFixed(2);
let uid = 0;
const P = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)];

export const MARKS = {
  eclipse: {
    title: 'Eclipse',
    idea: 'The moon slides across the sun and leaves one bright crescent. The plainest picture of the name.',
    draw: ({ ink, acc }) => {
      const id = 'm' + ++uid;
      return (
        `<defs><mask id="${id}"><rect width="64" height="64" fill="#fff"/><circle cx="38" cy="28" r="20" fill="#000"/></mask></defs>` +
        `<circle cx="29" cy="34" r="22" fill="${acc}" mask="url(#${id})"/>` +
        `<circle cx="38" cy="28" r="17.5" fill="none" stroke="${ink}" stroke-width="3.5"/>`
      );
    },
  },
  diamond: {
    title: 'Diamond ring',
    idea: 'The last flash of sunlight at the edge of totality. The ring is the moment two bodies align exactly, and the flare is the one point that matters.',
    draw: ({ ink, acc }) => {
      const [bx, by] = P(32, 33, 20, 48);
      const star = [];
      for (let i = 0; i < 8; i++) {
        const r = i % 2 === 0 ? 13.5 : 2.8;
        const [x, y] = P(bx, by, r, i * 45);
        star.push(`${f(x)} ${f(y)}`);
      }
      return (
        `<circle cx="32" cy="33" r="20" fill="none" stroke="${ink}" stroke-width="6"/>` +
        `<path d="M${star.join(' L')}Z" fill="${acc}"/>` +
        `<circle cx="${f(bx)}" cy="${f(by)}" r="6" fill="${acc}"/>`
      );
    },
  },
  syzygy: {
    title: 'Syzygy',
    idea: 'Sun, moon and earth in one line: the alignment that makes an eclipse. Three realities lined up on one axis.',
    draw: ({ ink, acc }) =>
      `<line x1="4" y1="32" x2="60" y2="32" stroke="${ink}" stroke-width="2" stroke-opacity=".55"/>` +
      `<circle cx="17" cy="32" r="12" fill="none" stroke="${ink}" stroke-width="3.5"/>` +
      `<circle cx="38" cy="32" r="5.5" fill="${acc}"/>` +
      `<circle cx="53" cy="32" r="7.5" fill="${ink}"/>`,
  },
  series: {
    title: 'Saros series',
    idea: 'Partial, total, partial: one eclipse in the sequence that repeats every 18 years. Reads as a timeline of the same place on three dates.',
    draw: ({ ink, acc }) => {
      const a = 'm' + ++uid, b = 'm' + ++uid;
      return (
        `<defs><mask id="${a}"><rect width="64" height="64" fill="#fff"/><circle cx="16" cy="32" r="9.5" fill="#000"/></mask>` +
        `<mask id="${b}"><rect width="64" height="64" fill="#fff"/><circle cx="48" cy="32" r="9.5" fill="#000"/></mask></defs>` +
        `<circle cx="10" cy="32" r="9" fill="${acc}" mask="url(#${a})"/>` +
        `<circle cx="32" cy="32" r="9" fill="${ink}"/><circle cx="32" cy="32" r="12" fill="none" stroke="${acc}" stroke-width="2"/>` +
        `<circle cx="54" cy="32" r="9" fill="${acc}" mask="url(#${b})"/>`
      );
    },
  },
  monogram: {
    title: 'S of two arcs',
    idea: 'An S drawn from the edges of two discs, one above the other: the letter built from eclipse geometry, the upper half lit.',
    draw: ({ ink, acc }) => {
      const [x0, y0] = P(32, 21, 12, 25), [x1, y1] = P(32, 21, 12, 270);
      const [x2, y2] = P(32, 45, 12, 90), [x3, y3] = P(32, 45, 12, 205);
      return (
        `<path d="M${f(x0)} ${f(y0)} A12 12 0 1 0 ${f(x1)} ${f(y1)}" fill="none" stroke="${acc}" stroke-width="6.5" stroke-linecap="round"/>` +
        `<path d="M${f(x2)} ${f(y2)} A12 12 0 1 1 ${f(x3)} ${f(y3)}" fill="none" stroke="${ink}" stroke-width="6.5" stroke-linecap="round"/>`
      );
    },
  },
  umbra: {
    title: 'Umbra',
    idea: 'The moon casts its shadow cone onto the ground. The same shape as a drone camera looking down at an asset.',
    draw: ({ ink, acc }) =>
      `<path d="M23.5 18 L12 51 M40.5 18 L52 51" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>` +
      `<ellipse cx="32" cy="52" rx="20" ry="6" fill="${acc}"/>` +
      `<circle cx="32" cy="15" r="9.5" fill="${ink}"/>`,
  },
  totality: {
    title: 'Path of totality',
    idea: 'The band an eclipse shadow draws across the earth: a globe with one track crossing it. Maps, places and time in one figure.',
    draw: ({ ink, acc }) => {
      const id = 'm' + ++uid;
      return (
        `<defs><clipPath id="${id}"><circle cx="32" cy="32" r="22.5"/></clipPath></defs>` +
        `<g clip-path="url(#${id})"><circle cx="8" cy="76" r="54" fill="none" stroke="${acc}" stroke-width="8"/>` +
        `<path d="M9.5 32 H54.5 M32 9.5 A10 22.5 0 0 0 32 54.5" fill="none" stroke="${ink}" stroke-width="2" stroke-opacity=".6"/></g>` +
        `<circle cx="32" cy="32" r="24" fill="none" stroke="${ink}" stroke-width="3.5"/>`
      );
    },
  },
  eighteen: {
    title: 'Eighteen',
    idea: 'A dial of 18 marks, one for each year of the cycle, with this year lit. Return, repeat, predict.',
    draw: ({ ink, acc }) => {
      let s = '';
      for (let i = 0; i < 18; i++) {
        const a = 90 - i * 20;
        const lit = i === 0;
        const [x0, y0] = P(32, 32, lit ? 15 : 19, a), [x1, y1] = P(32, 32, 27, a);
        s += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="${lit ? acc : ink}" stroke-width="${lit ? 5 : 3.4}" stroke-linecap="round"/>`;
      }
      return s + `<circle cx="32" cy="32" r="8" fill="${ink}"/>`;
    },
  },
  nodes: {
    title: 'Nodes',
    idea: 'The paths of the sun and the moon cross at two points, the nodes, and eclipses only happen there. Two realities meeting where it counts.',
    draw: ({ ink, acc }) => {
      // crossing points of two ellipses (a=27, b=9) rotated by +/-24 degrees lie on the horizontal axis
      const t = (24 * Math.PI) / 180, r = 1 / Math.sqrt(Math.cos(t) ** 2 / 729 + Math.sin(t) ** 2 / 81);
      return (
        `<ellipse cx="32" cy="32" rx="27" ry="9" fill="none" stroke="${ink}" stroke-width="3.4" transform="rotate(-24 32 32)"/>` +
        `<ellipse cx="32" cy="32" rx="27" ry="9" fill="none" stroke="${ink}" stroke-width="3.4" transform="rotate(24 32 32)"/>` +
        `<circle cx="${f(32 - r)}" cy="32" r="5.2" fill="${acc}"/><circle cx="${f(32 + r)}" cy="32" r="5.2" fill="${acc}"/>`
      );
    },
  },
};

export const ORDER = ['diamond', 'eclipse', 'nodes', 'umbra', 'series', 'syzygy', 'monogram', 'totality', 'eighteen'];

export function symbol(slug, c, size = 64) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${MARKS[slug].draw(c)}</svg>`;
}

export function appIcon(slug, { ground, ink, acc }, size = 64) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">` +
    `<rect width="64" height="64" rx="14" fill="${ground}"/>` +
    `<g transform="translate(10.24 10.24) scale(0.68)">${MARKS[slug].draw({ ink, acc })}</g></svg>`
  );
}

// the crescent as an inline glyph, used as the O in eclipse wordmarks
export function eclipseO(ink, acc, h) {
  const id = 'o' + ++uid;
  return (
    `<svg viewBox="0 0 64 64" width="${h}" height="${h}" aria-hidden="true" style="display:inline-block;vertical-align:-0.08em;margin:0 .02em">` +
    `<defs><mask id="${id}"><rect width="64" height="64" fill="#fff"/><circle cx="37" cy="32" r="26" fill="#000"/></mask></defs>` +
    `<circle cx="32" cy="32" r="30" fill="${acc}" mask="url(#${id})"/><circle cx="37" cy="32" r="21.5" fill="none" stroke="${ink}" stroke-width="9"/></svg>`
  );
}

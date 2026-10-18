/*
 * How a detection looks wherever it is drawn (the review's editor and contact sheet, the 360
 * view's overlay): its colour, the text and size of its label chip, and where the chips go so
 * they do not cover each other. Pure, so the review and the viewer agree and it can be tested.
 */

/**
 * Warm colours for classes that name an absence or a violation ("no helmet", "missing guard"):
 * red-orange, amber, crimson. They differ in lightness as well as hue.
 */
export const DET_WARN_PALETTE: readonly string[] = ['#f25820', '#ffb825', '#cc2538'];

/**
 * Cool and neutral colours for every other class: cyan, blue, violet, jade, lime, frost. Light
 * and mid tones, so a box reads on a bright wall and a dark ceiling once it has its dark halo.
 */
export const DET_SAFE_PALETTE: readonly string[] = [
  '#3adaf2',
  '#377ee3',
  '#ad7bee',
  '#2cce99',
  '#c1ee66',
  '#d3e8f7',
];

/** Text colours for a chip: a near black and a near white, tinted like the app's neutrals. */
export const CHIP_TEXT_DARK = '#15181d';
export const CHIP_TEXT_LIGHT = '#f6f7f9';

/** Lower case, separators (underscore, hyphen, spaces) folded to one space, trimmed. */
function classKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/** Whether a class name names an absence or a violation: "no-", "no_", "no ", "missing", "without". */
export function isWarningClass(name: string): boolean {
  const k = classKey(name);
  return k.startsWith('no ') || k.startsWith('missing') || k.startsWith('without');
}

/**
 * Prefix of the hashed key. Chosen so the usual PPE classes (helmet, safety jacket and vest,
 * person, gloves, boots; no helmet, no safety jacket, no gloves) each get their own colour.
 */
const SALT = 'd87:';

/** FNV-1a, 32 bit: a small stable hash, the same on every run and machine. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The colour of a class by its name: stable (the same name, in any case or with underscores,
 * hyphens or spaces, always gets the same colour), warm for warning classes, cool otherwise.
 */
export function classColor(name: string): string {
  const pal = isWarningClass(name) ? DET_WARN_PALETTE : DET_SAFE_PALETTE;
  return pal[hash(SALT + classKey(name)) % pal.length] ?? DET_SAFE_PALETTE[0] ?? '#3adaf2';
}

/**
 * The colour a detection is drawn in: its class's own colour when the project has the class
 * (so it matches the issues and the class list), otherwise one derived from the class name.
 */
export function detectionColor(projectColor: string | undefined, name: string): string {
  return projectColor ?? classColor(name);
}

function srgbLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return null;
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

/** WCAG contrast ratio of two hex colours (1 to 21); 1 when either cannot be read. */
export function contrastRatio(a: string, b: string): number {
  const x = srgbLuminance(a);
  const y = srgbLuminance(b);
  if (x === null || y === null) return 1;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The chip text colour that contrasts best with a chip filled `fill` (dark when unknown). */
export function chipTextColor(fill: string): string {
  return contrastRatio(fill, CHIP_TEXT_LIGHT) > contrastRatio(fill, CHIP_TEXT_DARK)
    ? CHIP_TEXT_LIGHT
    : CHIP_TEXT_DARK;
}

/**
 * A class name made readable: underscores and hyphens become spaces, the first letter is upper
 * case and capitalised words go lower case ("No_Safety_Jacket" is "No safety jacket"); words in
 * capitals ("PPE") stay as they are.
 */
export function readableClass(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = words.map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The text of a detection's chip: its readable class and its confidence ("Helmet 87%"). */
export function chipLabel(name: string, confidence?: number): string {
  const conf = confidence !== undefined ? ` ${String(Math.round(confidence * 100))}%` : '';
  return `${readableClass(name)}${conf}`;
}

/** Chip box: 12 px semibold text, padded. */
export const CHIP_FONT_PX = 12;
export const CHIP_H = 18;
export const CHIP_PAD_X = 6;

/**
 * The width of a chip for `text` in the UI sans at 12 px semibold. Estimated from character
 * classes (no layout is needed, so it is the same in a test and in the app).
 */
export function chipWidth(text: string, fontPx = CHIP_FONT_PX): number {
  let em = 0;
  for (const c of text) {
    if (/[ilj.,'|!:;]/.test(c)) em += 0.27;
    else if (/[ frt()]/.test(c)) em += 0.36;
    else if (/[mwMW%]/.test(c)) em += 0.86;
    else if (/[A-Z]/.test(c)) em += 0.66;
    else em += 0.56;
  }
  return Math.ceil(em * fontPx + CHIP_PAD_X * 2);
}

/**
 * Whether a box (`x0, y0` to `x1, y1` on screen) shows in a view; a chip is drawn only for those,
 * so a box scrolled out of the view does not leave its chip at the edge.
 */
export function boxInView(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  view: { width: number; height: number },
): boolean {
  return x1 > 0 && y1 > 0 && x0 < view.width && y0 < view.height;
}

export interface ChipRequest {
  /** The box's top left corner on screen. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChipPlace {
  x: number;
  y: number;
}

const overlaps = (
  a: ChipPlace & { w: number; h: number },
  b: ChipPlace & { w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where each chip goes, in the order given (put the most important first). A chip sits just
 * above its box's top left corner; it goes inside the box when that would leave the top of the
 * view, and it is kept inside the view sideways. A chip that would cover one already placed
 * moves up above it, or, when that leaves the view, down below it (greedy).
 */
export function stackChips(
  chips: readonly ChipRequest[],
  view: { width: number; height: number },
  gap = 2,
): ChipPlace[] {
  const placed: (ChipPlace & { w: number; h: number })[] = [];
  return chips.map((c) => {
    const x = Math.max(0, Math.min(c.x, view.width - c.w));
    const above = c.y - c.h;
    const start = above >= 0 ? above : Math.max(0, c.y);
    let y = start;
    let down = false;
    for (let guard = 0; guard <= placed.length * 2 + 1; guard++) {
      const hit = placed.find((p) => overlaps({ x, y, w: c.w, h: c.h }, p));
      if (!hit) break;
      if (!down) {
        const up = hit.y - c.h - gap;
        if (up >= 0) {
          y = up;
          continue;
        }
        down = true;
        y = start;
        continue;
      }
      y = hit.y + hit.h + gap;
    }
    const place = { x, y, w: c.w, h: c.h };
    placed.push(place);
    return { x, y };
  });
}

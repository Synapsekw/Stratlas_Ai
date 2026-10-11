/**
 * The Globe's pins, drawn once per look on small canvases (no image is fetched): a site is a chip
 * with a dot (mint when it has no open issues, amber when it has), its name and the number of its
 * open issues; a hovered chip's outline brightens and a selected one takes the dot's colour; sites
 * that crowd share one chip that says how many they are; an issue is a solid dot in its severity
 * colour. CesiumJS draws billboards in device pixels, so every sprite is drawn `ratio` times
 * larger than its CSS size.
 */
import { CHIP, chipMetrics, fitLabel, issueBadge, type ChipMetrics, type ViewSize } from '../chips';
import { withAlpha, type GlobePalette } from '../style';

export type PinTone = 'clear' | 'attention';
export type PinState = 'rest' | 'hover' | 'selected';

/** A canvas of a CSS size, painted in CSS pixels. */
function draw(
  width: number,
  height: number,
  ratio: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  });
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(ratio, ratio);
    paint(ctx);
  }
  return canvas;
}

const cache = new Map<string, HTMLCanvasElement>();

function sprite(
  key: string,
  cssSize: number,
  ratio: number,
  paint: (ctx: CanvasRenderingContext2D, size: number) => void,
): HTMLCanvasElement {
  const id = `${key}@${String(ratio)}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const canvas = draw(cssSize, cssSize, ratio, (ctx) => {
    paint(ctx, cssSize);
  });
  cache.set(id, canvas);
  return canvas;
}

function disc(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  fill: string | CanvasGradient,
): void {
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function halo(ctx: CanvasRenderingContext2D, c: number, r: number, colour: string, peak: number) {
  const g = ctx.createRadialGradient(c, c, 0, c, c, r);
  g.addColorStop(0, withAlpha(colour, peak));
  g.addColorStop(0.35, withAlpha(colour, peak * 0.45));
  g.addColorStop(1, withAlpha(colour, 0));
  disc(ctx, c, r, g);
}

export const toneColour = (tone: PinTone, palette: GlobePalette): string =>
  tone === 'attention' ? palette.attention : palette.accent;

/**
 * A chip drawn for the Globe: its canvas and its size in CSS pixels, `CHIP.pad` included. `id`
 * names the drawing, for a store that keeps one copy of each (CesiumJS's texture atlas).
 */
export interface ChipSprite {
  id: string;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

// weight 600 for both: the heaviest face of the UI font the app carries
const NAME_FONT = '600 12px';
const BADGE_FONT = '600 11px';
/** Text set on its middle line sits a little high: this much lower, capitals look centred. */
const TEXT_DROP = 0.75;

/** The font of a chip's words, as the browser is asked to load it before they are drawn. */
export const chipFont = (font: string): string => `${NAME_FONT} ${font}`;

let ruler: CanvasRenderingContext2D | null = null;

/** The width of a text in a font, in CSS pixels. */
function textWidth(font: string, text: string): number {
  ruler ??= document.createElement('canvas').getContext('2d');
  if (!ruler) return 0;
  ruler.font = font;
  return ruler.measureText(text).width;
}

/** The path of a rectangle with fully round ends. */
function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const r = height / 2;
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(x + width - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
}

/** A chip's words as they are drawn, and where they sit. */
interface ChipLayout {
  label: string;
  badge: string | null;
  m: ChipMetrics;
}

const layouts = new Map<string, ChipLayout>();
const chips = new Map<string, ChipSprite>();
/** Counts the times every chip was forgotten: a chip drawn again is another drawing. */
let drawing = 0;

function layout(text: string, open: number, font: string): ChipLayout {
  const badge = issueBadge(open);
  const key = JSON.stringify([text, badge, font]);
  const hit = layouts.get(key);
  if (hit) return hit;
  const nameFont = chipFont(font);
  const label = fitLabel(text, CHIP.maxName, (t) => textWidth(nameFont, t));
  const m = chipMetrics(
    textWidth(nameFont, label),
    badge === null ? null : textWidth(`${BADGE_FONT} ${font}`, badge),
  );
  const made = { label, badge, m };
  layouts.set(key, made);
  return made;
}

/** The size of a chip with these words, CSS pixels, without the clear room of its sprite. */
export function chipSize(text: string, open: number, font: string): ViewSize {
  const { m } = layout(text, open, font);
  return { width: m.width, height: m.height };
}

/**
 * Forget every chip measured and drawn. A canvas draws with the font faces loaded at that
 * moment: when one arrives later, the chips drawn without it have the wrong glyphs and width.
 */
export function forgetChips(): void {
  layouts.clear();
  chips.clear();
  drawing += 1;
}

function chip(
  text: string,
  open: number,
  colour: string,
  state: PinState,
  palette: GlobePalette,
  ratio: number,
  font: string,
): ChipSprite {
  const { label, badge, m } = layout(text, open, font);
  const key = JSON.stringify([
    text,
    badge,
    colour,
    state,
    palette.space,
    palette.ink,
    palette.attention,
    font,
    ratio,
  ]);
  const hit = chips.get(key);
  if (hit) return hit;
  const width = m.width + 2 * CHIP.pad;
  const height = m.height + 2 * CHIP.pad;
  const canvas = draw(width, height, ratio, (ctx) => {
    ctx.translate(CHIP.pad, CHIP.pad);
    const mid = m.height / 2;
    const selected = state === 'selected';
    pill(ctx, 0, 0, m.width, m.height);
    ctx.fillStyle = withAlpha(palette.space, 0.94);
    ctx.fill();
    if (selected) {
      ctx.fillStyle = withAlpha(palette.ink, 0.08);
      ctx.fill();
    }
    // the outline is drawn inside the chip: a chip keeps its size whatever its state
    const line = selected ? 1.5 : 1;
    pill(ctx, line / 2, line / 2, m.width - line, m.height - line);
    ctx.lineWidth = line;
    ctx.strokeStyle = selected ? colour : withAlpha(palette.ink, state === 'hover' ? 0.4 : 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(CHIP.dotX, mid, CHIP.dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = chipFont(font);
    ctx.fillStyle = palette.ink;
    ctx.fillText(label, m.nameX, mid + TEXT_DROP);
    if (badge !== null && m.badge) {
      pill(ctx, m.badge.x, mid - CHIP.badgeHeight / 2, m.badge.width, CHIP.badgeHeight);
      ctx.fillStyle = palette.attention;
      ctx.fill();
      ctx.font = `${BADGE_FONT} ${font}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = palette.space;
      ctx.fillText(badge, m.badge.x + m.badge.width / 2, mid + TEXT_DROP);
    }
  });
  const made = { id: `chip/${String(drawing)}/${key}`, canvas, width, height };
  chips.set(key, made);
  return made;
}

/** A site: its dot, its name (cut when long) and, with open issues, their number on amber. */
export function siteChip(
  name: string,
  open: number,
  tone: PinTone,
  state: PinState,
  palette: GlobePalette,
  ratio: number,
  font: string,
): ChipSprite {
  return chip(name, open, toneColour(tone, palette), state, palette, ratio, font);
}

/** Sites that crowd: one chip, its dot in the tone of what it holds, with the words for them. */
export function clusterChip(
  label: string,
  tone: PinTone,
  palette: GlobePalette,
  ratio: number,
  font: string,
): ChipSprite {
  return chip(label, 0, toneColour(tone, palette), 'rest', palette, ratio, font);
}

/** An issue of the open project: a solid dot in its severity colour on a dark seat. */
export function issuePin(colour: string, palette: GlobePalette, ratio: number): HTMLCanvasElement {
  return sprite(`issue/${colour}/${palette.space}`, 30, ratio, (ctx, size) => {
    const c = size / 2;
    halo(ctx, c, 14, colour, 0.3);
    disc(ctx, c, 8, withAlpha(palette.space, 0.92));
    disc(ctx, c, 6, colour);
  });
}

/** A measuring point: a small ring in the ink colour. */
export function measurePin(palette: GlobePalette, ratio: number): HTMLCanvasElement {
  return sprite(`measure/${palette.ink}/${palette.space}`, 18, ratio, (ctx, size) => {
    const c = size / 2;
    disc(ctx, c, 6, withAlpha(palette.space, 0.9));
    disc(ctx, c, 4.25, palette.ink);
    disc(ctx, c, 1.75, palette.space);
  });
}

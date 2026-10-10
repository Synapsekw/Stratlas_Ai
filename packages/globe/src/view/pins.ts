/**
 * The Globe's pins, drawn once per look on small canvases (no image is fetched): a site is a lit
 * dot with a soft halo, mint when it has no open issues and amber when it has; hovered and
 * selected sites grow a ring; a cluster is a dark disc with a count; an issue is a solid dot in
 * its severity colour. CesiumJS draws billboards in device pixels, so every sprite is drawn
 * `ratio` times larger than its CSS size.
 */
import { withAlpha, type GlobePalette } from '../style';

export type PinTone = 'clear' | 'attention';
export type PinState = 'rest' | 'hover' | 'selected';

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
  const px = Math.round(cssSize * ratio);
  const canvas = Object.assign(document.createElement('canvas'), { width: px, height: px });
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(ratio, ratio);
    paint(ctx, cssSize);
  }
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

function ring(ctx: CanvasRenderingContext2D, c: number, r: number, width: number, stroke: string) {
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
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

/** The CSS size of a site pin's sprite (the halo included). */
export const SITE_PIN_SIZE = 64;

/** A site: a lit dot with a halo; a ring when hovered, a brighter ring and core when selected. */
export function sitePin(
  tone: PinTone,
  state: PinState,
  palette: GlobePalette,
  ratio: number,
): HTMLCanvasElement {
  const colour = toneColour(tone, palette);
  return sprite(`site/${colour}/${state}/${palette.space}`, SITE_PIN_SIZE, ratio, (ctx, size) => {
    const c = size / 2;
    const core = state === 'rest' ? 6 : 7;
    halo(ctx, c, state === 'rest' ? 22 : 31, colour, state === 'rest' ? 0.5 : 0.62);
    if (state !== 'rest') {
      const strong = state === 'selected';
      ring(ctx, c, 14.5, strong ? 1.75 : 1.25, withAlpha(colour, strong ? 0.95 : 0.7));
    }
    // a dark seat keeps the dot readable on a bright pack or a busy street map
    disc(ctx, c, core + 2.25, withAlpha(palette.space, 0.9));
    disc(ctx, c, core, colour);
    disc(
      ctx,
      c,
      state === 'selected' ? 2.75 : 2,
      withAlpha(palette.ink, state === 'rest' ? 0.85 : 1),
    );
  });
}

/** Sites that crowd: a dark disc ringed in the tone of what it holds, with their number. */
export function clusterPin(
  count: number,
  tone: PinTone,
  palette: GlobePalette,
  ratio: number,
  font: string,
): HTMLCanvasElement {
  const colour = toneColour(tone, palette);
  const label = count > 99 ? '99+' : String(count);
  const r = label.length > 2 ? 16 : label.length > 1 ? 14.5 : 13;
  return sprite(`cluster/${label}/${colour}/${palette.space}/${font}`, 64, ratio, (ctx, size) => {
    const c = size / 2;
    halo(ctx, c, r + 15, colour, 0.36);
    disc(ctx, c, r, withAlpha(palette.space, 0.94));
    ring(ctx, c, r - 0.75, 1.5, colour);
    ctx.fillStyle = palette.ink;
    ctx.font = `600 ${label.length > 2 ? '11' : '12.5'}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, c, c + 0.75);
  });
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

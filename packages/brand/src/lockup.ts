/**
 * The horizontal lockup and the symbol as SVG text, for pages that inline the mark (the volumetric
 * report's band and footer). Composed from SYMBOL and WORDMARK with the brand kit's own transforms
 * (docs/brand/quadrion/kit/lockup/quadrion-horizontal-on-dark.svg), never redrawn: the kit lockup
 * sets the symbol at 1.46 and the wordmark at two thirds of WORDMARK's size.
 */

import raw from '../brand.json' with { type: 'json' };
import { WORDMARK } from './marks';
import { SYMBOL } from './symbol';

/** The background the mark sits on: the kit's on-dark or on-light colours. */
export type MarkSide = 'dark' | 'light';

/** Foreground (symbol quarters, QUADRION) and accent (tail, AI) per side, from the kit. */
export const MARK_COLOURS: Readonly<Record<MarkSide, { fg: string; accent: string }>> = {
  dark: { fg: '#EEF2F5', accent: '#5ED1B3' },
  light: { fg: '#11161C', accent: '#1A8C70' },
};

const NS = 'http://www.w3.org/2000/svg';

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const symbolPaths = (fg: string, accent: string): string =>
  SYMBOL.pieces.map((d, i) => `<path d="${d}" fill="${i === 3 ? accent : fg}"/>`).join('');

const title = (): string => `<title>${escapeXml(raw.productName)}</title>`;

/** The horizontal lockup (symbol, QUADRION, AI) on the kit's 746.11 x 156 view box. */
export function lockupSvg({ on }: { on: MarkSide }): string {
  const { fg, accent } = MARK_COLOURS[on];
  return (
    `<svg xmlns="${NS}" viewBox="0 0 746.11 156" role="img">` +
    title() +
    `<g transform="translate(34.15 34.15) scale(1.46)">${symbolPaths(fg, accent)}</g>` +
    `<g transform="translate(147.92 58) scale(0.666667)">` +
    `<path d="${WORDMARK.quadrion}" fill="${fg}"/>` +
    `<path d="${WORDMARK.ai}" fill="${accent}"/>` +
    `</g></svg>`
  );
}

/** The symbol alone on its own view box (on light by default). */
export function symbolSvg({ on = 'light' }: { on?: MarkSide } = {}): string {
  const { fg, accent } = MARK_COLOURS[on];
  return (
    `<svg xmlns="${NS}" viewBox="${SYMBOL.viewBox}" role="img">` +
    title() +
    symbolPaths(fg, accent) +
    `</svg>`
  );
}

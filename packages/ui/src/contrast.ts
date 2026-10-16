/** WCAG contrast for the oklch colours in tokens.css. */

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Relative luminance (WCAG 2) of an oklch colour, clamped to the sRGB gamut. */
function luminance(colour: string): number {
  const m = OKLCH.exec(colour.trim());
  if (!m) throw new Error(`Not an oklch colour: ${colour}`);
  const l = Number(m[1]) / (m[2] === '%' ? 100 : 1);
  const c = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  // OKLab -> linear sRGB
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = clamp01(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp01(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp01(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/** WCAG contrast ratio, 1 to 21, between two oklch colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

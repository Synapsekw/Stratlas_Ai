/**
 * Chart export (volumetric parity W1): the profile chart as a PNG and as CSV.
 *
 * The chart is styled by classes and `var(--token)` colours, which a standalone SVG image cannot
 * see, so `chartPng` copies each element's computed paint onto a clone before it is drawn to a
 * canvas. Files are saved through `dialog:saveFile`, the channel the 3D snapshot uses: the person
 * picks the place and the main process writes the bytes, so nothing lands in the project.
 */
import { fromSI, unitLabel } from '@aio/geo';
import type { SurveyPrecision, SurveyUnits } from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { t } from '@aio/ui';
import { bridge } from '../shell';

/** The paint and text properties the chart's stylesheet sets; each is written inline on the clone. */
const PAINT = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-variant-numeric',
  'text-anchor',
  'dominant-baseline',
  'shape-rendering',
] as const;

/** The crosshair, the hover readout and the live region. */
const OVERLAYS = '.pc-crosshair, [data-testid="chart-crosshair"], .pc-readout, [aria-live]';

const BACKGROUND_TOKEN = '--bg-1';

function readBlob(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(new Error(t('chart.exportFailed')));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Web fonts do not reach an SVG drawn into an image, so text gets an explicit stack that ends in a
 * generic family: the PNG then looks the same on every machine. Fonts are not embedded.
 */
function fontStack(family: string): string {
  const generic = /mono/i.test(family) ? 'ui-monospace, monospace' : 'sans-serif';
  return family ? `${family}, ${generic}` : generic;
}

/** Copy the computed paint of `from` and its descendants onto the matching nodes of `to`. */
function inlinePaint(from: Element, to: Element): void {
  const style = getComputedStyle(from);
  for (const attr of Array.from(to.attributes)) {
    if (attr.name !== 'style' && attr.value.includes('var(')) to.removeAttribute(attr.name);
  }
  // an inline style may carry var() too: keep its plain declarations, then the computed paint
  const kept = (to.getAttribute('style') ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !d.includes('var('));
  const isText = to.localName === 'text' || to.localName === 'tspan';
  const computed = PAINT.map((p) => {
    const v = style.getPropertyValue(p);
    return [p, p === 'font-family' && isText ? fontStack(v) : v] as const;
  })
    .filter(([, v]) => v !== '' && !v.includes('var('))
    .map(([p, v]) => `${p}:${v}`);
  const css = [...kept, ...computed].join(';');
  if (css) to.setAttribute('style', css);
  else to.removeAttribute('style');
  const a = from.children;
  const b = to.children;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x && y) inlinePaint(x, y);
  }
}

/** The chart as PNG bytes, drawn at `scale` times its size (default 2) on the panel colour. */
export async function chartPng(svg: SVGSVGElement, scale = 2): Promise<Uint8Array<ArrayBuffer>> {
  const box = svg.getBoundingClientRect();
  const width = Number(svg.getAttribute('width')) || box.width || 600;
  const height = Number(svg.getAttribute('height')) || box.height || 220;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlinePaint(svg, clone);
  // the hover state is not part of the picture; pins stay
  clone.querySelectorAll(OVERLAYS).forEach((el) => {
    el.remove();
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const bg = getComputedStyle(document.documentElement).getPropertyValue(BACKGROUND_TOKEN).trim();
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(clone),
  )}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => {
      resolve(el);
    };
    el.onerror = () => {
      reject(new Error(t('chart.exportFailed')));
    };
    el.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('chart.exportFailed'));
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error(t('chart.exportFailed'));
  return readBlob(blob);
}

const cell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
/** Chainages from different series are the same row when they agree to a micrometre. */
const rowKey = (c: number): string => c.toFixed(6);

/**
 * Chainage plus one column per surface, in the site distance unit and precision. Every header
 * names its unit; a surface with no ground at a chainage leaves the cell empty. Rows are the
 * chainages of all series in order, so series sampled differently still line up.
 */
export function seriesCsv(
  series: readonly ChartSeries[],
  units: SurveyUnits,
  precision: SurveyPrecision,
): string {
  const unit = unitLabel(units.distance);
  const fmt = (si: number) => fromSI(si, 'distance', units.distance).toFixed(precision.distance);
  const byKey = series.map((s) => {
    const m = new Map<string, number | null>();
    const n = Math.min(s.chainage.length, s.z.length);
    for (let i = 0; i < n; i++) {
      const z = s.z[i];
      m.set(rowKey(s.chainage[i] ?? 0), z != null && Number.isFinite(z) ? z : null);
    }
    return m;
  });
  const chainages = new Map<string, number>();
  for (const s of series) {
    for (const c of s.chainage) chainages.set(rowKey(c), c);
  }
  const rows = [...chainages.entries()].sort((a, b) => a[1] - b[1]);
  const out = [
    [`${t('chart.chainage')} (${unit})`, ...series.map((s) => `${s.label} (${unit})`)]
      .map(cell)
      .join(','),
  ];
  for (const [k, c] of rows) {
    out.push(
      [
        fmt(c),
        ...byKey.map((m) => {
          const z = m.get(k);
          return z == null ? '' : fmt(z);
        }),
      ].join(','),
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * Ask where, then write the image there. Answers the path, or null when the person cancels;
 * throws a sentence when the file could not be written.
 */
export async function savePng(
  bytes: Uint8Array<ArrayBuffer>,
  suggested: string,
): Promise<string | null> {
  const r = await bridge.call('dialog:saveFile', {
    defaultName: suggested,
    data: bytes,
    title: t('chart.exportPngTitle'),
  });
  if (!r.ok) throw new Error(r.error);
  if (r.value.error) throw new Error(r.value.error);
  return r.value.path;
}

// The volumetric report's page chrome, shared by pages A, B and C: the dark band with the lockup,
// the footer ("Prepared by <company> with <product> · Page n" and the symbol, nothing else), the
// numbered pile badges placed through the pictures' frame and spread apart where they would
// collide (`spreadMarkers`), the scale bar and north chip, the closing block of the report's last
// page (the closing remarks and the method note, once), the number formats and the resolved texts
// (the person's, else generated from the figures). Static markup only: the hidden report window
// prints it and the editor's preview renders it.
import { brand, lockupSvg, symbolSvg } from '@aio/brand';
import {
  formatReportDate,
  inShortSentence,
  methodNote,
  type VolumetricModel,
  type VolumetricPile,
} from '@aio/project/export';
import type { ReportViewsFrame, VolumetricTextId } from '@aio/schema';
import { t } from '@aio/ui';
import type { ReactElement, ReactNode } from 'react';
import type { ResolvedText } from '../types/template';
import './volumetric.css';

// ---------------------------------------------------------------- formats

const MINUS = '−';

/** The magnitude of a figure: grouped, no decimals from 100 (one below). */
function magnitude(v: number): string {
  const decimals = Math.abs(v) >= 100 ? 0 : 1;
  return Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A figure that prints as "0.0": it takes no sign, so nothing reads "−0.0" or "+0.0". */
const printsZero = (v: number): boolean => Math.abs(v) < 0.05;

/** A volume or tonnage figure without its unit: grouped, no decimals from 100 (one below), the Unicode minus when negative. */
export function num(v: number): string {
  return `${v < 0 && !printsZero(v) ? MINUS : ''}${magnitude(v)}`;
}

/** A signed figure: the Unicode minus for less, a plus for more, none for zero. */
export function signed(v: number, unit = ''): string {
  const sign = printsZero(v) ? '' : v < 0 ? MINUS : '+';
  return `${sign}${magnitude(v)}${unit}`;
}

/** A signed share: "−5.2 %". */
export function signedPct(pct: number): string {
  const sign = printsZero(pct) ? '' : pct < 0 ? MINUS : '+';
  return `${sign}${Math.abs(pct).toFixed(1)} %`;
}

/** A date of the report in words. */
export const dateText = (iso: string): string => formatReportDate(iso);

/** An SVG mark as an image source (no inline markup, works offline and under the HTML's CSP). */
export const svgSrc = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// ---------------------------------------------------------------- texts

export type VolumetricTexts = Record<VolumetricTextId, string | null>;

/**
 * The report's texts: the person's (the resolved text, else the model's), else generated: the
 * title, Prepared for (the project's customer), the "In short" sentence and the method note.
 * An empty optional part is null.
 */
export function volumetricTexts(model: VolumetricModel, text: ResolvedText): VolumetricTexts {
  const part = (id: VolumetricTextId): string | null => {
    const v = (text.parts[id] ?? model.text[id])?.trim() ?? '';
    return v === '' ? null : v;
  };
  return {
    title: part('title') ?? t('vreport.field.title.default'),
    preparedFor: part('preparedFor') ?? model.project.customer?.trim() ?? null,
    preparedBy: part('preparedBy'),
    summary: part('summary') ?? inShortSentence(model, t),
    intro: part('intro'),
    method: part('method') ?? methodNote(model, t),
    closing: part('closing'),
  };
}

// ---------------------------------------------------------------- page frame

/** One A4 page with the band at the top and the footer at the foot. */
export function Page({
  number,
  by,
  children,
  kind,
}: {
  number: number;
  by: string | null;
  kind: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`vr-page vr-page-${kind}`} data-page={number}>
      <Band />
      <div className="vr-body">{children}</div>
      <Footer number={number} by={by} />
    </section>
  );
}

/** The dark band: the lockup on dark, the report type and the tagline, the mint rule under it. */
export function Band(): ReactElement {
  return (
    <>
      <header className="vr-band">
        <img
          className="vr-lockup"
          src={svgSrc(lockupSvg({ on: 'dark' }))}
          alt={brand.productName}
        />
        <div className="vr-band-right">
          <span className="vr-band-type">{t('vreport.title')}</span>
          <span className="vr-band-tagline">{brand.tagline}</span>
        </div>
      </header>
      <div className="vr-rule" />
    </>
  );
}

/** The footer: the credit and the page number. The method note prints once, in `LastBlocks`. */
export function Footer({ number, by }: { number: number; by: string | null }): ReactElement {
  const credit = by
    ? t('vreport.footer', { company: by, product: brand.productName })
    : t('vreport.footer.noCompany', { product: brand.productName });
  return (
    <footer className="vr-foot">
      <p className="vr-foot-right">
        <span className="vr-foot-by">{`${credit} · ${t('vreport.page.number', { n: number })}`}</span>
        <img className="vr-symbol" src={svgSrc(symbolSvg({ on: 'light' }))} alt="" />
      </p>
    </footer>
  );
}

/**
 * The closing block of the report's last printed page, whichever page that is: the person's
 * closing remarks, then the method note, once (D12). Nothing on any other page.
 */
export function LastBlocks({
  texts,
  last,
}: {
  texts: VolumetricTexts;
  last: boolean;
}): ReactElement | null {
  if (!last) return null;
  return (
    <div className="vr-last">
      {texts.closing ? (
        <section className="vr-closing">
          <h2>{t('vreport.change.closing')}</h2>
          <p>{texts.closing}</p>
        </section>
      ) : null}
      {texts.method ? (
        <section className="vr-method">
          <h2>{t('vreport.method.title')}</h2>
          <p>{texts.method}</p>
        </section>
      ) : null}
    </div>
  );
}

/** Characters one line of the closing block holds (8.5 pt across the page's 182 mm). */
const LAST_LINE_CHARS = 120;

/**
 * The height the closing block takes on the last page, mm, by counts (never measured): a page
 * that prints it gives its pictures or rows that much less.
 */
export function lastBlocksMm(texts: VolumetricTexts, last: boolean): number {
  if (!last) return 0;
  const block = (text: string | null) =>
    text ? 8.2 + Math.ceil(text.length / LAST_LINE_CHARS) * 3.9 : 0;
  return block(texts.closing) + block(texts.method);
}

// ---------------------------------------------------------------- pictures

const pct = (v: number) => `${String(Math.round(v * 10000) / 100)}%`;

/** A badge after spreading: where it is drawn, its true place, and whether it was moved. */
export interface SpreadMarker {
  at: [number, number];
  anchor: [number, number];
  /** Moved far enough from its true place to need a leader back to it. */
  moved: boolean;
}

/** A box on a picture that badges keep clear of (the north chip, the scale bar). */
export interface KeepClear {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room kept between two badges, as a share of their diameter. */
const SPREAD_GAP = 1.12;
const SPREAD_ROUNDS = 80;

/**
 * Badges of one `radius` that would overlap are moved apart (D9), each pair along the line between
 * them (two at one point: along a direction fixed by their order, so the result never changes
 * between prints), moved off the `avoid` boxes by the shortest way, and kept inside `bounds` when
 * given. Every badge keeps its true place as `anchor`, to draw a leader to. Badges that already
 * stand clear do not move. Pure.
 */
export function spreadMarkers(
  points: readonly (readonly [number, number])[],
  radius: number,
  bounds?: { width: number; height: number },
  avoid: readonly KeepClear[] = [],
): SpreadMarker[] {
  const at = points.map((p): [number, number] => [p[0], p[1]]);
  const min = 2 * radius * SPREAD_GAP;
  const within = (v: number, size: number) =>
    size <= 2 * radius ? size / 2 : Math.min(Math.max(v, radius), size - radius);
  const clamp = (p: [number, number]) => {
    if (!bounds) return;
    p[0] = within(p[0], bounds.width);
    p[1] = within(p[1], bounds.height);
  };
  for (let round = 0; round < SPREAD_ROUNDS; round++) {
    let pushed = false;
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) {
        const a = at[i];
        const b = at[j];
        if (!a || !b) continue;
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        const gap = Math.hypot(dx, dy);
        if (gap >= min - 1e-9) continue;
        let d = gap;
        if (d < 1e-9) {
          // two at one point: a direction their order fixes
          const angle = (i * 7 + j) * 2.399963;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const push = (min - gap) / 2;
        a[0] -= (dx / d) * push;
        a[1] -= (dy / d) * push;
        b[0] += (dx / d) * push;
        b[1] += (dy / d) * push;
        clamp(a);
        clamp(b);
        pushed = true;
      }
    for (const p of at)
      for (const box of avoid) {
        // the box grown by the badge's radius: a centre inside it means the badge covers the box
        const x0 = box.x - radius;
        const x1 = box.x + box.width + radius;
        const y0 = box.y - radius;
        const y1 = box.y + box.height + radius;
        if (!(p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1)) continue;
        const fits = (v: number, size: number | undefined) =>
          size === undefined || (v >= radius && v <= size - radius);
        // the shortest way out that stays on the picture
        const ways = [
          { d: p[0] - x0, x: x0, y: p[1], ok: fits(x0, bounds?.width) },
          { d: x1 - p[0], x: x1, y: p[1], ok: fits(x1, bounds?.width) },
          { d: p[1] - y0, x: p[0], y: y0, ok: fits(y0, bounds?.height) },
          { d: y1 - p[1], x: p[0], y: y1, ok: fits(y1, bounds?.height) },
        ]
          .filter((w) => w.ok)
          .sort((a, b) => a.d - b.d);
        const way = ways[0];
        if (!way) continue;
        p[0] = way.x;
        p[1] = way.y;
        pushed = true;
      }
    if (!pushed) break;
  }
  return at.map((p, k) => {
    const anchor: [number, number] = [points[k]?.[0] ?? p[0], points[k]?.[1] ?? p[1]];
    return { at: p, anchor, moved: Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > radius * 0.2 };
  });
}

/** A pile badge's radius on a picture, mm (the 5.2 mm badge of volumetric.css). */
export const MARKER_R = 2.6;

/**
 * The pile badges of a picture `width` by `height` mm, at their places in mm from its top left:
 * spread apart where they would collide, each moved one with a leader and a dot at its true place.
 */
export function Markers({
  marks,
  width,
  height,
  avoid,
}: {
  marks: readonly { id: string; tag: string; x: number; y: number }[];
  width: number;
  height: number;
  /** Boxes the badges keep clear of, mm from the picture's top left. */
  avoid?: readonly KeepClear[];
}): ReactElement {
  const spread = spreadMarkers(
    marks.map((m) => [m.x, m.y] as const),
    MARKER_R,
    { width, height },
    avoid,
  );
  const leaders = spread.filter((s) => s.moved);
  const mm = (v: number) => v.toFixed(2);
  return (
    <>
      {leaders.length > 0 ? (
        <svg
          className="vr-leaders"
          viewBox={`0 0 ${mm(width)} ${mm(height)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {leaders.map((s) => (
            <g key={`${mm(s.anchor[0])}-${mm(s.anchor[1])}-${mm(s.at[0])}-${mm(s.at[1])}`}>
              {(['vr-leader-halo', 'vr-leader'] as const).map((cls) => (
                <line
                  key={cls}
                  className={cls}
                  x1={mm(s.anchor[0])}
                  y1={mm(s.anchor[1])}
                  x2={mm(s.at[0])}
                  y2={mm(s.at[1])}
                />
              ))}
              <circle className="vr-leader-dot" cx={mm(s.anchor[0])} cy={mm(s.anchor[1])} r="0.7" />
            </g>
          ))}
        </svg>
      ) : null}
      {marks.map((m, k) => {
        const s = spread[k];
        if (!s) return null;
        return (
          <span
            key={m.id}
            className={`vr-marker${s.moved ? ' is-moved' : ''}`}
            data-pile={m.id}
            style={{ left: pct(s.at[0] / width), top: pct(s.at[1] / height) }}
          >
            {m.tag}
          </span>
        );
      })}
    </>
  );
}

/** The longest nice length (1, 2 or 5 times a power of ten) at most a quarter of the width. */
export function scaleLength(widthM: number): number {
  const most = widthM / 4;
  if (!(most > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(most));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= most) ?? p;
}

/**
 * A top-down picture fitted in a box of `boxW` x `boxH` mm, its aspect kept, with the numbered
 * pile badges at their frame pixels (spread apart where they would collide), the scale bar and the
 * north chip. Without the picture, a quiet placeholder of the same size.
 */
export function SitePicture({
  src,
  frame,
  piles,
  boxW,
  boxH,
  className,
}: {
  src: string | null;
  frame: ReportViewsFrame | null;
  piles: readonly VolumetricPile[];
  boxW: number;
  boxH: number;
  className: string;
}): ReactElement {
  if (!src || !frame)
    return (
      <figure
        className={`${className} vr-picture is-empty`}
        style={{ width: `${String(boxW)}mm`, height: `${String(boxH)}mm` }}
      >
        <span className="vr-photo-none">{t('vreport.pictures.placeholder')}</span>
      </figure>
    );
  const k = Math.min(boxW / frame.widthPx, boxH / frame.heightPx);
  const w = frame.widthPx * k;
  const h = frame.heightPx * k;
  const widthM = frame.widthPx * frame.mPerPx;
  const len = scaleLength(widthM);
  const barMm = len > 0 ? (len / widthM) * w : 0;
  // the north chip (top right) and the scale bar (bottom left), mm: badges keep clear of both
  const chips: KeepClear[] = [
    { x: w - 14, y: 2, width: 12, height: 6 },
    ...(len > 0 ? [{ x: 2, y: h - 8, width: barMm + 16, height: 6 }] : []),
  ];
  // the badges of the piles the frame holds, in mm on the fitted picture
  const marks = piles.flatMap((p) =>
    p.marker &&
    p.marker[0] >= 0 &&
    p.marker[1] >= 0 &&
    p.marker[0] <= frame.widthPx &&
    p.marker[1] <= frame.heightPx
      ? [{ id: p.id, tag: p.tag, x: p.marker[0] * k, y: p.marker[1] * k }]
      : [],
  );
  return (
    <figure
      className={`${className} vr-picture`}
      style={{ width: `${String(boxW)}mm`, height: `${String(boxH)}mm` }}
    >
      <div
        className="vr-picture-inner"
        style={{ width: `${w.toFixed(2)}mm`, height: `${h.toFixed(2)}mm` }}
      >
        <img src={src} alt="" />
        <Markers marks={marks} width={w} height={h} avoid={chips} />
        <span className="vr-north">
          <svg viewBox="0 0 10 12" aria-hidden="true">
            <path d="M5 0 L9 11 L5 8.4 L1 11 Z" />
          </svg>
          N
        </span>
        {len > 0 ? (
          <span className="vr-scale">
            <span className="vr-scale-bar" style={{ width: `${barMm.toFixed(2)}mm` }} />
            <span className="vr-scale-label">{`${String(len)} m`}</span>
          </span>
        ) : null}
      </div>
    </figure>
  );
}

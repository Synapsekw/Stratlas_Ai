// The volumetric report's page chrome, shared by pages A, B and C: the dark band with the lockup,
// the footer ("Prepared by <company> with <product> · Page n" and the symbol), the numbered pile
// markers placed through the pictures' frame, the scale bar and north chip, the number formats and
// the resolved texts (the person's, else generated from the figures). Static markup only: the
// hidden report window prints it and the editor's preview renders it.
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

/** A volume or tonnage figure without its unit: grouped, no decimals from 100 (one below), the Unicode minus when negative. */
export function num(v: number): string {
  return `${v < 0 ? MINUS : ''}${magnitude(v)}`;
}

/** A signed figure: the Unicode minus for less, a plus for more, none for zero. */
export function signed(v: number, unit = ''): string {
  const sign = v < 0 ? MINUS : v > 0 ? '+' : '';
  return `${sign}${magnitude(v)}${unit}`;
}

/** A signed share: "−5.2 %". */
export function signedPct(pct: number): string {
  const sign = pct < 0 ? MINUS : pct > 0 ? '+' : '';
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
  method,
  children,
  kind,
}: {
  number: number;
  by: string | null;
  method?: string | null;
  kind: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`vr-page vr-page-${kind}`} data-page={number}>
      <Band />
      <div className="vr-body">{children}</div>
      <Footer number={number} by={by} method={method ?? null} />
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

/** The footer: the method note on the left (page A), the credit and page number on the right. */
export function Footer({
  number,
  by,
  method,
}: {
  number: number;
  by: string | null;
  method: string | null;
}): ReactElement {
  const credit = by
    ? t('vreport.footer', { company: by, product: brand.productName })
    : t('vreport.footer.noCompany', { product: brand.productName });
  return (
    <footer className="vr-foot">
      <p className="vr-method">
        {method ? (
          <>
            <strong>{t('vreport.method.title')}.</strong> {method}
          </>
        ) : null}
      </p>
      <p className="vr-foot-right">
        <span className="vr-foot-by">{`${credit} · ${t('vreport.page.number', { n: number })}`}</span>
        <img className="vr-symbol" src={svgSrc(symbolSvg({ on: 'light' }))} alt="" />
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------- pictures

const pct = (v: number) => `${String(Math.round(v * 10000) / 100)}%`;

/** The longest nice length (1, 2 or 5 times a power of ten) at most a quarter of the width. */
export function scaleLength(widthM: number): number {
  const most = widthM / 4;
  if (!(most > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(most));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= most) ?? p;
}

/**
 * A top-down picture fitted in a box of `boxW` x `boxH` mm, its aspect kept, with the numbered
 * pile markers at their frame pixels, the scale bar and the north chip. Without the picture, the
 * box says to take the pictures in the app.
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
        {piles.map((p) =>
          p.marker &&
          p.marker[0] >= 0 &&
          p.marker[1] >= 0 &&
          p.marker[0] <= frame.widthPx &&
          p.marker[1] <= frame.heightPx ? (
            <span
              key={p.id}
              className="vr-marker"
              style={{
                left: pct(p.marker[0] / frame.widthPx),
                top: pct(p.marker[1] / frame.heightPx),
              }}
            >
              {p.tag}
            </span>
          ) : null,
        )}
        <span className="vr-north">
          <svg viewBox="0 0 10 12" aria-hidden="true">
            <path d="M5 0 L9 11 L5 8.4 L1 11 Z" />
          </svg>
          N
        </span>
        {len > 0 ? (
          <span className="vr-scale">
            <span
              className="vr-scale-bar"
              style={{ width: `${((len / widthM) * w).toFixed(2)}mm` }}
            />
            <span className="vr-scale-label">{`${String(len)} m`}</span>
          </span>
        ) : null}
      </div>
    </figure>
  );
}

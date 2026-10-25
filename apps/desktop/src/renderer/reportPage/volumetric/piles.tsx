// Page B of the volumetric report (spec section 3, the founder-approved mock-up): the stock on the
// latest date with its tonnes and change, the share-of-stock bar (the 8 largest piles in the brand
// teals, the rest as Others), a card for each of the 8 largest piles (before and after crops at one
// framing, the change chip, tonnes, footprint, peak height and the person's note) and the smaller
// piles in a compact two-column list. Compact rows past the 24th continue on "B, continued" pages
// (`pagePlan`). The page is laid out by counts, never measured: the crops take the height the
// fixed counts leave (`cropHeightMm`).
import type { VolumetricModel, VolumetricPile } from '@aio/project/export';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import type { PageComponent, PageContext, ReportViews, ResolvedText } from '../types/template';
import { dateText, num, Page, signed, signedPct, volumetricTexts } from './chrome';
import './piles.css';

type CaptureRef = NonNullable<VolumetricModel['latest']>;

// ---------------------------------------------------------------- the page's budget, mm

/** The body's height on page B (A4 less the band, the rule, the top padding and the footer). */
const BODY_H = 250;
/** The header and the share bar, each with the space under it. */
const HEAD_H = 14.5;
const SHARE_H = 13.5;
/** The smaller-piles box: its padding, title and top margin, then each line of two rows. */
const SMALLER_FIXED = 13.4;
const SMALLER_LINE = 3.4;
/** The gap between card rows, and a card's height less its crops (title, captions, figures). */
const CARD_GAP = 2.6;
const CARD_FIXED = 23.6;
/** One line of note under a card's figures. */
const NOTE_H = 3.8;
/** A crop's width: half the card's inner width less the gap. */
export const CROP_W = 40;
const CROP_MIN = 12;

/**
 * The crops' height on page B: what the fixed counts leave of the body (the card rows, the compact
 * rows on this page, a note line when any card has a note), shared by the card rows; at least
 * 12 mm, at most the crop's width (a square).
 */
export function cropHeightMm({
  cardRows,
  compactRows,
  notes,
}: {
  cardRows: number;
  compactRows: number;
  notes: boolean;
}): number {
  if (cardRows <= 0) return CROP_W;
  const smaller = compactRows > 0 ? SMALLER_FIXED + Math.ceil(compactRows / 2) * SMALLER_LINE : 0;
  const cards = BODY_H - HEAD_H - SHARE_H - smaller;
  const perRow = (cards - (cardRows - 1) * CARD_GAP) / cardRows;
  const h = perRow - CARD_FIXED - (notes ? NOTE_H : 0);
  return Math.round(Math.min(CROP_W, Math.max(CROP_MIN, h)) * 10) / 10;
}

// ---------------------------------------------------------------- formats

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date in short: "3 Sep", with the year when the report's dates span two. */
function shortDate(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  return [String(Number(d)), month, withYear ? y : null].filter(Boolean).join(' ');
}

const way = (v: number | null): string =>
  v === null || v === 0 ? 'is-flat' : v < 0 ? 'is-down' : 'is-up';

const pct = (v: number) => `${(Math.round(v * 100000) / 1000).toFixed(3)}%`;

/** The person's note on a pile (the resolved text, else the model's), or null. */
function noteOf(p: VolumetricPile, text: ResolvedText): string | null {
  const v = (text.pileNotes[p.id] ?? p.note ?? '').trim();
  return v === '' ? null : v;
}

// ---------------------------------------------------------------- parts

function Header({ model }: { model: VolumetricModel }): ReactElement {
  const k = model.kpis;
  const title = model.latest
    ? t('vreport.piles.headingOn', { date: dateText(model.latest.date) })
    : t('vreport.piles.heading');
  return (
    <header className="vr-piles-head">
      <div>
        <h1>{title}</h1>
        {model.project.site ? <p className="vr-piles-site">{model.project.site}</p> : null}
      </div>
      <div className="vr-piles-figures">
        <span className="vr-piles-total">{`${num(k.stockM3)} m³`}</span>
        <span className="vr-piles-sub">
          {k.tonnes !== null ? (
            <span className="vr-piles-tonnes">{`${num(k.tonnes)} t`}</span>
          ) : null}
          {k.changeM3 !== null && model.compared ? (
            <span className={`vr-piles-change ${way(k.changeM3)}`}>
              {[signed(k.changeM3, ' m³'), k.changePct !== null ? signedPct(k.changePct) : null]
                .filter((s): s is string => s !== null)
                .join(' · ')}
            </span>
          ) : null}
        </span>
      </div>
    </header>
  );
}

/** Segments under this share carry no label (it would not fit). */
const LABEL_SHARE = 0.06;

function ShareBar({ model }: { model: VolumetricModel }): ReactElement {
  return (
    <section className="vr-share">
      <h2>{t('vreport.piles.share')}</h2>
      <div className="vr-share-bar">
        {model.share.map((s, i) => {
          const others = s.id === null;
          const cls = others
            ? 'vr-share-seg is-others'
            : `vr-share-seg vr-share-${String(i)}${i < 4 ? ' is-dark' : ''}`;
          const label = others ? t('vreport.piles.others') : (s.label ?? '');
          return (
            <span
              key={s.id ?? 'others'}
              className={cls}
              style={{ width: pct(s.share) }}
              title={`${label} ${(s.share * 100).toFixed(1)} %`}
            >
              {s.share >= LABEL_SHARE ? label : ''}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** A pile's crop on one date: the separate crop JPEG, else a CSS crop of the date's photo. */
function Crop({
  model,
  pile,
  date,
  latest,
  views,
  height,
  withYear,
}: {
  model: VolumetricModel;
  pile: VolumetricPile;
  date: CaptureRef;
  latest: boolean;
  views: ReportViews;
  height: number;
  withYear: boolean;
}): ReactElement {
  const m3 = pile.byDate.find((d) => d.capture === date.id)?.volumeM3 ?? null;
  const caption = [shortDate(date.date, withYear), m3 !== null ? `${num(m3)} m³` : null]
    .filter(Boolean)
    .join(' · ');
  const file = views.crop?.(pile.id, date.id) ?? null;
  const photo = file ? null : views.picture('photo', date.id);
  const frame = views.frame ?? model.frame;
  const box = pile.crop;
  let picture: ReactElement | null = null;
  if (file) picture = <img className="is-file" src={file} alt="" />;
  else if (photo && frame && box && box.size > 0)
    picture = (
      <span className="vr-crop-sq" style={{ top: `${((height - CROP_W) / 2).toFixed(2)}mm` }}>
        <img
          src={photo}
          alt=""
          style={{
            width: pct(frame.widthPx / box.size),
            left: pct(-box.x / box.size),
            top: pct(-box.y / box.size),
          }}
        />
      </span>
    );
  return (
    <figure className={`vr-crop${latest ? ' is-latest' : ''}${picture ? '' : ' is-empty'}`}>
      <span className="vr-crop-box" style={{ height: `${String(height)}mm` }}>
        {picture ?? <span className="vr-photo-none">{t('vreport.pictures.placeholder')}</span>}
      </span>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Card({
  model,
  pile,
  note,
  views,
  height,
}: {
  model: VolumetricModel;
  pile: VolumetricPile;
  note: string | null;
  views: ReportViews;
  height: number;
}): ReactElement {
  const dates = [model.compared, model.latest].filter((d): d is CaptureRef => d !== null);
  const withYear = new Set(dates.map((d) => d.date.slice(0, 4))).size > 1;
  const c = model.compared ? pile.changeM3 : null;
  return (
    <article className="vr-card">
      <header className="vr-card-head">
        <span className="vr-num">{String(pile.number)}</span>
        <span className="vr-card-name">{pile.label}</span>
        {c !== null ? (
          <span className={`vr-chip ${way(c)}`}>
            {[
              signed(c, ' m³'),
              pile.changePct !== null
                ? signedPct(pile.changePct)
                : pile.previousM3 !== null
                  ? t('vreport.change.new')
                  : null,
            ]
              .filter((s): s is string => s !== null)
              .join(' · ')}
          </span>
        ) : null}
      </header>
      <div className="vr-crops">
        {dates.map((d) => (
          <Crop
            key={d.id}
            model={model}
            pile={pile}
            date={d}
            latest={d.id === model.latest?.id}
            views={views}
            height={height}
            withYear={withYear}
          />
        ))}
      </div>
      <dl className="vr-stats">
        <div className="vr-stat">
          <dt className="vr-stat-label">{t('vreport.piles.tonnes')}</dt>
          <dd className="vr-stat-value">
            {pile.tonnes !== null ? num(pile.tonnes) : t('vreport.table.noTonnes')}
          </dd>
        </div>
        <div className="vr-stat">
          <dt className="vr-stat-label">{t('vreport.piles.footprint')}</dt>
          <dd className="vr-stat-value">
            {pile.areaM2 !== null ? Math.round(pile.areaM2).toLocaleString('en-US') : ''}
          </dd>
        </div>
        <div className="vr-stat">
          <dt className="vr-stat-label">{t('vreport.piles.peak')}</dt>
          <dd className="vr-stat-value">{pile.peakM !== null ? pile.peakM.toFixed(1) : ''}</dd>
        </div>
      </dl>
      {note ? <p className="vr-card-note">{note}</p> : null}
    </article>
  );
}

function Smaller({
  model,
  rows,
  text,
}: {
  model: VolumetricModel;
  rows: readonly VolumetricPile[];
  text: ResolvedText;
}): ReactElement {
  const lines = Math.ceil(rows.length / 2);
  const noted = rows.map((p) => noteOf(p, text));
  return (
    <section className="vr-smaller">
      <h2>
        {t('vreport.piles.smaller')}
        {noted.some((n) => n !== null) ? (
          <span className="vr-smaller-key">
            <span className="vr-note-mark" aria-hidden="true" />
            {t('vreport.piles.hasNote')}
          </span>
        ) : null}
      </h2>
      <ul
        className="vr-smaller-list"
        style={{ gridTemplateRows: `repeat(${String(Math.max(1, lines))}, auto)` }}
      >
        {rows.map((p, i) => {
          const c = model.compared ? p.changeM3 : null;
          const note = noted[i] ?? null;
          return (
            <li key={p.id} className="vr-smaller-row">
              <span className="vr-smaller-no">{String(p.number)}</span>
              <span className="vr-smaller-name">{p.label}</span>
              {note ? (
                <span
                  className="vr-note-mark"
                  title={note}
                  aria-label={t('vreport.piles.hasNote')}
                />
              ) : null}
              <span className="vr-smaller-m3">
                {p.latestM3 !== null ? `${num(p.latestM3)} m³` : ''}
              </span>
              <span className={`vr-smaller-change ${way(c)}`}>{c !== null ? signed(c) : ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- page

/** Page B, or one of its "B, continued" pages. */
export function PilesPage({
  model,
  text,
  views,
  page,
}: PageContext<VolumetricModel>): ReactElement {
  const texts = volumetricTexts(model, text);
  const byId = new Map(model.piles.map((p) => [p.id, p]));
  const pick = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((p): p is VolumetricPile => p !== undefined);
  const rows = pick(model.compact.slice(page.from, page.to));
  if (page.continued)
    return (
      <Page kind="piles" number={page.number} by={texts.preparedBy}>
        <h2 className="vr-continued">{t('vreport.page.pilesContinued')}</h2>
        <Smaller model={model} rows={rows} text={text} />
      </Page>
    );
  const cards = pick(model.cards);
  const notes = cards.map((p) => noteOf(p, text));
  const height = cropHeightMm({
    cardRows: Math.ceil(cards.length / 2),
    compactRows: rows.length,
    notes: notes.some((n) => n !== null),
  });
  return (
    <Page kind="piles" number={page.number} by={texts.preparedBy}>
      <Header model={model} />
      <ShareBar model={model} />
      <div className="vr-cards">
        {cards.map((p, i) => (
          <Card
            key={p.id}
            model={model}
            pile={p}
            note={notes[i] ?? null}
            views={views}
            height={height}
          />
        ))}
      </div>
      {rows.length > 0 ? <Smaller model={model} rows={rows} text={text} /> : null}
    </Page>
  );
}

/** Page B's entry in the volumetric template (collected by `types/index.ts`). */
export const volumetricPage: { id: 'piles'; component: PageComponent<VolumetricModel> } = {
  id: 'piles',
  component: PilesPage,
};

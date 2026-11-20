// Page A of the volumetric report (the founder-approved layout of 20 Nov 2026): the band, the
// title block (site, the survey date against the compared one, how many piles there are and how
// many have a volume, Prepared for), the latest orthophoto with the numbered pile badges beside
// the KPI tiles (stock on hand, the change since the compared survey, the survey error when every
// pile has one), "In short" and the intro, then the table of every pile with a diverging change
// bar: a pile without a volume reads "Not computed" across its figures, a missing base "Not set".
// Under the table a plain notice names the piles whose outlines overlap (D2). The rows past the
// twelfth continue on "A, continued" pages (`pagePlan`). No text is cut: the texts grow with
// their length and the photo row gives them the room, by counts (`leadHeightMm`).
import {
  formatVolumeM3,
  type VolumetricModel,
  type VolumetricOverlap,
  type VolumetricPile,
  type VolumetricPileRef,
} from '@aio/project/export';
import { symbolSvg } from '@aio/brand';
import { t } from '@aio/ui';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { PageContext, PageComponent } from '../types/template';
import {
  dateText,
  LastBlocks,
  lastBlocksMm,
  num,
  Page,
  signed,
  signedPct,
  SitePicture,
  svgSrc,
  volumetricTexts,
  type VolumetricTexts,
} from './chrome';

/** The orthophoto's box on page A, mm: its height is the lead row's (`leadHeightMm`). */
const PHOTO_W = 118;
/** The lead row (the photo beside the KPI tiles) at its full height and at its least, mm. */
const LEAD_H = 80;
const LEAD_MIN = 46;
/** Page A's body, and what its fixed parts take with one line of each text, mm (volumetric.css). */
const BODY_H = 250;
const TITLE_H = 25;
const SHORT_FIXED = 16.5;
const SHORT_LINE = 5.2;
const SHORT_LINE_CHARS = 78;
const TEXT_LINE = 4.5;
const TEXT_LINE_CHARS = 112;
const TABLE_HEAD = 11;
const TABLE_ROW = 6.6;

const lines = (chars: number, perLine: number) => Math.max(1, Math.ceil(chars / perLine));

/**
 * The height of the lead row on page A, mm: its full 80 mm, less what the texts need beyond the
 * room the page has (a long "In short", an intro, the overlap notice, the closing block when A is
 * the last page), never under 46 mm. By counts, never measured, so the page fits before printing.
 */
export function leadHeightMm(c: {
  summaryChars: number;
  introChars: number;
  noticeChars: number;
  rows: number;
  lastMm?: number;
}): number {
  const used =
    TITLE_H +
    SHORT_FIXED +
    lines(c.summaryChars, SHORT_LINE_CHARS) * SHORT_LINE +
    (c.introChars > 0 ? 3.5 + lines(c.introChars, TEXT_LINE_CHARS) * TEXT_LINE : 0) +
    TABLE_HEAD +
    c.rows * TABLE_ROW +
    (c.noticeChars > 0 ? 6 + lines(c.noticeChars, TEXT_LINE_CHARS) * TEXT_LINE : 0) +
    (c.lastMm ?? 0);
  const left = BODY_H - used;
  return Math.round(Math.min(LEAD_H, Math.max(LEAD_MIN, left)) * 10) / 10;
}

function TitleBlock({
  model,
  texts,
}: {
  model: VolumetricModel;
  texts: VolumetricTexts;
}): ReactElement {
  const meta = [
    model.project.site,
    model.latest ? t('vreport.band.surveyed', { date: dateText(model.latest.date) }) : null,
    model.compared ? t('vreport.band.compared', { date: dateText(model.compared.date) }) : null,
    // every pile is listed; how many have a volume is said only when some have none
    model.kpis.listed === model.kpis.piles
      ? t('vreport.band.piles', { count: model.kpis.listed })
      : t('vreport.band.pilesMeasured', {
          count: model.kpis.listed,
          measured: model.kpis.piles,
        }),
  ].filter((m): m is string => m !== null && m !== '');
  return (
    <div className="vr-title">
      <div>
        <h1>{texts.title}</h1>
        <p className="vr-title-meta">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </p>
      </div>
      {texts.preparedFor ? (
        <p className="vr-for">{t('vreport.band.preparedFor', { customer: texts.preparedFor })}</p>
      ) : null}
    </div>
  );
}

function Kpis({ model }: { model: VolumetricModel }): ReactElement {
  const k = model.kpis;
  const tonnesLine =
    k.tonnes === null
      ? null
      : k.tonnesPiles < k.piles
        ? `${t('vreport.kpi.stockTonnes', { tonnes: `${num(k.tonnes)} t` })}, ${t('vreport.kpi.tonnesPartial', { n: k.tonnesPiles, m: k.piles })}`
        : t('vreport.kpi.stockTonnes', { tonnes: `${num(k.tonnes)} t` });
  const weighed = model.piles.filter((p) => p.tonnes !== null && p.previousTonnes !== null);
  const tonnesChange =
    weighed.length > 0
      ? weighed.reduce((a, p) => a + (p.tonnes ?? 0) - (p.previousTonnes ?? 0), 0)
      : null;
  const change = k.changeM3;
  const way = change === null ? '' : change < 0 ? 'is-down' : change > 0 ? 'is-up' : 'is-flat';
  return (
    <div className="vr-kpis">
      <div className="vr-kpi vr-kpi-stock">
        <span className="vr-kpi-label">{t('vreport.kpi.stock')}</span>
        <span className="vr-kpi-figure">{formatVolumeM3(k.stockM3)}</span>
        {tonnesLine ? <span className="vr-kpi-sub">{tonnesLine}</span> : null}
      </div>
      {change !== null && model.compared ? (
        <div className={`vr-kpi vr-kpi-change ${way}`}>
          <span className="vr-kpi-label">
            {t('vreport.kpi.change', { date: dateText(model.compared.date) })}
          </span>
          <span className="vr-kpi-figure">{signed(change, ' m³')}</span>
          <span className="vr-kpi-sub">
            {[
              k.changePct !== null ? signedPct(k.changePct) : null,
              tonnesChange !== null ? signed(tonnesChange, ' t') : null,
            ]
              .filter((s): s is string => s !== null)
              .join(', ')}
          </span>
        </div>
      ) : null}
      {k.errorM3 !== null ? (
        <div className="vr-kpi vr-kpi-error">
          <span className="vr-kpi-label">{t('vreport.kpi.error')}</span>
          <span className="vr-kpi-figure">
            {t('vreport.kpi.errorValue', {
              volume: formatVolumeM3(k.errorM3),
              pct: `${(k.errorPct ?? 0).toFixed(1)} %`,
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function RankedTable({
  model,
  rows,
}: {
  model: VolumetricModel;
  rows: readonly VolumetricPile[];
}): ReactElement {
  const compared = model.compared !== null;
  const most = Math.max(0, ...model.piles.map((p) => Math.abs(p.changeM3 ?? 0)));
  // the figure columns a "Not computed" row spans: previous, latest, tonnes, peak, change
  const figureCols = compared ? 5 : 3;
  return (
    <table className="vr-table">
      <thead>
        <tr>
          <th className="vr-col-pile">{t('vreport.table.pile')}</th>
          <th className="vr-col-base">{t('vreport.table.base')}</th>
          {compared ? <th className="vr-col-n">{t('vreport.table.previous')}</th> : null}
          <th className="vr-col-n">{t('vreport.table.latest')}</th>
          <th className="vr-col-n">{t('vreport.table.tonnes')}</th>
          <th className="vr-col-n">{t('vreport.table.peak')}</th>
          {compared ? <th className="vr-col-change">{t('vreport.table.change')}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const c = p.changeM3;
          const width = c !== null && most > 0 ? (Math.abs(c) / most) * 50 : 0;
          const way = c === null || c === 0 ? 'is-flat' : c < 0 ? 'is-down' : 'is-up';
          const base = p.base.trim();
          const lead = (
            <>
              <td className="vr-col-pile">
                <span className="vr-pile-cell">
                  <span className="vr-num">{p.tag}</span>
                  <span className="vr-pile-name">{p.label}</span>
                </span>
              </td>
              <td className={`vr-col-base${base === '' ? ' is-quiet' : ''}`}>
                {base === '' ? t('vreport.pile.baseNotSet') : base}
              </td>
            </>
          );
          // no volume on the latest date: listed all the same (D1)
          if (p.latestM3 === null)
            return (
              <tr key={p.id} className="is-uncomputed" data-pile={p.id}>
                {lead}
                <td className="vr-col-none" colSpan={figureCols}>
                  {t('vreport.notComputed')}
                </td>
              </tr>
            );
          return (
            <tr key={p.id} data-pile={p.id}>
              {lead}
              {compared ? (
                <td className="vr-col-n">{p.previousM3 !== null ? num(p.previousM3) : ''}</td>
              ) : null}
              <td className="vr-col-n">{num(p.latestM3)}</td>
              <td className="vr-col-n">{p.tonnes !== null ? num(p.tonnes) : ''}</td>
              <td className="vr-col-n">{p.peakM !== null ? p.peakM.toFixed(1) : ''}</td>
              {compared ? (
                <td className="vr-col-change">
                  <span className="vr-change-cell">
                    <span className="vr-change">{c !== null ? signed(c) : ''}</span>
                    <span className="vr-bar">
                      {c !== null && c !== 0 ? (
                        <span
                          className={`vr-bar-fill ${way}`}
                          style={{ width: `${String(width)}%` }}
                        />
                      ) : null}
                    </span>
                  </span>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A pile as a sentence names it: its badge, then its name. */
function PileName({ pile }: { pile: VolumetricPileRef }): ReactElement {
  return (
    <span className="vr-notice-pile">
      <span className="vr-num">{pile.tag}</span>
      <strong>{pile.label}</strong>
    </span>
  );
}

/** Marks a slot of a catalogue sentence, so an element can stand in its place. */
const MARK = '\u0001';
const slot = (name: string) => `${MARK}${name}${MARK}`;

/** A catalogue sentence with elements in the places of its slots. */
function withSlots(sentence: string, slots: Readonly<Record<string, ReactNode>>): ReactNode[] {
  // odd parts are slot names, even parts the words between them
  return sentence
    .split(MARK)
    .map((part, k) => <Fragment key={k}>{k % 2 === 1 ? slots[part] : part}</Fragment>);
}

/**
 * The overlap warning (D2): piles whose outlines substantially overlap, so the site total may
 * count the same material twice. A plain notice; nothing without overlaps.
 */
export function OverlapNotice({
  overlaps,
}: {
  overlaps: readonly VolumetricOverlap[];
}): ReactElement | null {
  const [only] = overlaps;
  if (!only) return null;
  const pair = (o: VolumetricOverlap, sentence: string) =>
    withSlots(sentence, { a: <PileName pile={o.a} />, b: <PileName pile={o.b} /> });
  const body =
    overlaps.length === 1
      ? pair(only, t('vreport.overlap.warning', { a: slot('a'), b: slot('b') }))
      : withSlots(t('vreport.overlap.warningMany', { pairs: slot('pairs') }), {
          pairs: overlaps.map((o, k) => (
            <Fragment key={`${o.a.id}-${o.b.id}`}>
              {k > 0 ? '; ' : ''}
              {pair(o, t('vreport.overlap.pair', { a: slot('a'), b: slot('b') }))}
            </Fragment>
          )),
        });
  return (
    <p className="vr-notice" data-notice="overlap">
      {body}
    </p>
  );
}

/** The characters the overlap notice prints, for the page's budget. */
const noticeChars = (overlaps: readonly VolumetricOverlap[]) =>
  overlaps.length === 0
    ? 0
    : 70 + overlaps.reduce((n, o) => n + o.a.label.length + o.b.label.length + 16, 0);

/** Page A, or one of its "A, continued" pages. */
export function CoverPage({
  model,
  text,
  views,
  page,
  total,
}: PageContext<VolumetricModel>): ReactElement {
  const texts = volumetricTexts(model, text);
  const rows = model.piles.slice(page.from, page.to);
  const last = page.number === total;
  // the notice stands under the end of the table: on the page that holds the last row
  const notice = page.to >= model.piles.length ? model.overlaps : [];
  if (page.continued)
    return (
      <Page kind="cover" number={page.number} by={texts.preparedBy}>
        <h2 className="vr-continued">{t('vreport.page.coverContinued')}</h2>
        <RankedTable model={model} rows={rows} />
        <OverlapNotice overlaps={notice} />
        <LastBlocks texts={texts} last={last} />
      </Page>
    );
  const photo = model.latest ? views.picture('photo', model.latest.id) : null;
  const leadH = leadHeightMm({
    summaryChars: texts.summary?.length ?? 0,
    introChars: texts.intro?.length ?? 0,
    noticeChars: noticeChars(notice),
    rows: rows.length,
    lastMm: lastBlocksMm(texts, last),
  });
  return (
    <Page kind="cover" number={page.number} by={texts.preparedBy}>
      <TitleBlock model={model} texts={texts} />
      <div className="vr-lead" style={{ height: `${String(leadH)}mm` }}>
        <SitePicture
          className="vr-photo"
          src={photo}
          frame={views.frame ?? model.frame}
          piles={model.piles}
          boxW={PHOTO_W}
          boxH={leadH}
        />
        <Kpis model={model} />
      </div>
      <div className="vr-short">
        <img className="vr-symbol" src={svgSrc(symbolSvg({ on: 'light' }))} alt="" />
        <div>
          <h2>{t('vreport.inShort')}</h2>
          <p>{texts.summary}</p>
        </div>
      </div>
      {texts.intro ? <p className="vr-intro">{texts.intro}</p> : null}
      <RankedTable model={model} rows={rows} />
      <OverlapNotice overlaps={notice} />
      <LastBlocks texts={texts} last={last} />
    </Page>
  );
}

/** Page A's entry in the volumetric template (collected by `types/index.ts`). */
export const volumetricPage: { id: 'cover'; component: PageComponent<VolumetricModel> } = {
  id: 'cover',
  component: CoverPage,
};

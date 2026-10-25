// Page A of the volumetric report (spec section 3, the founder-approved mock-up): the band, the
// title block (site, the survey date against the compared one, the pile count, Prepared for), the
// latest orthophoto with the numbered pile markers beside the KPI tiles (stock on hand, the change
// since the compared survey, the survey error when every pile has one), "In short" and the intro,
// the ranked table with a diverging change bar per pile, the method note and the footer. The rows
// past the twelfth continue on "A, continued" pages (`pagePlan`).
import { formatVolumeM3, type VolumetricModel, type VolumetricPile } from '@aio/project/export';
import { symbolSvg } from '@aio/brand';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import type { PageContext, PageComponent } from '../types/template';
import {
  dateText,
  num,
  Page,
  signed,
  signedPct,
  SitePicture,
  svgSrc,
  volumetricTexts,
  type VolumetricTexts,
} from './chrome';

/** The orthophoto's box on page A, mm. */
const PHOTO_W = 118;
const PHOTO_H = 80;

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
    t('vreport.band.piles', { count: model.kpis.piles }),
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
  return (
    <table className="vr-table">
      <thead>
        <tr>
          <th className="vr-col-pile">{t('vreport.table.pile')}</th>
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
          return (
            <tr key={p.id}>
              <td className="vr-col-pile">
                <span className="vr-num">{String(p.number)}</span>
                <span className="vr-pile-name">{p.label}</span>
              </td>
              {compared ? (
                <td className="vr-col-n">{p.previousM3 !== null ? num(p.previousM3) : ''}</td>
              ) : null}
              <td className="vr-col-n">{p.latestM3 !== null ? num(p.latestM3) : ''}</td>
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

/** Page A, or one of its "A, continued" pages. */
export function CoverPage({
  model,
  text,
  views,
  page,
}: PageContext<VolumetricModel>): ReactElement {
  const texts = volumetricTexts(model, text);
  const rows = model.piles.slice(page.from, page.to);
  if (page.continued)
    return (
      <Page kind="cover" number={page.number} by={texts.preparedBy}>
        <h2 className="vr-continued">{t('vreport.page.coverContinued')}</h2>
        <RankedTable model={model} rows={rows} />
      </Page>
    );
  const photo = model.latest ? views.picture('photo', model.latest.id) : null;
  return (
    <Page kind="cover" number={page.number} by={texts.preparedBy} method={texts.method}>
      <TitleBlock model={model} texts={texts} />
      <div className="vr-lead">
        <SitePicture
          className="vr-photo"
          src={photo}
          frame={views.frame ?? model.frame}
          piles={model.piles}
          boxW={PHOTO_W}
          boxH={PHOTO_H}
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
    </Page>
  );
}

/** Page A's entry in the volumetric template (collected by `types/index.ts`). */
export const volumetricPage: { id: 'cover'; component: PageComponent<VolumetricModel> } = {
  id: 'cover',
  component: CoverPage,
};

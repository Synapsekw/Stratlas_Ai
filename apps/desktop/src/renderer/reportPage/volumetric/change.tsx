// Page C of the volumetric report (spec section 3, the founder-approved mock-up): what changed
// between the compared survey and the latest one. The header names the date pair and the site,
// with the Before / After / Change key at right; the two orthophotos stand side by side on the
// same frame; the app's cut and fill heat map between the two dates carries the pile markers, the
// app's own legend and a plain-words key with the deadband; then the change in each pile as a
// diverging bar chart from the largest drawdown to the largest growth (`changeOrder`). Change is
// each pile's volume difference (founder): the heat map is a picture of where the ground moved,
// its numbers are not printed. Bars past the 24th continue on "C, continued" pages (`pagePlan`);
// the closing remarks print at the foot of the last printed page.
import type { VolumetricModel, VolumetricPile } from '@aio/project/export';
import type { HeatmapStyle, ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import { HeatLegendView, LEGEND_RANGE_M } from '../../survey/heatLegendView';
import { CUT_FILL_DEFAULT_M } from '../../survey/volumes/cutFill';
import type { PageComponent, PageContext } from '../types/template';
import { dateText, Page, signed, SitePicture, volumetricTexts } from './chrome';
import './change.css';

/** The boxes of the pictures on page C, mm. */
const PAIR_W = 89;
const PAIR_H = 50;
const HEAT_W = 112;
const HEAT_H = 78;

/**
 * The cut and fill settings the pictures were taken with, when the capture saved them on the
 * frame (`cutFill`: the "Ignore under" deadband, the legend's half span and the site's heat map
 * colours); else the app's defaults.
 */
export interface FrameCutFill {
  thresholdM: number;
  rangeM: number;
  style?: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>;
}

export function frameCutFill(frame: ReportViewsFrame | null): FrameCutFill {
  const raw = (frame as { cutFill?: Partial<FrameCutFill> } | null)?.cutFill;
  const thresholdM =
    typeof raw?.thresholdM === 'number' && raw.thresholdM >= 0
      ? raw.thresholdM
      : CUT_FILL_DEFAULT_M;
  const rangeM = typeof raw?.rangeM === 'number' && raw.rangeM > 0 ? raw.rangeM : LEGEND_RANGE_M;
  return raw?.style ? { thresholdM, rangeM, style: raw.style } : { thresholdM, rangeM };
}

const way = (c: number | null) => (c === null || c === 0 ? 'is-flat' : c < 0 ? 'is-down' : 'is-up');

/** "The yard: what moved", or "What changed" when the project names no site. */
function heading(site: string | null): string {
  const name = site?.trim();
  return name ? t('vreport.change.siteTitle', { site: name }) : t('vreport.change.title');
}

function Head({ model }: { model: VolumetricModel }): ReactElement {
  const from = model.compared ? dateText(model.compared.date) : '';
  const to = model.latest ? dateText(model.latest.date) : '';
  return (
    <div className="vr-c-head">
      <div>
        <p className="vr-c-dates">{`${from} → ${to}`}</p>
        <h1>{heading(model.project.site)}</h1>
      </div>
      <p className="vr-c-keys">
        <span>{t('vreport.change.keyBefore')}</span>
        <span>{t('vreport.change.keyAfter')}</span>
        <span className="is-change">{t('vreport.piles.change')}</span>
      </p>
    </div>
  );
}

function ChangeChart({
  model,
  rows,
}: {
  model: VolumetricModel;
  rows: readonly VolumetricPile[];
}): ReactElement {
  const most = Math.max(0, ...model.piles.map((p) => Math.abs(p.changeM3 ?? 0)));
  return (
    <div className="vr-c-chart">
      <div className="vr-c-axis" aria-hidden="true">
        <span />
        <span className="vr-c-axis-hint">
          <span>{t('vreport.change.axisLess')}</span>
          <span>{t('vreport.change.axisMore')}</span>
        </span>
        <span className="vr-c-axis-unit">m³</span>
      </div>
      {rows.map((p) => {
        const c = p.changeM3;
        const width = c !== null && most > 0 ? (Math.abs(c) / most) * 50 : 0;
        return (
          <div className="vr-c-row" key={p.id} data-pile={p.id}>
            <span className="vr-c-name">
              <span className="vr-num">{p.tag}</span>
              <span>{p.label}</span>
            </span>
            <span className="vr-c-bar">
              {c !== null && c !== 0 ? (
                <span className={`vr-c-fill ${way(c)}`} style={{ width: `${String(width)}%` }} />
              ) : null}
            </span>
            <span className={`vr-c-value ${way(c)}`}>{c !== null ? signed(c) : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Page C, or one of its "C, continued" pages. */
export function ChangePage({
  model,
  text,
  views,
  page,
  total,
}: PageContext<VolumetricModel>): ReactElement {
  const texts = volumetricTexts(model, text);
  const byId = new Map(model.piles.map((p) => [p.id, p]));
  const rows = model.changeOrder
    .slice(page.from, page.to)
    .map((id) => byId.get(id))
    .filter((p): p is VolumetricPile => p !== undefined);
  const method = t('vreport.change.heatNote');
  const closing =
    texts.closing && page.number === total ? (
      <div className="vr-c-closing">
        <h2>{t('vreport.change.closing')}</h2>
        <p>{texts.closing}</p>
      </div>
    ) : null;
  if (page.continued)
    return (
      <Page kind="change" number={page.number} by={texts.preparedBy} method={method}>
        <h2 className="vr-continued">{t('vreport.page.changeContinued')}</h2>
        <ChangeChart model={model} rows={rows} />
        {closing}
      </Page>
    );
  const frame = views.frame ?? model.frame;
  const before = model.compared;
  const after = model.latest;
  const cf = frameCutFill(frame);
  const deadband = cf.thresholdM.toFixed(2);
  return (
    <Page kind="change" number={page.number} by={texts.preparedBy} method={method}>
      <Head model={model} />
      <div className="vr-c-pair">
        {[
          { cap: before, key: 'vreport.change.before' as const },
          { cap: after, key: 'vreport.change.after' as const },
        ].map(({ cap, key }) => (
          <figure className="vr-c-shot" key={key}>
            <SitePicture
              className="vr-c-photo"
              src={cap ? views.picture('photo', cap.id) : null}
              frame={frame}
              piles={model.piles}
              boxW={PAIR_W}
              boxH={PAIR_H}
            />
            <figcaption>{t(key, { date: cap ? dateText(cap.date) : '' })}</figcaption>
          </figure>
        ))}
      </div>
      <section className="vr-c-heat">
        <h2>{t('vreport.change.heatTitle')}</h2>
        <p className="vr-c-heat-dates">
          {t('vreport.change.heat', {
            from: before ? dateText(before.date) : '',
            to: after ? dateText(after.date) : '',
          })}
        </p>
        <p className="vr-c-heat-explain">{t('vreport.change.heatExplain')}</p>
        <div className="vr-c-heat-body">
          <SitePicture
            className="vr-c-heatmap"
            src={after && before ? views.picture('cutfill', after.id, before.id) : null}
            frame={frame}
            piles={model.piles}
            boxW={HEAT_W}
            boxH={HEAT_H}
          />
          <div className="vr-c-key">
            <h3>{t('vreport.key.title')}</h3>
            <p className="vr-c-key-row is-down">{t('vreport.key.red')}</p>
            <p className="vr-c-key-row is-up">{t('vreport.key.blue')}</p>
            <p className="vr-c-key-row is-flat">{t('vreport.key.grey', { deadband })}</p>
            {before && after ? (
              <HeatLegendView
                className="vr-c-legend"
                from={before.date}
                to={after.date}
                thresholdM={cf.thresholdM}
                rangeM={cf.rangeM}
                unit="m"
                {...(cf.style ? { style: cf.style } : {})}
              />
            ) : null}
          </div>
        </div>
      </section>
      <section className="vr-c-piles">
        <h2>{t('vreport.change.chart')}</h2>
        <ChangeChart model={model} rows={rows} />
      </section>
      {closing}
    </Page>
  );
}

/** Page C's entry in the volumetric template (collected by `types/index.ts`). */
export const volumetricPage: { id: 'change'; component: PageComponent<VolumetricModel> } = {
  id: 'change',
  component: ChangePage,
};

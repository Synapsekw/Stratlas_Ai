/**
 * The coverage legend (spec D23, D23a, D26): for the view shown, every class with its name and
 * range (never colour alone), the swatch with its optional hatch, the opacity slider (in sync with
 * the Display bench row), "Show from" and the hatch switch, and the indicative and assumptions
 * line. It has no position of its own: the stage places it in a corner slot (`rfLegend`, wanting
 * `br` then `bl`), through `StageCoverageLegend.tsx`.
 */
import { OVERLAP_WINDOW_DB } from '@aio/rf';
import type { RfStudy } from '@aio/schema';
import { Switch, useT, type MessageKey, type Vars } from '@aio/ui';
import type { ReactNode } from 'react';
import {
  CLASS_HATCH,
  OVERLAP_HATCH,
  OVERLAP_RAMP,
  RSRP_CLASSES,
  RSRP_RAMP,
  SHOW_FROM,
  classShown,
  sectorColour,
  sectorHatch,
  swatchBackground,
  type Hatch,
  type RsrpClassKey,
  type ShowFrom,
} from './coverageRamp';
import { setRfLayer, useRfLayer } from './coverageDisplay';
import type { RfView } from './rfStore';
import { VIEW_KEY, assumptionsText } from './rfText';
import './rf.css';

type T = (key: MessageKey, vars?: Vars) => string;

const SHOW_FROM_KEY: Record<ShowFrom, MessageKey> = {
  all: 'rf.legend.showFrom.all',
  fair: 'rf.legend.showFrom.fair',
  good: 'rf.legend.showFrom.good',
};
const HATCH_KEY: Record<Hatch, MessageKey> = {
  none: 'rf.legend.pattern.none',
  rising: 'rf.legend.pattern.rising',
  falling: 'rf.legend.pattern.falling',
  cross: 'rf.legend.pattern.cross',
  dots: 'rf.legend.pattern.dots',
};

/** The range text of each RSRP class from the study thresholds. */
export function classRanges(t: T, th: RfStudy['thresholds']): Record<RsrpClassKey, string> {
  return {
    excellent: t('rf.results.range.above', { dbm: th.excellentDbm }),
    good: t('rf.results.range.between', { hi: th.excellentDbm, lo: th.goodDbm }),
    fair: t('rf.results.range.between', { hi: th.goodDbm, lo: th.fairDbm }),
    poor: t('rf.results.range.between', { hi: th.fairDbm, lo: th.poorDbm }),
    none: t('rf.results.range.below', { dbm: th.poorDbm }),
  };
}

export interface CoverageLegendProps {
  view: RfView;
  study: RfStudy;
  /** Sector names in sector order (the best-server colours follow this order). */
  sectors: readonly { id: string; name: string }[];
  /** What is shown: the live preview or a run (its time, as the run list shows it). */
  source: { kind: 'preview' } | { kind: 'run'; at: string } | null;
}

function Line({
  swatch,
  name,
  value,
  dim,
  testId,
}: {
  swatch: string | null;
  name: ReactNode;
  value: ReactNode;
  dim?: boolean;
  testId?: string;
}) {
  return (
    <li className="rf-legend-row" data-dim={dim ? '' : undefined} data-testid={testId}>
      <span
        className="rf-legend-sw"
        data-clear={swatch === null ? '' : undefined}
        style={swatch === null ? undefined : { background: swatch }}
        aria-hidden="true"
      />
      <span className="rf-legend-name">{name}</span>
      <span className="rf-legend-val mono">{value}</span>
    </li>
  );
}

/** The legend body; the stage gives it its corner. */
export function CoverageLegend({ view, study, sectors, source }: CoverageLegendProps) {
  const t = useT();
  const opacity = useRfLayer((s) => s.opacity);
  const hatch = useRfLayer((s) => s.hatch);
  const showFrom = useRfLayer((s) => s.showFrom);
  const pct = Math.round(opacity * 100);
  const ranges = classRanges(t, study.thresholds);

  let rows: ReactNode;
  let note: string;
  if (view === 'rsrp') {
    rows = RSRP_CLASSES.map((c) => {
      const shown = classShown(c, showFrom);
      const name = t(`rf.results.class.${c}`);
      const label =
        c === 'none'
          ? t('rf.legend.noTint', { name })
          : shown
            ? hatch && CLASS_HATCH[c] !== 'none'
              ? t('rf.legend.withPattern', { name, pattern: t(HATCH_KEY[CLASS_HATCH[c]]) })
              : name
            : t('rf.legend.hiddenClass', { name });
      return (
        <Line
          key={c}
          testId={`rf-legend-${c}`}
          swatch={c === 'none' ? null : swatchBackground(RSRP_RAMP[c], CLASS_HATCH[c], hatch)}
          name={label}
          value={ranges[c]}
          dim={c === 'none' || !shown}
        />
      );
    });
    note = t('rf.legend.rsrpNote');
  } else if (view === 'bestServer') {
    rows = sectors.map((s, i) => (
      <Line
        key={s.id}
        testId={`rf-legend-sector-${s.id}`}
        swatch={swatchBackground(sectorColour(i), sectorHatch(i), hatch)}
        name={
          hatch
            ? t('rf.legend.withPattern', { name: s.name, pattern: t(HATCH_KEY[sectorHatch(i)]) })
            : s.name
        }
        value=""
      />
    ));
    note = t('rf.legend.bestServerNote');
  } else {
    rows = (['two', 'more'] as const).map((k) => (
      <Line
        key={k}
        testId={`rf-legend-overlap-${k}`}
        swatch={swatchBackground(OVERLAP_RAMP[k], OVERLAP_HATCH[k], hatch)}
        name={
          hatch && OVERLAP_HATCH[k] !== 'none'
            ? t('rf.legend.withPattern', {
                name: t(`rf.legend.overlap.${k}`),
                pattern: t(HATCH_KEY[OVERLAP_HATCH[k]]),
              })
            : t(`rf.legend.overlap.${k}`)
        }
        value={t(`rf.legend.overlap.${k}Note`)}
      />
    ));
    note = t('rf.legend.overlapNote', { db: OVERLAP_WINDOW_DB });
  }

  return (
    <section
      className="rf-legend overlay-box"
      data-surface="dark"
      aria-label={t('rf.legend.label')}
      data-testid="rf-legend"
    >
      <header className="rf-legend-head">
        <span>{t(VIEW_KEY[view])}</span>
        {source && (
          <span className="rf-legend-src mono">
            {source.kind === 'preview'
              ? t('rf.legend.preview')
              : t('rf.legend.run', { at: source.at })}
          </span>
        )}
      </header>
      <ul className="rf-legend-rows">{rows}</ul>
      <div className="rf-legend-ctl">
        <label htmlFor="rf-legend-opacity">{t('rf.legend.opacity')}</label>
        <input
          id="rf-legend-opacity"
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          aria-valuetext={`${String(pct)}%`}
          data-testid="rf-legend-opacity"
          onChange={(e) => {
            setRfLayer({ opacity: Number(e.target.value) / 100 });
          }}
        />
        <output className="mono" htmlFor="rf-legend-opacity">
          {pct}%
        </output>
      </div>
      {view === 'rsrp' && (
        <div className="rf-legend-ctl">
          <label htmlFor="rf-legend-from">{t('rf.legend.showFrom')}</label>
          <select
            id="rf-legend-from"
            className="input"
            value={showFrom}
            onChange={(e) => {
              setRfLayer({ showFrom: e.target.value as ShowFrom });
            }}
          >
            {SHOW_FROM.map((f) => (
              <option key={f} value={f}>
                {t(SHOW_FROM_KEY[f])}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="rf-legend-ctl rf-legend-hatch">
        <Switch
          checked={hatch}
          label={t('rf.legend.hatch')}
          onChange={(on) => {
            setRfLayer({ hatch: on });
          }}
        />
        <span aria-hidden="true">{t('rf.legend.hatch')}</span>
      </div>
      <p className="rf-legend-note">{note}</p>
      <p className="rf-legend-note" data-testid="rf-legend-indicative">
        <b>{t('rf.results.indicative')}</b> {t('rf.legend.indicativeBody')}{' '}
        {assumptionsText(t, study)}
      </p>
    </section>
  );
}

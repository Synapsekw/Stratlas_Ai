/**
 * The pile panel's head (spec section 3, boards 2 and 3): "‹ Inventory" and "Pile 2 of 19" with
 * the arrows, the name, the material chip and the density, the three figures (volume on its date,
 * tonnes at the density, the change since the date before, or "first survey", or the earlier
 * date's surface still preparing), the footprint, the highest point above the base and the base
 * picker, and the status line of a figure that is not up to date.
 */
import { formatNumber, formatQuantity, fromSI, unitLabel, type NumberLocale } from '@aio/geo';
import type { BaseSpec, ComparisonItem, SurfaceRef, SurveyUnits } from '@aio/schema';
import { densityOn, sideOptions, withDensityFrom } from '@aio/survey';
import { Button, Tip, useT } from '@aio/ui';
import { useId, useMemo, useState, type ReactElement } from 'react';
import { BasePicker, DEFAULT_BASE } from '../card/BasePicker';
import { CardMenu } from '../card/CardActions';
import type { DatedSurface } from '../card/pointHistory';
import { useCompare } from '../compareStore';
import { saveSiteSettings, updateMeasurement } from '../measureStore';
import type { PileData } from './PilePanel';
import type { PileSurfaceMode } from './pileLook';
import { footprintM2, minusSigned, parseDecimal, pilePosition, usePileView } from './pileView';
import '../compare.css';

/** Density decimals as the boards write it ("1.60"). */
const DENSITY_DECIMALS = 2;

/** A number in a unit and the unit's label, apart (the tiles set the unit smaller). */
export function volumeParts(
  m3: number,
  units: SurveyUnits,
  decimals: number,
  locale: NumberLocale,
): { num: string; unit: string } {
  return {
    num: formatNumber(fromSI(m3, 'volume', units.volume), decimals, locale),
    unit: unitLabel(units.volume),
  };
}

/** Tonnes in the site's mass unit, whole. */
export function massParts(
  tonnes: number,
  units: SurveyUnits,
  locale: NumberLocale,
): { num: string; unit: string } {
  return {
    num: formatNumber(fromSI(tonnes * 1000, 'mass', units.mass), 0, locale),
    unit: unitLabel(units.mass),
  };
}

/** A percentage with the Unicode minus: "−22.5 %". */
export function pctText(pct: number, locale: NumberLocale): string {
  return `${minusSigned(formatNumber(pct, 1, locale), pct)} %`;
}

/** The base of the first comparison changed: its stored figures go stale until recomputed. */
function setBase(id: string, ref: BaseSpec | SurfaceRef): void {
  updateMeasurement(id, (x) => {
    const first = x.items[0];
    if (!first) {
      const item: ComparisonItem = {
        id: 'a',
        from: ref,
        to: { kind: 'current' },
        useDeadband: false,
      };
      return { ...x, items: [item] };
    }
    const next: ComparisonItem = { ...first, from: ref };
    return {
      ...x,
      items: [next, ...x.items.slice(1)],
      results: x.results.map((r) => (r.item === first.id ? { ...r, status: 'stale' as const } : r)),
    };
  });
}

export function PileHeader({
  data,
  order,
  dates,
  onOpen,
  onBack,
}: {
  data: PileData;
  order: readonly string[];
  dates: readonly DatedSurface[];
  onOpen: (id: string) => void;
  onBack: () => void;
}): ReactElement {
  const t = useT();
  const { m, settings, units, locale, readOnly, material, figures, line } = data;
  const pos = pilePosition(order, m.id);
  const v = (x: number) => volumeParts(x, units, settings.precision.volume, locale);
  const { current, previous } = figures;
  // the density on the figure's date (`densityOn`: a later edit leaves earlier dates alone)
  const density =
    (material && current ? densityOn(material, current.capture, data.dateOf) : null) ??
    material?.densityTPerM3;
  const tonnes =
    current?.valueM3 != null && density !== undefined ? current.valueM3 * density : null;

  // the date just before the figure's: its surface may still be preparing
  const at = current ? dates.findIndex((d) => d.capture === current.capture) : -1;
  const earlier = at > 0 ? dates[at - 1] : undefined;
  const earlierPreparing =
    earlier?.state.kind === 'preparing' && previous?.capture !== earlier.capture
      ? earlier.state.pct
      : null;

  const vs = (() => {
    if (earlier && earlierPreparing !== null)
      return {
        caption: t('pile.vs', { date: earlier.label }),
        value: null,
        note: t('surface.state.preparing', { pct: Math.round(earlierPreparing) }),
        sign: undefined,
      };
    if (previous && figures.changeM3 !== null) {
      const c = v(figures.changeM3);
      return {
        caption: t('pile.vs', { date: previous.label }),
        value: minusSigned(c.num, figures.changeM3),
        note: [
          c.unit,
          ...(figures.changePct !== null ? [pctText(figures.changePct, locale)] : []),
        ].join(' · '),
        sign: figures.changeM3 < 0 ? 'loss' : figures.changeM3 > 0 ? 'gain' : undefined,
      };
    }
    // no figure yet: its status, never "first survey"
    if (!current)
      return { caption: t('vol.change'), value: null, note: line.text, sign: undefined };
    return { caption: t('vol.change'), value: null, note: t('pile.first'), sign: undefined };
  })();

  const area = footprintM2(m.points);
  const computed = useCompare((s) => s.computed[m.id]);
  const maxHeight = useMemo(() => {
    const first = m.items[0];
    const grid = computed?.heat.find((g) => g.item === first?.id);
    if (!grid) return null;
    let best = -Infinity;
    for (const dz of grid.dz) if (Number.isFinite(dz) && dz > best) best = dz;
    return Number.isFinite(best) && best > 0 ? best : null;
  }, [computed, m.items]);

  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const capture = m.scope.kind === 'survey' ? m.scope.capture : undefined;
  const options = useMemo(
    () =>
      sideOptions({ surfaces, captures, designs, ...(capture !== undefined ? { capture } : {}) }),
    [surfaces, captures, designs, capture],
  );

  return (
    <header className="pp-head">
      <div className="pp-top">
        <button type="button" className="pp-back" data-testid="pile-back" onClick={onBack}>
          {t('pile.back')}
        </button>
        {pos && (
          <span className="pp-pos">
            <span data-testid="pile-position">
              {t('pile.position', { n: pos.n, total: pos.total })}
            </span>
            <Button
              variant="icon"
              icon="back"
              aria-label={t('pile.prev')}
              disabled={pos.prev === null}
              data-testid="pile-prev"
              onClick={() => {
                if (pos.prev !== null) onOpen(pos.prev);
              }}
            />
            <Button
              variant="icon"
              icon="fwd"
              aria-label={t('pile.next')}
              disabled={pos.next === null}
              data-testid="pile-next"
              onClick={() => {
                if (pos.next !== null) onOpen(pos.next);
              }}
            />
          </span>
        )}
      </div>

      <div className="pp-title">
        <h2 className="pp-name" data-testid="pile-name">
          {m.label}
        </h2>
        <MaterialChip data={data} />
        {/* the density and the menu wrap together, never the "⋯" alone on a line */}
        <span className="pp-end">
          <DensityField data={data} />
          {/* the card's "⋯": the measurement's right-click actions (rename, colour, fly to, …) */}
          <span className="pp-menu">
            <CardMenu id={m.id} />
          </span>
        </span>
      </div>

      <div className="pp-kpi" data-testid="pile-kpi">
        <div className="pp-tile" data-testid="pile-kpi-volume">
          <span className="pp-cap">{t('pile.volume')}</span>
          {current?.valueM3 != null ? (
            <>
              <b>
                {v(current.valueM3).num} <small>{v(current.valueM3).unit}</small>
              </b>
              <em>{current.label}</em>
            </>
          ) : (
            <em>{line.text}</em>
          )}
        </div>
        <div className="pp-tile" data-testid="pile-kpi-tonnes">
          <span className="pp-cap">{t('pile.tonnes')}</span>
          {tonnes !== null && density !== undefined ? (
            <>
              <b>
                {massParts(tonnes, units, locale).num}{' '}
                <small>{massParts(tonnes, units, locale).unit}</small>
              </b>
              <em>
                {t('pile.atDensity', { density: formatNumber(density, DENSITY_DECIMALS, locale) })}
              </em>
            </>
          ) : (
            <em>{material ? line.text : t('pile.pickMaterial')}</em>
          )}
        </div>
        <div className="pp-tile" data-testid="pile-kpi-vs" data-sign={vs.sign}>
          <span className="pp-cap">{vs.caption}</span>
          {vs.value !== null && <b className="pp-change">{vs.value}</b>}
          <em className={vs.value !== null ? 'pp-change' : undefined}>{vs.note}</em>
        </div>
      </div>

      {line.tone !== 'ok' && (
        <p
          className="vd-status pp-status"
          data-tone={line.tone}
          data-testid="pile-status"
          role="status"
        >
          <span className="vd-dot" aria-hidden="true" />
          {line.text}
        </p>
      )}

      <dl className="pp-facts" data-testid="pile-facts">
        <div data-testid="pile-footprint">
          <dt className="pp-cap">{t('pile.footprint')}</dt>
          <dd>{formatQuantity(area, 'area', units, settings.precision, locale)}</dd>
        </div>
        {maxHeight !== null && (
          <div data-testid="pile-max-height">
            <dt className="pp-cap">{t('pile.maxHeight')}</dt>
            <dd>{formatQuantity(maxHeight, 'distance', units, settings.precision, locale)}</dd>
          </div>
        )}
        <div className="pp-base">
          <dt className="pp-cap">{t('pile.base')}</dt>
          <dd>
            <BasePicker
              value={m.items[0]?.from ?? DEFAULT_BASE}
              surfaces={options}
              readOnly={readOnly}
              m={m}
              onChange={(ref) => {
                setBase(m.id, ref);
              }}
            />
          </dd>
        </div>
        <SurfaceFact />
      </dl>
    </header>
  );
}

/**
 * How the opened pile's top shows in 3D (founder, 26 Oct 2026): solid red, or coloured by its
 * height above the base with a legend in the view. A view choice for the session.
 */
function SurfaceFact(): ReactElement {
  const t = useT();
  const surface = usePileView((s) => s.surface);
  const setSurface = usePileView((s) => s.setSurface);
  const modes: { id: PileSurfaceMode; label: string }[] = [
    { id: 'solid', label: t('pile.surface.solid') },
    { id: 'height', label: t('pile.surface.height') },
  ];
  return (
    <div className="pp-look">
      <dt className="pp-cap">{t('pile.surface')}</dt>
      <dd>
        <div
          className="seg"
          role="group"
          aria-label={t('pile.surface.aria')}
          data-testid="pile-surface"
        >
          {modes.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={surface === o.id}
              data-testid={`pile-surface-${o.id}`}
              onClick={() => {
                setSurface(o.id);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </dd>
    </div>
  );
}

/** The pile's material as a chip: the site materials and "No material". */
function MaterialChip({ data }: { data: PileData }): ReactElement {
  const t = useT();
  const { m, settings, readOnly, material } = data;
  // a kit pile without a site material is weighed by the kit's (`pileMaterial`), named here
  const kitOnly = !m.material && material !== null;
  return (
    <label className="pc-chip pp-material" data-on="">
      <span className="pp-swatch" aria-hidden="true" data-none={material ? undefined : ''} />
      <select
        className="vd-select"
        aria-label={t('vol.card.material')}
        value={m.material ?? ''}
        disabled={readOnly}
        data-testid="pile-material"
        onChange={(e) => {
          const id = e.target.value;
          updateMeasurement(m.id, (x) => {
            const next = { ...x };
            if (id) next.material = id;
            else delete next.material;
            return next;
          });
        }}
      >
        <option value="">{kitOnly ? material.name : t('pile.noMaterial')}</option>
        {settings.materials.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The material's density, written to the site materials when the field is left (Stage C dates it
 * from the date in focus). Without a site material there is nothing to write: disabled, with why.
 */
function DensityField({ data }: { data: PileData }): ReactElement {
  const t = useT();
  const whyId = useId();
  const { m, settings, readOnly, material, locale, dateOf, densityFrom, earliest } = data;
  const own = m.material ? settings.materials.find((x) => x.id === m.material) : undefined;
  // the density on the date an edit applies from (the date in focus)
  const at =
    material && densityFrom !== null
      ? densityOn(material, densityFrom, dateOf)
      : (material?.densityTPerM3 ?? null);
  // written as the tonnes tile writes it ("1.60"), and read back the same way
  const shown = at !== null ? formatNumber(at, DENSITY_DECIMALS, locale) : '';
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = readOnly || !own;
  const commit = () => {
    if (text === null || !own) return;
    const value = parseDecimal(text, locale);
    setText(null);
    if (value === null || value <= 0 || value === at) return;
    // dated from the date in focus: that date and later ones take it, earlier ones keep theirs
    const next =
      densityFrom !== null
        ? withDensityFrom(own, densityFrom, value, earliest ?? densityFrom, dateOf)
        : { ...own, densityTPerM3: value };
    const materials = settings.materials.map((x) => (x.id === own.id ? next : x));
    void saveSiteSettings({ ...settings, materials }).then(setError);
  };
  const field = (
    <label className="pp-density">
      <span>{t('pile.density')}</span>
      <input
        className="sv-input mono"
        inputMode="decimal"
        aria-label={t('pile.densityAria')}
        aria-describedby={!own ? whyId : undefined}
        value={text ?? shown}
        disabled={disabled}
        data-testid="pile-density"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape' && text !== null) {
            e.preventDefault();
            setText(null);
          }
        }}
      />
      <span className="pp-unit">{t('pile.densityUnit')}</span>
      {!own && (
        <span id={whyId} className="sr-only" data-testid="pile-density-why">
          {t('pile.pickMaterial')}
        </span>
      )}
    </label>
  );
  return (
    <>
      {own ? field : <Tip content={t('pile.pickMaterial')}>{field}</Tip>}
      {error && (
        <p className="notice warn small pp-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

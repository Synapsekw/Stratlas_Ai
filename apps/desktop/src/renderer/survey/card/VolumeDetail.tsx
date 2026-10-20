/**
 * The volume card's detail (volumetric parity W3 and W4), in plain words: per comparison the base
 * chip (`BasePicker`), the surface it is measured against, one status line, the figures and how
 * they were worked out; then the spread across bases, a figure carried from an earlier version
 * with "Recompute with the standard base" (and "was" once accepted), and the volume over time as
 * a chart and a table. Volumes come from the survey engine (`compareStore.ts`).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatQuantity, fromSI, localeOf, toSI, unitLabel } from '@aio/geo';
import type { ComparisonItem, ComparisonResult, SurfaceRef, SurveyMeasurement } from '@aio/schema';
import {
  deadbandFromStops,
  defaultItem,
  effectiveUnits,
  isBase,
  isTerrain,
  itemProblem,
  newItemId,
  seriesApplies,
  sideKey,
  sideOptions,
  sideFor,
  swapItem,
  volumeRows,
  type SideOption,
  type TimeRow,
} from '@aio/survey';
import { Button, EmptyState, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { TimeChart } from '../../charts/TimeChart';
import {
  compute,
  computeSeries,
  isStale,
  prepareParams,
  prepareSurfaces,
  recomputeStandard,
  seriesStale,
  useCompare,
  useSpread,
} from '../compareStore';
import type { ItemShare } from '../engineProtocol';
import { updateMeasurement, useMeasure } from '../measureStore';
import { BasePicker, baseName, DEFAULT_BASE, missingName, optionLabel } from './BasePicker';
import '../../charts/charts.css';
import '../compare.css';

/** The most comparisons one measurement holds (`SurveyMeasurement.items`). */
const MAX_ITEMS = 20;
/** The largest "Ignore changes smaller than" the schema takes, metres. */
const MAX_IGNORE_M = 10;

export interface StatusLine {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/**
 * The one status line of a comparison: why it cannot run, a figure carried from an earlier
 * version (never stale), live, computing, not computed, absent on the latest date, refused, stale,
 * partly outside the survey, or up to date.
 */
export function volumeStatusLine(
  r: ComparisonResult | undefined,
  state: {
    computing: boolean;
    live: boolean;
    stale: boolean;
    /** No result, but figures on earlier dates: the pile is absent on the latest one (R16). */
    absent?: boolean;
    /** Why the last Recompute could not run, or the engine's problem. */
    problem?: string | null;
    /** A neutral note (preparing found nothing left to prepare). */
    info?: string | null;
    /** The volume over time could not be worked out (after refused and stale). */
    seriesFailed?: boolean;
  },
): StatusLine {
  if (state.problem) return { tone: 'warn', text: state.problem };
  if (state.info) return { tone: 'muted', text: state.info };
  if (r?.carried) return { tone: 'muted', text: t('vol.status.carried', { base: r.carried.base }) };
  if (state.live) return { tone: 'muted', text: t('vol.status.live') };
  if (state.computing) return { tone: 'muted', text: t('vol.status.computing') };
  if (!r)
    return state.absent
      ? { tone: 'warn', text: t('vol.status.none') }
      : state.seriesFailed
        ? { tone: 'warn', text: t('vol.card.seriesFailed') }
        : { tone: 'muted', text: t('vol.status.notComputed') };
  if (r.status === 'refused')
    return {
      tone: 'warn',
      text: r.reason ? t('vol.card.refusedWhy', { reason: r.reason }) : t('vol.status.refused'),
    };
  if (state.stale || r.status === 'stale') return { tone: 'warn', text: t('vol.status.stale') };
  if (state.seriesFailed) return { tone: 'warn', text: t('vol.card.seriesFailed') };
  if (r.status === 'partial')
    return {
      tone: 'warn',
      text: r.reason ? t('vol.card.partlyWhy', { reason: r.reason }) : t('vol.status.partial'),
    };
  return { tone: 'ok', text: t('vol.status.ok') };
}

/** A new volume's comparison: the default base (Triangulated toe) under the current survey. */
export function volumeItem(taken: readonly { id: string }[]): ComparisonItem {
  return { id: newItemId(taken), from: DEFAULT_BASE, to: { kind: 'current' }, useDeadband: false };
}

/** A per-date row's date (R16): the `to` capture, else the `from` one. */
const rowDate = (r: ComparisonResult): string | undefined => r.toCapture ?? r.fromCapture;

/**
 * The item's figures over time, keyed by their date. Its stored figure is always the one for its
 * own date, stale or not, so the card never shows two numbers for one date; `stored` is that row
 * (to mark it stale with the figures).
 */
export function itemSeries(
  m: SurveyMeasurement,
  item: string,
): { series: ComparisonResult[]; stored: ComparisonResult | undefined } {
  const keyed = (r: ComparisonResult) => {
    const d = rowDate(r);
    return d !== undefined && r.toCapture === undefined ? { ...r, toCapture: d } : r;
  };
  const series = (m.series ?? []).filter((r) => r.item === item).map(keyed);
  const found = m.results.find((r) => r.item === item);
  const date = found ? rowDate(found) : undefined;
  if (!found || date === undefined) return { series, stored: undefined };
  const stored = keyed(found);
  return { series: [...series.filter((r) => r.toCapture !== date), stored], stored };
}

export function VolumeDetail({ m }: { m: SurveyMeasurement }): ReactElement {
  const t = useT();
  const fileReadOnly = useMeasure((s) => s.readOnly);
  const readOnly = useAnnotateReadOnly() || fileReadOnly;
  const settings = useMeasure((s) => s.settings);
  const status = useCompare((s) => s.status);
  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const computed = useCompare((s) => s.computed[m.id]);
  const running = useCompare((s) => s.running[m.id] === true);
  const engineProblem = useCompare((s) => s.problems[m.id]);
  const current = useCompare((s) => s.current);
  const preparing = useCompare((s) => s.preparing);
  const engineError = useCompare((s) => s.error);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const spread = useSpread(m.id);
  // why the last Recompute could not run (said in the status line, never silent)
  const [why, setWhy] = useState<string | null>(null);
  // what preparing the surfaces said: a failure warns, "nothing left to prepare" is neutral
  const [note, setNote] = useState<StatusLine | null>(null);
  // the series inputs a volume-over-time run failed for (never swallowed); other inputs clear it
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const units = effectiveUnits(settings.units, m.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const capture = m.scope.kind === 'survey' ? m.scope.capture : undefined;
  const options = useMemo(
    () =>
      sideOptions({
        surfaces,
        captures,
        designs,
        ...(capture !== undefined ? { capture } : {}),
      }),
    [surfaces, captures, designs, capture],
  );
  const stopsDeadband = deadbandFromStops(settings.heatmap.stops);
  const first = m.items[0];
  const carriedFirst =
    first !== undefined &&
    (m.results.some((r) => r.item === first.id && r.carried !== undefined) ||
      (m.series ?? []).some((r) => r.item === first.id && r.carried !== undefined));
  // the volume per survey date, worked out when shown (a carried pile keeps the kit's history)
  const points = m.points;
  // what a series run is for: the item, the outline (its edits move updatedAt) and the dates
  const seriesKey = [
    m.id,
    JSON.stringify(first ?? null),
    String(points.length),
    m.updatedAt ?? m.createdAt,
    String(captures.length),
  ].join('|');
  useEffect(() => {
    if (status !== 'ready' || readOnly || !first || carriedFirst) return;
    if (!seriesApplies(first) || points.length < 3 || captures.length === 0) return;
    let gone = false;
    computeSeries(m.id).then(
      () => {
        if (!gone) setFailedFor(null);
      },
      (e: unknown) => {
        // the renderer's console is the app's log; the card says it in plain words
        console.warn(`The volume over time of ${m.id} could not be worked out`, e);
        if (!gone) setFailedFor(seriesKey);
      },
    );
    return () => {
      gone = true;
    };
  }, [m.id, status, readOnly, first, carriedFirst, points, captures.length, seriesKey]);
  // cleared once the item stops running series (carried, read-only) or its inputs change
  const seriesFailed = failedFor === seriesKey && !carriedFirst && !readOnly;
  // "the engine is still starting" and the like no longer hold once it is ready
  const [seenStatus, setSeenStatus] = useState(status);
  if (seenStatus !== status) {
    setSeenStatus(status);
    if (status === 'ready') setWhy(null);
  }

  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);
  const signed = (x: number) => `${x > 0 ? '+' : ''}${v(x)}`;
  const writable = !readOnly;
  const haveSurfaces = surfaces.length > 0;

  /** Why a Recompute cannot run now, or null. */
  const blocked = (): string | null =>
    status !== 'ready'
      ? t('vol.card.engineStarting')
      : m.points.length < 3
        ? t('vol.card.needPoints')
        : null;

  const setItems = (items: ComparisonItem[]) => {
    updateMeasurement(m.id, (x) => {
      // the label is not an input of the result
      const key = (it: ComparisonItem) => JSON.stringify({ ...it, label: undefined });
      const before = new Map(x.items.map((it) => [it.id, key(it)]));
      return {
        ...x,
        items,
        // results of removed items go; a changed item's result is stale until recomputed
        results: x.results.flatMap((r) => {
          const it = items.find((y) => y.id === r.item);
          if (!it) return [];
          return before.get(it.id) === key(it) ? [r] : [{ ...r, status: 'stale' as const }];
        }),
      };
    });
  };
  const patchItem = (id: string, next: ComparisonItem) => {
    setItems(m.items.map((it) => (it.id === id ? next : it)));
  };

  const recompute = () => {
    const reason = blocked();
    setWhy(reason);
    setFailedFor(null);
    if (reason) return;
    // a new volume has no comparison yet: the default base, then compute
    if (m.items.length === 0)
      updateMeasurement(m.id, (x) =>
        x.items.length > 0 ? x : { ...x, items: [volumeItem(x.items)] },
      );
    void compute(m.id);
  };
  const recomputeWithStandard = () => {
    const reason = blocked();
    setWhy(reason);
    if (reason) return;
    void recomputeStandard(m.id).then(setWhy);
  };

  const live = computed?.live ? computed : null;
  const previous = m.previousResults?.[0];
  const material = settings.materials.find((x) => x.id === m.material) ?? null;
  const density = material?.densityTPerM3;
  const over = first ? itemSeries(m, first.id) : { series: [], stored: undefined };
  const storedRow = over.stored;
  // the stored figure's row is stale exactly when its figures are
  const storedStale =
    storedRow !== undefined && (storedRow.status === 'stale' || isStale({ current }, m, storedRow));
  const rows = first
    ? volumeRows(over.series, captures, {
        ...(density !== undefined ? { densityTPerM3: density } : {}),
        isStale: (r) => (r === storedRow ? storedStale : seriesStale(m, r)),
      })
    : [];
  // null outside the spread bases and while the item is carried (`spreadItem`, R16)
  const spreadValue = spread !== null && spread !== 'computing' ? spread : null;
  // one status line: why a Recompute cannot run, the series or preparing failed, the engine
  const problem =
    why ?? (note?.tone === 'warn' ? note.text : null) ?? engineError ?? engineProblem ?? null;
  const info = note?.tone === 'muted' ? note.text : null;

  const recomputeButton = writable && haveSurfaces && !carriedFirst && (
    <Button
      variant="quiet"
      icon="refresh"
      busy={running}
      data-testid="survey-recompute"
      onClick={recompute}
    >
      {t('vol.card.recompute')}
    </Button>
  );
  const compareDate = writable && m.items.length < MAX_ITEMS && (
    <button
      type="button"
      className="pc-chip-add"
      data-testid="survey-add-comparison"
      onClick={() => {
        setItems([...m.items, defaultItem(m.items, stopsDeadband)]);
      }}
    >
      {t('vol.card.compareDate')}
    </button>
  );

  const emptyState = status === 'ready' && !haveSurfaces && m.results.length === 0;
  const prepareButton = (
    <Button
      variant="secondary"
      busy={preparing !== null}
      data-testid="survey-prepare"
      onClick={() => {
        if (!manifest) return;
        // nothing left to prepare is not a failure
        const nothingLeft = prepareParams(manifest, surfaces) === null;
        void prepareSurfaces(manifest).then((text) => {
          setNote(text === null ? null : { tone: nothingLeft ? 'muted' : 'warn', text });
        });
      }}
    >
      {t('empty.survey.prepare')}
    </Button>
  );
  const canPrepare = status === 'ready' && !haveSurfaces && writable && manifest !== null;
  // without surfaces, carried and stale figures reach Recompute through Prepare surfaces
  const prepareInRow = canPrepare && !emptyState ? prepareButton : null;

  return (
    <div className="vd" data-testid="volume-detail">
      {emptyState && (
        <EmptyState
          icon="layers"
          title={t('empty.survey.noSurface.title')}
          body={t('empty.survey.noSurface.hint')}
          action={canPrepare ? prepareButton : undefined}
        />
      )}

      {m.items.length === 0 ? (
        <div className="vd-item" data-testid="vol-new-item">
          <StatusRow
            line={volumeStatusLine(undefined, {
              computing: running,
              live: false,
              stale: false,
              problem,
              info,
            })}
          >
            {recomputeButton}
            {prepareInRow}
          </StatusRow>
          <div className="pc-chips vd-chips">
            <BasePicker
              value={DEFAULT_BASE}
              surfaces={options}
              readOnly={readOnly}
              m={m}
              onChange={(ref) => {
                setItems([{ ...volumeItem([]), from: ref }]);
              }}
            />
            {compareDate}
          </div>
        </div>
      ) : (
        <ol className="vd-items">
          {m.items.map((it, k) => {
            const stored = m.results.find((r) => r.item === it.id);
            // a heat-only run never stands in for a carried figure (Task 10 ruling)
            const shown = live?.results.find((r) => r.item === it.id) ?? stored;
            const stale = !live && stored !== undefined && isStale({ current }, m, stored);
            // the share of the numbers shown (not of an older computation)
            const fromRun = computed?.results.find((r) => r.item === it.id);
            const share =
              shown && fromRun?.fingerprint === shown.fingerprint
                ? (computed?.shares.find((x) => x.item === it.id) ?? null)
                : null;
            const carriedSeries = (m.series ?? []).some(
              (r) => r.item === it.id && r.carried !== undefined,
            );
            const lead = k === 0;
            const carried = stored?.carried !== undefined || carriedSeries;
            return (
              <ItemBlock
                key={it.id}
                index={k}
                count={m.items.length}
                m={m}
                item={it}
                options={options}
                result={shown}
                stale={stale}
                share={share}
                line={volumeStatusLine(shown, {
                  computing: running,
                  live: live !== null,
                  stale,
                  absent: !shown && carriedSeries,
                  problem: lead ? problem : null,
                  info: lead ? info : null,
                  seriesFailed: lead && seriesFailed,
                })}
                readOnly={readOnly}
                carried={carried}
                onChange={(next) => {
                  patchItem(it.id, next);
                }}
                onRemove={() => {
                  setItems(m.items.filter((x) => x.id !== it.id));
                }}
                statusExtra={
                  lead ? (
                    <>
                      {previous && (
                        <span className="vd-was" data-testid="vol-was">
                          {t('mcard.was', { value: v(previous.netM3) })}
                        </span>
                      )}
                      {recomputeButton}
                      {prepareInRow}
                    </>
                  ) : null
                }
                above={
                  lead ? (
                    <>
                      {spreadValue && (
                        <p className="vd-spread" data-testid="vol-spread">
                          {t('mcard.spread', {
                            pct: formatQuantity(
                              spreadValue.pct / 100,
                              'grade',
                              'percent',
                              1,
                              locale,
                            ),
                          })}
                        </p>
                      )}
                      {(stored?.carried !== undefined || (!stored && carriedSeries)) &&
                        writable &&
                        haveSurfaces && (
                          <Button
                            variant="secondary"
                            icon="refresh"
                            busy={running}
                            className="vd-standard"
                            data-testid="vol-recompute-standard"
                            onClick={recomputeWithStandard}
                          >
                            {t('mcard.recomputeStandard')}
                          </Button>
                        )}
                    </>
                  ) : null
                }
                chipsExtra={k === m.items.length - 1 ? compareDate : null}
              />
            );
          })}
        </ol>
      )}

      {rows.some((r) => r.valueM3 !== null) && (
        <OverTime rows={rows} m={m} tonnage={density !== undefined} signed={signed} v={v} />
      )}
      {(material !== null || rows.some((r) => r.latest && r.changeM3 !== null)) && (
        <Facts rows={rows} material={material?.name ?? null} signed={signed} />
      )}
    </div>
  );
}

function StatusRow({ line, children }: { line: StatusLine; children?: ReactNode }) {
  return (
    <div className="vd-status-row">
      <p className="vd-status" data-tone={line.tone} data-testid="survey-cmp-status" role="status">
        <span className="vd-dot" aria-hidden="true" />
        {line.text}
      </p>
      {children}
    </div>
  );
}

function ItemBlock({
  index,
  count,
  m,
  item,
  options,
  result,
  stale,
  share,
  line,
  readOnly,
  carried,
  onChange,
  onRemove,
  statusExtra,
  above,
  chipsExtra,
}: {
  index: number;
  count: number;
  m: SurveyMeasurement;
  item: ComparisonItem;
  options: SideOption[];
  result: ComparisonResult | undefined;
  /** The stored figure no longer matches its inputs (marked with the status line). */
  stale: boolean;
  share: ItemShare | null;
  line: StatusLine;
  readOnly: boolean;
  /** A figure carried from an earlier version: changing how it is worked out waits for accepting. */
  carried: boolean;
  onChange: (next: ComparisonItem) => void;
  onRemove: () => void;
  statusExtra: ReactNode;
  above: ReactNode;
  chipsExtra: ReactNode;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const n = index + 1;
  const name = item.label ?? t('vol.card.comparisonN', { n });
  const setSide = (side: 'from' | 'to', ref: SurfaceRef) => {
    const other = side === 'from' ? 'to' : 'from';
    const next: ComparisonItem = { ...item, [side]: ref };
    // a base is sampled on the other side: never a base on both
    if (isBase(ref) && isBase(next[other])) next[other] = { kind: 'current' };
    onChange(next);
  };
  // a pile on a base under the current survey reads "Base: ..." alone; anything else shows To
  const showTo = !(isBase(item.from) && item.to.kind === 'current');
  const noTerrain = !isTerrain(item.from) && !isTerrain(item.to);
  const bad = itemProblem(item) !== null;
  const shownLine: StatusLine = bad
    ? { tone: 'warn', text: t('vol.card.bothBases') }
    : noTerrain && line.tone !== 'warn'
      ? { tone: 'warn', text: t('vol.card.noTerrain') }
      : line;
  return (
    <li className="vd-item" data-testid="survey-cmp-item" data-item={item.id}>
      {count > 1 && (
        <div className="vd-name-row">
          <input
            className="sv-input vd-name"
            aria-label={name}
            placeholder={t('vol.card.comparisonN', { n })}
            value={item.label ?? ''}
            readOnly={readOnly}
            onChange={(e) => {
              const label = e.target.value.slice(0, 120);
              const next: ComparisonItem = { ...item };
              if (label) next.label = label;
              else delete next.label;
              onChange(next);
            }}
          />
          {!readOnly && (
            <Button
              variant="icon"
              icon="x"
              aria-label={t('review.remove', { name })}
              onClick={onRemove}
            />
          )}
        </div>
      )}
      <StatusRow line={shownLine}>{statusExtra}</StatusRow>
      {above}
      <div className="pc-chips vd-chips">
        <BasePicker
          value={item.from}
          surfaces={options}
          readOnly={readOnly}
          m={m}
          onChange={(ref) => {
            setSide('from', ref);
          }}
        />
        {showTo && (
          <>
            <ToChip
              value={item.to}
              options={options}
              disabled={readOnly}
              onChange={(o) => {
                setSide('to', sideFor(o, m.points, item.to));
              }}
            />
            <Button
              variant="icon"
              icon="updown"
              aria-label={t('vol.card.swap')}
              tip={t('vol.card.swap')}
              disabled={readOnly}
              data-testid="survey-swap"
              onClick={() => {
                onChange(swapItem(item));
              }}
            />
          </>
        )}
        {chipsExtra}
      </div>
      {result && result.status !== 'refused' && (
        <Figures result={result} stale={stale} share={share} units={units} />
      )}
      <IgnoreRow item={item} m={m} readOnly={readOnly} carried={carried} onChange={onChange} />
    </li>
  );
}

/** What the comparison is measured against, as a chip holding the survey and design picker. */
function ToChip({
  value,
  options,
  disabled,
  onChange,
}: {
  value: SurfaceRef;
  options: SideOption[];
  disabled: boolean;
  onChange: (o: SideOption) => void;
}) {
  const t = useT();
  const key = sideKey(value);
  const surveys = options.filter((o) => o.group === 'Surveys');
  const designs = options.filter((o) => o.group === 'Designs');
  const known = surveys.some((o) => o.key === key) || designs.some((o) => o.key === key);
  return (
    <label className="pc-chip vd-to" data-on="">
      <span className="vd-to-name">{t('vol.card.toChip')}</span>
      <select
        className="vd-select"
        value={key}
        disabled={disabled}
        data-testid="survey-to"
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) onChange(o);
        }}
      >
        {!known && (
          <option value={key}>
            {isBase(value) ? baseName(value, options, t) : missingName(value, t)}
          </option>
        )}
        {surveys.length > 0 && (
          <optgroup label={t('chart.group.surveys')}>
            {surveys.map((o) => (
              <option key={o.key} value={o.key}>
                {optionLabel(o)}
              </option>
            ))}
          </optgroup>
        )}
        {designs.length > 0 && (
          <optgroup label={t('chart.group.designs')}>
            {designs.map((o) => (
              <option key={o.key} value={o.key}>
                {optionLabel(o)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Cut, fill, net and total, their areas, and how they were worked out (not for a carried figure). */
function Figures({
  result,
  stale,
  share,
  units,
}: {
  result: ComparisonResult;
  stale: boolean;
  share: ItemShare | null;
  units: ReturnType<typeof effectiveUnits>;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const locale = settings.locale ?? localeOf(units.distance);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);
  const a = (x: number) => formatQuantity(x, 'area', units, settings.precision, locale);
  const d = (x: number) => formatQuantity(x, 'distance', units, settings.precision, locale);
  // a figure carried from an earlier version has no area split and no method of its own (R16)
  const carried = result.carried !== undefined;
  const row = (key: string, label: string, volume: number, area: string | null) => (
    <tr data-key={key}>
      <th scope="row">{label}</th>
      <td className="vd-num">{v(volume)}</td>
      {!carried && <td className="vd-area">{area ?? ''}</td>}
    </tr>
  );
  const method = [
    ...(result.usedDeadband ? [`${t('vol.ignoreSmaller')} ${d(result.deadbandM)}`] : []),
    result.cellM > 0 ? t('vol.gridCell', { cell: d(result.cellM) }) : t('vol.highPrecision'),
  ].join(' · ');
  return (
    <>
      <table
        className="vd-res"
        data-testid="survey-cmp-result"
        data-stale={stale || result.status === 'stale' ? '' : undefined}
      >
        <caption className="sr-only">{t('chart.volume')}</caption>
        <tbody>
          {row('cut', t('vol.detail.cut'), result.cutM3, a(result.areaCutM2))}
          {row('fill', t('vol.detail.fill'), result.fillM3, a(result.areaFillM2))}
          {row(
            'net',
            t('vol.detail.net'),
            result.netM3,
            result.areaUnchangedM2 > 0
              ? t('vol.card.unchanged', { area: a(result.areaUnchangedM2) })
              : null,
          )}
          {row('total', t('vol.card.total'), result.totalM3, a(result.areaM2))}
          {result.uncoveredM2 > 0 && (
            <tr data-key="uncovered">
              <th scope="row">{t('mcard.noData')}</th>
              <td className="vd-num" colSpan={carried ? 1 : 2}>
                {a(result.uncoveredM2)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!carried && (
        <p className="vd-method" data-testid="vol-method">
          {method}
        </p>
      )}
      {share && share.share.areaM2 > 0 && (
        <p
          className="vd-share"
          data-testid="survey-cmp-share"
          data-share={share.share.share}
          data-tolerance={share.toleranceM}
        >
          {t('vol.card.inTolerance', {
            pct: formatQuantity(share.share.share, 'grade', 'percent', 1, locale),
            tol: d(share.toleranceM),
            inside: a(share.share.inToleranceM2),
            area: a(share.share.areaM2),
          })}
        </p>
      )}
    </>
  );
}

/** "Ignore changes smaller than [0.05] m": the switch and its height. */
function IgnoreRow({
  item,
  m,
  readOnly,
  carried,
  onChange,
}: {
  item: ComparisonItem;
  m: SurveyMeasurement;
  readOnly: boolean;
  /** Carried: read-only, so editing it never accepts the standard base by accident. */
  carried: boolean;
  onChange: (next: ComparisonItem) => void;
}) {
  const locked = readOnly || carried;
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const unit = effectiveUnits(settings.units, m.units).distance;
  const ignore = item.deadbandM ?? deadbandFromStops(settings.heatmap.stops);
  return (
    <div className="vd-ignore">
      <label className="sv-check">
        <input
          type="checkbox"
          checked={item.useDeadband}
          disabled={locked}
          data-testid="survey-use-deadband"
          onChange={(e) => {
            onChange({ ...item, useDeadband: e.target.checked, deadbandM: ignore });
          }}
        />
        {t('vol.ignoreSmaller')}
      </label>
      <input
        className="sv-input mono vd-ignore-value"
        type="number"
        step="0.01"
        min={0}
        aria-label={`${t('vol.ignoreSmaller')} (${unitLabel(unit)})`}
        value={Number(fromSI(ignore, 'distance', unit).toFixed(4))}
        readOnly={locked}
        data-testid="survey-deadband"
        onChange={(e) => {
          const x = Number(e.target.value);
          if (!Number.isFinite(x) || x < 0) return;
          const si = toSI(x, 'distance', unit);
          if (si > MAX_IGNORE_M) return;
          onChange({ ...item, deadbandM: si });
        }}
      />
      <span className="vd-unit">{unitLabel(unit)}</span>
      {carried && !readOnly && (
        <span className="vd-ignore-hint" data-testid="vol-ignore-carried">
          {t('vol.card.ignoreCarried')}
        </span>
      )}
    </div>
  );
}

/** The volume per survey date: the chart, then the table (the latest date highlighted). */
function OverTime({
  rows,
  m,
  tonnage,
  signed,
  v,
}: {
  rows: readonly TimeRow[];
  m: SurveyMeasurement;
  tonnage: boolean;
  signed: (x: number) => string;
  v: (x: number) => string;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const mass = (x: number) => formatQuantity(x, 'mass', units, settings.precision, locale);
  return (
    <section className="vd-time" aria-label={t('vol.overTime')}>
      <h4 className="vd-sub">{t('vol.overTime')}</h4>
      <TimeChart data={{ kind: 'volume', rows }} units={units} precision={settings.precision} />
      <table className="vd-time-table" data-testid="vol-time-table">
        <caption className="sr-only">{t('vol.card.overTimeTable')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.date')}</th>
            <th scope="col">{t('chart.volume')}</th>
            <th scope="col">{t('vol.change')}</th>
            {tonnage && <th scope="col">{t('vol.tonnage')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.capture}
              data-latest={r.latest ? '' : undefined}
              data-stale={r.stale ? '' : undefined}
              aria-current={r.latest ? 'date' : undefined}
            >
              <th scope="row">{r.label}</th>
              <td>{r.valueM3 !== null ? v(r.valueM3) : t('mcard.noData')}</td>
              <td>{r.changeM3 !== null ? signed(r.changeM3) : ''}</td>
              {tonnage && <td>{r.tonnes !== null ? mass(r.tonnes) : ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The detail rows under the chart: the change since the date before, and the material. */
function Facts({
  rows,
  material,
  signed,
}: {
  rows: readonly TimeRow[];
  material: string | null;
  signed: (x: number) => string;
}) {
  const t = useT();
  const at = rows.findIndex((r) => r.latest);
  const latest = rows[at];
  const before = rows.slice(0, Math.max(0, at)).findLast((r) => r.valueM3 !== null);
  return (
    <dl className="vd-facts">
      {latest?.changeM3 != null && before && (
        <div data-testid="vol-since">
          <dt>{t('vol.card.since', { date: before.label })}</dt>
          <dd>{signed(latest.changeM3)}</dd>
        </div>
      )}
      {material && (
        <div data-testid="vol-material">
          <dt>{t('vol.card.material')}</dt>
          <dd>{material}</dd>
        </div>
      )}
    </dl>
  );
}

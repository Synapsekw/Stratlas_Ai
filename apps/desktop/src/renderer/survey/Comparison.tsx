/**
 * Comparison items of a polygon (M11 G4, PRD SRV-1 and SRV-2): From and To pickers (current,
 * previous, any prepared survey, any design, a reference level with a typed value and Set to
 * highest or lowest, smart, best-fit plane, mean perimeter level, custom), swap, the warning when
 * neither side reads a survey, the deadband and its opt-in, several items per polygon, and the
 * results (cut, fill, net, total and their areas) with partial, refused and stale states. Volumes
 * come from G2's executor in the survey engine worker (`compareStore.ts`).
 */
import type { EngineStage } from '@aio/engine';
import { formatQuantity, fromSI, toSI, unitLabel } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { ComparisonItem, ComparisonResult, SurfaceRef, SurveyMeasurement } from '@aio/schema';
import {
  deadbandFromStops,
  defaultItem,
  effectiveUnits,
  isBase,
  itemProblem,
  setReferenceLevel,
  setReferenceMode,
  sideFor,
  sideKey,
  sideOptions,
  swapItem,
  terrainWarning,
  type SideOption,
} from '@aio/survey';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { BaseEditor } from './BaseEditor';
import {
  compute,
  followMeasurements,
  isStale,
  loadCompare,
  prepareSurfaces,
  setHeat,
  useCompare,
  type Computed,
} from './compareStore';
import type { ItemShare } from './engineProtocol';
import { attachHeat3d, attachHeatMap, attachSiteMap } from './heatScene';
import { HeatmapStopsButton } from './HeatmapStops';
import { Materials } from './Materials';
import type { Frame } from './measureScene';
import { updateMeasurement, useMeasure } from './measureStore';
import { WholeSite } from './WholeSite';
import './compare.css';

const MAX_ITEMS = 20;

/** The comparisons section of a polygon measurement's panel. */
export function Comparisons({ m }: { m: SurveyMeasurement }) {
  const readOnly = useMeasure((s) => s.readOnly);
  const settings = useMeasure((s) => s.settings);
  const status = useCompare((s) => s.status);
  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const computed = useCompare((s) => s.computed[m.id]);
  const running = useCompare((s) => s.running[m.id] === true);
  const problem = useCompare((s) => s.problems[m.id]);
  const current = useCompare((s) => s.current);
  const preparing = useCompare((s) => s.preparing);
  const engineError = useCompare((s) => s.error);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const [note, setNote] = useState<string | null>(null);
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
  if (m.family !== 'polygon') return null;

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
  const live = computed?.live ? computed : null;

  return (
    <details className="sv-sec" open data-testid="survey-comparisons">
      <summary>Comparisons ({m.items.length})</summary>
      {status === 'ready' && surfaces.length === 0 && (
        <div className="notice small" role="status">
          <span>No survey surface is prepared yet. Volumes need the surveys as height tiles.</span>
          {!readOnly && manifest && (
            <button
              type="button"
              className="btn sm"
              disabled={preparing !== null}
              data-testid="survey-prepare"
              onClick={() => {
                void prepareSurfaces(manifest).then(setNote);
              }}
            >
              {preparing ? 'Preparing surfaces…' : 'Prepare surfaces'}
            </button>
          )}
        </div>
      )}
      {(note ?? engineError) && <p className="small faint">{note ?? engineError}</p>}
      {problem && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {problem}
        </p>
      )}
      <ol className="sv-cmp-items">
        {m.items.map((it, k) => {
          const stored = m.results.find((r) => r.item === it.id);
          const shown = live?.results.find((r) => r.item === it.id) ?? stored;
          const stale = !live && stored !== undefined && isStale({ current }, m, stored);
          // the share of the numbers shown (not of an older computation)
          const fromRun = computed?.results.find((r) => r.item === it.id);
          const share =
            shown && fromRun?.fingerprint === shown.fingerprint
              ? (computed?.shares.find((x) => x.item === it.id) ?? null)
              : null;
          return (
            <ItemEditor
              share={share}
              key={it.id}
              index={k}
              m={m}
              item={it}
              options={options}
              result={shown ?? null}
              stale={stale}
              live={live !== null}
              running={running}
              stopsDeadband={stopsDeadband}
              readOnly={readOnly}
              onChange={(next) => {
                patchItem(it.id, next);
              }}
              onRemove={() => {
                setItems(m.items.filter((x) => x.id !== it.id));
              }}
            />
          );
        })}
      </ol>
      <div className="sv-row sv-wrap">
        {!readOnly && m.items.length < MAX_ITEMS && (
          <button
            type="button"
            className="btn sm"
            data-testid="survey-add-comparison"
            onClick={() => {
              setItems([...m.items, defaultItem(m.items, stopsDeadband)]);
            }}
          >
            <Icon name="plus" size={12} /> Add a comparison
          </button>
        )}
        {m.items.length > 0 && (
          <button
            type="button"
            className="btn sm"
            disabled={running}
            data-testid="survey-recompute"
            onClick={() => {
              void compute(m.id);
            }}
          >
            {running ? 'Computing…' : 'Recompute'}
          </button>
        )}
        <span className="sv-grow" />
        {computed && (
          <span className="small faint" data-testid="survey-compute-ms">
            {Math.round(computed.ms)} ms
          </span>
        )}
      </div>
      {m.items.length > 0 && <HeatControls m={m} computed={computed ?? null} />}
    </details>
  );
}

function ItemEditor({
  index,
  m,
  item,
  options,
  result,
  share,
  stale,
  live,
  running,
  stopsDeadband,
  readOnly,
  onChange,
  onRemove,
}: {
  index: number;
  m: SurveyMeasurement;
  item: ComparisonItem;
  options: SideOption[];
  result: ComparisonResult | null;
  share: ItemShare | null;
  stale: boolean;
  live: boolean;
  running: boolean;
  stopsDeadband: number;
  readOnly: boolean;
  onChange: (next: ComparisonItem) => void;
  onRemove: () => void;
}) {
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const warn = terrainWarning(item);
  const bad = itemProblem(item);
  const n = index + 1;
  const setSide = (side: 'from' | 'to', ref: SurfaceRef) => {
    const other = side === 'from' ? 'to' : 'from';
    const next: ComparisonItem = { ...item, [side]: ref };
    // a base is sampled on the other side: never a base on both
    if (isBase(ref) && isBase(next[other])) next[other] = { kind: 'current' };
    onChange(next);
  };
  const deadband = item.deadbandM ?? stopsDeadband;
  return (
    <li className="sv-cmp-item" data-testid="survey-cmp-item" data-item={item.id}>
      <div className="sv-row">
        <input
          className="sv-input sv-grow"
          aria-label={`Comparison ${String(n)} name`}
          placeholder={`Comparison ${String(n)}`}
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
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Remove comparison ${String(n)}`}
            onClick={onRemove}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="sv-cmp-sides">
        <SidePicker
          label="From"
          n={n}
          value={item.from}
          options={options}
          points={m.points}
          disabled={readOnly}
          onChange={(ref) => {
            setSide('from', ref);
          }}
        />
        <button
          type="button"
          className="btn ghost sm sv-swap"
          aria-label={`Swap From and To of comparison ${String(n)}`}
          title="Swap From and To"
          disabled={readOnly}
          data-testid="survey-swap"
          onClick={() => {
            onChange(swapItem(item));
          }}
        >
          <Icon name="updown" size={12} />
        </button>
        <SidePicker
          label="To"
          n={n}
          value={item.to}
          options={options}
          points={m.points}
          disabled={readOnly}
          onChange={(ref) => {
            setSide('to', ref);
          }}
        />
      </div>
      {(['from', 'to'] as const).map((side) => {
        const ref = item[side];
        if (ref.kind === 'reference')
          return (
            <ReferenceLevel
              key={side}
              n={n}
              side={side}
              value={ref}
              units={units.distance}
              decimals={settings.precision.distance}
              disabled={readOnly}
              onChange={(r) => {
                setSide(side, r);
              }}
            />
          );
        if (ref.kind === 'custom')
          return (
            <BaseEditor
              key={side}
              m={m}
              base={ref}
              disabled={readOnly}
              onChange={(r) => {
                setSide(side, r);
              }}
            />
          );
        return null;
      })}
      {warn && (
        <p className="notice warn small" role="note" data-testid="survey-terrain-warning">
          <Icon name="warn" size={12} /> {warn}
        </p>
      )}
      {bad && (
        <p className="notice danger small" role="alert">
          {bad}
        </p>
      )}
      <div className="sv-row sv-wrap">
        <label className="sv-field sv-inline">
          <span>Deadband</span>
          <input
            className="sv-input mono"
            type="number"
            step="0.01"
            min={0}
            aria-label={`Deadband of comparison ${String(n)} (${unitLabel(units.distance)})`}
            value={Number(fromSI(deadband, 'distance', units.distance).toFixed(4))}
            readOnly={readOnly}
            data-testid="survey-deadband"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v < 0) return;
              const si = toSI(v, 'distance', units.distance);
              if (si > 10) return;
              onChange({ ...item, deadbandM: si });
            }}
          />
          <span className="faint small">{unitLabel(units.distance)}</span>
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={item.useDeadband}
            disabled={readOnly}
            data-testid="survey-use-deadband"
            onChange={(e) => {
              onChange({ ...item, useDeadband: e.target.checked, deadbandM: deadband });
            }}
          />
          Use deadband in calculations
        </label>
      </div>
      <Results result={result} share={share} stale={stale} live={live} running={running} m={m} />
    </li>
  );
}

const GROUPS: SideOption['group'][] = ['Surveys', 'Designs', 'Bases'];

function SidePicker({
  label,
  n,
  value,
  options,
  points,
  disabled,
  onChange,
}: {
  label: 'From' | 'To';
  n: number;
  value: SurfaceRef;
  options: SideOption[];
  points: SurveyMeasurement['points'];
  disabled: boolean;
  onChange: (ref: SurfaceRef) => void;
}) {
  const key = sideKey(value);
  const known = options.some((o) => o.key === key);
  return (
    <label className="sv-field">
      <span>{label}</span>
      <select
        className="sv-input"
        aria-label={`${label} of comparison ${String(n)}`}
        value={key}
        disabled={disabled}
        data-testid={`survey-${label.toLowerCase()}`}
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) onChange(sideFor(o, points, value));
        }}
      >
        {!known && <option value={key}>{key} (not available)</option>}
        {GROUPS.map((g) => {
          const os = options.filter((o) => o.group === g);
          if (os.length === 0) return null;
          return (
            <optgroup key={g} label={g}>
              {os.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.note ? `${o.label} (${o.note})` : o.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

const MODE_TEXT: Record<string, string> = {
  'perimeter-max': 'the highest point on the perimeter',
  'perimeter-min': 'the lowest point on the perimeter',
  'interior-max': 'the highest point inside',
  'interior-min': 'the lowest point inside',
};

function ReferenceLevel({
  n,
  side,
  value,
  units,
  decimals,
  disabled,
  onChange,
}: {
  n: number;
  side: 'from' | 'to';
  value: Extract<SurfaceRef, { kind: 'reference' }>;
  units: ReturnType<typeof effectiveUnits>['distance'];
  decimals: number;
  disabled: boolean;
  onChange: (ref: SurfaceRef) => void;
}) {
  const typed = value.mode === 'level' ? value.levelM : undefined;
  const [text, setText] = useState(
    typed !== undefined ? fromSI(typed, 'distance', units).toFixed(decimals) : '',
  );
  return (
    <div className="sv-sub sv-ref" role="group" aria-label={`Reference level (${side})`}>
      <label className="sv-field sv-inline">
        <span>Level</span>
        <input
          className="sv-input mono"
          type="number"
          step="0.001"
          aria-label={`Reference level of comparison ${String(n)} (${unitLabel(units)})`}
          data-testid="survey-ref-level"
          value={value.mode === 'level' ? text : ''}
          placeholder={value.mode === 'level' ? '' : 'Typed level'}
          readOnly={disabled}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value !== '' && Number.isFinite(v))
              onChange(setReferenceLevel(value, toSI(v, 'distance', units)));
          }}
          onFocus={() => {
            if (value.mode !== 'level') setText('');
          }}
        />
        <span className="faint small">{unitLabel(units)}</span>
      </label>
      <div className="sv-row sv-wrap">
        <button
          type="button"
          className="btn sm"
          aria-pressed={value.mode === 'perimeter-max'}
          disabled={disabled}
          data-testid="survey-ref-highest"
          onClick={() => {
            onChange(setReferenceMode(value, 'perimeter-max'));
          }}
        >
          Set to highest
        </button>
        <button
          type="button"
          className="btn sm"
          aria-pressed={value.mode === 'perimeter-min'}
          disabled={disabled}
          data-testid="survey-ref-lowest"
          onClick={() => {
            onChange(setReferenceMode(value, 'perimeter-min'));
          }}
        >
          Set to lowest
        </button>
      </div>
      {value.mode !== 'level' && (
        <p className="small faint">The level follows {MODE_TEXT[value.mode]} of the surface.</p>
      )}
    </div>
  );
}

function Results({
  result,
  share,
  stale,
  live,
  running,
  m,
}: {
  result: ComparisonResult | null;
  share: ItemShare | null;
  stale: boolean;
  live: boolean;
  running: boolean;
  m: SurveyMeasurement;
}) {
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision);
  const a = (x: number) => formatQuantity(x, 'area', units, settings.precision);
  if (!result)
    return (
      <p className="small faint" data-testid="survey-cmp-status">
        {running ? 'Computing…' : 'Not computed yet'}
      </p>
    );
  if (result.status === 'refused')
    return (
      <p className="notice danger small" data-testid="survey-cmp-status" role="status">
        Not computed: {result.reason ?? 'refused'}
      </p>
    );
  const isStaleNow = stale || result.status === 'stale';
  return (
    <div className={`sv-cmp-res${isStaleNow ? ' stale' : ''}`}>
      <p className="small faint">
        {result.fromLabel} to {result.toLabel}
      </p>
      {isStaleNow && (
        <p className="notice warn small" data-testid="survey-cmp-status" role="status">
          Stale, recompute
        </p>
      )}
      {result.status === 'partial' && (
        <p className="notice warn small" data-testid="survey-cmp-status" role="status">
          Partly outside the survey: {result.reason ?? ''}. The volumes are of the covered part.
        </p>
      )}
      {live && <p className="small faint">Live while you edit; saved when the edit ends.</p>}
      <table className="sv-readout" data-testid="survey-cmp-result">
        <caption className="sr-only">Comparison results</caption>
        <tbody>
          <tr data-key="cut">
            <th scope="row">Cut</th>
            <td className="mono">{v(result.cutM3)}</td>
            <td className="mono faint">{a(result.areaCutM2)}</td>
          </tr>
          <tr data-key="fill">
            <th scope="row">Fill</th>
            <td className="mono">{v(result.fillM3)}</td>
            <td className="mono faint">{a(result.areaFillM2)}</td>
          </tr>
          <tr data-key="net">
            <th scope="row">Net</th>
            <td className="mono">{v(result.netM3)}</td>
            <td className="mono faint">{a(result.areaUnchangedM2)} unchanged</td>
          </tr>
          <tr data-key="total">
            <th scope="row">Total</th>
            <td className="mono">{v(result.totalM3)}</td>
            <td className="mono faint">{a(result.areaM2)}</td>
          </tr>
          {result.uncoveredM2 > 0 && (
            <tr data-key="uncovered">
              <th scope="row">Not covered</th>
              <td className="mono" colSpan={2}>
                {a(result.uncoveredM2)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="small faint">
        {result.usedDeadband
          ? `Deadband used: changes under ${formatQuantity(result.deadbandM, 'distance', units, settings.precision)} count as unchanged.`
          : 'No deadband in the volumes.'}{' '}
        {result.cellM > 0
          ? `Grid ${formatQuantity(result.cellM, 'distance', units, settings.precision)}.`
          : 'Exact (triangulated).'}
      </p>
      {share && share.share.areaM2 > 0 && (
        <p
          className="small"
          data-testid="survey-cmp-share"
          data-share={share.share.share}
          data-tolerance={share.toleranceM}
        >
          <b>{(share.share.share * 100).toFixed(1)}% in tolerance</b> (plus or minus{' '}
          {formatQuantity(share.toleranceM, 'distance', units, settings.precision)}):{' '}
          {a(share.share.inToleranceM2)} of {a(share.share.areaM2)}; cut beyond it{' '}
          {a(share.share.cutM2)}, fill beyond it {a(share.share.fillM2)}.
        </p>
      )}
    </div>
  );
}

function HeatControls({ m, computed }: { m: SurveyMeasurement; computed: Computed | null }) {
  const heat = useCompare((s) => s.heat);
  const has = (computed?.heat.length ?? 0) > 0;
  return (
    <fieldset className="sv-sub" data-testid="survey-heat">
      <legend>Heat map of the difference</legend>
      <div className="sv-row sv-wrap">
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.show3d}
            onChange={(e) => {
              setHeat({ show3d: e.target.checked });
            }}
          />
          On the terrain (3D)
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.show2d}
            onChange={(e) => {
              setHeat({ show2d: e.target.checked });
            }}
          />
          On the map (2D)
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.contours}
            onChange={(e) => {
              setHeat({ contours: e.target.checked });
            }}
          />
          Contours
        </label>
      </div>
      {m.items.length > 1 && (
        <label className="sv-field">
          <span>Show</span>
          <select
            className="sv-input"
            value={heat.item ?? m.items[0]?.id ?? ''}
            onChange={(e) => {
              setHeat({ item: e.target.value });
            }}
          >
            {m.items.map((it, k) => (
              <option key={it.id} value={it.id}>
                {it.label ?? `Comparison ${String(k + 1)}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {!has && (
        <p className="small faint">
          A heat map shows once a comparison on the survey grid has been computed.
        </p>
      )}
      <HeatmapStopsButton />
    </fieldset>
  );
}

/**
 * The comparisons' mount in the measurements layer: the engine for the open project, the focused
 * polygon followed, its heat maps in the 3D view and on the map, and the G4 dialogs.
 */
export function CompareLayer({
  stage,
  map,
  frame,
}: {
  stage: EngineStage | null;
  map: MapController | null;
  frame: Frame | null;
}) {
  const project = useWorkspace((s) => s.project);
  const dialog = useCompare((s) => s.dialog);
  const projectId = project?.id ?? null;
  useEffect(() => followMeasurements(), []);
  useEffect(() => {
    void loadCompare(
      project ? { id: project.id, root: project.root, manifest: project.manifest } : null,
    );
    // the project's identity, not each manifest edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => (stage && frame ? attachHeat3d(stage, frame) : undefined), [stage, frame]);
  useEffect(() => (map && frame ? attachHeatMap(map, frame) : undefined), [map, frame]);
  useEffect(
    () => (map && frame && projectId ? attachSiteMap(map, frame, projectId) : undefined),
    [map, frame, projectId],
  );
  return (
    <>
      {dialog === 'materials' && <Materials />}
      {dialog === 'site' && <WholeSite />}
    </>
  );
}

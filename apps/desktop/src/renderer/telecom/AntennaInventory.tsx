import type { AntennaKind, AntennasFile, AntennaStatus, AntennaUnit } from '@aio/schema';
import { Button, Chip, EmptyState, IconButton, Row, t } from '@aio/ui';
import type { CSSProperties, ReactElement } from 'react';
import { azimuthLines, formatDeg, trueAzimuth } from './antennaFormat';
import { KIND_COLOURS } from './antennaScene';
import { filteredUnits } from './antennaStore';
import { isAntennaDrawn, type AntennaFilter } from './antennaVisibility';

export interface AntennaInventoryProps {
  file: AntennasFile | null;
  selected: string | null;
  hidden: Record<string, true>;
  solo: AntennaKind | null;
  filter: AntennaFilter;
  readOnly: boolean;
  /** A transient status line shown under the tabs. */
  note?: string | null;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onToggleGroup: (kind: AntennaKind) => void;
  onSolo: (kind: AntennaKind | null) => void;
  onFilter: (f: AntennaFilter) => void;
  onHideAll: () => void;
  onShowAll: () => void;
}

const KINDS: readonly AntennaKind[] = ['panel', 'short', 'dish', 'other'];
const FILTERS: readonly AntennaFilter[] = ['draft', 'accepted', 'rejected', 'all'];
const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;
/** Outline style carries the status beside the text chip: dashed draft, solid accepted, dotted rejected. */
const OUTLINE: Record<AntennaStatus, CSSProperties> = {
  draft: { outline: '1px dashed var(--fg-3)', outlineOffset: -1 },
  accepted: { outline: '1px solid var(--fg-2)', outlineOffset: -1 },
  rejected: { outline: '1px dotted var(--fg-4)', outlineOffset: -1 },
};

/** The selected filter tab (aria-selected carries the state; a tab takes no aria-pressed). */
const TAB_ON: CSSProperties = {
  background: 'var(--acc-a20)',
  borderColor: 'var(--acc-a40)',
  color: 'var(--acc-strong)',
};

/** The north every azimuth of the file is from, or null when the units mix them. */
type North = 'project' | 'true' | null;

function northOf(units: readonly AntennaUnit[]): North {
  let north: North = null;
  for (const u of units) {
    if (!u.azimuthGridDeg) continue;
    const ref = u.convergenceDeg === null ? 'project' : 'true';
    if (north !== null && north !== ref) return null;
    north = ref;
  }
  return north;
}

/** The azimuth of a row: degrees only when the summary names the north, else the full line. */
function rowAzimuth(unit: AntennaUnit, north: North): string | null {
  const grid = unit.azimuthGridDeg;
  if (!grid) return null;
  if (north === null) return azimuthLines(unit)?.primary ?? null;
  return formatDeg(
    unit.convergenceDeg === null ? grid.value : trueAzimuth(grid.value, unit.convergenceDeg),
  );
}

/** Never shrinks: the status text stays whole beside the outline style. */
const CHIP: CSSProperties = { flex: 'none', display: 'inline-flex' };
/** Name, azimuth and downtilt give way first, with an ellipsis. */
const TEXT: CSSProperties = {
  display: 'flex',
  gap: 'var(--sp-4)',
  alignItems: 'baseline',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

interface UnitRowProps {
  unit: AntennaUnit;
  north: North;
  selected: boolean;
  hidden: boolean;
  drawn: boolean;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
}

function UnitRow({
  unit,
  north,
  selected,
  hidden,
  drawn,
  onSelect,
  onToggleVisible,
}: UnitRowProps): ReactElement {
  const az = rowAzimuth(unit, north);
  const name = unit.name;
  return (
    <Row
      kind="tree"
      className="antenna-row"
      role="treeitem"
      aria-selected={selected}
      data-testid="antenna-row"
      data-status={unit.status}
      selected={selected}
      style={{ ...OUTLINE[unit.status], ...(drawn ? {} : { opacity: 0.45 }) }}
      tabIndex={0}
      onClick={() => {
        onSelect(unit.id);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(unit.id);
        }
      }}
      label={
        <span style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'center', minWidth: 0 }}>
          <span style={TEXT}>
            <span>{name}</span>
            {az ? <span className="mono">{az}</span> : null}
            {unit.downtiltDeg ? (
              <span className="mono">{formatDeg(unit.downtiltDeg.value)}</span>
            ) : null}
          </span>
          <span style={CHIP} data-testid="antenna-status">
            <Chip kind="status" tone={TONE[unit.status]}>
              {t(`telecom.antennas.status.${unit.status}`)}
            </Chip>
          </span>
          {unit.notFoundInLatest ? (
            <span style={CHIP}>
              <Chip kind="tag">{t('telecom.antennas.notFound')}</Chip>
            </span>
          ) : null}
        </span>
      }
      actions={
        <IconButton
          icon={hidden ? 'eye-off' : 'eye'}
          label={t(hidden ? 'telecom.antennas.show' : 'telecom.antennas.hide', { name })}
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisible(unit.id);
          }}
        />
      }
    />
  );
}

/** The antenna inventory: filter tabs and units grouped by kind under a summary line. */
export function AntennaInventory(props: AntennaInventoryProps): ReactElement {
  const { file } = props;
  if (!file)
    return (
      <EmptyState
        title={t('telecom.antennas.empty.none.title')}
        body={t('telecom.antennas.empty.none.body')}
      />
    );
  if (file.units.length === 0)
    return (
      <EmptyState
        title={t('telecom.antennas.empty.nothing.title')}
        body={t('telecom.antennas.empty.nothing.body')}
      />
    );
  const antennas = file.units.filter((u) => u.kind !== 'other').length;
  const other = file.units.length - antennas;
  const review = file.units.filter((u) => u.status === 'draft').length;
  const north = northOf(file.units);
  const summary = [
    antennas > 0 ? t('telecom.antennas.summary.antennas', { count: antennas }) : null,
    other > 0 ? t('telecom.antennas.summary.other', { count: other }) : null,
    review > 0 ? t('telecom.antennas.summary.review', { count: review }) : null,
    north ? t(`telecom.antennas.summary.north.${north}`) : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  const listed = filteredUnits(file, props.filter);
  const vis = { selected: props.selected, hidden: props.hidden, solo: props.solo };
  return (
    // minmax(0, 1fr): a long row ellipsizes in a narrow aside instead of widening the column
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-4)' }}>
        <Button size="sm" data-testid="antenna-hide-all" onClick={props.onHideAll}>
          {t('telecom.antennas.hideAll')}
        </Button>
        <Button size="sm" data-testid="antenna-show-all" onClick={props.onShowAll}>
          {t('telecom.antennas.showAll')}
        </Button>
      </div>
      <p className="mono" data-testid="antenna-summary" style={{ margin: 0 }}>
        {summary}
      </p>
      <div
        role="tablist"
        aria-label={t('telecom.antennas.title')}
        style={{ display: 'flex', gap: 'var(--sp-4)', flexWrap: 'wrap' }}
      >
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            role="tab"
            aria-selected={props.filter === f}
            tabIndex={props.filter === f ? 0 : -1}
            style={props.filter === f ? TAB_ON : undefined}
            data-testid={`antenna-filter-${f}`}
            onClick={() => {
              props.onFilter(f);
            }}
            onKeyDown={(e) => {
              const at = FILTERS.indexOf(f);
              const next =
                e.key === 'ArrowRight'
                  ? (at + 1) % FILTERS.length
                  : e.key === 'ArrowLeft'
                    ? (at + FILTERS.length - 1) % FILTERS.length
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? FILTERS.length - 1
                        : -1;
              if (next < 0) return;
              e.preventDefault();
              const target = FILTERS[next];
              if (!target) return;
              props.onFilter(target);
              e.currentTarget.parentElement
                ?.querySelector<HTMLElement>(`[data-testid="antenna-filter-${target}"]`)
                ?.focus();
            }}
          >
            {`${t(`telecom.antennas.filter.${f}`)} ${filteredUnits(file, f).length}`}
          </Button>
        ))}
      </div>
      {props.note ? (
        <p className="telecom-help telecom-note" role="status" data-testid="antenna-note">
          {props.note}
        </p>
      ) : null}
      {listed.length === 0 ? (
        <EmptyState title={t('telecom.antennas.filter.empty')} />
      ) : (
        <div role="tree" aria-label={t('telecom.antennas.title')}>
          {KINDS.map((kind) => {
            const units = listed.filter((u) => u.kind === kind);
            if (units.length === 0) return null;
            const allHidden = file.units
              .filter((u) => u.kind === kind)
              .every((u) => props.hidden[u.id] === true);
            const label = t(`telecom.antennas.kind.${kind}`);
            return (
              <div key={kind} role="treeitem" aria-expanded="true" aria-label={label}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-4)',
                    padding: 'var(--sp-3) var(--sp-4)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 10,
                      flex: 'none',
                      borderRadius: 2,
                      background: KIND_COLOURS[kind],
                    }}
                  />
                  {/* the group's label says it; a tree holds groups and items, not headings */}
                  <h4
                    aria-hidden="true"
                    style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 'var(--t-title)' }}
                  >
                    {label}
                  </h4>
                  <span className="mono">{units.length}</span>
                  <IconButton
                    icon={allHidden ? 'eye-off' : 'eye'}
                    label={t(
                      allHidden ? 'telecom.antennas.group.show' : 'telecom.antennas.group.hide',
                      { name: label },
                    )}
                    data-testid={`antenna-group-eye-${kind}`}
                    onClick={() => {
                      props.onToggleGroup(kind);
                    }}
                  />
                  <IconButton
                    icon="target"
                    label={t('telecom.antennas.group.solo', { name: label })}
                    pressed={props.solo === kind}
                    data-testid={`antenna-group-solo-${kind}`}
                    onClick={() => {
                      props.onSolo(props.solo === kind ? null : kind);
                    }}
                  />
                </div>
                <div role="group">
                  {units.map((u) => (
                    <UnitRow
                      key={u.id}
                      unit={u}
                      north={north}
                      selected={props.selected === u.id}
                      hidden={props.hidden[u.id] === true}
                      drawn={isAntennaDrawn(vis, u)}
                      onSelect={props.onSelect}
                      onToggleVisible={props.onToggleVisible}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

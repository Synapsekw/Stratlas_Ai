import type { AntennaKind, AntennasFile, AntennaStatus, AntennaUnit } from '@aio/schema';
import { Chip, EmptyState, IconButton, Menu, Row, t, type MenuEntry } from '@aio/ui';
import { useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { azimuthLines, formatDeg, trueAzimuth } from './antennaFormat';

export interface AntennaInventoryProps {
  file: AntennasFile | null;
  selected: string | null;
  hidden: Record<string, true>;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSetStatus: (id: string, status: AntennaStatus) => void;
  onOpenDetails: (id: string) => void;
}

const KINDS: readonly AntennaKind[] = ['panel', 'short', 'dish', 'other'];
const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;
/** Outline style carries the status beside the text chip: dashed draft, solid accepted, dotted rejected. */
const OUTLINE: Record<AntennaStatus, CSSProperties> = {
  draft: { outline: '1px dashed var(--fg-3)', outlineOffset: -1 },
  accepted: { outline: '1px solid var(--fg-2)', outlineOffset: -1 },
  rejected: { outline: '1px dotted var(--fg-4)', outlineOffset: -1 },
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
  readOnly: boolean;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSetStatus: (id: string, status: AntennaStatus) => void;
  onOpenDetails: (id: string) => void;
}

function UnitRow({
  unit,
  north,
  selected,
  hidden,
  readOnly,
  onSelect,
  onToggleVisible,
  onSetStatus,
  onOpenDetails,
}: UnitRowProps): ReactElement {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const az = rowAzimuth(unit, north);
  const name = unit.name;
  const items: MenuEntry[] = [
    {
      id: 'accept',
      label: t('telecom.antennas.accept'),
      icon: 'check',
      onSelect: () => {
        onSetStatus(unit.id, 'accepted');
      },
      ...(readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {}),
    },
    {
      id: 'reject',
      label: t('telecom.antennas.reject'),
      icon: 'x',
      onSelect: () => {
        onSetStatus(unit.id, 'rejected');
      },
      ...(readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {}),
    },
    'separator',
    {
      id: 'details',
      label: t('telecom.antennas.details'),
      onSelect: () => {
        onOpenDetails(unit.id);
      },
    },
  ];
  return (
    <Row
      kind="tree"
      className="antenna-row"
      role="treeitem"
      aria-selected={selected}
      data-testid="antenna-row"
      data-status={unit.status}
      selected={selected}
      style={OUTLINE[unit.status]}
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
        <>
          <IconButton
            icon={hidden ? 'eye-off' : 'eye'}
            label={t(hidden ? 'telecom.antennas.show' : 'telecom.antennas.hide', { name })}
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisible(unit.id);
            }}
          />
          <IconButton
            ref={opener}
            icon="more"
            label={t('telecom.antennas.more', { name })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
          />
          <Menu
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            opener={opener}
            label={t('telecom.antennas.more', { name })}
            items={items}
          />
        </>
      }
    />
  );
}

/** The antenna inventory: units grouped by kind under a summary line, with no chrome of its own. */
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
  return (
    // minmax(0, 1fr): a long row ellipsizes in a narrow aside instead of widening the column
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--sp-4)' }}>
      <p className="mono" data-testid="antenna-summary" style={{ margin: 0 }}>
        {summary}
      </p>
      <div role="tree" aria-label={t('telecom.antennas.title')}>
        {KINDS.map((kind) => {
          const units = file.units.filter((u) => u.kind === kind);
          if (units.length === 0) return null;
          return (
            <div key={kind} role="group" aria-label={t(`telecom.antennas.kind.${kind}`)}>
              {/* the group's label says it; a tree holds groups and items, not headings */}
              <h4
                aria-hidden="true"
                style={{
                  margin: 0,
                  padding: 'var(--sp-3) var(--sp-4)',
                  fontSize: 'var(--t-title)',
                }}
              >
                {t(`telecom.antennas.kind.${kind}`)}
              </h4>
              {units.map((u) => (
                <UnitRow
                  key={u.id}
                  unit={u}
                  north={north}
                  selected={props.selected === u.id}
                  hidden={props.hidden[u.id] === true}
                  readOnly={props.readOnly}
                  onSelect={props.onSelect}
                  onToggleVisible={props.onToggleVisible}
                  onSetStatus={props.onSetStatus}
                  onOpenDetails={props.onOpenDetails}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

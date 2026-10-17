import type { AntennaKind, AntennasFile, AntennaStatus, AntennaUnit } from '@aio/schema';
import { Chip, EmptyState, IconButton, Menu, Row, t, type MenuEntry } from '@aio/ui';
import { useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { azimuthLines, formatDeg } from './antennaFormat';

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

interface UnitRowProps {
  unit: AntennaUnit;
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
  const az = azimuthLines(unit);
  const name = unit.name;
  const items: MenuEntry[] = [
    {
      id: 'accept',
      label: t('telecom.antennas.accept'),
      icon: 'check',
      onSelect: () => {
        onSetStatus(unit.id, 'accepted');
      },
      ...(readOnly ? { disabledReason: t('telecom.antennas.accept') } : {}),
    },
    {
      id: 'reject',
      label: t('telecom.antennas.reject'),
      icon: 'x',
      onSelect: () => {
        onSetStatus(unit.id, 'rejected');
      },
      ...(readOnly ? { disabledReason: t('telecom.antennas.reject') } : {}),
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
      role="treeitem"
      aria-selected={selected}
      data-testid="antenna-row"
      data-status={unit.status}
      selected={selected}
      style={OUTLINE[unit.status]}
      onClick={() => {
        onSelect(unit.id);
      }}
      label={
        <span style={{ display: 'inline-flex', gap: 'var(--sp-4)', alignItems: 'baseline' }}>
          <span>{name}</span>
          {az ? <span className="mono">{az.primary}</span> : null}
          {unit.downtiltDeg ? (
            <span className="mono">{formatDeg(unit.downtiltDeg.value)}</span>
          ) : null}
          <Chip kind="status" tone={TONE[unit.status]}>
            {t(`telecom.antennas.status.${unit.status}`)}
          </Chip>
          {unit.notFoundInLatest ? <Chip kind="tag">{t('telecom.antennas.notFound')}</Chip> : null}
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
  const summary = [
    antennas > 0 ? t('telecom.antennas.summary.antennas', { count: antennas }) : null,
    other > 0 ? t('telecom.antennas.summary.other', { count: other }) : null,
    review > 0 ? t('telecom.antennas.summary.review', { count: review }) : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      <p className="mono" data-testid="antenna-summary" style={{ margin: 0 }}>
        {summary}
      </p>
      <div role="tree" aria-label={t('telecom.antennas.title')}>
        {KINDS.map((kind) => {
          const units = file.units.filter((u) => u.kind === kind);
          if (units.length === 0) return null;
          return (
            <div key={kind} role="group" aria-label={t(`telecom.antennas.kind.${kind}`)}>
              <h4
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

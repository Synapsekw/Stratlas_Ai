/**
 * One antenna in the Antennas group: a tick for the bulk bar, its kind colour, name and kind, the
 * azimuth and downtilt as fields saved on Enter or leaving them (Esc reverts), its height, its
 * status chip and a trash that asks to delete it. A click or Enter selects it; whatever is passed
 * as children (the selected unit's details) shows under it, in the same list item, so a reveal
 * scrolls the row and its details into view together.
 */
import type { AntennaUnit } from '@aio/schema';
import { Chip, IconButton, t } from '@aio/ui';
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from 'react';
import { askDeleteAntennas } from './antennaDelete';
import { DASH } from './AntennaDetails';
import { TONE } from './antennaFormat';
import { KIND_COLOURS } from './antennaScene';
import { AntennaTypedField } from './AntennaTypedValues';

/** The north every azimuth of the file is from, or null when the units mix them. */
export type North = 'project' | 'true' | null;

export function northOf(units: readonly AntennaUnit[]): North {
  let north: North = null;
  for (const u of units) {
    if (!u.azimuthGridDeg) continue;
    const ref = u.convergenceDeg === null ? 'project' : 'true';
    if (north !== null && north !== ref) return null;
    north = ref;
  }
  return north;
}

export interface AntennaRowProps {
  unit: AntennaUnit;
  selected: boolean;
  ticked: boolean;
  readOnly: boolean;
  /** The north of the whole list; null when the units mix them (each field names its own). */
  north: North;
  /** Drawn in 3D (not hidden, not outside a solo); a row not drawn is dimmed. */
  drawn?: boolean;
  onSelect(id: string): void;
  onTick(id: string): void;
  onContextMenu?(e: MouseEvent, id: string): void;
  /** Under the row, in the same item: the selected unit's details. */
  children?: ReactNode;
}

const DIM: CSSProperties = { opacity: 0.45 };

/** A click or key on a control in the row is the control's, not the row's. */
const stop = (e: { stopPropagation(): void }) => {
  e.stopPropagation();
};

export function AntennaRow(props: AntennaRowProps): ReactElement {
  const { unit, selected, ticked, readOnly, north } = props;
  const name = unit.name;
  const dish = unit.kind === 'dish';
  const height = (unit.centreHeightM?.value ?? unit.box.centre[2]).toFixed(1);
  return (
    <li className="antenna-item" data-row-id={unit.id} role="none">
      <div
        className="row antenna-row"
        data-kind="tree"
        role="treeitem"
        aria-selected={selected}
        aria-label={name}
        data-testid="antenna-row"
        data-status={unit.status}
        data-selected={selected ? '' : undefined}
        data-north={north ?? 'mixed'}
        tabIndex={0}
        style={props.drawn === false ? DIM : undefined}
        onClick={() => {
          props.onSelect(unit.id);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onSelect(unit.id);
          }
        }}
        onContextMenu={
          props.onContextMenu
            ? (e) => {
                e.preventDefault();
                props.onContextMenu?.(e, unit.id);
              }
            : undefined
        }
      >
        <input
          type="checkbox"
          className="antenna-tick"
          aria-label={t('project.antennas.tick', { name })}
          checked={ticked}
          onClick={stop}
          onChange={() => {
            props.onTick(unit.id);
          }}
        />
        <span
          aria-hidden="true"
          className="antenna-swatch"
          style={{ background: KIND_COLOURS[unit.kind] }}
        />
        <span className="antenna-name">{name}</span>
        <span className="antenna-kind">{t(`telecom.antennas.card.kind.${unit.kind}`)}</span>
        {/* the field's own label names the north it reads in, also when the units mix them */}
        <span className="antenna-cell">
          <AntennaTypedField
            unit={unit}
            fieldKey="azimuthGridDeg"
            readOnly={readOnly}
            compact
            testId="antenna-row-az"
          />
        </span>
        <span className="antenna-cell">
          {dish ? (
            <span className="mono antenna-dash" data-testid="antenna-row-tilt">
              {DASH}
            </span>
          ) : (
            <AntennaTypedField
              unit={unit}
              fieldKey="downtiltDeg"
              readOnly={readOnly}
              compact
              testId="antenna-row-tilt"
            />
          )}
        </span>
        <span className="mono antenna-height">{height}</span>
        <span className="antenna-status" data-testid="antenna-status">
          <Chip kind="status" tone={TONE[unit.status]}>
            {t(`telecom.antennas.status.${unit.status}`)}
          </Chip>
        </span>
        <IconButton
          icon="trash"
          className="antenna-trash"
          label={t('project.antennas.deleteRow', { name })}
          data-testid="antenna-row-delete"
          {...(readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {})}
          onClick={(e) => {
            e.stopPropagation();
            askDeleteAntennas([unit.id]);
          }}
        />
      </div>
      {props.children}
    </li>
  );
}

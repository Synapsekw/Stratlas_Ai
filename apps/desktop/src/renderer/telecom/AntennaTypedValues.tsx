/**
 * "Your values" on the antenna card: the azimuth, downtilt, centre elevation and size a person
 * types over the measured ones (or types in for a flagged unit too thin to measure). A value
 * commits on Enter or when the field is left; Reset to measured brings back the kept measured one.
 * The azimuth reads in the north the card's Azimuth shows (true when the file has the convergence,
 * else project north) and is stored as grid azimuth.
 */
import type { AntennaUnit } from '@aio/schema';
import { Button, t, type MessageKey } from '@aio/ui';
import { useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { trueAzimuth } from './antennaFormat';
import { resetTypedValue, setTypedValue } from './antennaStore';
import { TYPED_RANGE, canReset, isNotMeasured, parseTyped, type TypedKey } from './antennaTyped';

export interface AntennaTypedValuesProps {
  unit: AntennaUnit;
  readOnly: boolean;
}

interface Field {
  key: TypedKey;
  label: MessageKey;
  /** Decimals the prefilled value shows. */
  dp: number;
}

const FIELDS: readonly Field[] = [
  { key: 'azimuthGridDeg', label: 'telecom.antennas.typed.azimuth.true', dp: 1 },
  { key: 'downtiltDeg', label: 'telecom.antennas.typed.downtilt', dp: 1 },
  { key: 'centreHeightM', label: 'telecom.antennas.typed.centre', dp: 2 },
  { key: 'widthM', label: 'telecom.antennas.typed.width', dp: 2 },
  { key: 'heightM', label: 'telecom.antennas.typed.height', dp: 2 },
  { key: 'depthM', label: 'telecom.antennas.typed.depth', dp: 2 },
];

/** The field's label: the azimuth names its north. */
function labelOf(unit: AntennaUnit, f: Field): string {
  if (f.key !== 'azimuthGridDeg') return t(f.label);
  return t(
    unit.convergenceDeg === null
      ? 'telecom.antennas.typed.azimuth.project'
      : 'telecom.antennas.typed.azimuth.true',
  );
}

/** A stored value as the field shows it: the azimuth turned to true north when it can be. */
function shown(unit: AntennaUnit, key: TypedKey, v: number): number {
  return key === 'azimuthGridDeg' && unit.convergenceDeg !== null
    ? trueAzimuth(v, unit.convergenceDeg)
    : v;
}

/** A value the field shows as it is stored: a true azimuth back to grid. */
function stored(unit: AntennaUnit, key: TypedKey, v: number): number {
  const conv = unit.convergenceDeg;
  return key === 'azimuthGridDeg' && conv !== null ? (((v - conv) % 360) + 360) % 360 : v;
}

/** The value the field starts from: the unit's, or for the centre the box's; empty when none. */
function prefill(unit: AntennaUnit, f: Field): string {
  const v = unit[f.key]?.value ?? (f.key === 'centreHeightM' ? unit.box.centre[2] : undefined);
  if (v === undefined) return '';
  // 359.96 shows as 0, the same as the card's value
  const n = Number(shown(unit, f.key, v).toFixed(f.dp));
  return String(f.key === 'azimuthGridDeg' && n === 360 ? 0 : n);
}

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 'var(--sp-4) var(--sp-4)',
  paddingTop: 'var(--sp-4)',
};
const LABEL: CSSProperties = {
  display: 'grid',
  gap: 'var(--sp-1)',
  color: 'var(--fg-2)',
  fontSize: 'var(--t-11)',
};

function TypedField(props: {
  unit: AntennaUnit;
  field: Field;
  start: string;
  readOnly: boolean;
}): ReactElement {
  const { unit, field, start, readOnly } = props;
  const [text, setText] = useState(start);
  const [bad, setBad] = useState(false);
  // the value being written: Enter then leaving the field is one entry, not two writes; cleared
  // when the write ends, so an entry whose write failed can be committed again
  const pending = useRef<number | null>(null);
  const errId = useId();
  const [lo, hi] = TYPED_RANGE[field.key];

  const commit = (): void => {
    const entry = text.trim();
    if (entry === '') {
      // an empty entry writes nothing: the field shows the value again
      setBad(false);
      setText(start);
      return;
    }
    const v = parseTyped(field.key, entry);
    setBad(v === null);
    if (v === null) return;
    // the same number as shown (168.0 over 168) keeps the value as it is
    if ((start !== '' && v === Number(start)) || v === pending.current) return;
    pending.current = v;
    void setTypedValue(unit.id, field.key, stored(unit, field.key, v)).finally(() => {
      pending.current = null;
    });
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-1)', alignContent: 'start', minWidth: 0 }}>
      <label style={LABEL}>
        {labelOf(unit, field)}
        <input
          type="text"
          inputMode="decimal"
          className="input sm mono"
          data-testid={`antenna-typed-${field.key}`}
          value={text}
          disabled={readOnly}
          aria-invalid={bad ? true : undefined}
          aria-describedby={bad ? errId : undefined}
          style={{ width: '100%', minWidth: 0 }}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          onBlur={commit}
        />
      </label>
      {bad ? (
        <small id={errId} role="alert" style={{ color: 'var(--danger-ink)' }}>
          {t('telecom.antennas.typed.invalid', { min: lo, max: hi })}
        </small>
      ) : null}
      {canReset(unit, field.key) ? (
        <Button
          variant="link"
          data-testid={`antenna-typed-reset-${field.key}`}
          tip={t('telecom.antennas.typed.reset.tip')}
          disabledReason={readOnly ? t('telecom.antennas.readOnly') : undefined}
          style={{ justifySelf: 'start' }}
          onClick={() => {
            void resetTypedValue(unit.id, field.key);
          }}
        >
          {t('telecom.antennas.typed.reset')}
        </Button>
      ) : null}
    </div>
  );
}

/** The typed values, collapsed unless the unit has nothing measured. Key it by the unit id. */
export function AntennaTypedValues({ unit, readOnly }: AntennaTypedValuesProps): ReactElement {
  const [open, setOpen] = useState(() => isNotMeasured(unit));
  const fields = unit.kind === 'dish' ? FIELDS.filter((f) => f.key !== 'downtiltDeg') : FIELDS;
  return (
    <details
      data-testid="antenna-typed"
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary style={{ cursor: 'pointer', color: 'var(--fg-2)' }}>
        {t('telecom.antennas.typed.title')}
      </summary>
      <div style={GRID}>
        {fields.map((f) => {
          const start = prefill(unit, f);
          // a new stored value (typed, reset, or another unit) starts the field afresh
          return (
            <TypedField
              key={`${unit.id}:${f.key}:${unit[f.key]?.basis ?? ''}:${start}`}
              unit={unit}
              field={f}
              start={start}
              readOnly={readOnly}
            />
          );
        })}
      </div>
    </details>
  );
}

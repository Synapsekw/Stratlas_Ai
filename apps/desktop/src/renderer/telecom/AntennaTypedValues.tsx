/**
 * "Your values" on the antenna card: the azimuth, downtilt, centre elevation and size a person
 * types over the measured ones (or types in for a flagged unit too thin to measure). A value
 * commits on Enter or when the field is left; Reset to measured brings back the kept measured one.
 */
import type { AntennaUnit } from '@aio/schema';
import { Button, t, type MessageKey } from '@aio/ui';
import { useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
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
  { key: 'azimuthGridDeg', label: 'telecom.antennas.typed.azimuth', dp: 1 },
  { key: 'downtiltDeg', label: 'telecom.antennas.typed.downtilt', dp: 1 },
  { key: 'centreHeightM', label: 'telecom.antennas.typed.centre', dp: 2 },
  { key: 'widthM', label: 'telecom.antennas.typed.width', dp: 2 },
  { key: 'heightM', label: 'telecom.antennas.typed.height', dp: 2 },
  { key: 'depthM', label: 'telecom.antennas.typed.depth', dp: 2 },
];

/** The value the field starts from: the unit's, or for the centre the box's; empty when none. */
function prefill(unit: AntennaUnit, f: Field): string {
  const v = unit[f.key]?.value ?? (f.key === 'centreHeightM' ? unit.box.centre[2] : undefined);
  return v === undefined ? '' : String(Number(v.toFixed(f.dp)));
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
  // Enter then leaving the field is one entry, not two writes
  const committed = useRef(start);
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
    if (entry === committed.current) return;
    const v = parseTyped(field.key, entry);
    setBad(v === null);
    if (v === null) return;
    committed.current = entry;
    void setTypedValue(unit.id, field.key, v);
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-1)', alignContent: 'start', minWidth: 0 }}>
      <label style={LABEL}>
        {t(field.label)}
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

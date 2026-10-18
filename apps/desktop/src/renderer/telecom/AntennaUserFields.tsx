import type { AntennaUnit, AntennaUserFields as UserFields } from '@aio/schema';
import { t } from '@aio/ui';
import { useState, type ReactElement } from 'react';

export interface AntennaUserFieldsProps {
  unit: AntennaUnit;
  readOnly: boolean;
  onPatchUser: (fields: UserFields) => void;
}

/** The weight in kg when `text` is a number from 0 to 500, else null. */
function parseWeight(text: string): number | null {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return null;
  const n = Number(text);
  return n <= 500 ? n : null;
}

/** The fields a person types for one unit: model, weight, frequencies and in-service. */
export function AntennaUserFields(props: AntennaUserFieldsProps): ReactElement {
  const { unit, readOnly } = props;
  const [model, setModel] = useState(unit.user.model ?? '');
  const [freq, setFreq] = useState(unit.user.frequencies ?? '');
  const [weight, setWeight] = useState(
    unit.user.weightKg === undefined ? '' : String(unit.user.weightKg),
  );
  const [weightBad, setWeightBad] = useState(false);
  // A different unit starts from its own saved values, never the previous unit's text.
  const [seenId, setSeenId] = useState(unit.id);
  if (seenId !== unit.id) {
    setSeenId(unit.id);
    setModel(unit.user.model ?? '');
    setFreq(unit.user.frequencies ?? '');
    setWeight(unit.user.weightKg === undefined ? '' : String(unit.user.weightKg));
    setWeightBad(false);
  }

  const commitWeight = (): void => {
    if (weight.trim() === '') {
      setWeightBad(false);
      return;
    }
    const n = parseWeight(weight);
    setWeightBad(n === null);
    if (n !== null && n !== unit.user.weightKg) props.onPatchUser({ weightKg: n });
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
        {t('telecom.antennas.field.model')}
        <input
          type="text"
          value={model}
          disabled={readOnly}
          maxLength={120}
          onChange={(e) => {
            setModel(e.target.value);
          }}
          onBlur={() => {
            if (model !== (unit.user.model ?? '')) props.onPatchUser({ model });
          }}
        />
      </label>
      <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
        {t('telecom.antennas.field.weight')}
        <input
          type="text"
          inputMode="decimal"
          value={weight}
          disabled={readOnly}
          aria-invalid={weightBad ? true : undefined}
          aria-describedby={weightBad ? 'antenna-weight-err' : undefined}
          onChange={(e) => {
            setWeight(e.target.value);
          }}
          onBlur={commitWeight}
        />
        {weightBad ? (
          <small id="antenna-weight-err" role="alert">
            {t('telecom.antennas.field.weight.invalid')}
          </small>
        ) : null}
      </label>
      <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
        {t('telecom.antennas.field.frequencies')}
        <input
          type="text"
          value={freq}
          disabled={readOnly}
          maxLength={200}
          onChange={(e) => {
            setFreq(e.target.value);
          }}
          onBlur={() => {
            if (freq !== (unit.user.frequencies ?? '')) props.onPatchUser({ frequencies: freq });
          }}
        />
      </label>
      <label style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={unit.user.active === true}
          disabled={readOnly}
          onChange={(e) => {
            props.onPatchUser({ active: e.target.checked });
          }}
        />
        {t('telecom.antennas.field.active')}
      </label>
    </div>
  );
}

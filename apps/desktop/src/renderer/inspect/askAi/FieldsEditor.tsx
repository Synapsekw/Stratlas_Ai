/**
 * The values a custom request reads off each box: rows of a name, a type, the choices (for a
 * choice) or the unit (for a number), and remove. Keys are made from the names (`reading`,
 * `in_normal_range`), unique with `_2`, so the person never types one.
 */
import type { FieldSpec, FieldType } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';

/** Values a saved request may read (the schema's cap). */
export const MAX_FIELDS = 12;
const TYPES: readonly FieldType[] = ['text', 'number', 'yesno', 'choice'];

/** A key from a label: lower case words joined by `_`, starting with a letter, unique in `taken`. */
export function fieldKey(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '') base = 'value';
  else if (!/^[a-z]/.test(base)) base = `v_${base}`;
  base = base.slice(0, 36).replace(/_+$/, '');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}_${String(n)}`;
    if (!taken.has(k)) return k;
  }
}

/** Every field keyed again from its label, in order. */
export function withKeys(fields: readonly FieldSpec[]): FieldSpec[] {
  const taken = new Set<string>();
  return fields.map((f) => {
    const key = fieldKey(f.label, taken);
    taken.add(key);
    return { ...f, key };
  });
}

/** Whether a field still needs something before the request can be sent or saved. */
export function fieldsProblem(fields: readonly FieldSpec[]): boolean {
  return fields.some(
    (f) => f.label.trim() === '' || (f.type === 'choice' && (f.choices?.length ?? 0) < 2),
  );
}

const parseChoices = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().slice(0, 40))
    .filter((x) => x !== '')
    .slice(0, 20);

/** A field changed to `type`: the choices only on a choice, the unit only on a number. */
function retype(f: FieldSpec, type: FieldType): FieldSpec {
  const out: FieldSpec = { key: f.key, label: f.label, type };
  if (type === 'choice') out.choices = f.choices ?? [];
  if (type === 'number' && f.unit !== undefined) out.unit = f.unit;
  return out;
}

export function FieldsEditor({
  fields,
  onChange,
  disabled = false,
}: {
  fields: readonly FieldSpec[];
  onChange: (f: FieldSpec[]) => void;
  disabled?: boolean;
}): ReactElement {
  const t = useT();
  // the choices as typed (a trailing comma stays while the next one is written), by row
  const [typed, setTyped] = useState<Record<number, string>>({});
  const set = (i: number, f: FieldSpec) => {
    onChange(withKeys(fields.map((x, n) => (n === i ? f : x))));
  };
  return (
    <div className="askp-fields" data-testid="ask-fields">
      {fields.length > 0 && (
        <ul className="askp-field-rows">
          {fields.map((f, i) => {
            const n = String(i);
            return (
              <li key={n} className="askp-field">
                <input
                  className="input askp-field-label"
                  data-testid={`field-label-${n}`}
                  aria-label={t('askPanel.fields.label')}
                  placeholder={t('askPanel.fields.labelPlaceholder')}
                  maxLength={60}
                  value={f.label}
                  disabled={disabled}
                  onChange={(e) => {
                    set(i, { ...f, label: e.target.value });
                  }}
                />
                <select
                  className="input askp-field-type"
                  data-testid={`field-type-${n}`}
                  aria-label={t('askPanel.fields.type')}
                  value={f.type}
                  disabled={disabled}
                  onChange={(e) => {
                    const type = TYPES.find((x) => x === e.target.value) ?? 'text';
                    set(i, retype(f, type));
                  }}
                >
                  {TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`askPanel.fields.type.${x}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost icon sm askp-field-remove"
                  data-testid={`field-remove-${n}`}
                  aria-label={t('askPanel.fields.remove', {
                    label: f.label.trim() || t('askPanel.fields.labelPlaceholder'),
                  })}
                  disabled={disabled}
                  onClick={() => {
                    setTyped({});
                    onChange(withKeys(fields.filter((_, x) => x !== i)));
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
                {f.type === 'choice' && (
                  <input
                    className="input askp-field-extra"
                    data-testid={`field-choices-${n}`}
                    aria-label={t('askPanel.fields.choices')}
                    placeholder={t('askPanel.fields.choicesPlaceholder')}
                    value={typed[i] ?? (f.choices ?? []).join(', ')}
                    disabled={disabled}
                    onChange={(e) => {
                      const text = e.target.value;
                      setTyped((s) => ({ ...s, [i]: text }));
                      set(i, { ...f, choices: parseChoices(text) });
                    }}
                  />
                )}
                {f.type === 'number' && (
                  <input
                    className="input askp-field-extra"
                    data-testid={`field-unit-${n}`}
                    aria-label={t('askPanel.fields.unit')}
                    placeholder={t('askPanel.fields.unitPlaceholder')}
                    maxLength={20}
                    value={f.unit ?? ''}
                    disabled={disabled}
                    onChange={(e) => {
                      const unit = e.target.value;
                      const next: FieldSpec = { key: f.key, label: f.label, type: f.type };
                      set(i, unit === '' ? next : { ...next, unit });
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="askp-field-foot">
        <button
          type="button"
          className="btn ghost sm"
          data-testid="field-add"
          disabled={disabled || fields.length >= MAX_FIELDS}
          onClick={() => {
            onChange(withKeys([...fields, { key: 'value', label: '', type: 'text' }]));
          }}
        >
          <Icon name="plus" size={12} />
          {t('askPanel.fields.add')}
        </button>
        {fields.length >= MAX_FIELDS && (
          <span className="faint small">{t('askPanel.fields.max', { max: MAX_FIELDS })}</span>
        )}
      </div>
    </div>
  );
}

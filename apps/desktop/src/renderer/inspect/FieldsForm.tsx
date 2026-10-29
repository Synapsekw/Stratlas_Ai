/**
 * Custom field values on a suggestion or an issue. `FieldsList` is the compact read-only list (label,
 * then the value with its unit); `FieldsForm` fixes the values before an accept: a number box, a
 * text box, Yes / No / Unknown buttons and a choice list. A number that is not a number is not
 * reported, so the old value stays. A read-only package gets the list.
 */
import { formatFieldValue } from '@aio/project/export';
import type { FieldValue } from '@aio/schema';
import { t, useT, type MessageKey } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import './fields.css';

/** The choices the app itself asks for (change requests); a value carries no choice list. */
const BUILT_IN_CHOICES: Readonly<Record<string, readonly string[]>> = {
  change_type: ['new', 'removed', 'moved', 'progress', 'damage'],
};

const CHANGE_WORDS: Readonly<Record<string, MessageKey>> = {
  new: 'fields.change.new',
  removed: 'fields.change.removed',
  moved: 'fields.change.moved',
  progress: 'fields.change.progress',
  damage: 'fields.change.damage',
};

/** The change kinds are shown in words; any other choice is shown as the request wrote it. */
const choiceLabel = (key: string, c: string): string =>
  key === 'change_type' && CHANGE_WORDS[c] ? t(CHANGE_WORDS[c]) : c;

function useWords() {
  const t = useT();
  return {
    yes: t('fields.yes'),
    no: t('fields.no'),
    unknown: t('fields.unknown'),
    none: t('fields.none'),
  };
}

export function FieldsList({ fields }: { fields: readonly FieldValue[] }): ReactElement {
  const words = useWords();
  return (
    <dl className="fields-list" data-testid="fields-list">
      {fields.map((f) => (
        <div key={f.key} className="fields-item">
          <dt>{f.label}</dt>
          <dd data-empty={f.value === null || undefined}>{formatFieldValue(f, words)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** '' is no value, a number is the value, anything else is not a number (undefined). */
function parseNumber(text: string): number | null | undefined {
  const s = text.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const shown = (n: number | null) => (n === null ? '' : String(n));

function NumberField(p: { field: FieldValue; onValue: (v: number | null) => void }): ReactElement {
  const current = typeof p.field.value === 'number' ? p.field.value : null;
  // what is being typed; null when not editing, so the box follows the stored value
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? shown(current);
  return (
    <input
      className="ann-input"
      data-testid={`field-${p.field.key}`}
      aria-label={p.field.label}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setTyped(e.target.value);
        const n = parseNumber(e.target.value);
        if (n !== undefined) p.onValue(n);
      }}
      onBlur={() => {
        setTyped(null);
      }}
    />
  );
}

export function FieldsForm({
  fields,
  onChange,
  readOnly,
}: {
  fields: readonly FieldValue[];
  onChange: (f: FieldValue[]) => void;
  readOnly?: boolean;
}): ReactElement {
  const t = useT();
  const words = useWords();
  if (readOnly) return <FieldsList fields={fields} />;
  const set = (key: string, value: FieldValue['value']) => {
    onChange(fields.map((f) => (f.key === key ? { ...f, value } : f)));
  };
  return (
    <fieldset className="fields-form" data-testid="fields-form">
      <legend>{t('fields.edit')}</legend>
      {fields.map((f) => {
        const choices = f.type === 'choice' ? (f.choices ?? BUILT_IN_CHOICES[f.key]) : undefined;
        return (
          <div key={f.key} className="field-row">
            <span className="field-name">{f.label}</span>
            <span className="field-input">
              {f.type === 'number' ? (
                <>
                  <NumberField
                    field={f}
                    onValue={(v) => {
                      set(f.key, v);
                    }}
                  />
                  {f.unit && <span className="field-unit">{f.unit}</span>}
                </>
              ) : f.type === 'yesno' ? (
                <span
                  className="field-seg"
                  role="group"
                  aria-label={f.label}
                  data-testid={`field-${f.key}`}
                >
                  {(['yes', 'no', 'unknown'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="ann-btn"
                      data-value={v}
                      aria-pressed={f.value === v}
                      onClick={() => {
                        set(f.key, v);
                      }}
                    >
                      {words[v]}
                    </button>
                  ))}
                </span>
              ) : choices ? (
                <select
                  className="ann-select"
                  data-testid={`field-${f.key}`}
                  aria-label={f.label}
                  value={typeof f.value === 'string' ? f.value : ''}
                  onChange={(e) => {
                    set(f.key, e.target.value);
                  }}
                >
                  {/* a value outside the list stays visible but cannot be picked again */}
                  {(f.value === null || !choices.includes(String(f.value))) && (
                    <option value={typeof f.value === 'string' ? f.value : ''} disabled>
                      {typeof f.value === 'string' && f.value !== '' ? f.value : t('fields.pick')}
                    </option>
                  )}
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {choiceLabel(f.key, c)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="ann-input"
                  data-testid={`field-${f.key}`}
                  aria-label={f.label}
                  value={typeof f.value === 'string' ? f.value : ''}
                  onChange={(e) => {
                    set(f.key, e.target.value === '' ? null : e.target.value);
                  }}
                />
              )}
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}

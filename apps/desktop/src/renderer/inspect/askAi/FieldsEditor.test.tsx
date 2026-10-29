// @vitest-environment jsdom
import type { FieldSpec } from '@aio/schema';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fieldKey, FieldsEditor, fieldsProblem, MAX_FIELDS, withKeys } from './FieldsEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const sel = (id: string) => `[data-testid="${id}"]`;
const q = (id: string) => host.querySelector<HTMLButtonElement>(sel(id));
const input = (id: string) => host.querySelector<HTMLInputElement>(sel(id));
const select = (id: string) => host.querySelector<HTMLSelectElement>(sel(id));

/** Types into a React-controlled input or select. */
function setValue(el: HTMLInputElement | HTMLSelectElement | null, value: string) {
  if (!el) throw new Error('no element');
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

/** Renders the editor as its owner would, keeping the fields it is handed back. */
function Harness({ start, seen }: { start: FieldSpec[]; seen: (f: FieldSpec[]) => void }) {
  const [fields, setFields] = useState(start);
  return (
    <FieldsEditor
      fields={fields}
      onChange={(f) => {
        seen(f);
        setFields(f);
      }}
    />
  );
}

describe('fieldKey', () => {
  it('makes keys from labels', () => {
    expect(fieldKey('Reading', new Set())).toBe('reading');
    expect(fieldKey('In normal range?', new Set())).toBe('in_normal_range');
    expect(fieldKey('2nd gauge', new Set())).toBe('v_2nd_gauge');
    expect(fieldKey('', new Set())).toBe('value');
  });
  it('keeps keys unique with _2', () => {
    expect(fieldKey('Reading', new Set(['reading']))).toBe('reading_2');
    expect(fieldKey('Reading', new Set(['reading', 'reading_2']))).toBe('reading_3');
  });
  it('re-keys every field from its label', () => {
    const f = withKeys([
      { key: 'x', label: 'Reading', type: 'number' },
      { key: 'y', label: 'Reading', type: 'number' },
    ]);
    expect(f.map((x) => x.key)).toEqual(['reading', 'reading_2']);
  });
});

describe('fieldsProblem', () => {
  it('wants a name and two choices', () => {
    expect(fieldsProblem([])).toBe(false);
    expect(fieldsProblem([{ key: 'value', label: ' ', type: 'text' }])).toBe(true);
    expect(fieldsProblem([{ key: 'a', label: 'A', type: 'choice', choices: ['x'] }])).toBe(true);
    expect(fieldsProblem([{ key: 'a', label: 'A', type: 'choice', choices: ['x', 'y'] }])).toBe(
      false,
    );
  });
});

describe('FieldsEditor', () => {
  it('adds a value, and its label gives the key', () => {
    const seen = vi.fn<(f: FieldSpec[]) => void>();
    act(() => {
      root.render(<Harness start={[]} seen={seen} />);
    });
    act(() => {
      q('field-add')?.click();
    });
    setValue(input('field-label-0'), 'Reading');
    expect(seen.mock.lastCall?.[0]).toEqual([{ key: 'reading', label: 'Reading', type: 'text' }]);
  });

  it('asks for a unit on a number and choices on a choice', () => {
    const seen = vi.fn<(f: FieldSpec[]) => void>();
    act(() => {
      root.render(
        <Harness start={[{ key: 'reading', label: 'Reading', type: 'text' }]} seen={seen} />,
      );
    });
    expect(q('field-unit-0')).toBeNull();
    setValue(select('field-type-0'), 'number');
    setValue(input('field-unit-0'), 'bar');
    expect(seen.mock.lastCall?.[0]).toEqual([
      { key: 'reading', label: 'Reading', type: 'number', unit: 'bar' },
    ]);
    setValue(select('field-type-0'), 'choice');
    expect(q('field-unit-0')).toBeNull();
    setValue(input('field-choices-0'), 'ok, worn,');
    expect(input('field-choices-0')?.value).toBe('ok, worn,');
    expect(seen.mock.lastCall?.[0]).toEqual([
      { key: 'reading', label: 'Reading', type: 'choice', choices: ['ok', 'worn'] },
    ]);
  });

  it('removes a value and stops adding at the limit', () => {
    const seen = vi.fn<(f: FieldSpec[]) => void>();
    const many: FieldSpec[] = Array.from({ length: MAX_FIELDS }, (_, i) => ({
      key: `v${String(i)}`,
      label: `V${String(i)}`,
      type: 'text',
    }));
    act(() => {
      root.render(<Harness start={many} seen={seen} />);
    });
    expect(q('field-add')?.disabled).toBe(true);
    act(() => {
      q('field-remove-0')?.click();
    });
    expect(seen.mock.lastCall?.[0]).toHaveLength(MAX_FIELDS - 1);
    expect(q('field-add')?.disabled).toBe(false);
  });
});

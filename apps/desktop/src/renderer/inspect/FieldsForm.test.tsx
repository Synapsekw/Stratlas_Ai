// @vitest-environment jsdom
/** Custom field values: the compact list and the form that fixes each type before an accept. */
import type { FieldValue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldsForm, FieldsList } from './FieldsForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fields: FieldValue[] = [
  { key: 'reading', label: 'Reading', type: 'number', value: 42.5, unit: 'bar' },
  { key: 'tag', label: 'Tag', type: 'text', value: 'P-101' },
  { key: 'leaking', label: 'Leaking', type: 'yesno', value: 'no' },
  {
    key: 'change_type',
    label: 'Change',
    type: 'choice',
    value: 'new',
    choices: ['new', 'removed', 'moved', 'progress', 'damage'],
  },
];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const render = (node: React.ReactElement) => {
  root = createRoot(host);
  act(() => root?.render(node));
};
const type = (el: HTMLInputElement, value: string) => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const q = (sel: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

describe('FieldsList', () => {
  it('prints each label with its value and unit', () => {
    render(
      <FieldsList fields={[...fields, { key: 'r2', label: 'Other', type: 'text', value: null }]} />,
    );
    const text = host.textContent;
    expect(text).toContain('Reading');
    expect(text).toContain('42.5 bar');
    expect(text).toContain('P-101');
    expect(text).toContain('No');
    expect(text).toContain('Not read');
  });
});

describe('FieldsForm', () => {
  it('limits a choice to its choices, in words for the change kinds', () => {
    render(<FieldsForm fields={fields} onChange={vi.fn()} />);
    const select = q('[data-testid="field-change_type"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'New',
      'Removed',
      'Moved',
      'Progress',
      'Damage',
    ]);
    expect(select.value).toBe('new');
  });

  it('shows a value outside the choices as a disabled current value', () => {
    const odd: FieldValue = {
      key: 'state',
      label: 'State',
      type: 'choice',
      value: 'half',
      choices: ['open', 'closed'],
    };
    render(<FieldsForm fields={[odd]} onChange={vi.fn()} />);
    const select = q('[data-testid="field-state"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['half', 'open', 'closed']);
    expect(select.options[0]?.disabled).toBe(true);
    expect(select.value).toBe('half');
  });

  it('reports a new number', () => {
    const onChange = vi.fn();
    render(<FieldsForm fields={fields} onChange={onChange} />);
    type(q('[data-testid="field-reading"]') as HTMLInputElement, '17');
    const out = onChange.mock.calls[0]?.[0] as FieldValue[];
    expect(out[0]?.value).toBe(17);
    expect(out[1]?.value).toBe('P-101');
  });

  it('keeps the old value for a bad number', () => {
    const onChange = vi.fn();
    render(<FieldsForm fields={fields} onChange={onChange} />);
    const input = q('[data-testid="field-reading"]') as HTMLInputElement;
    type(input, 'abc');
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.value).toBe('42.5');
  });

  it('reports text, yes/no/unknown and choice edits', () => {
    const onChange = vi.fn();
    render(<FieldsForm fields={fields} onChange={onChange} />);
    type(q('[data-testid="field-tag"]') as HTMLInputElement, 'P-202');
    expect((onChange.mock.calls[0]?.[0] as FieldValue[])[1]?.value).toBe('P-202');
    act(() => {
      q('[data-testid="field-leaking"] [data-value="unknown"]').click();
    });
    expect((onChange.mock.calls[1]?.[0] as FieldValue[])[2]?.value).toBe('unknown');
    const select = q('[data-testid="field-change_type"]') as HTMLSelectElement;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act(() => {
      set?.call(select, 'damage');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect((onChange.mock.calls[2]?.[0] as FieldValue[])[3]?.value).toBe('damage');
  });

  it('shows the list without inputs when read only', () => {
    render(<FieldsForm fields={fields} onChange={vi.fn()} readOnly />);
    expect(host.querySelector('input, select, button')).toBeNull();
    expect(host.textContent).toContain('42.5 bar');
  });
});

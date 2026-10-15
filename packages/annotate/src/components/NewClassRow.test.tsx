// @vitest-environment jsdom
import type { IssueClass } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewClassRow, registerClassCreator, useClassCreator } from './NewClassRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const spalling: IssueClass = {
  id: 'spalling',
  label: 'Spalling',
  color: '#7cc46b',
  severityModel: 'sev',
};
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
});

describe('NewClassRow', () => {
  it('turns into a field; Enter creates and hands back the class', async () => {
    const onCreate = vi.fn(() => Promise.resolve(spalling));
    const onCreated = vi.fn();
    const el = render(<NewClassRow onCreate={onCreate} onCreated={onCreated} />);
    const button = el.querySelector('button');
    expect(button?.textContent).toBe('+ New class...');
    act(() => {
      button?.click();
    });
    const input = el.querySelector('input');
    if (!input) throw new Error('no field');
    act(() => {
      type(input, '  Spalling ');
    });
    await act(async () => {
      key(input, 'Enter');
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith('Spalling');
    expect(onCreated).toHaveBeenCalledWith(spalling);
    expect(el.querySelector('input')).toBeNull();
  });

  it('Escape cancels; an empty name and a refused create show the reason', async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn(() => Promise.reject(new Error('Classes not saved: disk full')));
    const onCreated = vi.fn();
    const el = render(
      <NewClassRow onCreate={onCreate} onCreated={onCreated} startOpen onCancel={onCancel} />,
    );
    const input = el.querySelector('input');
    if (!input) throw new Error('no field');
    input.focus();
    act(() => {
      key(input, 'Enter');
    });
    expect(el.textContent).toContain('Type a name for the class.');
    act(() => {
      type(input, 'Rust');
    });
    await act(async () => {
      key(input, 'Enter');
      await Promise.resolve();
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Classes not saved: disk full');
    expect(el.querySelector('[role="alert"]')?.className).toBe('ann-error');
    expect(onCreated).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    act(() => {
      key(input, 'Escape');
    });
    expect(onCancel).toHaveBeenCalled();
    expect(el.querySelector('input')).toBeNull();
  });

  it('is disabled with the reason', () => {
    const el = render(
      <NewClassRow onCreate={vi.fn()} onCreated={vi.fn()} disabledReason="Read-only project" />,
    );
    const button = el.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('Read-only project');
  });

  it('shares one registered creator with every picker', () => {
    let seen: unknown = 'unset';
    function Probe() {
      seen = useClassCreator();
      return null;
    }
    render(<Probe />);
    expect(seen).toBeNull();
    const fn = () => Promise.resolve(spalling);
    let off: () => void = () => undefined;
    act(() => {
      off = registerClassCreator(fn);
    });
    expect(seen).toBe(fn);
    act(() => {
      off();
    });
    expect(seen).toBeNull();
  });
});

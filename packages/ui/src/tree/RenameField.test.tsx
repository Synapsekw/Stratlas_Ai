// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameField } from './RenameField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

const setup = (initial = 'Old', maxLength?: number) => {
  const onCommit = vi.fn();
  const onEnd = vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <RenameField
        initial={initial}
        label="Name"
        placeholder="Name"
        testId="f"
        onCommit={onCommit}
        onEnd={onEnd}
        {...(maxLength !== undefined ? { maxLength } : {})}
      />,
    ),
  );
  const field = host.querySelector<HTMLInputElement>('[data-testid="f"]');
  if (!field) throw new Error('no field');
  return { field, onCommit, onEnd };
};
const key = (el: HTMLElement, k: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};
const leave = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

describe('RenameField', () => {
  it('takes a longer cap for measurement labels', () => {
    expect(setup('Old', 200).field.maxLength).toBe(200);
    act(() => root?.unmount());
    expect(setup().field.maxLength).toBe(80);
  });

  it('Enter saves the trimmed text', () => {
    const { field, onCommit, onEnd } = setup();
    field.value = '  New ';
    key(field, 'Enter');
    expect(onCommit).toHaveBeenCalledWith('New');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('unchanged text saves nothing', () => {
    const { field, onCommit, onEnd } = setup();
    key(field, 'Enter');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels', () => {
    const { field, onCommit, onEnd } = setup();
    field.value = 'Other';
    key(field, 'Escape');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('leaving the field after Enter does not end twice', () => {
    const { field, onEnd } = setup();
    key(field, 'Enter');
    leave(field);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('leaving the field saves', () => {
    const { field, onCommit } = setup();
    field.value = 'Moved';
    leave(field);
    expect(onCommit).toHaveBeenCalledWith('Moved');
  });
});

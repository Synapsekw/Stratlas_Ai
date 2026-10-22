// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RejectReasonMenu } from './RejectReasonMenu';

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

function show(onPick = vi.fn(), onClose = vi.fn()) {
  function H() {
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={opener} type="button">
          Reject
        </button>
        <RejectReasonMenu open opener={opener} onPick={onPick} onClose={onClose} />
      </>
    );
  }
  act(() => {
    root.render(<H />);
  });
  return { onPick, onClose };
}
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (label: string) => items().find((i) => i.textContent === label);

describe('RejectReasonMenu', () => {
  it('lists the reasons and the way out, in order', () => {
    show();
    expect(items().map((i) => i.textContent)).toEqual([
      'Looks like it but is not…',
      'Not a defect',
      'Wrong class',
      'Box is wrong',
      'Other reason',
      'Reject without a reason',
    ]);
  });

  it('picks a plain reason and closes', () => {
    const { onPick, onClose } = show();
    act(() => item('Wrong class')?.click());
    expect(onPick).toHaveBeenCalledWith('wrong-class');
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects without a reason as null', () => {
    const { onPick } = show();
    act(() => item('Reject without a reason')?.click());
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('asks what it is for "looks like it but is not" and sends the text on Enter', () => {
    const { onPick } = show();
    expect(document.body.querySelector('input')).toBeNull();
    act(() => item('Looks like it but is not…')?.click());
    expect(onPick).not.toHaveBeenCalled();
    const input = document.body.querySelector<HTMLInputElement>('input');
    expect(input?.placeholder).toBe('What is it? For example, a painted band');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'a painted band',
      );
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith('looks-like-but-is-not', 'a painted band');
  });

  it('limits the note to 200 characters', () => {
    show();
    act(() => item('Looks like it but is not…')?.click());
    expect(document.body.querySelector<HTMLInputElement>('input')?.maxLength).toBe(200);
  });

  it('closes on Escape and gives focus back to the opener', async () => {
    function H() {
      const opener = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={opener} type="button" data-testid="opener">
            Reject
          </button>
          <RejectReasonMenu
            open={open}
            opener={opener}
            onPick={() => undefined}
            onClose={() => {
              setOpen(false);
            }}
          />
        </>
      );
    }
    act(() => {
      root.render(<H />);
    });
    act(() => {
      item('Wrong class')?.focus();
    });
    await act(async () => {
      item('Wrong class')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="opener"]'));
  });
});

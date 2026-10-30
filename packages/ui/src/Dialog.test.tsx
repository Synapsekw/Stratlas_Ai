// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, openDialogCount, type DialogProps } from './Dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.documentElement.removeAttribute('data-theme');
});

const render = (node: ReactNode) => {
  root = createRoot(host);
  act(() => root?.render(node));
};
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialogs = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
/** Focus is put back in a microtask, after React removed the dialog. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const key = (el: Element | null, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => {
    el?.dispatchEvent(e);
  });
  return e;
};
const pressScrim = (scrim: Element | null, target: Element | null = scrim) => {
  act(() => {
    target?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    scrim?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

/** A page with an opener button that opens one dialog with two fields. */
function Page(props: Partial<DialogProps> & { startOpen?: boolean; inner?: ReactNode }) {
  const { startOpen, inner, ...rest } = props;
  const [open, setOpen] = useState(startOpen ?? false);
  return (
    <>
      <button
        type="button"
        data-testid="opener"
        onClick={() => {
          setOpen(true);
        }}
      >
        open
      </button>
      <Dialog
        title="Export"
        testId="dlg"
        {...rest}
        open={open}
        onClose={() => {
          rest.onClose?.();
          setOpen(false);
        }}
      >
        <input data-testid="first" aria-label="first" />
        <input data-testid="second" aria-label="second" />
        {inner}
      </Dialog>
    </>
  );
}
const openIt = () => {
  const opener = q('opener');
  opener?.focus();
  act(() => opener?.click());
};

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    render(<Page />);
    expect(dialogs()).toHaveLength(0);
    expect(openDialogCount()).toBe(0);
  });

  it('is a modal dialog in a portal under the body, on one scrim', () => {
    render(<Page />);
    openIt();
    const d = q('dlg');
    expect(d?.getAttribute('role')).toBe('dialog');
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(host.contains(d)).toBe(false);
    expect(d?.closest('.q-scrim')?.parentElement?.parentElement).toBe(document.body);
    expect(document.body.querySelectorAll('.q-scrim')).toHaveLength(1);
  });

  it('labelled by its title, described by its description', () => {
    render(<Page description="Choose what goes into the package." />);
    openIt();
    const d = q('dlg');
    const title = document.getElementById(d?.getAttribute('aria-labelledby') ?? '');
    expect(title?.tagName).toBe('H2');
    expect(title?.textContent).toBe('Export');
    const desc = document.getElementById(d?.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe('Choose what goes into the package.');
  });

  it('can be described by an element inside its body', () => {
    render(<Page describedBy="why" inner={<p id="why">Because.</p>} />);
    openIt();
    expect(q('dlg')?.getAttribute('aria-describedby')).toBe('why');
  });

  it('takes role alertdialog and a size', () => {
    render(<Page role="alertdialog" size="sm" />);
    openIt();
    const d = document.body.querySelector('[role="alertdialog"]');
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(d?.getAttribute('data-size')).toBe('sm');
  });

  it('moves focus inside: the first control, or initialFocus', () => {
    render(<Page />);
    openIt();
    expect(document.activeElement).toBe(q('first'));
    act(() => root?.unmount());
    root = null;
    function WithInitial() {
      const second = useRef<HTMLInputElement>(null);
      return (
        <Dialog open title="T" onClose={vi.fn()} initialFocus={second} hideClose>
          <input data-testid="a" aria-label="a" />
          <input data-testid="b" aria-label="b" ref={second} />
        </Dialog>
      );
    }
    render(<WithInitial />);
    expect(document.activeElement).toBe(q('b'));
  });

  it('with no control in the body, focus starts on the footer, not on Close', () => {
    render(
      <Dialog
        open
        title="Delete run"
        onClose={vi.fn()}
        footer={
          <button type="button" data-testid="cancel">
            Cancel
          </button>
        }
      >
        <p>The run and its files go to the trash.</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(q('cancel'));
  });

  it('traps focus: Tab from the last control wraps to the first, Shift+Tab back', () => {
    render(<Page footer={<button type="button">Save</button>} />);
    openIt();
    const d = q('dlg');
    const close = d?.querySelector<HTMLElement>('.q-dialog-close');
    const save = [...(d?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Save');
    // tab order: close (title row), first, second, Save
    save?.focus();
    expect(key(save ?? null, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    key(close ?? null, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    openIt();
    const e = key(q('first'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(dialogs()).toHaveLength(0);
  });

  it('Escape from nowhere (focus lost to the page) still closes the open dialog', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    openIt();
    (document.activeElement as HTMLElement | null)?.blur();
    key(document.body, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape a control inside already used (a field clearing itself)', () => {
    const onClose = vi.fn();
    render(
      <Page
        onClose={onClose}
        inner={
          <input
            data-testid="search"
            aria-label="search"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.preventDefault();
            }}
          />
        }
      />,
    );
    openIt();
    key(q('search'), 'Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the opener', async () => {
    render(<Page />);
    openIt();
    expect(document.activeElement).toBe(q('first'));
    key(q('first'), 'Escape');
    await settle();
    expect(document.activeElement).toBe(q('opener'));
  });

  it('returns focus to returnFocus when given', async () => {
    render(
      <>
        <button type="button" data-testid="elsewhere">
          x
        </button>
        <Page returnFocus={() => q('elsewhere')} />
      </>,
    );
    openIt();
    key(q('first'), 'Escape');
    await settle();
    expect(document.activeElement).toBe(q('elsewhere'));
  });

  it('the close button closes, named "Close" by default', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    openIt();
    const close = q('dlg')?.querySelector<HTMLButtonElement>('.q-dialog-close');
    expect(close?.getAttribute('aria-label')).toBe('Close');
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hideClose leaves the title row without a close button', () => {
    render(<Page hideClose />);
    openIt();
    expect(q('dlg')?.querySelector('.q-dialog-close')).toBeNull();
  });

  it('a press on the scrim closes; a press inside or one that started inside does not', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    openIt();
    const scrim = q('dlg-scrim');
    // starts in a field, ends on the scrim (a text selection dragged out)
    pressScrim(scrim, q('first'));
    expect(onClose).not.toHaveBeenCalled();
    act(() => q('first')?.click());
    expect(onClose).not.toHaveBeenCalled();
    pressScrim(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissable={false}: the scrim does not close it, Escape still does', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} dismissable={false} />);
    openIt();
    pressScrim(q('dlg-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    key(q('first'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the footer', () => {
    render(<Page footer={<button type="button">Save</button>} />);
    openIt();
    expect(q('dlg')?.querySelector('.q-dialog-foot')?.textContent).toBe('Save');
  });

  it('wears the theme of the control that opened it', () => {
    render(
      <div data-theme="dark-map">
        <Page />
      </div>,
    );
    openIt();
    expect(q('dlg')?.closest('[data-theme]')?.getAttribute('data-theme')).toBe('dark-map');
  });

  describe('stacking', () => {
    /** Dialog A with a button that opens dialog B. */
    function Stack({ onA, onB }: { onA: () => void; onB: () => void }) {
      const [a, setA] = useState(false);
      const [b, setB] = useState(false);
      return (
        <>
          <button
            type="button"
            data-testid="opener"
            onClick={() => {
              setA(true);
            }}
          >
            open
          </button>
          <Dialog
            open={a}
            title="A"
            testId="a"
            onClose={() => {
              onA();
              setA(false);
            }}
          >
            <button
              type="button"
              data-testid="open-b"
              onClick={() => {
                setB(true);
              }}
            >
              more
            </button>
            <Dialog
              open={b}
              title="B"
              testId="b"
              onClose={() => {
                onB();
                setB(false);
              }}
            >
              <input data-testid="b-field" aria-label="b" />
            </Dialog>
          </Dialog>
        </>
      );
    }
    const openBoth = () => {
      openIt();
      const ob = q('open-b');
      ob?.focus();
      act(() => ob?.click());
    };

    it('the one opened from another sits above it; the one below goes inert, its scrim clear', () => {
      render(<Stack onA={vi.fn()} onB={vi.fn()} />);
      openBoth();
      expect(openDialogCount()).toBe(2);
      expect(q('a')?.hasAttribute('inert')).toBe(true);
      expect(q('b')?.hasAttribute('inert')).toBe(false);
      expect(q('a-scrim')?.hasAttribute('data-under')).toBe(true);
      expect(q('b-scrim')?.hasAttribute('data-under')).toBe(false);
      // opened from inside a modal: lifted to the top layer
      expect(q('b-scrim')?.parentElement?.getAttribute('data-layer')).toBe('top');
      expect(document.activeElement).toBe(q('b-field'));
    });

    it('Escape closes only the top one, then the next; focus walks back', async () => {
      const onA = vi.fn();
      const onB = vi.fn();
      render(<Stack onA={onA} onB={onB} />);
      openBoth();
      key(q('b-field'), 'Escape');
      await settle();
      expect(onB).toHaveBeenCalledTimes(1);
      expect(onA).not.toHaveBeenCalled();
      expect(q('a')?.hasAttribute('inert')).toBe(false);
      expect(q('a-scrim')?.hasAttribute('data-under')).toBe(false);
      expect(document.activeElement).toBe(q('open-b'));
      key(q('open-b'), 'Escape');
      await settle();
      expect(onA).toHaveBeenCalledTimes(1);
      expect(openDialogCount()).toBe(0);
      expect(document.activeElement).toBe(q('opener'));
    });

    it('an Escape from another modal above it is left to that modal', () => {
      const onClose = vi.fn();
      render(<Page onClose={onClose} />);
      openIt();
      const other = document.createElement('div');
      other.setAttribute('role', 'dialog');
      const field = document.createElement('input');
      other.append(field);
      document.body.append(other);
      key(field, 'Escape');
      expect(onClose).not.toHaveBeenCalled();
      other.remove();
    });
  });

  it('motion: fades and scales in from its centre; reduced motion drops the scale', () => {
    const css = readFileSync(join(import.meta.dirname, 'parts/dialog.css'), 'utf8');
    expect(css).toMatch(/@starting-style\s*{[\s\S]*?\.q-dialog\s*{[^}]*scale\(0\.97\)/);
    expect(css).toMatch(/transform-origin:\s*center/);
    // no bounce, no ease-in
    expect(css).not.toMatch(/ease-in\b|cubic-bezier\([^)]*-|cubic-bezier\([^)]*1\.[1-9]/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.q-dialog\s*{[^}]*transform:\s*none/);
    expect(css).toMatch(/:root\[data-motion='reduce'\] \.q-dialog\s*{[^}]*transform:\s*none/);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './controls';

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
});

const render = (node: React.ReactNode) => {
  root = createRoot(host);
  act(() => root?.render(node));
};
const btn = () => {
  const el = host.querySelector('button');
  if (!el) throw new Error('no button');
  return el;
};
const click = () => {
  act(() => {
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('Button', () => {
  it('defaults to a small secondary type=button', () => {
    render(<Button>Go</Button>);
    expect(btn().className).toBe('btn sm secondary');
    expect(btn().type).toBe('button');
  });

  it('takes size and variant into the class', () => {
    render(
      <Button size="lg" variant="primary">
        Go
      </Button>,
    );
    expect(btn().className).toBe('btn lg primary');
  });

  it('sets aria-pressed for a toggle, true and false', () => {
    render(<Button pressed>Go</Button>);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    act(() => root?.render(<Button pressed={false}>Go</Button>));
    expect(btn().getAttribute('aria-pressed')).toBe('false');
  });

  it('omits aria-pressed when not a toggle', () => {
    render(<Button>Go</Button>);
    expect(btn().hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps a disabled-with-reason button focusable, described and inert', () => {
    const onClick = vi.fn();
    render(
      <Button disabledReason="Add photos first" onClick={onClick}>
        Go
      </Button>,
    );
    expect(btn().getAttribute('aria-disabled')).toBe('true');
    expect(btn().hasAttribute('disabled')).toBe(false);
    const id = btn().getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(host.querySelector(`[id="${id}"]`)?.textContent).toBe('Add photos first');
    click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is busy: aria-busy, a spinner instead of the icon, clicks ignored', () => {
    const onClick = vi.fn();
    render(
      <Button busy icon="plus" onClick={onClick}>
        Go
      </Button>,
    );
    expect(btn().getAttribute('aria-busy')).toBe('true');
    expect(btn().querySelector('.spin')).not.toBeNull();
    expect(btn().querySelector('svg')).toBeNull();
    click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the icon when not busy and calls onClick', () => {
    const onClick = vi.fn();
    render(
      <Button icon="plus" onClick={onClick}>
        Go
      </Button>,
    );
    expect(btn().querySelector('svg')).not.toBeNull();
    expect(btn().querySelector('.spin')).toBeNull();
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses the native attribute for a plain disabled', () => {
    render(<Button disabled>Go</Button>);
    expect(btn().disabled).toBe(true);
    expect(btn().hasAttribute('aria-disabled')).toBe(false);
  });

  it('advertises its shortcut keys', () => {
    render(<Button shortcut="global.palette">Go</Button>);
    expect(btn().getAttribute('aria-keyshortcuts')).toMatch(/K/);
  });
});

describe('IconButton', () => {
  it('names itself from label and takes the icon variant', () => {
    render(<IconButton icon="plus" label="Add" />);
    expect(btn().getAttribute('aria-label')).toBe('Add');
    expect(btn().className.split(' ')).toContain('icon');
    expect(btn().className.split(' ')).toContain('btn');
  });
});

// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chip } from './Chip';

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
const render = (ui: ReactElement) => {
  act(() => {
    root.render(ui);
  });
};
function chip(): HTMLElement {
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no chip');
  return el;
}

describe('Chip', () => {
  it('tag gives class tag and the tone class', () => {
    render(<Chip kind="tag">RTK</Chip>);
    expect(chip().className).toBe('tag');
    expect(chip().textContent).toBe('RTK');
    render(
      <Chip kind="tag" tone="acc">
        RTK
      </Chip>,
    );
    expect(chip().className).toBe('tag acc');
  });

  it('status gives chip-status with a dot', () => {
    render(
      <Chip kind="status" tone="off">
        Idle
      </Chip>,
    );
    expect(chip().classList.contains('chip-status')).toBe(true);
    expect(chip().getAttribute('data-tone')).toBe('off');
    expect(chip().querySelector('.dot')).not.toBeNull();
    expect(chip().textContent).toBe('Idle');
  });

  it('sev gives class sev with --sev from the colour', () => {
    render(
      <Chip kind="sev" color="oklch(0.7 0.2 30)">
        High
      </Chip>,
    );
    expect(chip().classList.contains('sev')).toBe(true);
    expect(chip().style.getPropertyValue('--sev')).toBe('oklch(0.7 0.2 30)');
    expect(chip().textContent).toBe('High');
  });
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BottomSwitch } from './BottomSwitch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const render = (node: React.ReactNode) => {
  root ??= createRoot(host);
  act(() => root?.render(node));
};
const byId = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('the Dates | Footage switch', () => {
  it('keeps its test ids and names, with an icon and a word on each side', () => {
    render(<BottomSwitch slot="dates" />);
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Bottom timeline',
    );
    const dates = byId('bottom-switch-dates');
    const footage = byId('bottom-switch-footage');
    expect(dates?.getAttribute('aria-label')).toBe('Dates');
    expect(footage?.getAttribute('aria-label')).toBe('Footage');
    expect(dates?.getAttribute('aria-pressed')).toBe('true');
    expect(footage?.getAttribute('aria-pressed')).toBe('false');
    for (const b of [dates, footage]) {
      expect(b?.querySelector('svg')).not.toBeNull();
      // the word is the part a narrow bar drops; the name never depends on it
      const word = b?.querySelector('.tl-switch-label');
      expect(word?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(dates?.querySelector('.tl-switch-label')?.textContent).toBe('Dates');
  });

  it('a narrow bar keeps the icons alone (the container query on the bottom bar)', () => {
    // jsdom does not lay out container queries: the rule itself is checked
    const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.tl-wrap \{[^}]*container: tl-wrap \/ inline-size;/);
    const narrow = /@container tl-wrap \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(narrow).not.toBeNull();
    // the CI window with both sidebars open (a bar of about 380 px) is narrow
    expect(Number(narrow?.[1])).toBeGreaterThan(380);
    expect(narrow?.[2]).toMatch(/\.tl-switch-label \{\s*display: none;/);
    expect(narrow?.[2]).toMatch(/--tl-switch-w: 60px;/);
  });
});

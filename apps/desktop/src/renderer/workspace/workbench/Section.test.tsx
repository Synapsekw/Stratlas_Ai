// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Section } from './Section';
import { sectionStore, useSections } from './sectionState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
let api: ReturnType<typeof useSections> | undefined;

function Bar() {
  const s = useSections('measure');
  useEffect(() => {
    api = s;
  });
  return null;
}
function Page({ forceA }: { forceA?: boolean | undefined }) {
  return (
    <>
      <Bar />
      <Section id="a" bench="measure" title="Alpha" count={3} forceOpen={forceA}>
        <p>a-body</p>
      </Section>
      <Section id="b" bench="measure" title="Beta" defaultOpen>
        <p>b-body</p>
      </Section>
    </>
  );
}
const render = (forceA?: boolean) => {
  root = createRoot(host);
  act(() => root?.render(<Page forceA={forceA} />));
};
const head = (id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-testid="wb-section-${id}"] > button`);

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('Section', () => {
  it('starts collapsed unless defaultOpen, and shows the count', () => {
    render();
    expect(head('a')?.getAttribute('aria-expanded')).toBe('false');
    expect(head('b')?.getAttribute('aria-expanded')).toBe('true');
    expect(head('a')?.textContent).toContain('3');
  });

  it('toggles on click, and Enter and Space on the button', () => {
    render();
    act(() => head('a')?.click());
    expect(head('a')?.getAttribute('aria-expanded')).toBe('true');
    // a native button turns Enter and Space into click; assert the header is that button
    expect(head('a')?.tagName).toBe('BUTTON');
    expect(head('a')?.type).toBe('button');
    act(() => head('a')?.click());
    expect(head('a')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a closed body out of the tab order', () => {
    render();
    expect(
      host
        .querySelector('#' + CSS.escape(head('a')?.getAttribute('aria-controls') ?? ''))
        ?.hasAttribute('inert'),
    ).toBe(true);
  });

  it('remembers state across a remount', () => {
    render();
    act(() => head('a')?.click());
    act(() => head('b')?.click());
    act(() => root?.unmount());
    render();
    expect(head('a')?.getAttribute('aria-expanded')).toBe('true');
    expect(head('b')?.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('quadrion.sections')).toContain('"measure"');
  });

  it('collapses all, then expands all', () => {
    render();
    act(() => api?.collapseAll());
    expect(head('a')?.getAttribute('aria-expanded')).toBe('false');
    expect(head('b')?.getAttribute('aria-expanded')).toBe('false');
    act(() => api?.expandAll());
    expect(head('a')?.getAttribute('aria-expanded')).toBe('true');
    expect(head('b')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('forceOpen keeps a section open after collapse all, and releases to the saved state', () => {
    render(true);
    act(() => api?.collapseAll());
    expect(head('a')?.getAttribute('aria-expanded')).toBe('true');
    expect(head('b')?.getAttribute('aria-expanded')).toBe('false');
    act(() => root?.render(<Page />));
    expect(head('a')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders actions outside the toggle button', () => {
    let clicks = 0;
    root = createRoot(host);
    act(() =>
      root?.render(
        <Section
          id="c"
          bench="measure"
          title="Gamma"
          testId="custom-c"
          actions={
            <button type="button" data-testid="c-act" onClick={() => (clicks += 1)}>
              eye
            </button>
          }
        >
          <p>c-body</p>
        </Section>,
      ),
    );
    const section = host.querySelector<HTMLElement>('[data-testid="custom-c"]');
    const toggle = section?.querySelector<HTMLButtonElement>(':scope > button');
    const action = host.querySelector<HTMLButtonElement>('[data-testid="c-act"]');
    expect(toggle?.contains(action ?? null)).toBe(false);
    expect(action?.closest('.wb-section-actions')?.parentElement).toBe(section);
    act(() => action?.click());
    expect(clicks).toBe(1);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });
});

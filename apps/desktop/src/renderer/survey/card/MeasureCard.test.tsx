// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardModel } from './cardModel';
import { MeasureCard } from './MeasureCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL: CardModel = {
  icon: 'ruler',
  name: 'Haul ramp',
  tool: 'Distance',
  scope: { label: 'October', capture: 'oct' },
  colour: '#ef476f',
  colourName: 'Red',
  primary: { label: 'Slope length', text: '142.6 m' },
  secondary: 'Horizontal length 140.9 m · Height change 21.4 m · Grade 15.2 %',
  more: [
    { label: 'Horizontal length', text: '140.9 m' },
    { label: 'Slope length', text: '142.6 m' },
    { label: 'Terrain length', text: '143.0 m' },
    { label: 'Bearing', text: `045°30'00"` },
  ],
};

const SLOTS = {
  chips: <div data-testid="slot-chips" />,
  chart: <svg data-testid="slot-chart" />,
  detail: <div data-testid="slot-detail" />,
};

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/** Type into a controlled input the way React sees it. */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const press = (el: Element, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

describe('MeasureCard', () => {
  it('live variant shows header, primary, secondary only', () => {
    mount(
      <MeasureCard
        model={MODEL}
        variant="live"
        slots={SLOTS}
        actions={<div data-testid="slot-actions" />}
        onRename={() => undefined}
      />,
    );
    expect(q('card-name')).not.toBeNull();
    expect(q('card-primary')?.textContent).toContain('142.6');
    expect(q('card-primary')?.textContent).toContain('m');
    expect(q('card-secondary')?.textContent).toBe(MODEL.secondary);
    for (const gone of ['slot-chips', 'slot-chart', 'slot-detail', 'slot-actions', 'card-more'])
      expect(q(gone), gone).toBeNull();
  });

  it('detail variant shows every part in order', () => {
    mount(
      <MeasureCard
        model={MODEL}
        variant="detail"
        slots={SLOTS}
        actions={<div data-testid="slot-actions" />}
        menu={<button type="button" data-testid="slot-menu" />}
        testId="mc"
      />,
    );
    const order = [
      'card-name',
      'card-scope',
      'card-colour',
      'slot-menu',
      'card-primary',
      'card-secondary',
      'card-more',
      'slot-chips',
      'slot-chart',
      'slot-detail',
      'slot-actions',
    ].map((id) => {
      const el = q(id);
      if (!el) throw new Error(`no ${id}`);
      return el;
    });
    order.forEach((el, i) => {
      const next = order[i + 1];
      if (next) expect(el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);
    });
    expect(q('mc')?.getAttribute('data-variant')).toBe('detail');
    expect(q('card-scope')?.textContent).toBe('October');
  });

  it('report variant renders to static markup with no buttons', () => {
    const html = renderToStaticMarkup(
      <MeasureCard
        model={MODEL}
        variant="report"
        slots={SLOTS}
        actions={<button type="button">Fly to</button>}
        menu={<button type="button">More</button>}
        onRename={() => undefined}
      />,
    );
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).toContain('Haul ramp');
    expect(html).toContain('142.6');
    expect(html).toContain(MODEL.secondary);
    expect(html).toContain('data-testid="slot-chart"');
    expect(html).not.toContain('slot-chips');
    expect(html).not.toContain('slot-detail');
  });

  it('More unfolds the full readout', () => {
    mount(<MeasureCard model={MODEL} variant="detail" />);
    const more = q('card-more') as HTMLButtonElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(q('card-readout')).toBeNull();
    act(() => {
      more.click();
    });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const rows = [...(q('card-readout')?.querySelectorAll('tr') ?? [])];
    expect(rows.map((r) => r.textContent)).toEqual(MODEL.more.map((r) => `${r.label}${r.text}`));
    act(() => {
      more.click();
    });
    expect(q('card-readout')).toBeNull();
  });

  it('rename commits on Enter and caps at 200', () => {
    const onRename = vi.fn();
    mount(<MeasureCard model={MODEL} variant="detail" onRename={onRename} />);
    const input = q('card-name') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.maxLength).toBe(200);
    type(input, 'East ramp');
    expect(onRename).not.toHaveBeenCalled();
    press(input, 'Enter');
    expect(onRename).toHaveBeenLastCalledWith('East ramp');
    type(input, 'x'.repeat(250));
    press(input, 'Enter');
    expect(onRename).toHaveBeenLastCalledWith('x'.repeat(200));
    // Escape puts the name back and commits nothing
    type(input, 'Scrap');
    press(input, 'Escape');
    expect(input.value).toBe('Haul ramp');
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it('keeps focus in the name when the saved name comes back', () => {
    const onRename = vi.fn();
    mount(<MeasureCard model={MODEL} variant="detail" onRename={onRename} />);
    const input = q('card-name') as HTMLInputElement;
    act(() => {
      input.focus();
    });
    type(input, 'East ramp');
    press(input, 'Enter');
    expect(onRename).toHaveBeenCalledWith('East ramp');
    act(() =>
      root?.render(
        <MeasureCard
          model={{ ...MODEL, name: 'East ramp' }}
          variant="detail"
          onRename={onRename}
        />,
      ),
    );
    expect(q('card-name')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('East ramp');
  });

  it('names the swatch with its colour', () => {
    mount(<MeasureCard model={MODEL} variant="detail" />);
    expect(q('card-colour')?.getAttribute('aria-label')).toBe('Colour, Red');
  });

  it('shows the name as text when it cannot be renamed', () => {
    mount(<MeasureCard model={MODEL} variant="detail" />);
    expect(q('card-name')?.tagName).not.toBe('INPUT');
    expect(q('card-name')?.textContent).toBe('Haul ramp');
  });
});

describe('the card names its measurement', () => {
  it('carries the measurement id its chart is exported by, and none while drawing', () => {
    expect(
      renderToStaticMarkup(<MeasureCard model={MODEL} variant="detail" measureId="m1" />),
    ).toContain('data-measure-id="m1"');
    expect(renderToStaticMarkup(<MeasureCard model={MODEL} variant="live" />)).not.toContain(
      'data-measure-id',
    );
  });
});

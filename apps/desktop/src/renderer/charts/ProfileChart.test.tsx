// @vitest-environment jsdom
import type { SurveyPrecision, SurveyUnits } from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileChart, type ProfileChartProps } from './ProfileChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRIC: SurveyUnits = {
  distance: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 't',
  grade: 'percent',
};
const IMPERIAL: SurveyUnits = {
  distance: 'ft',
  area: 'ft2',
  volume: 'yd3',
  density: 'lb/ft3',
  mass: 'ston',
  grade: 'percent',
};
const PRECISION: SurveyPrecision = { coordinate: 3, distance: 2, area: 1, volume: 1, grade: 1 };

const CH = [0, 10, 20, 30, 40];
const current: ChartSeries = {
  key: 'cap-2',
  label: '05 Oct',
  kind: 'current',
  date: '2026-10-05',
  chainage: CH,
  z: [100, 102, 104, 102, 100],
};
const earlier: ChartSeries = {
  key: 'cap-1',
  label: '01 Sep',
  kind: 'earlier',
  date: '2026-09-01',
  chainage: CH,
  z: [100, 101, 101, 101, 100],
};
const design: ChartSeries = {
  key: 'design-1',
  label: 'Design',
  kind: 'design',
  chainage: CH,
  z: [101, 103, 105, 103, 101],
};

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function render(p: Partial<ProfileChartProps> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const props: ProfileChartProps = {
    series: [design, earlier, current],
    shadeVs: null,
    exaggeration: 1,
    ends: { a: 'A', b: 'B' },
    units: METRIC,
    precision: PRECISION,
    width: 600,
    height: 240,
    ...p,
  };
  act(() => root?.render(<ProfileChart {...props} />));
  return host;
}

const svgOf = (h: HTMLElement) => {
  const svg = h.querySelector('svg');
  if (!svg) throw new Error('no svg');
  return svg;
};
const line = (h: HTMLElement, key: string) => h.querySelector(`polyline[data-series="${key}"]`);
/** The x of the current line's sample `i`, in the svg's own pixels (jsdom rects sit at 0). */
const sampleX = (h: HTMLElement, i: number) => {
  const pts = line(h, 'cap-2')?.getAttribute('points')?.split(' ') ?? [];
  return Number(pts[i]?.split(',')[0]);
};
const move = (h: HTMLElement, clientX: number) => {
  act(() => {
    svgOf(h).dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY: 50 }));
  });
};
const readout = (h: HTMLElement) => h.querySelector('[data-testid="chart-readout"]');

describe('ProfileChart', () => {
  it('draws current solid and design dashed regardless of order', () => {
    for (const order of [
      [current, design, earlier],
      [design, earlier, current],
    ]) {
      const h = render({ series: order });
      const cur = line(h, 'cap-2');
      const des = line(h, 'design-1');
      const old = line(h, 'cap-1');
      expect(cur?.getAttribute('stroke')).toBe('var(--chart-current)');
      expect(cur?.getAttribute('stroke-dasharray') ?? '').toBe('');
      expect(des?.getAttribute('stroke')).toBe('var(--chart-design)');
      expect(des?.getAttribute('stroke-dasharray')).toBe('6 4');
      expect(old?.getAttribute('stroke')).toBe('var(--chart-earlier)');
      // the current line draws last, on top
      const keys = [...h.querySelectorAll('polyline[data-series]')].map((p) =>
        p.getAttribute('data-series'),
      );
      expect(keys.at(-1)).toBe('cap-2');
      act(() => root?.unmount());
      root = undefined;
      host.remove();
    }
    host = document.createElement('div');
  });

  it('shades cut and fill against the chosen surface and prints both areas', () => {
    const areas = (el: HTMLElement) =>
      el.querySelector('[data-testid="chart-areas"]')?.textContent ?? '';
    const again = () => {
      act(() => root?.unmount());
      root = undefined;
      host.remove();
    };
    // a design goes from the current to the design: the current 1 m below it is all fill
    let h = render({ shadeVs: 'design-1' });
    expect(h.querySelectorAll('polygon.pc-fill').length).toBeGreaterThan(0);
    expect(h.querySelectorAll('polygon.pc-cut').length).toBe(0);
    expect(areas(h)).toContain('Cut 0.0 m²');
    expect(areas(h)).toContain('Fill 40.0 m²'); // 1 m over 40 m
    again();

    // the current 1 m above a design is all cut (the pile above the design, as in the mockup)
    const low: ChartSeries = { ...design, key: 'design-low', z: [99, 101, 103, 101, 99] };
    h = render({ series: [low, current], shadeVs: 'design-low' });
    expect(h.querySelectorAll('polygon.pc-cut').length).toBeGreaterThan(0);
    expect(h.querySelectorAll('polygon.pc-fill').length).toBe(0);
    expect(areas(h)).toContain('Cut 40.0 m²');
    expect(areas(h)).toContain('Fill 0.0 m²');
    again();

    // an earlier date goes from it to the current: the current above it is fill
    h = render({ shadeVs: 'cap-1' });
    expect(h.querySelectorAll('polygon.pc-fill').length).toBeGreaterThan(0);
    expect(h.querySelectorAll('polygon.pc-cut').length).toBe(0);
    expect(areas(h)).toContain('Cut 0.0 m²');
    expect(areas(h)).toContain('Fill 50.0 m²'); // 0,1,3,1,0 m over 10 m steps
    const fill = h.querySelector('polygon.pc-fill');
    expect(fill?.getAttribute('fill')).toBeNull(); // the colour comes from charts.css tokens

    // no target: no shading and no areas
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    h = render({ shadeVs: null });
    expect(h.querySelectorAll('polygon').length).toBe(0);
    expect(h.querySelector('[data-testid="chart-areas"]')).toBeNull();
  });

  it('axis labels and hover follow imperial units', () => {
    const h = render({ units: IMPERIAL });
    const text = svgOf(h).textContent;
    expect(text).toContain('Elevation (ft)');
    expect(text).toContain('Chainage (ft)');
    expect(text).toContain('A → B');
    expect(text).toContain('Vertical exaggeration 1:1');
    // elevation ticks are in feet: 100 m is about 328 ft
    const ticks = [...h.querySelectorAll('[data-axis="z"] text')].map((t) => Number(t.textContent));
    expect(Math.min(...ticks)).toBeGreaterThan(300);
    move(h, sampleX(h, 2));
    const r = readout(h)?.textContent ?? '';
    // chainage 20 m = 65.62 ft; current at 104 m = 341.21 ft
    expect(r).toContain('65.62 ft');
    expect(r).toContain('341.21 ft');
    expect(r).not.toContain(' m');
  });

  it('shaded against the date before, the change shows once: the Δ line, no Difference row', () => {
    const h = render({ shadeVs: 'cap-1' });
    move(h, sampleX(h, 1) + (sampleX(h, 2) - sampleX(h, 1)) / 2); // chainage 15
    const r = readout(h);
    expect(r?.querySelector('[data-testid="chart-delta"]')?.textContent).toContain('+2.00 m');
    expect(r?.querySelector('[data-row="diff"]')).toBeNull();
    expect(r?.querySelector('[data-row="grade"]')).not.toBeNull();
  });

  it('hover readout lists every visible surface, difference and grade', () => {
    const h = render({ shadeVs: 'design-1' });
    expect(h.querySelector('[data-testid="chart-crosshair"]')).toBeNull();
    move(h, sampleX(h, 1) + (sampleX(h, 2) - sampleX(h, 1)) / 2); // chainage 15
    expect(h.querySelector('[data-testid="chart-crosshair"]')).not.toBeNull();
    const r = readout(h);
    const txt = r?.textContent ?? '';
    expect(txt).toContain('15.00 m');
    for (const label of ['05 Oct', '01 Sep', 'Design']) expect(txt).toContain(label);
    expect(txt).toContain('103.00 m'); // current at 15
    expect(txt).toContain('101.00 m'); // earlier at 15
    expect(txt).toContain('Difference');
    expect(r?.querySelector('[data-row="diff"]')?.textContent).toContain('1.00 m'); // 103 - 104
    expect(txt).toContain('Grade');
    expect(txt).toContain('20.0 %'); // 2 m over 10 m
    // one dot per surface with data
    expect(h.querySelectorAll('[data-testid="chart-crosshair"] circle').length).toBe(3);
    // one accessible name (on the focusable plot, not again on the svg), and a polite live copy
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    expect(plot?.getAttribute('aria-label')).toBe('Profile from A to B, vertical exaggeration 1:1');
    expect(svgOf(h).hasAttribute('aria-label')).toBe(false);
    const live = h.querySelector('[data-testid="chart-live"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('15.00 m, Difference -1.00 m');
    // blur while the pointer is still over the plot keeps the crosshair
    act(() => plot?.focus());
    act(() => plot?.blur());
    expect(readout(h)).not.toBeNull();
    act(() => {
      // React derives pointerleave from pointerout with the element left for
      svgOf(h).dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(readout(h)).toBeNull();
    expect(live?.textContent).toBe('');
  });

  it('Escape clears the crosshair and goes no further', () => {
    const h = render();
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    act(() => plot?.focus());
    let heard = 0;
    const outer = () => {
      heard++;
    };
    document.body.addEventListener('keydown', outer);
    act(() => {
      plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(heard).toBe(0);
    document.body.removeEventListener('keydown', outer);
  });

  it('numbers group by the locale given, as the cards do', () => {
    const big: ChartSeries = { ...current, chainage: [0, 1500, 3000], z: [1, 2, 3] };
    const h = render({ series: [big], locale: 'imperial' });
    expect(h.textContent).toMatch(/1,000/);
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    expect(render({ series: [big], locale: 'metric' }).textContent).toMatch(/1 000/);
  });

  it('arrow keys move the crosshair one sample', () => {
    const h = render();
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    expect(plot?.tabIndex).toBe(0);
    act(() => plot?.focus());
    expect(readout(h)?.textContent).toContain('0.00 m');
    const key = (k: string) => {
      act(() => {
        plot?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };
    key('ArrowRight');
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 10.00 m');
    key('ArrowRight');
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 20.00 m');
    key('ArrowLeft');
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 10.00 m');
    key('End');
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 40.00 m');
    key('ArrowRight'); // stays at the last sample
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 40.00 m');
  });

  it('click pins at the chainage under the pointer', () => {
    const onPin = vi.fn();
    const h = render({
      onPin,
      pins: [
        {
          chainage: 30,
          e: 0,
          n: 0,
          reference: 0,
          values: [{ key: 'cap-2', label: '05 Oct', z: 102, delta: null, grade: null }],
        },
      ],
    });
    expect(h.querySelectorAll('[data-testid="section-chart-pin"]').length).toBe(1);
    const x = sampleX(h, 2);
    act(() => {
      svgOf(h).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: 50 }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin.mock.calls[0]?.[0]).toBeCloseTo(20, 6);
    // the keyboard pins too: Enter at the crosshair
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    act(() => plot?.focus());
    act(() => {
      plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPin).toHaveBeenLastCalledWith(0);
  });

  it('controlled hoverAt draws the crosshair without a pointer', () => {
    let h = render({ hoverAt: 20 });
    expect(h.querySelector('[data-testid="chart-crosshair"]')).not.toBeNull();
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 20.00 m');
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    // controlled null: a pointer move asks, but the chart waits for the owner
    const onHover = vi.fn();
    h = render({ hoverAt: null, onHover });
    expect(h.querySelector('[data-testid="chart-crosshair"]')).toBeNull();
    move(h, sampleX(h, 2));
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(h.querySelector('[data-testid="chart-crosshair"]')).toBeNull();
  });

  it('pointer move calls onHover with the chainage', () => {
    const onHover = vi.fn();
    const h = render({ onHover });
    move(h, sampleX(h, 2));
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover.mock.calls[0]?.[0]).toBeCloseTo(20, 6);
    act(() => {
      svgOf(h).dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('click calls onPinAt, a second click on the pin clears it', () => {
    const onPinAt = vi.fn();
    const onPin = vi.fn();
    const h = render({ onPinAt, onPin });
    const click = (x: number) => {
      act(() => {
        svgOf(h).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: 50 }));
      });
    };
    click(sampleX(h, 2));
    expect(onPinAt).toHaveBeenCalledTimes(1);
    expect(onPinAt.mock.calls[0]?.[0]).toBeCloseTo(20, 6);
    // pinned: a solid accent crosshair with a pin badge, held while the pointer moves away
    expect(h.querySelector('[data-testid="chart-pin-mark"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="chart-pin-badge"]')?.textContent).toBe(
      '20.00 m · pinned',
    );
    move(h, sampleX(h, 4));
    expect(h.querySelector('[data-testid="chart-pin-mark"]')).not.toBeNull();
    click(sampleX(h, 2) + 2);
    expect(onPinAt).toHaveBeenLastCalledWith(null);
    expect(h.querySelector('[data-testid="chart-pin-mark"]')).toBeNull();
    // section pins are no longer made by a click when the chart pins its point
    expect(onPin).not.toHaveBeenCalled();
  });

  it('a controlled pinnedAt shows the pin and the readout without a pointer', () => {
    const h = render({ pinnedAt: 30, onPinAt: vi.fn() });
    expect(h.querySelector('[data-testid="chart-pin-badge"]')?.textContent).toBe(
      '30.00 m · pinned',
    );
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 30.00 m');
  });

  it('double-click calls onFly', () => {
    const onFly = vi.fn();
    const h = render({ onFly });
    act(() => {
      svgOf(h).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: sampleX(h, 3), clientY: 50 }),
      );
    });
    expect(onFly).toHaveBeenCalledTimes(1);
    expect(onFly.mock.calls[0]?.[0]).toBeCloseTo(30, 6);
  });

  it('a double-click leaves the point pinned there and flies', () => {
    const onPinAt = vi.fn();
    const onFly = vi.fn();
    const h = render({ onPinAt, onFly });
    const x = sampleX(h, 3);
    // the browser's order: click (detail 1), click (detail 2), dblclick
    for (const [type, detail] of [
      ['click', 1],
      ['click', 2],
      ['dblclick', 2],
    ] as const)
      act(() => {
        svgOf(h).dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: x, clientY: 50, detail }),
        );
      });
    expect(onFly).toHaveBeenCalledTimes(1);
    expect(onFly.mock.calls[0]?.[0]).toBeCloseTo(30, 6);
    expect(onPinAt).not.toHaveBeenCalledWith(null);
    expect(onPinAt.mock.lastCall?.[0]).toBeCloseTo(30, 6);
    expect(h.querySelector('[data-testid="chart-pin-badge"]')?.textContent).toBe(
      '30.00 m · pinned',
    );
  });

  it('the readout shows chainage, both elevations and Δ cut', () => {
    const before: ChartSeries = { ...earlier, z: [100, 103, 105, 103, 100] };
    const h = render({ series: [before, current], hoverAt: 20 });
    const r = readout(h);
    expect(r?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 20.00 m');
    expect(r?.querySelector('[data-row="cap-2"]')?.textContent).toBe('05 Oct104.00 m');
    expect(r?.querySelector('[data-row="cap-1"]')?.textContent).toBe('01 Sep105.00 m');
    const d = h.querySelector('[data-testid="chart-delta"]');
    expect(d?.textContent).toBe('Δ −1.00 m cut');
    expect(d?.getAttribute('data-kind')).toBe('cut');
    // the two dots joined by a dashed gap
    expect(h.querySelector('[data-testid="chart-gap"]')).not.toBeNull();
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    // later higher is fill
    const h2 = render({ series: [earlier, current], hoverAt: 20 });
    expect(h2.querySelector('[data-testid="chart-delta"]')?.textContent).toBe('Δ +3.00 m fill');
  });

  it('a 0.02 m difference draws no gap line', () => {
    const near: ChartSeries = { ...earlier, z: current.z.map((z) => (z ?? 0) - 0.02) };
    const h = render({ series: [near, current], hoverAt: 20 });
    expect(h.querySelectorAll('[data-testid="chart-crosshair"] circle').length).toBe(2);
    expect(h.querySelector('[data-testid="chart-gap"]')).toBeNull();
    expect(h.querySelector('[data-testid="chart-delta"]')?.textContent).toBe('Δ +0.02 m fill');
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    // one survey: no delta at all
    const one = render({ series: [current], hoverAt: 20 });
    expect(one.querySelector('[data-testid="chart-delta"]')).toBeNull();
    expect(one.querySelector('[data-testid="chart-gap"]')).toBeNull();
  });

  it('Esc clears the pin and then the hover', () => {
    const onPinAt = vi.fn();
    const onHover = vi.fn();
    const h = render({ onPinAt, onHover });
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    move(h, sampleX(h, 2));
    act(() => {
      svgOf(h).dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: sampleX(h, 2), clientY: 50 }),
      );
    });
    expect(h.querySelector('[data-testid="chart-pin-mark"]')).not.toBeNull();
    const esc = () => {
      act(() => {
        plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    };
    esc();
    expect(onPinAt).toHaveBeenLastCalledWith(null);
    expect(h.querySelector('[data-testid="chart-pin-mark"]')).toBeNull();
    expect(readout(h)).not.toBeNull();
    esc();
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(readout(h)).toBeNull();
  });

  it('static render (width given, interactive false) has no crosshair and no listeners', () => {
    const onPin = vi.fn();
    const ro = vi.fn();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor() {
        ro();
      }
      observe = vi.fn();
      disconnect = vi.fn();
    };
    try {
      const h = render({ interactive: false, onPin, width: 688, height: 200, shadeVs: 'cap-1' });
      expect(ro).not.toHaveBeenCalled();
      expect(svgOf(h).getAttribute('width')).toBe('688');
      const plot = h.querySelector('[data-testid="chart-plot"]');
      expect(plot?.hasAttribute('tabindex')).toBe(false);
      // static, the svg itself is the named image
      expect(svgOf(h).getAttribute('role')).toBe('img');
      expect(svgOf(h).getAttribute('aria-label')).toBe(
        'Profile from A to B, vertical exaggeration 1:1',
      );
      expect(h.querySelector('[data-testid="chart-live"]')).toBeNull();
      move(h, sampleX(h, 2));
      act(() => {
        svgOf(h).dispatchEvent(
          new MouseEvent('click', { bubbles: true, clientX: sampleX(h, 2), clientY: 50 }),
        );
      });
      expect(h.querySelector('[data-testid="chart-crosshair"]')).toBeNull();
      expect(readout(h)).toBeNull();
      expect(onPin).not.toHaveBeenCalled();
      // the report still gets the shading and the areas
      expect(h.querySelectorAll('polygon.pc-fill').length).toBeGreaterThan(0);
      expect(h.querySelector('[data-testid="chart-areas"]')).not.toBeNull();
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  it("the readout's own button keeps the crosshair and its keys", () => {
    const onHover = vi.fn();
    const onPinAt = vi.fn();
    const onAction = vi.fn();
    const h = render({
      pinnedAt: 30,
      onPinAt,
      onHover,
      readoutAction: (
        <button type="button" data-testid="ro-action" onClick={onAction}>
          Add pin here
        </button>
      ),
    });
    const button = h.querySelector<HTMLButtonElement>('[data-testid="ro-action"]');
    expect(button).not.toBeNull();
    // a press focuses the button: the crosshair does not jump to the line's start
    act(() => button?.focus());
    expect(onHover).not.toHaveBeenCalled();
    expect(readout(h)?.querySelector('.pc-ro-head')?.textContent).toBe('Chainage 30.00 m');
    // Enter on the button is the button's, not the chart's pin
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      button?.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(onPinAt).not.toHaveBeenCalled();
    act(() => button?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("F flies to the keyboard crosshair and the keys are told in the chart's help", () => {
    const onFly = vi.fn();
    const h = render({ onFly, onPinAt: vi.fn() });
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    act(() => plot?.focus());
    const key = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      act(() => {
        plot?.dispatchEvent(e);
      });
      return e;
    };
    key('ArrowRight');
    key('ArrowRight');
    expect(key('f').defaultPrevented).toBe(true);
    expect(onFly).toHaveBeenCalledWith(20);
    key('F');
    expect(onFly).toHaveBeenCalledTimes(2);
    // with a modifier it is someone else's shortcut
    const ctrl = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true });
    act(() => {
      plot?.dispatchEvent(ctrl);
    });
    expect(onFly).toHaveBeenCalledTimes(2);
    const help = (plot?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(help).toContain('Enter pins');
    expect(help).toContain('F flies');
  });

  it('without onFly, F does nothing and the help leaves it out', () => {
    const h = render({ onPinAt: vi.fn() });
    const plot = h.querySelector<HTMLElement>('[data-testid="chart-plot"]');
    act(() => plot?.focus());
    const e = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
    act(() => {
      plot?.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    const help = (plot?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(help).not.toContain('F flies');
  });
});

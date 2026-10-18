// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalkDetOverlay, type OverlayBox } from './WalkDetOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const det = (id: string, x: number): Detection => ({
  id,
  pass: 'model-1.json',
  source: { kind: 'frame', layer: 'w', t: 2 },
  size: [2000, 1000],
  geom: { type: 'box', x, y: 480, w: 40, h: 40 },
  classId: 'helmet',
  severity: null,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'model', producer: 'local' },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const render = (boxes: OverlayBox[]) => {
  act(() => {
    root.render(
      <WalkDetOverlay
        boxes={boxes}
        look={{ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }}
        width={800}
        height={600}
      />,
    );
  });
};

describe('the detection overlay of the 360 view', () => {
  it('draws the boxes in front of the camera with their label chip and leaves out those behind', () => {
    render([
      { detection: det('front', 980), color: '#3adaf2', label: 'Helmet 87%', title: 'Helmet 87%' },
      { detection: det('behind', 0), color: '#3adaf2', label: 'Helmet 50%' },
    ]);
    expect(host.querySelector('[data-testid="walk-det-overlay"]')).not.toBeNull();
    const shown = [...host.querySelectorAll('[data-testid="walk-det-box"]')];
    expect(shown.map((g) => g.getAttribute('data-id'))).toEqual(['front']);
    // the line in the class colour over its dark halo, and the tooltip
    expect(shown[0]?.querySelector('polygon.line')).not.toBeNull();
    expect(shown[0]?.querySelector('polygon.halo')).not.toBeNull();
    expect(shown[0]?.getAttribute('style')).toContain('#3adaf2');
    expect(shown[0]?.querySelector('title')?.textContent).toBe('Helmet 87%');
    // one chip, filled with the class colour, dark text on the light cyan
    const chips = [...host.querySelectorAll('.walk-det-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['Helmet 87%']);
    expect(chips[0]?.querySelector('rect')?.getAttribute('fill')).toContain('#3adaf2');
    expect(chips[0]?.querySelector('text')?.getAttribute('fill')).toContain('#15181d');
  });

  it('puts the chip above the box and keeps overlapping chips apart', () => {
    render([
      { detection: det('a', 990), color: '#3adaf2', label: 'Helmet 87%' },
      { detection: det('b', 995), color: '#f25820', label: 'No safety jacket 78%' },
    ]);
    const box = (id: string) => {
      const pts = (
        host.querySelector(`[data-id="${id}"] polygon.line`)?.getAttribute('points') ?? ''
      )
        .split(' ')
        .map((p) => p.split(',').map(Number));
      return {
        left: Math.min(...pts.map((p) => p[0] ?? 0)),
        top: Math.min(...pts.map((p) => p[1] ?? 0)),
      };
    };
    const at = (id: string) => {
      const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(
        host.querySelector(`.walk-det-chip[data-id="${id}"]`)?.getAttribute('transform') ?? '',
      );
      return { x: Number(m?.[1]), y: Number(m?.[2]) };
    };
    const b = box('b');
    // b is drawn last, so its chip is placed first, just above its box
    expect(at('b').x).toBeCloseTo(b.left, 0);
    expect(at('b').y).toBeCloseTo(b.top - 18, 0);
    // a's chip would cover b's: it moves up above it
    expect(at('a').y).toBeLessThanOrEqual(at('b').y - 18);
  });

  it('thickens the hovered box and draws it on top', () => {
    render([
      { detection: det('a', 980), color: '#3adaf2', label: 'Helmet 87%' },
      { detection: det('b', 1000), color: '#f25820', label: 'No helmet 60%' },
    ]);
    const ids = () =>
      [...host.querySelectorAll('[data-testid="walk-det-box"]')].map((g) =>
        g.getAttribute('data-id'),
      );
    expect(ids()).toEqual(['a', 'b']);
    const a = host.querySelector('[data-testid="walk-det-box"][data-id="a"]');
    act(() => {
      a?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    expect(ids()).toEqual(['b', 'a']);
    expect(host.querySelector('[data-id="a"]')?.classList.contains('hov')).toBe(true);
  });
});

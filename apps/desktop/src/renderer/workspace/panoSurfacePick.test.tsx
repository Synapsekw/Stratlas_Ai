// @vitest-environment jsdom
import type { PanoLook } from '@aio/engine';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./panoView', () => ({
  createPanoImageView: () => ({
    setImage: () => undefined,
    setLook: () => undefined,
    dispose: () => undefined,
  }),
}));

import { PanoSurface } from './panoSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

function mount(look: PanoLook, extra: { onPickBearing?: (deg: number) => void }) {
  const onLook = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <PanoSurface
        url="x"
        headingDeg={0}
        cov={null}
        look={look}
        label="pano"
        onLook={onLook}
        {...extra}
      />,
    ),
  );
  const el = host.querySelector<HTMLElement>('[role="img"]');
  if (!el) throw new Error('missing surface');
  // jsdom has no layout: a 800 x 400 box at the origin
  el.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
  Object.defineProperty(el, 'clientHeight', { value: 400 });
  return { el, onLook };
}
const fire = (el: HTMLElement, type: string, x: number, y: number) => {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  });
};

const LOOK: PanoLook = { yawDeg: 30, pitchDeg: 0, fovDeg: 70 };

describe('PanoSurface landmark click', () => {
  it('reports the bearing of a click at the centre', () => {
    const onPickBearing = vi.fn();
    const { el } = mount(LOOK, { onPickBearing });
    fire(el, 'pointerdown', 400, 200);
    fire(el, 'pointerup', 400, 200);
    expect(onPickBearing).toHaveBeenCalledTimes(1);
    expect(onPickBearing.mock.calls[0]?.[0]).toBeCloseTo(30);
    expect(el.dataset.picking).toBe('true');
  });

  it('a 20 px drag still turns the view and picks nothing', () => {
    const onPickBearing = vi.fn();
    const { el, onLook } = mount(LOOK, { onPickBearing });
    fire(el, 'pointerdown', 400, 200);
    fire(el, 'pointermove', 420, 200);
    fire(el, 'pointerup', 420, 200);
    expect(onLook).toHaveBeenCalled();
    expect(onPickBearing).not.toHaveBeenCalled();
  });

  it('does nothing new without onPickBearing', () => {
    const { el, onLook } = mount(LOOK, {});
    fire(el, 'pointerdown', 400, 200);
    fire(el, 'pointerup', 400, 200);
    expect(onLook).not.toHaveBeenCalled();
    expect(el.dataset.picking).toBeUndefined();
  });
});

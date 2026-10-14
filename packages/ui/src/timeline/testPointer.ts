import { act } from 'react';

/** jsdom has no pointer capture; the timelines only need it to exist. */
function stubPointerCapture() {
  const proto = Element.prototype as Partial<Element>;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
}

function pointer(type: string, clientX: number, el: Element | null) {
  const ev = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  act(() => {
    el?.dispatchEvent(ev);
  });
}

/**
 * Drags the first camera direction keyframe through `xs` (down at the first, a move at each
 * other, up at the last), finding the diamond again before each event as a remount would lose it.
 */
export function dragKeyframe(host: HTMLElement, xs: readonly number[]): void {
  stubPointerCapture();
  const kf = () => host.querySelector('[data-testid="timeline-direction-key"]');
  const [first = 0, ...rest] = xs;
  pointer('pointerdown', first, kf());
  for (const x of rest) pointer('pointermove', x, kf());
  pointer('pointerup', rest[rest.length - 1] ?? first, kf());
}

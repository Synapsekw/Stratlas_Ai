import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FrameImage, FramesCompare, swipeAt, swipeKey, type FramesMode } from './FramesCompare';

const labels = { a: '1 Jan 2026', b: '1 Jun 2026', handle: 'Swipe', empty: 'No view' };

function html(mode: FramesMode, amount: number, b: boolean) {
  return renderToStaticMarkup(
    <FramesCompare
      a={<i>frame a</i>}
      b={b ? <i>frame b</i> : null}
      mode={mode}
      amount={amount}
      onAmount={() => undefined}
      aspect={1.5}
      labels={labels}
    />,
  );
}

describe('FramesCompare', () => {
  it('shows both dates side by side', () => {
    const h = html('side', 0.5, true);
    expect(h).toContain('data-mode="side"');
    expect(h).toContain('frame a');
    expect(h).toContain('frame b');
    expect(h).toContain('1 Jan 2026');
    expect(h).toContain('1 Jun 2026');
    expect(h).not.toMatch(/[–—]/);
  });

  it('says so when the other date has no view', () => {
    const h = html('side', 0.5, false);
    expect(h).toContain('No view');
    expect(h).not.toContain('frame b');
  });

  it('swipes: the later date right of the handle, a slider for the keyboard', () => {
    const h = html('swipe', 0.3, true);
    expect(h).toContain('data-mode="swipe"');
    expect(h).toContain('clip-path:inset(0 0 0 30%)');
    expect(h).toMatch(/role="slider"[^>]*aria-label="Swipe"/);
    expect(h).toContain('aria-valuenow="30"');
    expect(h).toContain('aspect-ratio:1.5');
  });

  it('blends the later date over the earlier one', () => {
    const h = html('blend', 0.5, true);
    expect(h).toContain('opacity:0.5');
    expect(h).not.toContain('role="slider"');
  });
});

describe('swipe handle', () => {
  it('follows the pointer, clamped to the box', () => {
    const box = { left: 100, width: 400 };
    expect(swipeAt(300, box)).toBe(0.5);
    expect(swipeAt(0, box)).toBe(0);
    expect(swipeAt(900, box)).toBe(1);
    expect(swipeAt(300, { left: 0, width: 0 })).toBe(0.5);
  });

  it('steps with the arrow keys, further with Shift, to the ends with Home and End', () => {
    expect(swipeKey('ArrowRight', 0.5)).toBeCloseTo(0.55);
    expect(swipeKey('ArrowLeft', 0.5)).toBeCloseTo(0.45);
    expect(swipeKey('ArrowRight', 0.5, true)).toBeCloseTo(0.7);
    expect(swipeKey('ArrowLeft', 0.02)).toBe(0);
    expect(swipeKey('Home', 0.5)).toBe(0);
    expect(swipeKey('End', 0.5)).toBe(1);
    expect(swipeKey('a', 0.5)).toBeNull();
  });
});

describe('FrameImage', () => {
  it('shows a photo or a paused video frame at its time', () => {
    const photo = renderToStaticMarkup(
      <FrameImage kind="photo" src="aio://project/p/photos/a.jpg" missing="No footage" />,
    );
    expect(photo).toContain('<img');
    expect(photo).toContain('src="aio://project/p/photos/a.jpg"');
    const video = renderToStaticMarkup(
      <FrameImage kind="video" src="aio://project/p/video/b.mp4" t={12.5} missing="No footage" />,
    );
    expect(video).toContain('<video');
    expect(video).toContain('data-t="12.5"');
    expect(video).not.toContain('autoplay');
  });
});

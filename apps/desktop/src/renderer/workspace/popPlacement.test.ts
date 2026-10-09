import { describe, expect, it } from 'vitest';
import { placePop, type Box } from './popPlacement';

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

// the stage of the smallest window (1100 x 700) with both side panels open, as measured in the app
const STAGE = box(252, 74, 739, 673);
// and of the default window (1440 x 900)
const WIDE = box(252, 74, 1079, 872);
// the Survey measurements tool on the stage toolbar
const SURVEY = box(471, 86, 505, 120);

describe('placePop', () => {
  it('opens below its tool, aligned with its start, when it fits', () => {
    const p = placePop({
      area: WIDE,
      anchor: SURVEY,
      width: 300,
      height: 200,
      align: 'start',
      minTop: 128,
    });
    expect(p).toEqual({ left: 469, top: 128, maxWidth: 811, maxHeight: 736, scroll: false });
  });

  it('never runs under the timeline below the stage: it scrolls inside instead', () => {
    // the Survey measurements popover is 676 px tall, the stage leaves 537 px under the tool
    const p = placePop({
      area: STAGE,
      anchor: SURVEY,
      width: 346,
      height: 676,
      align: 'start',
      minTop: 128,
    });
    expect(p.top).toBe(128);
    expect(p.top + p.maxHeight).toBe(STAGE.bottom - 8);
    expect(p.scroll).toBe(true);
  });

  it('never runs under the Context panel right of the stage: it moves left', () => {
    // the Haul road panel (440 px) opens from a tool in the right half of the survey popover
    const p = placePop({
      area: STAGE,
      anchor: box(602, 160, 636, 185),
      width: 440,
      height: 458,
      align: 'start',
      minTop: 128,
    });
    expect(p.left + 440).toBeLessThanOrEqual(STAGE.right - 8);
    expect(p.left).toBe(STAGE.right - 8 - 440);
    expect(p.top).toBe(193);
    expect(p.scroll).toBe(false);
  });

  it('a nested panel too tall for the room under its tool moves up, not above its root popover', () => {
    const p = placePop({
      area: STAGE,
      anchor: box(602, 400, 636, 425),
      width: 440,
      height: 458,
      align: 'start',
      minTop: 128,
    });
    expect(p.top).toBe(STAGE.bottom - 8 - 458);
    expect(p.maxHeight).toBe(458);
    const tall = placePop({
      area: STAGE,
      anchor: box(602, 400, 636, 425),
      width: 440,
      height: 900,
      align: 'start',
      minTop: 128,
    });
    expect(tall.top).toBe(128);
    expect(tall.maxHeight).toBe(STAGE.bottom - 8 - 128);
    expect(tall.scroll).toBe(true);
  });

  it('keeps an end-aligned popover on its tool and inside the left edge', () => {
    const end = placePop({
      area: STAGE,
      anchor: box(690, 86, 724, 120),
      width: 240,
      height: 100,
      align: 'end',
      minTop: 128,
    });
    expect(end.left).toBe(724 + 2 - 240);
    const pushed = placePop({
      area: STAGE,
      anchor: box(270, 86, 304, 120),
      width: 240,
      height: 100,
      align: 'end',
      minTop: 128,
    });
    expect(pushed.left).toBe(STAGE.left + 8);
  });

  it('a stage narrower than the popover limits its width', () => {
    const p = placePop({
      area: box(0, 0, 200, 600),
      anchor: box(20, 10, 50, 40),
      width: 300,
      height: 100,
      align: 'start',
      minTop: 48,
    });
    expect(p).toEqual({ left: 8, top: 48, maxWidth: 184, maxHeight: 544, scroll: false });
  });
});

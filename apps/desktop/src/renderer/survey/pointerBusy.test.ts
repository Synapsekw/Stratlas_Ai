// @vitest-environment jsdom
import { emptyMeasurements } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureStore } from './measureStore';
import { pointerBusy } from './pointerBusy';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

beforeEach(() => {
  measureStore.setState({ file: emptyMeasurements(), tool: null, draw: null, editing: null });
});

describe('pointerBusy', () => {
  const surface = () => {
    const pane = document.createElement('div');
    const canvas = document.createElement('canvas');
    pane.append(canvas);
    return { pane, canvas };
  };

  it('is free with nothing armed', () => {
    expect(pointerBusy(surface().canvas, { tool: 'select' })).toBe(false);
  });

  it('a measure tool armed, drawing or editing owns the pointer', () => {
    const { canvas } = surface();
    measureStore.setState({ tool: 'distance' as never });
    expect(pointerBusy(canvas)).toBe(true);
    measureStore.setState({ tool: null, editing: {} as never });
    expect(pointerBusy(canvas)).toBe(true);
  });

  it("the stage's own tool other than Select owns it", () => {
    expect(pointerBusy(surface().canvas, { tool: 'section' })).toBe(true);
    expect(pointerBusy(surface().canvas, { tool: 'pcselect' })).toBe(true);
  });

  it('a pick armed on the pane or a crosshair on the surface owns it', () => {
    const a = surface();
    a.pane.dataset.picking = 'true';
    expect(pointerBusy(a.canvas)).toBe(true);
    const b = surface();
    b.canvas.style.cursor = 'crosshair';
    expect(pointerBusy(b.canvas)).toBe(true);
  });
});

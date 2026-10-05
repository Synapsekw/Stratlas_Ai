import { describe, expect, it } from 'vitest';
import type { SavedView } from '../types';
import { CameraLink, sameView, type LinkableStage } from './cameraLink';

/** A stage stand-in: restoring a view runs the controls' update, which reports a change. */
class FakeStage implements LinkableStage {
  view: SavedView;
  renders = 0;
  restores = 0;
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly controls = {
    _sphericalDelta: {
      r: 0,
      phi: 0.2,
      theta: 0.1,
      set: (r: number, phi: number, theta: number) => {
        Object.assign(this.controls._sphericalDelta, { r, phi, theta });
      },
    },
    _panOffset: {
      x: 3,
      y: 0,
      z: 0,
      set: (x: number, y: number, z: number) => {
        Object.assign(this.controls._panOffset, { x, y, z });
      },
    },
    _scale: 0.9,
    addEventListener: (type: string, l: () => void) => {
      const set = this.listeners.get(type) ?? new Set();
      set.add(l);
      this.listeners.set(type, set);
    },
    removeEventListener: (type: string, l: () => void) => {
      this.listeners.get(type)?.delete(l);
    },
  };

  constructor(position: [number, number, number], target: [number, number, number] = [0, 0, 0]) {
    this.view = { position, target };
  }

  emit(type: 'change' | 'start') {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }

  /** The person orbits this view. */
  orbit(position: [number, number, number], target?: [number, number, number]) {
    this.emit('start');
    this.view = { position, target: target ?? this.view.target };
    this.emit('change');
  }

  saveView(): SavedView {
    return { position: [...this.view.position], target: [...this.view.target] };
  }

  restoreView(view: SavedView): void {
    this.restores++;
    this.view = { position: [...view.position], target: [...view.target] };
    this.emit('change');
  }

  requestRender(): void {
    this.renders++;
  }

  listenerCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

describe('linked cameras', () => {
  it('compares views within a tolerance', () => {
    const a: SavedView = { position: [1, 2, 3], target: [0, 0, 0] };
    expect(sameView(a, { position: [1, 2, 3 + 1e-9], target: [0, 0, 0] })).toBe(true);
    expect(sameView(a, { position: [1, 2, 3.1], target: [0, 0, 0] })).toBe(false);
    expect(sameView(a, { position: [1, 2, 3], target: [0, 0.5, 0] })).toBe(false);
  });

  it('brings the second view to the first when linked, then follows both ways', () => {
    const a = new FakeStage([100, 50, 100]);
    const b = new FakeStage([10, 5, 10]);
    const link = new CameraLink(a, b);
    expect(b.view).toEqual(a.view);
    a.orbit([80, 60, 20], [5, 0, 5]);
    expect(b.view).toEqual({ position: [80, 60, 20], target: [5, 0, 5] });
    b.orbit([-30, 40, 0]);
    expect(a.view.position).toEqual([-30, 40, 0]);
    // one copy per move: the copied view's own change event is not sent back
    expect(a.restores).toBe(1);
    expect(b.restores).toBe(2);
    link.dispose();
  });

  it('drops the other view glide when the person starts moving one', () => {
    const a = new FakeStage([100, 50, 100]);
    const b = new FakeStage([100, 50, 100]);
    const link = new CameraLink(a, b);
    a.orbit([90, 50, 100]);
    expect(b.controls._sphericalDelta).toMatchObject({ phi: 0, theta: 0 });
    expect(b.controls._panOffset).toMatchObject({ x: 0 });
    expect(b.controls._scale).toBe(1);
    link.dispose();
  });

  it('lets each view move alone when unlinked and syncs to the last moved on relink', () => {
    const a = new FakeStage([100, 50, 100]);
    const b = new FakeStage([100, 50, 100]);
    const link = new CameraLink(a, b);
    link.setLinked(false);
    expect(link.linked).toBe(false);
    a.orbit([1, 1, 1]);
    b.orbit([2, 2, 2]);
    expect(a.view.position).toEqual([1, 1, 1]);
    expect(b.view.position).toEqual([2, 2, 2]);
    link.setLinked(true);
    expect(a.view.position).toEqual([2, 2, 2]);
    // linking from a chosen view
    link.setLinked(false);
    a.orbit([7, 7, 7]);
    link.setLinked(true, b);
    expect(a.view.position).toEqual([2, 2, 2]);
    link.dispose();
  });

  it('removes its listeners on dispose', () => {
    const a = new FakeStage([1, 1, 1]);
    const b = new FakeStage([1, 1, 1]);
    const link = new CameraLink(a, b, false);
    expect(a.listenerCount()).toBe(2);
    link.dispose();
    expect(a.listenerCount() + b.listenerCount()).toBe(0);
    a.orbit([5, 5, 5]);
    expect(b.view.position).toEqual([1, 1, 1]);
  });
});

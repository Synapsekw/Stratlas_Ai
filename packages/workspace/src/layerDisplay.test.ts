import { describe, expect, it } from 'vitest';
import { cleanLayerDisplay, createLayerDisplay } from './layerDisplay';

describe('layer display (opacity and on top of a drawing)', () => {
  it('keeps a valid choice and drops what it cannot read', () => {
    expect(cleanLayerDisplay({ opacity: 0.4, onTop: true })).toEqual({ opacity: 0.4, onTop: true });
    expect(cleanLayerDisplay({ opacity: 3 })).toEqual({ opacity: 1 });
    expect(cleanLayerDisplay({ opacity: -1 })).toEqual({ opacity: 0 });
    expect(cleanLayerDisplay({ opacity: 'half', onTop: 'yes' })).toEqual({});
    expect(cleanLayerDisplay(null)).toEqual({});
    // off is the default: not kept
    expect(cleanLayerDisplay({ onTop: false })).toEqual({});
  });

  it('merges a change into one layer and leaves the others alone', () => {
    const s = createLayerDisplay();
    s.getState().set('a', { opacity: 0.5 });
    s.getState().set('b', { onTop: true });
    s.getState().set('a', { onTop: true });
    expect(s.getState().byLayer).toEqual({
      a: { opacity: 0.5, onTop: true },
      b: { onTop: true },
    });
    s.getState().set('a', { onTop: false });
    expect(s.getState().byLayer.a).toEqual({ opacity: 0.5 });
  });

  it('replaces everything when another project opens, and only tells when it changed', () => {
    const s = createLayerDisplay();
    s.getState().set('a', { opacity: 0.5 });
    let told = 0;
    s.subscribe(() => told++);
    s.getState().replace({ a: { opacity: 0.5 } });
    expect(told).toBe(0);
    s.getState().replace({ c: { opacity: 2 } });
    expect(told).toBe(1);
    expect(s.getState().byLayer).toEqual({ c: { opacity: 1 } });
  });
});

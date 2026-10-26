import { describe, expect, it } from 'vitest';
import { askPileFly, flyStep, pileFly, sampleGate } from './pileFly';

describe('the fly to an opened pile', () => {
  it('frames the box when it shows, else waits for it, then frames an estimate', () => {
    expect(flyStep({ boxShown: true, editing: false, deferred: false })).toBe('box');
    expect(flyStep({ boxShown: false, editing: false, deferred: false })).toBe('wait');
    expect(flyStep({ boxShown: false, editing: false, deferred: true })).toBe('estimate');
  });

  it('never moves the camera under an edit that began while it waited', () => {
    // asked with the edit already on: the flat outline, at once
    expect(flyStep({ boxShown: false, editing: true, deferred: false })).toBe('estimate');
    // the wait ended during an edit: dropped
    expect(flyStep({ boxShown: false, editing: true, deferred: true })).toBe('drop');
    expect(flyStep({ boxShown: true, editing: true, deferred: true })).toBe('drop');
  });

  it('asks with a new number each time, never for `never`', () => {
    pileFly.setState({ ask: null });
    askPileFly('a', 'never');
    expect(pileFly.getState().ask).toBeNull();
    askPileFly('a');
    const one = pileFly.getState().ask?.seq ?? 0;
    askPileFly('a', 'if-out-of-view');
    expect(pileFly.getState().ask).toMatchObject({ id: 'a', onlyIfOutOfView: true });
    expect(pileFly.getState().ask?.seq).toBeGreaterThan(one);
  });
});

describe('the sample gate', () => {
  it('drops a late result for a pile left again (A, B, back to A)', () => {
    const g = sampleGate();
    expect(g.start('A')).toBe(true);
    expect(g.start('A')).toBe(false);
    expect(g.settle('A')).toBe(true);
    // B asked, then A again before B lands: A is cached, B no longer wanted
    expect(g.start('B')).toBe(true);
    g.reuse();
    expect(g.settle('B')).toBe(false);
    // a failure frees the gate for the same key
    expect(g.start('C')).toBe(true);
    g.fail('C');
    expect(g.start('C')).toBe(true);
  });
});

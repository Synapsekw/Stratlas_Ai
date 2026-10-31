import type { InspectorScan } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { initialChoice, selectionOf, toggleFlight, toggleInspection } from './pickerModel';

const flight = (id: string, cloud = true, path = true) => ({
  id,
  name: id,
  cloud,
  path,
  aligned: 'relocalised' as const,
});
const scan: InspectorScan = {
  root: '/x',
  generation: '2024-bag',
  asset: 'Chamber',
  inspections: [
    {
      id: 'a',
      name: 'A',
      mergedCloud: true,
      findings: 95,
      importedAs: null,
      flights: [flight('a1'), flight('a2'), flight('a3', false, false)],
    },
    {
      id: 'b',
      name: 'B',
      mergedCloud: false,
      findings: 3,
      importedAs: 's-b',
      flights: [flight('b1'), flight('b2')],
    },
  ],
};

describe('picker model', () => {
  it('the picker preselects new inspections and marks imported ones', () => {
    const c = initialChoice(scan);
    expect(c.inspections.a).toEqual({ on: true, flights: ['a1', 'a2'] });
    expect(c.inspections.b).toEqual({ on: false, flights: [] });
    expect(selectionOf(c, scan)).toEqual({ inspections: [{ id: 'a' }] });
  });

  it('unticking every flight unticks the inspection', () => {
    let c = initialChoice(scan);
    c = toggleFlight(c, scan, 'a', 'a1');
    expect(c.inspections.a?.on).toBe(true);
    c = toggleFlight(c, scan, 'a', 'a2');
    expect(c.inspections.a).toEqual({ on: false, flights: [] });
    expect(selectionOf(c, scan)).toBeNull();
    // ticking a flight brings the inspection back
    c = toggleFlight(c, scan, 'a', 'a2');
    expect(selectionOf(c, scan)).toEqual({ inspections: [{ id: 'a', flights: ['a2'] }] });
  });

  it('all flights ticked sends no flight list', () => {
    let c = toggleInspection(initialChoice(scan), scan, 'b');
    expect(selectionOf(c, scan)).toEqual({ inspections: [{ id: 'a' }, { id: 'b' }] });
    c = toggleFlight(c, scan, 'b', 'b2');
    expect(selectionOf(c, scan)).toEqual({
      inspections: [{ id: 'a' }, { id: 'b', flights: ['b1'] }],
    });
  });

  it('a flight with no data cannot be ticked, and the toggle flips a whole inspection', () => {
    let c = toggleFlight(initialChoice(scan), scan, 'a', 'a3');
    expect(c.inspections.a?.flights).toEqual(['a1', 'a2']);
    c = toggleInspection(c, scan, 'a');
    expect(c.inspections.a?.on).toBe(false);
    c = toggleInspection(c, scan, 'a');
    expect(c.inspections.a).toEqual({ on: true, flights: ['a1', 'a2'] });
  });
});

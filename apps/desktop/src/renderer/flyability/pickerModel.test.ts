import type { InspectorMission, InspectorScan } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  chamberTick,
  flatScan,
  initialChoice,
  missionRequest,
  missionTotals,
  selectionOf,
  toggleChamber,
  toggleFlight,
  toggleInspection,
} from './pickerModel';

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
      photos: 120,
      importedAs: null,
      flights: [flight('a1'), flight('a2'), flight('a3', false, false)],
    },
    {
      id: 'b',
      name: 'B',
      mergedCloud: false,
      findings: 3,
      photos: 3,
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

const chamber = (id: string, extra: Partial<InspectorScan['inspections'][number]> = {}) => ({
  root: `/m/${id}`,
  generation: '2025-mcap' as const,
  asset: null,
  inspections: [
    {
      id,
      name: `Inspection ${id}`,
      mergedCloud: true,
      findings: 2,
      photos: 5,
      importedAs: null,
      flights: [flight(`${id}1`), flight(`${id}2`, false, true)],
      ...extra,
    },
  ],
});
const mission: InspectorMission = {
  root: '/m',
  exports: [
    { path: '/m/x/Chamber A', name: 'Chamber A', scan: chamber('a') },
    { path: '/m/x/Chamber B', name: 'Chamber B', scan: chamber('b') },
    { path: '/m/x/Chamber C', name: 'Chamber C', scan: chamber('c', { importedAs: 's-c' }) },
  ],
  skipped: { folders: ['Raw'], files: 2 },
  capped: false,
};

describe('picker model, mission folders', () => {
  it('counts chambers, photos and point clouds', () => {
    // each chamber: one cloud flight plus its merged cloud
    expect(missionTotals(mission)).toEqual({ chambers: 3, photos: 15, clouds: 6 });
  });

  it('ticks every new chamber, and a chamber tick flips all its inspections', () => {
    const scan = flatScan(mission);
    let c = initialChoice(scan);
    expect(mission.exports.map((e) => chamberTick(c, e.scan))).toEqual(['all', 'all', 'none']);
    c = toggleFlight(c, scan, 'a', 'a1');
    expect(chamberTick(c, mission.exports[0]?.scan ?? scan)).toBe('some');
    c = toggleChamber(c, mission.exports[0]?.scan ?? scan);
    expect(chamberTick(c, mission.exports[0]?.scan ?? scan)).toBe('all');
    c = toggleChamber(c, mission.exports[0]?.scan ?? scan);
    expect(chamberTick(c, mission.exports[0]?.scan ?? scan)).toBe('none');
  });

  it('sends the ticked chambers as paths, each new one named after its folder', () => {
    let c = initialChoice(flatScan(mission));
    c = toggleChamber(c, mission.exports[2]?.scan ?? flatScan(mission));
    expect(missionRequest(c, mission)).toEqual({
      paths: ['/m/x/Chamber A', '/m/x/Chamber B', '/m/x/Chamber C'],
      inspector: {
        inspections: [
          { id: 'a', space: 'Chamber A' },
          { id: 'b', space: 'Chamber B' },
          // already a space: it goes back into it, under its own name
          { id: 'c' },
        ],
      },
    });
    c = toggleChamber(
      toggleChamber(c, mission.exports[0]?.scan ?? flatScan(mission)),
      mission.exports[2]?.scan ?? flatScan(mission),
    );
    expect(missionRequest(c, mission)?.paths).toEqual(['/m/x/Chamber B']);
  });

  it('an export picked itself keeps its inspection names', () => {
    const own: InspectorMission = {
      ...mission,
      root: '/m/x/Chamber A',
      exports: mission.exports.slice(0, 1),
    };
    expect(missionRequest(initialChoice(flatScan(own)), own)).toEqual({
      paths: ['/m/x/Chamber A'],
      inspector: { inspections: [{ id: 'a' }] },
    });
  });

  it('nothing ticked sends nothing', () => {
    let c = initialChoice(flatScan(mission));
    for (const e of mission.exports.slice(0, 2)) c = toggleChamber(c, e.scan);
    expect(missionRequest(c, mission)).toBeNull();
  });
});

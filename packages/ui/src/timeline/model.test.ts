import { describe, expect, it } from 'vitest';
import { mockIssue, mockManifest, T0 } from '../__fixtures__/project';
import type { Layer } from '@aio/schema';
import {
  buildTimelineModel,
  clipAt,
  DEFAULT_CLIP_MS,
  flightGroupName,
  flightGroups,
  neighbourClip,
  severityColor,
} from './model';

describe('buildTimelineModel', () => {
  const manifest = mockManifest();

  it('places every clip at flight start plus offset', () => {
    const m = buildTimelineModel(manifest, [], { dji0665: 11_000 });
    expect(m.clips).toEqual([
      {
        layerId: 'dji0665',
        name: 'DJI_0665 overview',
        startMs: T0,
        endMs: T0 + 11_000,
        estimated: false,
        group: `flights/dji0665.json@${String(T0)}`,
      },
      {
        layerId: 'dji0789',
        name: 'DJI_0789 tanks pass',
        startMs: T0 + 3_605_000,
        endMs: T0 + 3_605_000 + DEFAULT_CLIP_MS,
        estimated: true,
        group: `flights/dji0789.json@${String(T0 + 3_600_000)}`,
      },
    ]);
  });

  it('puts issues with a video sighting on the clock in the severity colour', () => {
    const m = buildTimelineModel(manifest, [mockIssue()], {});
    expect(m.issues).toEqual([
      { issueId: 'i1', code: 'F01', tMs: T0 + 3_605_000 + 2_000, color: '#e0533f', severity: 5 },
    ]);
  });

  it('skips issues without a time-bearing sighting', () => {
    const issue = mockIssue({
      sightings: [
        { on: 'mesh', layer: 'plant', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } },
      ],
    });
    expect(buildTimelineModel(manifest, [issue], {}).issues).toEqual([]);
  });

  it('places issues seen on a timed photo at the photo time', () => {
    const issue = mockIssue({
      severity: 3,
      sightings: [
        { on: 'image', layer: 'findings', photo: 'p2', geom: { type: 'point', x: 1, y: 1 } },
        { on: 'image', layer: 'findings', photo: 'p1', geom: { type: 'point', x: 1, y: 1 } },
      ],
    });
    expect(buildTimelineModel(manifest, [issue], {}).issues).toEqual([
      {
        issueId: 'i1',
        code: 'F01',
        tMs: Date.parse('2023-02-21T12:30:00Z'),
        color: '#e3c44f',
        severity: 3,
      },
    ]);
  });

  it('adds timed photos and captures', () => {
    const m = buildTimelineModel(manifest, [], {});
    expect(m.photos).toEqual([
      { layerId: 'findings', photoId: 'p1', tMs: Date.parse('2023-02-21T12:30:00Z') },
    ]);
    expect(m.captures).toEqual([{ id: 'c1', label: 'Survey 1', tMs: Date.UTC(2023, 1, 21) }]);
  });

  it('spans the clips with a small margin', () => {
    const m = buildTimelineModel(manifest, [], { dji0665: 11_000, dji0789: 11_000 });
    expect(m.range).not.toBeNull();
    const [a, b] = m.range ?? [0, 0];
    expect(a).toBeLessThan(T0);
    expect(b).toBeGreaterThan(T0 + 3_605_000 + 11_000);
    expect(b - a).toBeLessThan(2 * 3_600_000);
  });

  it('has no range for a project with no time-bearing data', () => {
    const empty = { ...manifest, layers: [], captures: [] };
    expect(buildTimelineModel(empty, [], {}).range).toBeNull();
  });
});

describe('clip navigation', () => {
  const m = buildTimelineModel(mockManifest(), [], { dji0665: 11_000, dji0789: 11_000 });

  it('finds the clip under a time', () => {
    expect(clipAt(m, T0 + 5_000)?.layerId).toBe('dji0665');
    expect(clipAt(m, T0 + 60_000)).toBeUndefined();
  });

  it('steps to the next and previous clip', () => {
    expect(neighbourClip(m, 'dji0665', 1)?.layerId).toBe('dji0789');
    expect(neighbourClip(m, 'dji0789', 1)).toBeUndefined();
    expect(neighbourClip(m, 'dji0789', -1)?.layerId).toBe('dji0665');
    expect(neighbourClip(m, null, 1)?.layerId).toBe('dji0665');
  });
});

describe('severityColor', () => {
  const models = mockManifest().severityModels;
  it('reads the level colour from the model', () => {
    expect(severityColor(models, 'tank', 3)).toBe('#e3c44f');
    expect(severityColor(models, 'tank', 'uncertain')).toBe('#777777');
  });
  it('returns undefined for unknown models or levels', () => {
    expect(severityColor(models, 'nope', 3)).toBeUndefined();
    expect(severityColor(models, 'tank', 4)).toBeUndefined();
  });
});

describe('flight groups', () => {
  const clip = (n: number, flight = 'flights/f101.json'): Layer => ({
    kind: 'video',
    id: `v${String(n)}`,
    name: `Flight 101 · Shell pass 1 · clip ${String(n + 1)} of 3`,
    visible: true,
    src: { path: `video/v${String(n)}.mp4` },
    flight: { src: { path: flight }, startUtcMs: T0 },
    lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
    offsetMs: n * 60_000,
  });

  it('names a flight from the common prefix of its clip names', () => {
    expect(
      flightGroupName(
        ['Flight 101 · Shell pass 1 · clip 1 of 7', 'Flight 101 · Shell pass 1 · clip 2 of 7'],
        'f101',
      ),
    ).toBe('Flight 101 · Shell pass 1');
    expect(flightGroupName(['A', 'B'], 'f101')).toBe('f101');
    expect(flightGroupName(['DJI_0665 overview'], 'x')).toBe('DJI_0665 overview');
  });

  it('groups clips cut from one flight log and keeps the timeline grouped', () => {
    const layers = [clip(2), clip(0), clip(1), clip(0, 'flights/f102.json')];
    const groups = flightGroups(layers);
    expect(groups.map((g) => [g.name, g.clips.map((c) => c.id)])).toEqual([
      ['Flight 101 · Shell pass 1', ['v0', 'v1', 'v2']],
      ['Flight 101 · Shell pass 1 · clip 1 of 3', ['v0']],
    ]);
    const m = buildTimelineModel({ ...mockManifest(), layers }, [], { v2: 30_000 });
    expect(m.groups[0]).toMatchObject({
      name: 'Flight 101 · Shell pass 1',
      startMs: T0,
      endMs: T0 + 150_000,
      clips: ['v0', 'v1', 'v2'],
    });
  });
});

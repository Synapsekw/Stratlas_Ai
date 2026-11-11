import { describe, expect, it } from 'vitest';
import { siteInsights, type SiteSnapshot } from './rules';
import { CAPTURES, checkpoints, qaFile } from './testing';
import { trackRules, type SiteTrack } from './trackRules';

const PAIR = { from: 'm2', to: 'm3' };
const DATE = { m1: '2026-07-01', m2: '2026-08-01', m3: '2026-09-01' } as const;

type Values = SiteTrack['sightings'][number]['values'];

function track(
  kind: SiteTrack['kind'],
  values: [keyof typeof DATE, Values][],
  extra: Partial<SiteTrack['sightings'][number]> = {},
): SiteTrack {
  return {
    id: `${kind}:${values[0]?.[0]}:x`,
    kind,
    sightings: values.map(([c, v]) => ({
      capture: c,
      date: DATE[c],
      ref: `${kind}-${c}`,
      draft: false,
      values: v,
      ...extra,
    })),
  };
}

describe('trackRules', () => {
  it('flags an antenna that turned the short way round past north, with its name', () => {
    const [i] = trackRules(
      [
        track(
          'antenna',
          [
            ['m2', { azimuthDeg: 358, downtiltDeg: 4 }],
            ['m3', { azimuthDeg: 4, downtiltDeg: 4.2 }],
          ],
          { name: 'A3' },
        ),
      ],
      PAIR,
    );
    expect(i).toMatchObject({
      rule: 'antenna-turned',
      severity: 'warning',
      text: {
        key: 'insights.antennaTurned',
        params: { name: 'A3', azimuth: '6.0', from: '2026-08-01' },
      },
      actions: [{ id: 'insights.openAntenna', unit: 'antenna-m3' }],
    });
    expect(i?.evidence[0]).toEqual({
      kind: 'track',
      id: 'antenna:m2:x',
      object: 'antenna',
      ref: 'antenna-m3',
    });
  });

  it('flags a downtilt change alone, and both together', () => {
    const tilt = trackRules(
      [
        track('antenna', [
          ['m2', { azimuthDeg: 10, downtiltDeg: 2 }],
          ['m3', { azimuthDeg: 11, downtiltDeg: 3.5 }],
        ]),
      ],
      PAIR,
    );
    expect(tilt[0]?.text.key).toBe('insights.antennaTilted');
    const both = trackRules(
      [
        track('antenna', [
          ['m2', { azimuthDeg: 10, downtiltDeg: 2 }],
          ['m3', { azimuthDeg: 20, downtiltDeg: 0 }],
        ]),
      ],
      PAIR,
    );
    expect(both[0]?.text).toMatchObject({
      key: 'insights.antennaTurnedTilted',
      params: { azimuth: '10.0', tilt: '2.0' },
    });
  });

  it('stays quiet under the thresholds, on drafts, and when the last sighting is not the latest date', () => {
    const small = track('antenna', [
      ['m2', { azimuthDeg: 10, downtiltDeg: 2 }],
      ['m3', { azimuthDeg: 12.9, downtiltDeg: 2.9 }],
    ]);
    const draft = track(
      'antenna',
      [
        ['m2', { azimuthDeg: 10 }],
        ['m3', { azimuthDeg: 40 }],
      ],
      { draft: true },
    );
    const old = track('antenna', [
      ['m1', { azimuthDeg: 10 }],
      ['m2', { azimuthDeg: 40 }],
    ]);
    const once = track('antenna', [['m3', { azimuthDeg: 10 }]]);
    expect(trackRules([small, draft, old, once], PAIR)).toEqual([]);
    expect(
      trackRules(
        [
          track('antenna', [
            ['m2', { azimuthDeg: 0 }],
            ['m3', { azimuthDeg: 90 }],
          ]),
        ],
        null,
      ),
    ).toEqual([]);
  });

  it('flags a hot spot that got hotter and opens it in Inspect', () => {
    const out = trackRules(
      [
        track(
          'hotspot',
          [
            ['m2', { peakC: 61 }],
            ['m3', { peakC: 67.5 }],
          ],
          { layer: 'th', photo: 'p1' },
        ),
        track('hotspot', [
          ['m2', { peakC: 61 }],
          ['m3', { peakC: 64 }],
        ]),
      ],
      PAIR,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'hotspot-hotter',
      text: { params: { peak: '67.5', rise: '6.5' } },
      actions: [{ id: 'insights.openHotspot', detection: 'hotspot-m3', layer: 'th', photo: 'p1' }],
    });
  });

  it('notes a change region that grew by share and area, open ones too', () => {
    const out = trackRules(
      [
        track(
          'region',
          [
            ['m2', { areaM2: 40 }],
            ['m3', { areaM2: 52 }],
          ],
          { draft: true },
        ),
        track('region', [
          ['m2', { areaM2: 10 }],
          ['m3', { areaM2: 14 }],
        ]),
        track('region', [
          ['m2', { areaM2: 400 }],
          ['m3', { areaM2: 450 }],
        ]),
      ],
      PAIR,
    );
    expect(out.map((i) => i.text.params)).toEqual([{ area: '52', share: 30, from: '2026-08-01' }]);
    expect(out[0]?.actions).toEqual([{ id: 'insights.openChanges', pair: PAIR }]);
  });

  it('runs inside the digest, after the other warnings of its severity', () => {
    const s: SiteSnapshot = {
      captures: CAPTURES,
      qa: {
        m2: qaFile('m2', { checkpoints: checkpoints(0.03) }),
        m3: qaFile('m3', { checkpoints: checkpoints(0.03) }),
      },
      qaLevel: 'moderate',
      rmseLimitM: 0.1,
      figures: [],
      changes: [],
      staleChangeSets: [],
      today: '2026-09-02',
      tracks: [
        track('antenna', [
          ['m2', { azimuthDeg: 0 }],
          ['m3', { azimuthDeg: 5 }],
        ]),
      ],
    };
    expect(siteInsights(s).map((i) => i.rule)).toEqual(['antenna-turned']);
    const none: SiteSnapshot = { ...s };
    delete none.tracks;
    expect(siteInsights(none)).toEqual([]);
  });
});

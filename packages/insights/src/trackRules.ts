/**
 * The site digest's track rules (Wave 3 M2): what changed on an object seen on several survey
 * dates, read from its track (`@aio/change` `antennaTracks`, `hotspotTracks`, `regionTracks`; the
 * shape is repeated here so this package needs only the schema). Rules, never AI; each speaks only
 * when the track's last sighting is on the latest survey date, and compares it with the sighting
 * just before.
 *
 * | rule              | severity | when                                                              |
 * | ----------------- | -------- | ----------------------------------------------------------------- |
 * | `antenna-turned`  | warning  | an antenna's azimuth moved `TURN_DEG` or more, or its downtilt      |
 * |                   |          | `TILT_DEG` or more (both dates reviewed, not drafts)                |
 * | `hotspot-hotter`  | warning  | a hot spot's peak rose `HOTTER_C` or more (both dates reviewed)     |
 * | `region-grew`     | info     | a change region's area grew `GREW_SHARE` and `GREW_MIN_M2` or more  |
 *
 * Change regions count while open or confirmed (a dismissed one is not in the track at all).
 */
import type { Insight } from './rules';

export type SiteTrackMetric =
  | 'azimuthDeg'
  | 'downtiltDeg'
  | 'centreHeightM'
  | 'areaM2'
  | 'netM3'
  | 'maxDistM'
  | 'peakC'
  | 'deltaC';

export interface SiteTrack {
  id: string;
  kind: 'antenna' | 'region' | 'hotspot';
  sightings: readonly {
    capture: string;
    date: string;
    ref: string;
    draft: boolean;
    name?: string;
    layer?: string;
    photo?: string;
    values: Partial<Record<SiteTrackMetric, number>>;
  }[];
}

/** Azimuth moved this many degrees or more since the date before. */
export const TURN_DEG = 3;
/** Downtilt moved this many degrees or more. */
export const TILT_DEG = 1;
/** A hot spot's peak rose this many °C or more. */
export const HOTTER_C = 5;
/** A region's area grew this share or more... */
export const GREW_SHARE = 0.2;
/** ...and at least this many m². */
export const GREW_MIN_M2 = 5;

const fixed = (v: number, digits = 1) => v.toFixed(digits);

/** a - b the shorter way round (-180 to 180). */
function turn(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

export function trackRules(
  tracks: readonly SiteTrack[],
  latestPair: { from: string; to: string } | null,
): Insight[] {
  if (latestPair === null) return [];
  const latest = latestPair.to;
  const out: Insight[] = [];
  for (const tr of tracks) {
    const last = tr.sightings.at(-1);
    const prev = tr.sightings.at(-2);
    if (!last || !prev || last.capture !== latest) continue;
    const evidence = [
      { kind: 'track' as const, id: tr.id, object: tr.kind, ref: last.ref },
      { kind: 'capture' as const, id: last.capture },
    ];
    if (tr.kind === 'antenna') {
      if (last.draft || prev.draft) continue;
      const name = last.name ?? last.ref;
      const a = last.values.azimuthDeg;
      const pa = prev.values.azimuthDeg;
      const tl = last.values.downtiltDeg;
      const pt = prev.values.downtiltDeg;
      const az = a !== undefined && pa !== undefined ? turn(a, pa) : 0;
      const dt = tl !== undefined && pt !== undefined ? tl - pt : 0;
      const turned = Math.abs(az) >= TURN_DEG;
      const tilted = Math.abs(dt) >= TILT_DEG;
      if (!turned && !tilted) continue;
      out.push({
        id: `antenna-turned:${tr.id}`,
        rule: 'antenna-turned',
        severity: 'warning',
        text: turned
          ? {
              key: tilted ? 'insights.antennaTurnedTilted' : 'insights.antennaTurned',
              params: {
                name,
                azimuth: fixed(Math.abs(az)),
                tilt: fixed(Math.abs(dt)),
                from: prev.date,
              },
            }
          : {
              key: 'insights.antennaTilted',
              params: { name, tilt: fixed(Math.abs(dt)), from: prev.date },
            },
        evidence,
        actions: [{ id: 'insights.openAntenna', unit: last.ref }],
      });
    } else if (tr.kind === 'hotspot') {
      if (last.draft || prev.draft) continue;
      const p = last.values.peakC;
      const pp = prev.values.peakC;
      if (p === undefined || pp === undefined || p - pp < HOTTER_C) continue;
      out.push({
        id: `hotspot-hotter:${tr.id}`,
        rule: 'hotspot-hotter',
        severity: 'warning',
        text: {
          key: 'insights.hotspotHotter',
          params: { peak: fixed(p), rise: fixed(p - pp), from: prev.date },
        },
        evidence,
        actions: [
          {
            id: 'insights.openHotspot',
            detection: last.ref,
            ...(last.layer ? { layer: last.layer } : {}),
            ...(last.photo ? { photo: last.photo } : {}),
          },
        ],
      });
    } else {
      const a = last.values.areaM2;
      const pa = prev.values.areaM2;
      if (a === undefined || pa === undefined || pa <= 0) continue;
      const grew = a - pa;
      if (grew < GREW_MIN_M2 || grew / pa < GREW_SHARE) continue;
      out.push({
        id: `region-grew:${tr.id}`,
        rule: 'region-grew',
        severity: 'info',
        text: {
          key: 'insights.regionGrew',
          params: { area: fixed(a, 0), share: Math.round((grew / pa) * 100), from: prev.date },
        },
        evidence,
        actions: [{ id: 'insights.openChanges', pair: latestPair }],
      });
    }
  }
  return out;
}

import { toWgs84 } from '@aio/geo';
import { describe, expect, it } from 'vitest';
import { ORIGIN, sampleIssues, sampleManifest } from './fixtures';
import {
  CSV_COLUMNS,
  issueLocation,
  issueZone,
  issuesCoco,
  issuesCsv,
  issuesGeoJson,
  issuesKitAssessment,
  noDashes,
  parseCsv,
  reportModel,
} from './index';

const ctx = () => ({ manifest: sampleManifest(), issues: sampleIssues() });

describe('noDashes', () => {
  it('turns number ranges into "to" and other dashes into commas', () => {
    expect(noDashes('5–10 cm')).toBe('5 to 10 cm');
    expect(noDashes('Roof — crown')).toBe('Roof, crown');
    expect(noDashes('plain - hyphen')).toBe('plain - hyphen');
  });
});

describe('issueZone', () => {
  it('reads the kit location line, the area line, or the road chainage', () => {
    const [glass, seal, map] = sampleIssues();
    if (!glass || !seal || !map) throw new Error('fixture');
    expect(issueZone(glass)).toBe('Roof and crown');
    expect(issueZone(map)).toBe('Bottom plate');
    expect(issueZone(seal)).toBe('Not zoned');
    expect(issueZone({ ...seal, note: 'Bleeding at km 7.452' })).toBe('km 7');
    expect(issueZone({ ...seal, note: 'Tinted patch.\nZone L11.' })).toBe('L11');
    expect(
      issueZone({ ...seal, note: 'Location: 61.7 m above datum, East side, Level 15, top floor.' }),
    ).toBe('Level 15, top floor');
  });
});

describe('issueLocation', () => {
  it('gives project CRS and WGS84 coordinates of a mesh pin', () => {
    const m = sampleManifest();
    const [glass] = sampleIssues();
    const loc = glass && issueLocation(m, glass);
    expect(loc?.project).toEqual([ORIGIN[0] + 10, ORIGIN[1] + 20, ORIGIN[2] + 2]);
    const [lon, lat] = toWgs84([ORIGIN[0] + 10, ORIGIN[1] + 20, 0], 32639);
    expect(loc?.wgs84?.[0]).toBeCloseTo(lon, 9);
    expect(loc?.wgs84?.[1]).toBeCloseTo(lat, 9);
  });

  it('places a map-only issue from its WGS84 geometry, without a height', () => {
    const map = sampleIssues()[2];
    if (!map) throw new Error('fixture');
    const loc = issueLocation(sampleManifest(), map);
    expect(loc?.wgs84?.slice(0, 2)).toEqual([48, 28.7]);
    expect(loc?.project[2]).toBeNull();
    expect(loc?.project[0]).toBeGreaterThan(100000);
  });
});

describe('issuesCsv', () => {
  it('writes the stable column set with labels from the models', () => {
    const csv = issuesCsv(ctx());
    expect(csv.startsWith('﻿')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(4);
    const col = (name: string) => CSV_COLUMNS.indexOf(name as (typeof CSV_COLUMNS)[number]);
    // sorted by code
    expect(rows.slice(1).map((r) => r[col('code')])).toEqual(['D001', 'D002', 'D010']);
    const glass = rows[2] ?? [];
    expect(glass[col('title')]).toBe('Cracked pane, "north" bay');
    expect(glass[col('class')]).toBe('Glazing damage');
    expect(glass[col('severity')]).toBe('3');
    expect(glass[col('severity_label')]).toBe('Severe');
    expect(glass[col('sightings')]).toBe('3');
    expect(glass[col('photos')]).toBe('p1 p2');
    expect(glass[col('crs')]).toBe('EPSG:32639');
    expect(Number(glass[col('easting')])).toBeCloseTo(ORIGIN[0] + 10, 3);
    expect(Number(glass[col('lat')])).toBeGreaterThan(28);
    expect(glass[col('note')]).toContain('\n');
    expect(rows[1]?.[col('severity_label')]).toBe('Uncertain');
  });

  it('keeps the header when there are no issues', () => {
    expect(parseCsv(issuesCsv({ manifest: sampleManifest(), issues: [] }))).toHaveLength(1);
  });
});

describe('issuesGeoJson', () => {
  it('writes one WGS84 feature per spatial sighting', () => {
    const fc = issuesGeoJson(ctx());
    expect(fc.type).toBe('FeatureCollection');
    const kinds = fc.features.map((f) => `${f.properties.code}:${f.geometry.type}`);
    expect(kinds).toEqual(['D001:Polygon', 'D002:Point', 'D010:Point']);
    const pt = fc.features[1];
    expect(pt?.geometry.type === 'Point' && pt.geometry.coordinates[2]).toBeCloseTo(102, 6);
    expect(pt?.properties.severityLabel).toBe('Severe');
    expect(pt?.properties.color).toBe('#ee3f4b');
    const poly = fc.features[0]?.geometry;
    if (poly?.type !== 'Polygon') throw new Error('expected a polygon');
    expect(poly.coordinates[0]?.[0]).toEqual(poly.coordinates[0]?.at(-1));
  });
});

describe('issuesCoco', () => {
  it('writes images, categories from the catalogue and box or polygon annotations', () => {
    const coco = issuesCoco(ctx(), (_layer, photo) =>
      photo === 'p1' ? { width: 2560, height: 1706 } : null,
    );
    expect(coco.categories.map((c) => c.name)).toEqual(['glazing', 'sealant']);
    expect(coco.categories[0]).toMatchObject({ id: 1, supercategory: 'facade' });
    expect(coco.images).toEqual([
      expect.objectContaining({ id: 1, file_name: 'photos/p1.jpg', width: 2560, height: 1706 }),
    ]);
    expect(coco.annotations).toHaveLength(2);
    const box = coco.annotations.find((a) => a.attributes.issue_code === 'D002');
    expect(box).toMatchObject({ image_id: 1, category_id: 1, bbox: [10, 20, 30, 40], area: 1200 });
    const poly = coco.annotations.find((a) => a.attributes.issue_code === 'D001');
    expect(poly?.category_id).toBe(2);
    expect(poly?.segmentation).toEqual([[50, 50, 60, 50, 60, 70]]);
    expect(poly?.bbox).toEqual([50, 50, 10, 20]);
    expect(poly?.area).toBe(100);
  });
});

describe('issuesKitAssessment', () => {
  it('writes kit assessment.json findings with corner boxes and photo statuses', () => {
    const kit = issuesKitAssessment(ctx());
    expect(kit.photos.p1).toEqual({ status: 'finding', note: expect.any(String) as string });
    expect(kit.photos.p3).toEqual({ status: 'none', note: '' });
    const f = kit.findings.find((x) => x.group === 'D002');
    expect(f).toMatchObject({ photo: 'p1', class: 'glazing', severity: 3, bbox: [10, 20, 40, 60] });
    const unc = kit.findings.find((x) => x.group === 'D001');
    expect(unc?.severity).toBeNull();
    expect(kit.issues.map((i) => i.code)).toEqual(['D001', 'D002', 'D010']);
  });
});

describe('reportModel', () => {
  it('counts by severity, class and zone and orders the register worst first', () => {
    const r = reportModel(ctx(), { brandName: 'Stratlas', now: new Date('2026-10-04T08:00:00Z') });
    expect(r.title).toBe('Sample site');
    expect(r.bySeverity.map((s) => `${s.label}:${String(s.count)}`)).toEqual([
      'Severe:1',
      'Minor:1',
      'Uncertain:1',
    ]);
    expect(r.byClass.map((c) => `${c.label}:${String(c.count)}`)).toEqual([
      'Glazing damage:2',
      'Sealant failure:1',
    ]);
    expect(r.byZone.map((z) => z.zone)).toContain('Roof and crown');
    expect(r.rows.map((x) => x.code)).toEqual(['D002', 'D010', 'D001']);
    expect(r.rows[0]?.photo).toMatchObject({ src: 'photos/p1.jpg', box: [10, 20, 30, 40] });
    expect(r.rows[0]?.note).toBe(
      'Crack across the pane, 5 to 10 cm\nLocation: 74.4 m above datum, East side, Roof and crown.',
    );
    expect(r.rows[0]?.position).toEqual([10, 2, -20]);
    expect(JSON.stringify(r)).not.toMatch(/[–—]/);
  });
});

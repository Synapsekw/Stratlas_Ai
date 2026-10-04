import { resolveReportBranding, type ReportModel, type ReportRow } from '@aio/project/export';
import { describe, expect, it } from 'vitest';
import {
  barChart,
  brandingFromQuery,
  cropRect,
  esc,
  exteriorPose,
  reportHtml,
  snapshotPose,
} from './layout';

describe('cropRect', () => {
  it('frames the marked box with context at 4:3, inside the image', () => {
    const c = cropRect([1000, 800, 100, 50], 2560, 1920);
    expect(c.w / c.h).toBeCloseTo(4 / 3, 5);
    expect(c.x).toBeLessThanOrEqual(1000);
    expect(c.y).toBeLessThanOrEqual(800);
    expect(c.x + c.w).toBeGreaterThanOrEqual(1100);
    expect(c.y + c.h).toBeGreaterThanOrEqual(850);
    expect(c.w).toBeGreaterThanOrEqual(2560 * 0.3);
  });

  it('stays inside the image near an edge', () => {
    const c = cropRect([0, 0, 40, 40], 1280, 960);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it('uses the whole photo without a box', () => {
    expect(cropRect(null, 1280, 960)).toEqual({ x: 0, y: 0, w: 1280, h: 960 });
  });
});

describe('snapshotPose', () => {
  it('looks at the point along its surface normal', () => {
    const p = snapshotPose([10, 2, -20], [0, 0, 1], [0, 0, 0], 50);
    expect(p.target).toEqual([10, 2, -20]);
    expect(p.eye[0]).toBeCloseTo(10);
    expect(p.eye[2]).toBeGreaterThan(-20);
  });

  it('steps outside a hollow asset (a tank) to look in at a finding on its inner wall', () => {
    const p = exteriorPose([1, 0.1, -1], [0, 5, 0], 8);
    // frames the whole asset: aims between the finding and the asset centre
    expect(p.target[1]).toBeGreaterThan(0.1);
    expect(p.target[1]).toBeLessThan(5);
    const d = Math.hypot(p.eye[0] - 0, p.eye[2] - 0);
    expect(d).toBeGreaterThan(8);
    expect(p.eye[1]).toBeGreaterThan(5);
    expect(Math.sign(p.eye[0])).toBe(1);
    expect(Math.sign(p.eye[2])).toBe(-1);
  });

  it('without a normal, looks from outside the model towards its axis', () => {
    const p = snapshotPose([10, 5, 0], null, [0, 0, 0], 40);
    expect(p.eye[0]).toBeGreaterThan(10);
    expect(p.eye[1]).toBeGreaterThan(5);
  });
});

describe('barChart', () => {
  it('draws one bar per row with its label and count', () => {
    const svg = barChart([
      { label: 'Severe <3>', color: '#ee3f4b', count: 2 },
      { label: 'Minor', color: '#fad34b', count: 0 },
    ]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Severe &lt;3&gt;');
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
  });
});

const row = (code: string): ReportRow => ({
  id: code,
  code,
  title: `Crack ${code}`,
  classLabel: 'Glazing',
  classColor: '#ee3f4b',
  severity: 3,
  severityLabel: 'Severe',
  severityColor: '#ee3f4b',
  status: 'approved',
  zone: 'Roof',
  coords: 'E 1.00, N 2.00 (EPSG:32639)',
  wgs84: '',
  note: 'Line one\nLine two',
  author: 'Reviewer',
  updatedAt: '2026-10-04',
  sightings: 2,
  photo: null,
  position: null,
  normal: null,
});

const model = (branding = resolveReportBranding(undefined, 'Stratlas')): ReportModel => ({
  title: 'Tower',
  customer: 'ACME',
  site: 'Dubai',
  branding,
  date: '2026-10-04',
  crs: 'EPSG:32640',
  captureLabel: 'Survey, 2024-06-05',
  total: 2,
  bySeverity: [{ label: 'Severe', color: '#ee3f4b', count: 2 }],
  byClass: [{ label: 'Glazing', color: '#ee3f4b', count: 2 }],
  byZone: [{ zone: 'Roof', count: 2 }],
  byStatus: [{ status: 'approved', count: 2 }],
  rows: [row('D001'), row('D002')],
});

describe('report branding', () => {
  it('has no logo, company or accent by default', () => {
    const html = reportHtml(model(), new Map());
    expect(html).not.toContain('aio://branding/');
    expect(html).not.toContain('class="logo"');
    expect(html).not.toContain('brand-name');
    expect(html).not.toContain('<style>');
  });

  it("shows the person's logo, company name and accent when set", () => {
    const b = resolveReportBranding(
      { companyName: 'Synapse <Solutions>', logo: 'logo-abc123def.png', accent: '#2266aa' },
      'Stratlas',
    );
    const html = reportHtml(model(b), new Map());
    expect(html).toContain('<img src="aio://branding/logo-abc123def.png" alt="">');
    expect(html).toContain('<span class="brand-name">Synapse &lt;Solutions&gt;</span>');
    expect(html).toContain('--acc:#2266aa');
  });

  it('reads only valid branding from the page query', () => {
    expect(brandingFromQuery(null)).toBeUndefined();
    expect(brandingFromQuery('{not json')).toBeUndefined();
    expect(brandingFromQuery(JSON.stringify({ logo: '../../secret.png' }))).toBeUndefined();
    expect(brandingFromQuery(JSON.stringify({ accent: 'red' }))).toBeUndefined();
    expect(brandingFromQuery(JSON.stringify({ companyName: 'A', accent: '#aabbcc' }))).toEqual({
      companyName: 'A',
      accent: '#aabbcc',
    });
  });
});

describe('reportHtml', () => {
  it('lays out a cover, summary, register and one page per issue', () => {
    const m: ReportModel = {
      ...model(),
    };
    const html = reportHtml(m, new Map([['D001', { photo: 'data:image/jpeg;base64,AA' }]]));
    expect(html).toContain('class="cover"');
    expect(html).toContain('Issue register');
    expect((html.match(/class="issue-page"/g) ?? []).length).toBe(2);
    expect(html).toContain('data:image/jpeg;base64,AA');
    expect(html).toContain('Line one<br>Line two');
    expect(html).not.toMatch(/[–—]/);
  });

  it('escapes text', () => {
    expect(esc('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });
});

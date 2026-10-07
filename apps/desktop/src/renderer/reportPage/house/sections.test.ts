// @vitest-environment jsdom
import {
  houseReportModel,
  resolveReportBranding,
  type PlanPoint,
  type ReportRow,
} from '@aio/project/export';
import { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { isFlat, locatorMap, niceStep, pileMap } from './charts';
import {
  auditFooter,
  coverHtml,
  frameHtml,
  issuePageHtml,
  metres,
  narrativeHtml,
  type HouseContext,
} from './sections';

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'tower',
  name: 'Tower',
  customer: 'Client Co',
  site: 'Dubai',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [{ id: 'c1', label: 'Survey', date: '2024-06-05' }],
  brand: 'eand',
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Facade',
      levels: [{ value: 2, label: 'Moderate', color: '#ff7a2d', criteria: 'Plan repair' }],
    },
  ],
  classCatalogues: [],
});

const row: ReportRow = {
  id: 'D1',
  code: 'D1',
  title: 'Crack <b>',
  classLabel: 'Crack',
  classColor: '#ff7a2d',
  severity: 2,
  severityLabel: 'Moderate',
  severityColor: '#ff7a2d',
  status: 'reviewed',
  zone: 'Roof',
  coords: '',
  wgs84: '',
  note: '',
  author: 'Reviewer',
  updatedAt: '2026-10-04',
  sightings: 1,
  photo: null,
  position: null,
  normal: null,
};

const extra = { photoName: '', captured: '', action: '', actionIsCriteria: false, disclaimer: 'D' };

function ctx(company?: string): HouseContext {
  return {
    h: houseReportModel({
      manifest,
      issues: [],
      branding: resolveReportBranding(company ? { companyName: company } : undefined, 'Stratlas'),
    }),
    text: { summary: '', method: '', findings: '' },
    images: { overview: [] },
    product: 'Stratlas',
  };
}

describe('issue page', () => {
  it('prints an issue without photo, 3D position or note', () => {
    const html = issuePageHtml(row, {}, extra);
    expect(html).toContain('No photo marks this issue.');
    expect(html).toContain('No 3D position for this issue.');
    expect(html).toContain('No note was written for this issue.');
    expect(html).toContain('Crack &lt;b&gt;');
    expect(html).not.toContain('ip-close');
    expect(html).not.toContain('class="ip-ht"');
  });

  it('shows the photo, close-up, 3D view, height and action when there are some', () => {
    const html = issuePageHtml(
      { ...row, position: [1, 74.42, 2], note: 'Rust — spots' },
      { photo: 'blob:p', closeup: 'blob:c', view: 'blob:v' },
      { ...extra, action: 'Plan repair', photoName: 'p1.jpg' },
    );
    expect(html).toContain('src="blob:p"');
    expect(html).toContain('src="blob:c"');
    expect(html).toContain('src="blob:v"');
    expect(html).toContain('74.4 m');
    expect(html).toContain('Recommended action');
    expect(html).toContain('Rust, spots');
  });

  it('shows where a map-only issue lies', () => {
    const html = issuePageHtml(row, { locator: '<svg class="map"></svg>' }, extra);
    expect(html).toContain('ip-loc');
    expect(html).toContain('Where the issue lies');
  });
});

describe('cover', () => {
  it('is neutral by default and never carries the client brand', () => {
    const html = coverHtml(ctx());
    expect(html).toContain('Made with Stratlas');
    expect(html).toContain('Client Co');
    expect(html).not.toMatch(/eand|e&amp;/);
    expect(html).toContain('cv-in solo');
  });

  it("carries the person's company", () => {
    const html = coverHtml(ctx('Synapse Solutions'));
    expect(html).toContain('Prepared by Synapse Solutions');
    expect(html).toContain('cv-name');
    expect(html).not.toContain('Made with');
  });
});

describe('charts and text', () => {
  const pt = (id: string, x: number, z: number, y = 0, map = true): PlanPoint => ({
    id,
    x,
    z,
    y,
    color: '#ff7a2d',
    code: id,
    map,
  });

  it('picks nice scale steps and tells flat sites from tall assets', () => {
    expect(niceStep(37)).toBe(20);
    expect(niceStep(7)).toBe(5);
    expect(niceStep(0.3)).toBe(0.2);
    expect(isFlat([pt('a', 0, 0), pt('b', 100, 0)])).toBe(true);
    expect(isFlat([pt('a', 0, 0, 0, false), pt('b', 5, 0, 70, false)])).toBe(false);
  });

  it('draws a locator with only the issues near the one it is about', () => {
    const svg = locatorMap(
      [pt('a', 0, 0), pt('b', 30, 10), pt('far', 5000, 0)],
      pt('a', 0, 0),
      new Map(),
      'D1',
    );
    // the focus (dot and ring) plus one neighbour; the far issue is left out
    expect((svg.match(/<circle/g) ?? []).length).toBe(3);
    // dark, like every map in the app
    expect(svg).toContain('class="map loc"');
  });

  it('draws stockpile toe lines with their names', () => {
    const svg = pileMap(
      [
        {
          name: 'Pile 01',
          outline: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
        },
        { name: 'Pile 02', outline: null },
      ],
      'Piles',
    );
    expect((svg.match(/class="pile"/g) ?? []).length).toBe(1);
    expect(svg).toContain('>01<');
    expect(pileMap([{ name: 'x', outline: null }], 'Piles')).toBe('');
  });

  it('marks template prompts and formats heights', () => {
    expect(narrativeHtml('Text [Add the purpose.] & more')).toBe(
      'Text <mark>[Add the purpose.]</mark> &amp; more',
    );
    expect(metres(0.035)).toBe('0.04 m');
    expect(metres(76.94)).toBe('76.9 m');
  });
});

describe('audit trail (M9)', () => {
  const audit = {
    root: 'ab'.repeat(32),
    count: 42,
    verified: true,
    rows: [{ code: 'F01', at: '2026-10-07 09:00', who: 'Rana Example', change: 'F01 to reviewed' }],
    more: 0,
  };
  const withAudit = (a: typeof audit | null) =>
    houseReportModel({
      manifest,
      issues: [],
      branding: resolveReportBranding(undefined, 'Stratlas'),
      audit: a,
    });

  it('prints the audit section only for a project with a journal', () => {
    expect(withAudit(audit).sections).toContain('audit');
    expect(withAudit(null).sections).not.toContain('audit');
  });

  it('puts the audit head, count and verified in every page footer', () => {
    const h = withAudit(audit);
    expect(auditFooter(h)).toContain('abababababababab');
    expect(auditFooter(h)).toContain('42 entries, verified');
    expect(auditFooter({ ...h, audit: { ...audit, verified: false } })).toContain('not verified');
    expect(auditFooter(withAudit(null))).toBe('');
    const frame = frameHtml({ ...ctx(), h });
    expect(frame).toContain('pg-fa');
  });
});

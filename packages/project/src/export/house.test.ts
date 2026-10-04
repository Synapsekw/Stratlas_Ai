import { ProjectManifest, type RoadModel, type VolumesFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sampleIssues, sampleManifest } from './fixtures';
import {
  defaultIssuePages,
  houseKind,
  houseReportModel,
  issueAction,
  narrativeFacts,
  pciRating,
} from './house';
import { resolveReportBranding } from './report';

const branding = resolveReportBranding(undefined, 'Stratlas');
const now = new Date('2026-10-04T12:00:00Z');

describe('houseReportModel', () => {
  it('prints every section and one page per graded issue by default', () => {
    const h = houseReportModel({
      manifest: sampleManifest(),
      issues: sampleIssues(),
      branding,
      now,
    });
    expect(h.kind).toBe('inspection');
    expect(h.sections).toEqual([
      'contents',
      'summary',
      'scope',
      'site',
      'statistics',
      'register',
      'issues',
      'appendices',
    ]);
    // the uncertain issue is listed in an appendix, not given a page
    expect(h.issuePages.map((r) => r.code)).toEqual(['D002', 'D010']);
    expect(h.uncertain.map((r) => r.code)).toEqual(['D001']);
    expect(h.totals).toMatchObject({ photos: 3, meshes: 1 });
    expect(h.withPhoto).toBe(2);
    expect(h.plan.map((p) => [p.code, p.map]).sort()).toEqual([
      ['D001', false],
      ['D002', false],
      ['D010', true],
    ]);
    expect(h.scale[0]?.levels.map((l) => l.label)).toEqual(['Severe', 'Minor']);
  });

  it('follows the section and issue page settings', () => {
    const h = houseReportModel({
      manifest: sampleManifest(),
      issues: sampleIssues(),
      branding,
      now,
      contents: { sections: { contents: false, site: false }, issuePages: 'above-lowest' },
    });
    expect(h.sections).not.toContain('contents');
    expect(h.sections).not.toContain('site');
    expect(h.issuePages.map((r) => r.code)).toEqual(['D002']);
    const none = houseReportModel({
      manifest: sampleManifest(),
      issues: sampleIssues(),
      branding,
      now,
      contents: { issuePages: 'none' },
    });
    expect(none.issuePages).toEqual([]);
    expect(none.sections).not.toContain('issues');
    expect(none.sections).toContain('register');
  });

  it('gives a road survey pages only above the lowest level unless the person chose', () => {
    const manifest = ProjectManifest.parse({ ...sampleManifest(), type: 'road' });
    const h = houseReportModel({ manifest, issues: sampleIssues(), branding, now });
    expect(h.kind).toBe('road');
    expect(h.issuePagesRule).toBe('above-lowest');
    expect(h.issuePages.map((r) => r.code)).toEqual(['D002']);
    const all = houseReportModel({
      manifest,
      issues: sampleIssues(),
      branding,
      now,
      contents: { issuePages: 'all' },
    });
    expect(all.issuePages.map((r) => r.code)).toEqual(['D002', 'D010']);
    expect(defaultIssuePages('inspection')).toBe('all');
    expect(defaultIssuePages('volumetric')).toBe('all');
  });

  it('prints a project without issues', () => {
    const h = houseReportModel({ manifest: sampleManifest(), issues: [], branding, now });
    expect(h.kind).toBe('fusion');
    expect(h.base.total).toBe(0);
    expect(h.issuePages).toEqual([]);
    expect(h.sections).toContain('register');
    expect(h.sections).not.toContain('issues');
    const f = narrativeFacts(h);
    expect(f.issues.total).toBe(0);
    expect(f.issues.worst).toEqual([]);
  });

  it('keeps issues without photos or positions', () => {
    const issues = sampleIssues().map((i) => ({ ...i, sightings: [] }));
    const h = houseReportModel({ manifest: sampleManifest(), issues, branding, now });
    expect(h.issuePages).toHaveLength(2);
    expect(h.issuePages.every((r) => r.photo === null && r.position === null)).toBe(true);
    expect(h.placed).toBe(0);
    expect(h.plan).toEqual([]);
  });

  it('gives the action of the severity level as the recommendation', () => {
    const m = ProjectManifest.parse({
      ...sampleManifest(),
      severityModels: [
        {
          id: 'sev',
          name: 'Facade',
          levels: [
            { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
            { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act', action: 'Repair now' },
          ],
        },
      ],
    });
    const [glass, , map] = sampleIssues();
    if (!glass || !map) throw new Error('fixtures');
    expect(issueAction(m, glass)).toBe('Repair now');
    expect(issueAction(m, map)).toBe('Monitor');
  });

  it('summarises stockpile volumes on the default base, with hand corrections', () => {
    const fc = (net: number) => ({ fill: net, cut: 0, net });
    const vols = (n: number) => ({ tin: fc(n), plane: fc(n + 1), avg: fc(n + 2), low: fc(n + 3) });
    const epoch = (net: number) => ({
      captureId: 'c1',
      areaM2: 100,
      topM: 10,
      heightM: 5,
      ring: [],
      volumes: vols(net),
    });
    const volumes: VolumesFile = {
      schema: 'aio.volumes/1',
      densityTPerM3: 1.6,
      deadbandM: 0.05,
      defaultBase: 'tin',
      bases: [{ id: 'tin', label: 'Triangulated toe' }],
      captures: [
        { epoch: 'e1', captureId: 'c1', date: '2026-01-01', label: 'Jan' },
        { epoch: 'e2', captureId: 'c2', date: '2026-02-01', label: 'Feb' },
      ],
      piles: [
        {
          id: 'P2',
          name: 'Pile 2',
          zoneRing: [],
          change: fc(-10),
          epochs: { e1: epoch(100) },
        },
        {
          id: 'P1',
          name: 'Pile 1',
          zoneRing: [],
          change: fc(5),
          epochs: { e1: epoch(50), e2: epoch(55) },
        },
      ],
      totals: {},
      pileChange: fc(-5),
      siteChange: fc(-7),
    };
    const h = houseReportModel({
      manifest: sampleManifest(),
      issues: [],
      branding,
      now,
      volumes,
      edits: {
        schema: 'aio.boundaries/1',
        edits: [
          {
            pile: 'P1',
            epoch: 'e2',
            ring: [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
            volumes: vols(60),
            areaM2: 120,
            topM: 10,
            heightM: 6,
            autoNet: 55,
            updatedAt: '2026-02-02T00:00:00Z',
          },
        ],
      },
    });
    expect(h.kind).toBe('volumetric');
    expect(h.volumes?.piles.map((p) => [p.name, p.net, p.edited])).toEqual([
      ['Pile 1', [50, 60], true],
      ['Pile 2', [100, null], false],
    ]);
    expect(h.volumes?.totals).toEqual([150, 60]);
    expect(narrativeFacts(h).volumes?.totalsM3).toEqual([150, 60]);
  });

  it('rates road sample units under the headline severity', () => {
    const ratings = [
      { min: 86, label: 'Good', color: '#1f9d55' },
      { min: 56, label: 'Fair', color: '#f2c94c' },
      { min: 0, label: 'Failed', color: '#6d6d6d' },
    ];
    expect(pciRating(ratings, 90).label).toBe('Good');
    expect(pciRating(ratings, 60).label).toBe('Fair');
    expect(pciRating(ratings, null).label).toBe('');
    const unit = (id: string, medium: number) => ({
      id,
      pavementM2: 100,
      km: 1,
      pci: { low: medium + 5, medium, high: medium - 5 },
      deducts: [{ distress: 'alligator_cracking', densityPct: 1, deduct: 10 }],
      cells: [[0, 0]] as [number, number][],
    });
    const road: RoadModel = {
      schema: 'aio.road/1',
      name: 'Ring road',
      centreline: { points: [], chainageKm: [], lengthKm: 7.5 },
      pci: {
        standard: 'ASTM D6433',
        severities: ['Low', 'Medium', 'High'],
        headline: 'medium',
        network: { low: 95, medium: 88, high: 77 },
        ratings,
        grid: { cellM: 5, origin: [0, 0, 0] },
        sections: [
          { fromKm: 0, toKm: 0.25, pavementM2: 100, pci: { low: 1, medium: 70, high: 1 } },
        ],
        units: [unit('a', 90), unit('b', 40), unit('c', 60)],
      },
      density: { gridOrigin: [0, 0, 0], sizes: {} },
    };
    const h = houseReportModel({ manifest: sampleManifest(), issues: [], branding, now, road });
    expect(h.kind).toBe('road');
    expect(h.road?.ratings.map((r) => r.count)).toEqual([1, 1, 1]);
    expect(h.road?.worst.map((w) => w.id)).toEqual(['b', 'c', 'a']);
    expect(h.road?.worst[0]?.distress).toBe('alligator cracking');
    expect(h.road?.sections[0]?.rating).toBe('Fair');
    expect(narrativeFacts(h).road?.rating).toBe('Good');
  });

  it('uses the builder type when the manifest has one', () => {
    const m = { ...sampleManifest(), type: 'twin' as const };
    expect(houseKind(m, sampleIssues(), {})).toBe('fusion');
    expect(houseKind(sampleManifest(), [], { volumes: {} })).toBe('volumetric');
  });
});

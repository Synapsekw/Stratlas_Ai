import { ProjectManifest, type RoadModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sampleIssues, sampleManifest } from './fixtures';
import {
  defaultIssuePages,
  houseKind,
  houseReportModel,
  houseVolumesOf,
  issueAction,
  narrativeFacts,
  pciRating,
  type HouseVolumes,
} from './house';
import { resolveReportBranding } from './report';

const branding = resolveReportBranding(undefined, 'Quadrion AI');
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
      'approvals',
      'appendices',
    ]);
    // the uncertain issue is listed in an appendix, not given a page
    expect(h.issuePages.map((r) => r.code)).toEqual(['D002', 'D010']);
    expect(h.uncertain.map((r) => r.code)).toEqual(['D001']);
    expect(h.totals).toMatchObject({ photos: 3, meshes: 1, walks: 0, walkMinutes: 0 });
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

  it('leaves draft model previews out of the project data', () => {
    const m = sampleManifest();
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const mesh = (id: string, draft: boolean) => ({
      kind: 'mesh' as const,
      id,
      name: id,
      src: { path: `models/${id}.glb` },
      transform: I,
      derived: { kind: 'model' as const, source: ['site'], ...(draft ? { draft: true } : {}) },
    });
    const manifest = ProjectManifest.parse({
      ...m,
      layers: [...m.layers, mesh('model-draft-site', true), mesh('model-site', false)],
    });
    const h = houseReportModel({ manifest, issues: [], branding, now });
    const names = h.layers.map((l) => l.name);
    expect(names).toContain('model-site');
    expect(names).not.toContain('model-draft-site');
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

  it('summarises the site inventory the caller worked out from engine results', () => {
    const volumes: HouseVolumes = {
      base: 'Triangulated toe',
      piles: 2,
      dates: [
        { label: 'Jan', date: '2026-01-01', totalM3: 150.4 },
        { label: 'Feb', date: '2026-02-01', totalM3: 160.2 },
      ],
      changeM3: 9.8,
      text: { date: '2026-02-01', total: '160.2 m³', change: '9.8 m³', since: '2026-01-01' },
    };
    const h = houseReportModel({ manifest: sampleManifest(), issues: [], branding, now, volumes });
    expect(h.kind).toBe('volumetric');
    expect(h.volumes).toBe(volumes);
    expect(narrativeFacts(h).volumes).toEqual({
      base: 'Triangulated toe',
      captures: ['2026-01-01', '2026-02-01'],
      piles: 2,
      totalsM3: [150, 160],
      changeM3: 10,
      total: '160.2 m³',
      change: '9.8 m³',
      since: '2026-01-01',
      date: '2026-02-01',
      movers: [],
      notCounted: 0,
    });
    expect(narrativeFacts(h).qa).toBeNull();
    const none = houseReportModel({ manifest: sampleManifest(), issues: [], branding, now });
    expect(none.volumes).toBeNull();
    expect(narrativeFacts(none).volumes).toBeNull();
  });

  it('names the piles that moved most and counts the ones left out', () => {
    const rows = [
      {
        date: '2026-01-01',
        label: 'Jan',
        totalM3: 300,
        parts: [
          { id: 'a', valueM3: 100 },
          { id: 'b', valueM3: 100 },
          { id: 'c', valueM3: 100 },
        ],
      },
      {
        date: '2026-02-01',
        label: 'Feb',
        totalM3: 290,
        parts: [
          { id: 'a', valueM3: 160 },
          { id: 'b', valueM3: 30 },
          { id: 'c', valueM3: 100 },
        ],
        change: { m3: -10 },
        notCounted: [{ id: 'd', reason: 'missing' }],
      },
    ];
    const names: Record<string, string> = { a: 'North pile', b: 'Sand', c: 'Gravel' };
    const v = houseVolumesOf(
      rows,
      ['Toe', 'Toe', 'Toe', 'Toe'],
      (m3) => `${String(m3)} m³`,
      (id) => names[id] ?? id,
    );
    expect(v?.movers).toEqual([
      { label: 'Sand', changeM3: -70, change: '70 m³' },
      { label: 'North pile', changeM3: 60, change: '60 m³' },
    ]);
    expect(v?.notCounted).toBe(1);
    // without names, none are worked out
    expect(houseVolumesOf(rows, ['Toe'], String)?.movers).toBeUndefined();
  });

  it('carries the survey QA verdicts by date, holds named', () => {
    const manifest = ProjectManifest.parse({
      ...sampleManifest(),
      captures: [
        { id: 'c1', label: 'Survey Jan', date: '2026-01-02' },
        { id: 'c2', label: 'Survey Feb', date: '2026-02-02' },
        { id: 'c3', label: 'Survey Mar', date: '2026-03-02' },
      ],
    });
    const h = houseReportModel({
      manifest,
      issues: [],
      branding,
      now,
      qa: [
        { capture: 'c3', status: 'hold' },
        { capture: 'c1', status: 'pass' },
        { capture: 'c2', status: 'released' },
      ],
    });
    expect(narrativeFacts(h).qa).toEqual({
      held: [{ label: 'Survey Mar', date: '2026-03-02' }],
      passed: 1,
      released: 1,
      unchecked: 0,
    });
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

  it('counts walk layers and their total length in minutes', () => {
    const base = sampleManifest();
    const walk = (id: string, durationS: number) => ({
      kind: 'walk' as const,
      id: `walk-${id}`,
      name: `Walk ${id}`,
      record: { path: `walks/${id}/walk.json` },
      src: { path: `walks/${id}/playback.mp4` },
      durationS,
    });
    const manifest = ProjectManifest.parse({
      ...base,
      layers: [...base.layers, walk('a', 90), walk('b', 150)],
    });
    const h = houseReportModel({ manifest, issues: sampleIssues(), branding, now });
    expect(h.totals).toMatchObject({ walks: 2, walkMinutes: 4 });
    expect(h.layers.filter((r) => r.kind === 'walk')).toMatchObject([
      { name: 'Walk a', count: 2 },
      { name: 'Walk b', count: 3 },
    ]);
  });
});

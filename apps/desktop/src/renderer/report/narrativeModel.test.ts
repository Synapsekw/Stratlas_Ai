import { houseReportModel, narrativeFacts, resolveReportBranding } from '@aio/project/export';
import { NarrativeFile, ProjectManifest, type Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  changedParts,
  editorTexts,
  hasPlaceholders,
  restoreVersion,
  saveParts,
  versionsOf,
} from './narrativeModel';
import { dataLine, listOf, longDate, templateNarrative } from './narrativeTemplate';

const sampleManifest = () =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'site',
    name: 'Sample site',
    customer: 'ACME',
    site: 'Kuwait',
    crs: { epsg: 32639 },
    origin: [245714, 3179542, 100],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-02' }],
    layers: [
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [{ id: 'p1', src: { path: 'photos/p1.jpg' } }],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Facade',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Facade classes',
        assetType: 'facade',
        classes: [
          { id: 'glazing', label: 'Glazing damage', color: '#ee3f4b', severityModel: 'sev' },
        ],
      },
    ],
  });

const issue = (code: string, severity: Issue['severity']): Issue => ({
  id: code,
  code,
  classId: 'glazing',
  severityModelId: 'sev',
  severity,
  status: 'reviewed',
  title: `Cracked pane ${code}`,
  note: '',
  author: 'Reviewer',
  createdAt: '2026-01-02T10:00:00Z',
  updatedAt: '2026-01-02T10:00:00Z',
  source: 'human',
  sightings: [],
});
const sampleIssues = () => [issue('D002', 3), issue('D001', 'uncertain'), issue('D010', 1)];

const empty = { summary: '', method: '', findings: '' };
const at = (s: string) => new Date(`2026-10-04T${s}:00Z`);

describe('narrative versions', () => {
  it('saves only changed parts as new versions and keeps the old ones', () => {
    let f = saveParts(
      null,
      { summary: 'AI text', method: 'AI method' },
      { source: 'ai' },
      at('10:00'),
    );
    // findings was never saved: the editor's fallback text counts as a change
    expect(changedParts(f, editorTexts(f, empty))).toEqual(['findings']);
    f = saveParts(
      f,
      { summary: 'Edited', method: 'AI method' },
      { source: 'user', author: 'D' },
      at('10:05'),
    );
    expect(versionsOf(f, 'summary').map((v) => [v.version.text, v.version.source])).toEqual([
      ['Edited', 'user'],
      ['AI text', 'ai'],
    ]);
    expect(f?.parts.method?.versions).toHaveLength(1);
    expect(NarrativeFile.safeParse(f).success).toBe(true);
  });

  it('shows saved texts in the editor, the fallback for parts never saved', () => {
    const f = saveParts(null, { findings: 'Saved' }, { source: 'user' });
    const t = editorTexts(f, { summary: 'S', method: 'M', findings: 'F' });
    expect(t).toEqual({ summary: 'S', method: 'M', findings: 'Saved' });
    expect(changedParts(f, t)).toEqual(['summary', 'method']);
  });

  it('restores an old version as the newest without losing any', () => {
    let f = saveParts(null, { summary: 'One' }, { source: 'ai', model: 'm' }, at('09:00'));
    f = saveParts(f, { summary: 'Two' }, { source: 'user' }, at('09:10'));
    if (!f) throw new Error('saved');
    const r = restoreVersion(f, 'summary', 0, at('09:20'));
    expect(r.parts.summary?.versions.map((v) => v.text)).toEqual(['One', 'Two', 'One']);
    expect(r.parts.summary?.versions[2]).toMatchObject({ source: 'ai', model: 'm' });
    expect(restoreVersion(r, 'summary', 2)).toBe(r);
  });

  it('finds template prompts still to fill', () => {
    expect(hasPlaceholders('Text [Add the purpose of the survey.]')).toBe(true);
    expect(hasPlaceholders('Plain [1] text')).toBe(false);
  });
});

describe('narrative template', () => {
  const h = houseReportModel({
    manifest: sampleManifest(),
    issues: sampleIssues(),
    branding: resolveReportBranding(undefined, 'Stratlas'),
    now: at('12:00'),
  });
  const facts = narrativeFacts(h);

  it('fills the statistics in, with prompts for the author when asked', () => {
    const t = templateNarrative(facts, { todo: true });
    expect(t.summary).toContain('Sample site at Kuwait was surveyed on 2 Jan 2026.');
    expect(t.summary).toContain('3 issues');
    expect(t.summary).toContain('D002');
    expect(hasPlaceholders(t.summary)).toBe(true);
    expect(hasPlaceholders(t.method)).toBe(true);
    expect(t.findings).toContain('listed in the appendix');
    const plain = templateNarrative(facts, { todo: false });
    expect(hasPlaceholders(`${plain.summary}${plain.method}${plain.findings}`)).toBe(false);
    expect(`${t.summary}${t.method}${t.findings}`).not.toMatch(/[â€“â€”]/);
  });

  it('writes a project without issues', () => {
    const none = narrativeFacts(
      houseReportModel({
        manifest: sampleManifest(),
        issues: [],
        branding: resolveReportBranding(undefined, 'Stratlas'),
      }),
    );
    const t = templateNarrative(none, { todo: false });
    expect(t.findings).toBe('No issues were recorded.');
    expect(t.summary).not.toContain('undefined');
  });

  it('formats lists, dates and data', () => {
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    expect(longDate('2019-01-24')).toBe('24 Jan 2019');
    expect(
      dataLine({
        photos: 1,
        panoramas: 0,
        videos: 2,
        meshes: 1,
        clouds: 1,
        points: 1500,
        rasters: 0,
        vectors: 0,
      }),
    ).toBe('1 photo, 2 video clips, 1 3D model and 1 point cloud (1,500 points)');
  });
});

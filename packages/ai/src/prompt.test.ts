import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt';

describe('the system prompt', () => {
  it('tells the model how to show things, with the tools and the severity wording', () => {
    const p = systemPrompt('issues');
    expect(p).toContain('Showing things:');
    expect(p).toContain('show_issue');
    expect(p).toContain('show_photos');
    expect(p).toContain('show_issues');
    expect(p).toContain('highest level present');
    expect(p).toContain('severityLevels');
    expect(p.indexOf('Showing things:')).toBeLessThan(p.indexOf('Rules:'));
  });

  it('says "this asset" is the selected asset: an area cannot be selected', () => {
    const p = systemPrompt('scene3d');
    expect(p).toContain(
      '- "This asset" means the selected asset (where: "selection"). With nothing selected it means the whole project: leave where out.',
    );
    expect(p).not.toContain('selected asset or area');
  });

  it('says why a photo count and a finding count can differ', () => {
    const p = systemPrompt('photo');
    const line =
      '- Photo counts in Media include detections that are not accepted yet. Findings do not. Say so when the two numbers differ.';
    expect(p.split('\n')).toContain(line);
    // inside the block on showing things
    expect(p.indexOf('Showing things:')).toBeLessThan(p.indexOf(line));
    expect(p.indexOf(line)).toBeLessThan(p.indexOf('Rules:'));
  });

  it('has no en or em dash in any profile', () => {
    for (const profile of ['full', 'compact', 'answer-only'] as const) {
      expect(systemPrompt('scene3d', profile)).not.toMatch(/[–—]/);
    }
  });

  it('names the show tools in the compact prompt', () => {
    const p = systemPrompt('photo', 'compact');
    expect(p).toContain('show_issue');
    expect(p).toContain('show_photos');
  });

  it('is the same for the same window, so it caches', () => {
    expect(systemPrompt('map')).toBe(systemPrompt('map'));
  });
});

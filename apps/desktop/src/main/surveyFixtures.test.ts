import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { missingSurveyDemoFiles, SURVEY_DEMOS } from '../../e2e/surveyFixtures';

describe('the survey demo cache check', () => {
  let dir = '';
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the truth file of every demo that lacks one', () => {
    dir = mkdtempSync(join(tmpdir(), 'survey-cache-'));
    const demos = Object.values(SURVEY_DEMOS);
    for (const d of demos) mkdirSync(join(dir, d.id));
    writeFileSync(join(dir, SURVEY_DEMOS.earthworks.id, 'truth.json'), '{}');
    writeFileSync(join(dir, SURVEY_DEMOS.earthworks.id, 'manifest.json'), '{}');
    const missing = missingSurveyDemoFiles(dir);
    expect(missing).toHaveLength(6);
    expect(missing.some((f) => f.includes(SURVEY_DEMOS.earthworks.id))).toBe(false);
  });

  it('is empty when all four demos have a truth file', () => {
    dir = mkdtempSync(join(tmpdir(), 'survey-cache-'));
    for (const d of Object.values(SURVEY_DEMOS)) {
      mkdirSync(join(dir, d.id));
      writeFileSync(join(dir, d.id, 'truth.json'), '{}');
      writeFileSync(join(dir, d.id, 'manifest.json'), '{}');
    }
    expect(missingSurveyDemoFiles(dir)).toEqual([]);
  });
});

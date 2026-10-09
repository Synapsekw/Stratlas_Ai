import {
  ComparisonItem,
  ComparisonPreset,
  IndustrySet,
  isSurfaceSide,
  SurveyTemplate,
  SurveyTemplatesFile,
} from '@aio/schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { availableItems, itemsFromPresets, templateLibrary, templateProblems } from './model';
import { industrySet, industryTemplates, INDUSTRY_SET_LABELS } from './industry';
import { TOOL_FAMILY } from '../tools/readout';

const raw = (set: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${set}.json`, import.meta.url), 'utf8')) as unknown;

/** What each set must offer (plan G9, PRD SRV-14). */
const NAMES: Record<IndustrySet, string[]> = {
  construction: [
    'OG to subgrade design',
    'Survey to OG',
    'Survey to subgrade',
    'Compare to previous',
    'Pad check',
    'Area progress',
  ],
  mining: [
    'Stockpile (smart base)',
    'Bench volume to reference level',
    'Blast area',
    'Post-blast',
    'Berm check',
    'End-of-month inventory',
    'Exclusion zone',
  ],
  landfill: [
    'Cell progress',
    'Lift heights',
    'Airspace remaining',
    'Compaction',
    'Monthly cell report',
    'Daily change',
  ],
};

describe('industry template sets', () => {
  for (const set of IndustrySet.options) {
    describe(set, () => {
      it('is a valid SurveyTemplatesFile with the set named on every template', () => {
        const file = SurveyTemplatesFile.parse(raw(set));
        expect(file.templates.map((t) => t.name)).toEqual(NAMES[set]);
        for (const t of file.templates) {
          expect(t.set, t.id).toBe(set);
          expect(t.id.startsWith(`${set}-`), t.id).toBe(true);
          expect(t.bookmarked, t.id).toBe(true);
        }
      });

      it('has templates that parse, can be saved and show their own rows', () => {
        for (const t of industrySet(set)) {
          expect(SurveyTemplate.safeParse(t).success, t.id).toBe(true);
          expect(templateProblems(t), t.id).toEqual([]);
          expect(TOOL_FAMILY[t.tool], t.id).toBe(t.family);
          const offered = availableItems(t.tool);
          for (const k of t.items) expect(offered, `${t.id} ${k}`).toContain(k);
          for (const f of t.fields)
            if (f.type === 'dropdown') expect(f.options?.length ?? 0, f.id).toBeGreaterThan(0);
        }
      });

      it('has comparison presets with a surface on at least one side (isSurfaceSide)', () => {
        for (const t of industrySet(set)) {
          if (t.tool !== 'volume') expect(t.comparisons, t.id).toEqual([]);
          else expect(t.comparisons.length, t.id).toBeGreaterThan(0);
          for (const p of t.comparisons) {
            expect(ComparisonPreset.safeParse(p).success, `${t.id} ${p.label ?? ''}`).toBe(true);
            expect(isSurfaceSide(p.from) || isSurfaceSide(p.to), t.id).toBe(true);
            // a deadband preset says so explicitly, never a silent default
            if (p.useDeadband) expect(p.deadbandM, t.id).toBeGreaterThan(0);
          }
          // a measurement made from it gets valid comparison items
          for (const it of itemsFromPresets(t.comparisons))
            expect(ComparisonItem.safeParse(it).success, t.id).toBe(true);
        }
      });

      it('has no em or en dashes in what a person reads', () => {
        expect(JSON.stringify(raw(set))).not.toMatch(/[–—]/);
      });
    });
  }

  it('gives the templates of the enabled sets, in set order, each once', () => {
    expect(industryTemplates([])).toEqual([]);
    const both = industryTemplates(['landfill', 'construction', 'landfill']);
    expect(both.map((t) => t.set)).toEqual([
      ...NAMES.construction.map(() => 'construction'),
      ...NAMES.landfill.map(() => 'landfill'),
    ]);
    const ids = industryTemplates(['construction', 'mining', 'landfill']).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(INDUSTRY_SET_LABELS).sort()).toEqual([...IndustrySet.options].sort());
  });

  it('joins the toolbar after the project and the library; a same id is the project own', () => {
    const own = { ...industrySet('mining')[0], name: 'Our stockpile' } as SurveyTemplate;
    const lib = templateLibrary(
      { schema: 'aio.survey-templates/1', templates: [own] },
      null,
      industryTemplates(['mining']),
    );
    expect(lib[0]).toMatchObject({ source: 'project', template: { name: 'Our stockpile' } });
    expect(lib.filter((l) => l.source === 'set')).toHaveLength(NAMES.mining.length - 1);
  });
});

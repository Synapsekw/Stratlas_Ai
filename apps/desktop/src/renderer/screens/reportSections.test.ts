import { HOUSE_SECTIONS } from '@aio/project/export';
import { defaultSurveySettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { offeredSections, sectionsWithData } from './reportSections';

const DATA_SECTIONS = ['measurements', 'earthworks', 'stockpiles', 'landfill', 'haul', 'hydrology'];

describe('report sections offered on the Reports screen', () => {
  it('leaves out the survey and run sections a project has no data for', () => {
    const offered = offeredSections([]);
    for (const id of DATA_SECTIONS) expect(offered).not.toContain(id);
    expect(offered).toEqual(HOUSE_SECTIONS.filter((id) => !DATA_SECTIONS.includes(id)));
  });

  it('offers a data section once the project has it, in the report order', () => {
    const offered = offeredSections(['hydrology', 'stockpiles']);
    expect(offered.filter((id) => DATA_SECTIONS.includes(id))).toEqual(['stockpiles', 'hydrology']);
    expect(offered).not.toContain('landfill');
    expect(offered).not.toContain('haul');
  });

  it('offers no data section while the survey files are still being read', () => {
    expect(offeredSections(null)).toEqual(offeredSections([]));
  });
});

describe('the sections a project has data for', () => {
  const none = {
    measurements: [],
    settings: defaultSurveySettings(),
    templates: null,
    haulRuns: 0,
    hydroRuns: 0,
  };

  it('is none for a project without survey measurements or runs (a tank farm)', () => {
    expect(sectionsWithData(none)).toEqual([]);
  });

  it('names the run sections of a project with haul-road or hydrology runs', () => {
    expect(sectionsWithData({ ...none, haulRuns: 2 })).toEqual(['haul']);
    expect(sectionsWithData({ ...none, hydroRuns: 1 })).toEqual(['hydrology']);
  });
});

import { PipelineName, PIPELINES } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  groupedPipelines,
  JOB_KIND,
  jobKind,
  jobTitle,
  KIND_LABEL,
  PIPELINE_GROUP,
  PIPELINE_GROUPS,
  ungroupedPipelines,
} from './pipelines';

describe('pipelines by area (the Advanced list)', () => {
  it('gives every pipeline of the schema exactly one area', () => {
    // fails when a pipeline is added to the schema without an area in PIPELINE_GROUP
    expect(ungroupedPipelines()).toEqual([]);
    expect(
      ungroupedPipelines(
        PipelineName.options.map((name) => ({ name, title: '', description: '' })),
      ),
    ).toEqual([]);
    expect(Object.keys(PIPELINE_GROUP).sort()).toEqual([...PipelineName.options].sort());
    const areas = new Set(PIPELINE_GROUPS.map((g) => g.id));
    for (const area of Object.values(PIPELINE_GROUP)) expect(areas.has(area)).toBe(true);
  });

  it('lists each pipeline once, none missing, in the areas of the brief', () => {
    const groups = groupedPipelines(PIPELINES);
    const listed = groups.flatMap((g) => g.pipelines.map((p) => p.name));
    expect(listed).toHaveLength(PIPELINES.length);
    expect(new Set(listed).size).toBe(PIPELINES.length);
    expect([...listed].sort()).toEqual(PIPELINES.map((p) => p.name).sort());
    expect(groups.map((g) => g.label)).toEqual([
      'Photos to maps',
      'Inspection',
      'Stockpiles and volumes',
      'Change between dates',
      'Survey tools',
      'Water and haul roads',
      'Import and convert',
      'Map packs',
      'Road survey',
      'Telecom coverage',
      'System',
    ]);
    // no area is empty, and Other only appears for a pipeline nobody placed
    expect(groups.every((g) => g.pipelines.length > 0)).toBe(true);
    expect(groups.some((g) => g.id === 'other')).toBe(false);
  });

  it('keeps the order of the schema inside an area', () => {
    const photos = groupedPipelines(PIPELINES).find((g) => g.id === 'photos');
    expect(photos?.pipelines.map((p) => p.name)).toEqual([
      'photo.align',
      'photo.georef',
      'photo.products',
    ]);
  });

  it('reports a pipeline without an area and still shows it, under Other', () => {
    const grown = [...PIPELINES, { name: 'new.thing', title: 'New thing', description: '' }];
    expect(ungroupedPipelines(grown)).toEqual(['new.thing']);
    const groups = groupedPipelines(grown);
    expect(groups.at(-1)).toMatchObject({ id: 'other', label: 'Other' });
    expect(groups.at(-1)?.pipelines.map((p) => p.name)).toEqual(['new.thing']);
    expect(groups.flatMap((g) => g.pipelines)).toHaveLength(grown.length);
  });
});

describe('job titles', () => {
  it('reads the photo jobs as one activity and leaves the rest as the schema names them', () => {
    expect(jobTitle('photo.align')).toBe('Maps from photos: matching the photos');
    expect(jobTitle('photo.products')).toBe('Maps from photos: building the maps');
    expect(jobTitle('photo.georef')).toBe('Maps from photos: ground control');
    expect(jobTitle('system.selftest')).toBe('Check the pipeline pack');
    expect(jobTitle('road.build')).toBe('Road survey');
  });
});

describe('the kind of a job', () => {
  it('gives every pipeline of the schema exactly one kind', () => {
    expect(Object.keys(JOB_KIND).sort()).toEqual(PIPELINES.map((p) => p.name).sort());
  });

  it('tells map processing from AI analysis', () => {
    expect(jobKind('photo.products')).toBe('maps');
    expect(jobKind('model.fit_cloud')).toBe('maps');
    expect(jobKind('model.evidence')).toBe('maps');
    expect(jobKind('inspection.run')).toBe('ai');
    expect(jobKind('aik.cameras')).toBe('ai');
    expect(jobKind('survey.compare')).toBe('survey');
    expect(jobKind('road.build')).toBe('survey');
    expect(jobKind('survey.export')).toBe('files');
    expect(jobKind('tiles.mesh')).toBe('files');
    expect(jobKind('packs.imagery')).toBe('system');
    expect(jobKind('system.selftest')).toBe('system');
  });

  it('files a pipeline it does not know under System', () => {
    expect(jobKind('later.pipeline')).toBe('system');
  });

  it('has a label for every kind', () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual(['ai', 'files', 'maps', 'survey', 'system']);
  });
});

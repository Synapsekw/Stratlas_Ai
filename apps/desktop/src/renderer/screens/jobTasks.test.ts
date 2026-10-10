import { PipelineName, PIPELINES } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  groupedPipelines,
  JOB_TASK_SECTIONS,
  JOB_TASKS,
  jobTitle,
  PIPELINE_GROUP,
  PIPELINE_GROUPS,
  PRIMARY_TASK,
  taskBlocked,
  tasksOf,
  ungroupedPipelines,
} from './jobTasks';

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

describe('the tasks of New job', () => {
  const known = new Set<string>(PIPELINES.map((p) => p.name));

  it('starts with Create maps from photos, the primary task', () => {
    expect(JOB_TASKS[0]?.id).toBe(PRIMARY_TASK);
    expect(JOB_TASKS[0]?.title).toBe('Create maps from photos');
    expect(JOB_TASKS[0]?.pipelines).toEqual(['photo.align', 'photo.georef', 'photo.products']);
  });

  it('is a short list under three headings, every task in one of them', () => {
    expect(JOB_TASKS.length).toBeLessThanOrEqual(10);
    expect(JOB_TASK_SECTIONS.map((s) => s.label)).toEqual([
      'Maps and models',
      'Measure and compare',
      'Import and convert',
    ]);
    const placed = JOB_TASK_SECTIONS.flatMap((s) => tasksOf(s.id));
    expect(placed.map((t) => t.id).sort()).toEqual(JOB_TASKS.map((t) => t.id).sort());
    for (const s of JOB_TASK_SECTIONS) expect(tasksOf(s.id).length).toBeGreaterThan(0);
  });

  it('has unique tasks that name real pipelines and speak plainly', () => {
    expect(new Set(JOB_TASKS.map((t) => t.id)).size).toBe(JOB_TASKS.length);
    expect(new Set(JOB_TASKS.map((t) => t.title)).size).toBe(JOB_TASKS.length);
    for (const t of JOB_TASKS) {
      expect(t.pipelines.length).toBeGreaterThan(0);
      for (const p of t.pipelines) expect(known.has(p)).toBe(true);
      // no engine-room words, no em or en dashes in what a person reads
      expect(`${t.title} ${t.hint}`).not.toMatch(/pipeline|photogrammetry|[–—]/i);
    }
  });

  it('says what a task needs before it can open', () => {
    const maps = JOB_TASKS.find((t) => t.id === 'photo-maps');
    const changes = JOB_TASKS.find((t) => t.id === 'changes');
    const stockpiles = JOB_TASKS.find((t) => t.id === 'stockpiles');
    if (!maps || !changes || !stockpiles) throw new Error('a task is missing');
    expect(taskBlocked(maps, { project: false, surveyDates: 0 })).toBe('Open a project first.');
    expect(taskBlocked(maps, { project: true, surveyDates: 0 })).toBeNull();
    expect(taskBlocked(changes, { project: true, surveyDates: 1 })).toBe(
      'This project needs two survey dates.',
    );
    expect(taskBlocked(changes, { project: true, surveyDates: 2 })).toBeNull();
    // a new project needs nothing open
    expect(taskBlocked(stockpiles, { project: false, surveyDates: 0 })).toBeNull();
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

import { PIPELINES } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { JOB_TASK_SECTIONS, JOB_TASKS, PRIMARY_TASK, taskBlocked, tasksOf } from './jobTasks';

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

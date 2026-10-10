import type { JobRecord, JobStep } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { phaseState, plannedPhases, runView } from './phases';

const step = (name: string, state: JobStep['state']): JobStep => ({ name, state });

function job(
  pipeline: JobRecord['pipeline'],
  status: JobRecord['status'],
  steps: JobStep[],
  o: Partial<JobRecord> = {},
): JobRecord {
  return {
    id: `${pipeline}-1`,
    pipeline,
    project: 'C:/site',
    params: { run: '20261010-0900' },
    status,
    progress: 0,
    steps,
    artifacts: [],
    createdAt: '2026-10-10T09:00:00.000Z',
    updatedAt: '2026-10-10T09:00:00.000Z',
    ...o,
  };
}

const ALIGN = ['inspect', 'features', 'match', 'sfm', 'georef', 'report'];
const align = (states: JobStep['state'][], status: JobRecord['status'], progress = 0) =>
  job(
    'photo.align',
    status,
    ALIGN.map((n, i) => step(n, states[i] ?? 'pending')),
    { progress },
  );
const allDone: JobStep['state'][] = ['done', 'done', 'done', 'done', 'done', 'done'];

describe('one phase from its stages', () => {
  it('follows the stages in it', () => {
    expect(phaseState([], true)).toBe('pending');
    expect(phaseState([step('a', 'pending')], true)).toBe('pending');
    expect(phaseState([step('a', 'done'), step('b', 'running')], true)).toBe('running');
    expect(phaseState([step('a', 'done'), step('b', 'skipped')], true)).toBe('done');
    expect(phaseState([step('a', 'skipped'), step('b', 'skipped')], true)).toBe('kept');
    expect(phaseState([step('a', 'done'), step('b', 'failed')], false)).toBe('failed');
    expect(phaseState([step('a', 'done'), step('b', 'cancelled')], false)).toBe('stopped');
    // between two stages of a job at work the phase is still working
    expect(phaseState([step('a', 'done'), step('b', 'pending')], true)).toBe('running');
    expect(phaseState([step('a', 'done'), step('b', 'pending')], false)).toBe('stopped');
  });
});

describe('a run as one list of phases', () => {
  it('shows matching and the maps to come as one run, in plain words', () => {
    const v = runView(
      [align(['done', 'running'], 'running', 0.4)],
      ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'],
    );
    expect(v.phases.map((p) => [p.label, p.state])).toEqual([
      ['Reading photos', 'done'],
      ['Matching photos', 'running'],
      ['Building the map', 'pending'],
      ['Building the 3D model', 'pending'],
      ['Adding to the project', 'pending'],
    ]);
    expect(v.headline).toBe('Matching photos');
    // matching is the first third of the whole run
    expect(v.percent).toBe(12);
    expect(v.between).toBe(false);
    for (const p of v.phases) expect(p.label).not.toMatch(/align|product|pipeline/i);
  });

  it('is still at work between matching and the maps', () => {
    const v = runView([align(allDone, 'done', 1)], ['ortho', 'dsm']);
    expect(v.between).toBe(true);
    expect(v.headline).toBe('Building the map');
    expect(v.percent).toBe(30);
    // a quick run without a 3D model has no such phase
    expect(v.phases.map((p) => p.id)).toEqual(['read', 'match', 'map', 'add']);
  });

  it('carries on into the maps job', () => {
    const products = job(
      'photo.products',
      'running',
      [
        step('prepare', 'done'),
        step('dense', 'done'),
        step('fuse', 'done'),
        step('ortho', 'done'),
        step('mesh', 'running'),
        step('texture', 'pending'),
        step('commit', 'pending'),
      ],
      { id: 'p-1', progress: 0.5, createdAt: '2026-10-10T09:30:00.000Z' },
    );
    const v = runView([products, align(allDone, 'done', 1)], null);
    expect(v.job?.id).toBe('p-1');
    expect(v.phases.map((p) => [p.id, p.state])).toEqual([
      ['read', 'done'],
      ['match', 'done'],
      ['map', 'done'],
      ['model', 'running'],
      ['add', 'pending'],
    ]);
    expect(v.headline).toBe('Building the 3D model');
    expect(v.percent).toBe(65);
  });

  it('has nothing left to do when both jobs are done', () => {
    const products = job(
      'photo.products',
      'done',
      [step('dense', 'done'), step('ortho', 'done'), step('commit', 'done')],
      { progress: 1, createdAt: '2026-10-10T09:30:00.000Z' },
    );
    const v = runView([products, align(allDone, 'done', 1)], null);
    expect(v.headline).toBeNull();
    expect(v.percent).toBe(100);
  });

  it('shows a pause, and what was kept after resuming', () => {
    const paused = runView(
      [align(['done', 'cancelled'], 'cancelled', 0.2)],
      ['ortho', 'dsm', 'mesh'],
    );
    expect(paused.phases.slice(0, 2).map((p) => p.state)).toEqual(['done', 'stopped']);
    expect(paused.phases.find((p) => p.id === 'map')?.state).toBe('pending');
    const resumed = runView([align(['skipped', 'running'], 'running', 0.3)], ['ortho']);
    expect(resumed.phases[0]).toMatchObject({ id: 'read', state: 'kept' });
  });

  it('drops the maps to come when they are no longer queued', () => {
    const v = runView([align(['done', 'cancelled'], 'cancelled', 0.2)], null);
    expect(v.phases.map((p) => p.id)).toEqual(['read', 'match']);
    expect(v.percent).toBe(20);
  });

  it('shows the ground control adjustment as its own single phase', () => {
    const georef = job(
      'photo.georef',
      'running',
      [step('adjust', 'running'), step('report', 'pending'), step('commit', 'pending')],
      { progress: 0.5, createdAt: '2026-10-10T10:00:00.000Z' },
    );
    const v = runView([georef, align(allDone, 'done', 1)], null);
    expect(v.phases).toEqual([
      { id: 'control', label: 'Improving accuracy with ground control', state: 'running' },
    ]);
    expect(v.percent).toBe(50);
  });

  it('ignores maps made before the photos were matched again', () => {
    const old = job('photo.products', 'done', [step('ortho', 'done')], {
      createdAt: '2026-10-09T09:00:00.000Z',
      progress: 1,
    });
    const v = runView([align(['running'], 'running', 0.1), old], ['ortho']);
    expect(v.phases.find((p) => p.id === 'map')?.state).toBe('pending');
  });

  it('plans the phases of the outputs a person asked for', () => {
    expect(plannedPhases([])).toEqual([]);
    expect(plannedPhases(['ortho', 'dsm'])).toEqual(['map', 'add']);
    expect(plannedPhases(['ortho', 'mesh'])).toEqual(['map', 'model', 'add']);
    expect(plannedPhases(['tiles'])).toEqual(['map', 'model', 'add']);
  });

  it('is empty before any job exists', () => {
    expect(runView([], ['ortho'])).toMatchObject({ job: null, phases: [], percent: 0 });
  });
});

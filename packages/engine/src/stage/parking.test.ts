// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { createWorkspace, type OpenProject } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { configureEngine, engineConfig } from '../config';
import {
  hasParkedStage,
  parkStage,
  releaseParkedStage,
  takeParkedStage,
  type Parkable,
} from './parking';

function project(id: string, root = `E:/${id}`): OpenProject {
  const manifest: ProjectManifest = {
    schema: 'aio.project/1',
    id,
    name: id,
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  };
  return { id, root, manifest };
}

function fakeStage(projectId: string) {
  const log: string[] = [];
  const stage: Parkable & { lost: boolean; log: string[] } = {
    projectId,
    lost: false,
    get contextLost() {
      return this.lost;
    },
    antialias: engineConfig().quality.antialias !== false,
    log,
    park: () => log.push('park'),
    resume: () => log.push('resume'),
    setQuality: () => log.push('quality'),
    dispose: () => log.push('dispose'),
  };
  return stage;
}

describe('stage parking', () => {
  const host = document.createElement('div');
  afterEach(() => {
    releaseParkedStage();
  });

  it('keeps the stage of the open project and gives it back to the next view', () => {
    const store = createWorkspace();
    store.getState().openProject(project('a'));
    const stage = fakeStage('a');
    expect(parkStage(stage, store)).toBe(true);
    expect(stage.log).toEqual(['park']);
    expect(takeParkedStage(store, host)).toBe(stage);
    // shown again with the graphics tier of now
    expect(stage.log).toEqual(['park', 'resume', 'quality']);
    expect(hasParkedStage()).toBe(false);
  });

  it('keeps nothing without an open project', () => {
    const store = createWorkspace();
    expect(parkStage(fakeStage('a'), store)).toBe(false);
    expect(hasParkedStage()).toBe(false);
  });

  it('lets the stage go when another project opens or the project closes', () => {
    const store = createWorkspace();
    store.getState().openProject(project('a'));
    const a = fakeStage('a');
    parkStage(a, store);
    // the same project with an edited manifest keeps it
    store.getState().openProject({ ...project('a'), manifest: { ...project('a').manifest } });
    expect(hasParkedStage()).toBe(true);
    store.getState().openProject(project('b'));
    expect(a.log).toEqual(['park', 'dispose']);
    expect(takeParkedStage(store, host)).toBeNull();

    store.getState().openProject(project('a'));
    const again = fakeStage('a');
    parkStage(again, store);
    store.getState().closeProject();
    expect(again.log).toEqual(['park', 'dispose']);
  });

  it('builds anew for another store, a lost context or a renderer made otherwise', () => {
    const store = createWorkspace();
    store.getState().openProject(project('a'));
    const other = createWorkspace();
    other.getState().openProject(project('a'));
    const a = fakeStage('a');
    parkStage(a, store);
    expect(takeParkedStage(other, host)).toBeNull();
    expect(a.log).toEqual(['park', 'dispose']);

    const lost = fakeStage('a');
    parkStage(lost, store);
    lost.lost = true;
    expect(takeParkedStage(store, host)).toBeNull();
    expect(lost.log.at(-1)).toBe('dispose');

    const was = engineConfig().quality;
    const aa = fakeStage('a');
    parkStage(aa, store);
    configureEngine({ quality: { ...was, antialias: !aa.antialias } });
    try {
      expect(takeParkedStage(store, host)).toBeNull();
      expect(aa.log.at(-1)).toBe('dispose');
    } finally {
      configureEngine({ quality: was });
    }
  });

  it('keeps one stage at most', () => {
    const store = createWorkspace();
    store.getState().openProject(project('a'));
    const first = fakeStage('a');
    const second = fakeStage('a');
    parkStage(first, store);
    parkStage(second, store);
    expect(first.log).toEqual(['park', 'dispose']);
    expect(takeParkedStage(store, host)).toBe(second);
  });
});

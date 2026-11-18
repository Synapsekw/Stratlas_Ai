import { describe, expect, it } from 'vitest';
import { ipc, ProjectManifest, projectToolSets, ToolSet } from './index';

const base = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const parse = (toolSets: unknown) => {
  const r = ProjectManifest.safeParse({ ...base, toolSets });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
};

describe('project tool sets', () => {
  it('names the five sets', () => {
    expect(ToolSet.options).toEqual(['earthworks', 'road', 'engineering', 'telecom', 'thermal']);
  });

  it('is optional: a manifest without it parses to what it was, and reads as not chosen', () => {
    const r = ProjectManifest.safeParse(base);
    expect(r.success && r.data).toEqual(base);
    expect(r.success && projectToolSets(r.data)).toBeUndefined();
  });

  it('keeps the list a person chose, the empty one too', () => {
    expect(projectToolSets(parse(['telecom', 'thermal']))).toEqual(['telecom', 'thermal']);
    expect(projectToolSets(parse([]))).toEqual([]);
  });

  it('never refuses a name of a later build: it stays in the file and is not read', () => {
    const m = parse(['telecom', 'marine']);
    expect(m.toolSets).toEqual(['telecom', 'marine']);
    expect(projectToolSets(m)).toEqual(['telecom']);
  });

  it('reads a malformed value as absent instead of failing', () => {
    for (const bad of [7, null, 'telecom', ['Has Spaces'], [3], Array(17).fill('road')]) {
      const m = parse(bad);
      expect(m.toolSets).toBeUndefined();
      expect(projectToolSets(m)).toBeUndefined();
    }
  });

  it('reads each set once', () => {
    expect(projectToolSets(parse(['road', 'road']))).toEqual(['road']);
  });
});

describe('project:setToolSets', () => {
  const { request } = ipc['project:setToolSets'];

  it('takes a list of known sets, or null for what the project type gives', () => {
    expect(request.safeParse({ projectId: 'p', toolSets: ['telecom'] }).success).toBe(true);
    expect(request.safeParse({ projectId: 'p', toolSets: [] }).success).toBe(true);
    expect(request.safeParse({ projectId: 'p', toolSets: null }).success).toBe(true);
  });

  it('refuses an unknown set and an extra field', () => {
    expect(request.safeParse({ projectId: 'p', toolSets: ['marine'] }).success).toBe(false);
    expect(request.safeParse({ projectId: 'p', toolSets: [], more: 1 }).success).toBe(false);
  });
});

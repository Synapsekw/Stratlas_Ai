import { ProjectManifest, type JobRecord } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeSpace, setActiveSpace } from '../spaces/activeSpace';
import { activeSpaceOf, scopedManifest } from '../spaces/spaceModel';
import { followImport, importedSpace, importsLeft, noteImports, resetFollow } from './followImport';

const ROOT = 'E:/p';
const INSP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const INSP_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const INSP_C = 'cccccccc-0000-4000-8000-000000000003';

const space = (id: string, name: string, inspectionId: string, pending = false) => ({
  id,
  name,
  crs: { local: 'flyability' },
  origin: [0, 0, 0],
  source: { kind: 'flyability', inspectionId, ...(pending ? { pending: true } : {}) },
});
const cloud = (id: string, spaceId: string) => ({
  kind: 'photos',
  id,
  name: id,
  items: [],
  space: spaceId,
});
const manifest = (spaces: unknown[], layers: unknown[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Tank survey',
    crs: { epsg: 32640 },
    origin: [10, 20, 30],
    captures: [],
    severityModels: [],
    classCatalogues: [],
    spaces,
    layers,
  });

const A = space('fly-aaaaaaaa', 'Space A', INSP_A);
const B = space('fly-bbbbbbbb', 'Space B', INSP_B);
const C = space('fly-cccccccc', 'Space C', INSP_C);
const onlyA = manifest([A], [cloud('a1', A.id)]);
const withB = manifest([A, B], [cloud('a1', A.id), cloud('b1', B.id), cloud('b2', B.id)]);

let seq = 0;
const job = (
  id: string,
  inspection: string,
  status: JobRecord['status'],
  project = ROOT,
): JobRecord =>
  ({
    id,
    pipeline: 'flyability.import',
    project,
    status,
    progress: status === 'done' ? 1 : 0,
    params: { src: 'D:/export', inspections: [{ id: inspection }] },
    updatedAt: `2026-11-19T10:00:${String(seq++).padStart(2, '0')}.000Z`,
  }) as unknown as JobRecord;

const open = (m: ProjectManifest) => {
  workspace.getState().openProject({ id: 'p1', root: ROOT, manifest: m });
};
/** The app's steps when the job list changes: note, read the manifest again when one finished, follow. */
const jobsChange = (prev: JobRecord[], next: JobRecord[], reloaded?: ProjectManifest) => {
  const stopped = noteImports(prev, next, ROOT);
  if (reloaded) workspace.getState().replaceManifest(reloaded);
  if (reloaded || stopped) followImport(next, stopped === 'cancelled');
};
const shown = () => {
  const m = workspace.getState().project?.manifest;
  if (!m) throw new Error('no project');
  const id = activeSpaceOf(m, activeSpace().getState().byProject.p1);
  return { id, layers: scopedManifest(m, id).layers.map((l) => l.id) };
};
const notices = () => toastQueue().map((x) => x.message);

beforeEach(() => {
  clearToasts();
  resetFollow();
  open(onlyA);
  setActiveSpace('p1', A.id);
});

describe('the space an import filled', () => {
  it('is the space of the first inspection of the job', () => {
    expect(importedSpace(withB, job('j', INSP_B, 'done'))?.id).toBe(B.id);
    expect(importedSpace(withB, job('j', INSP_C, 'done'))).toBeNull();
  });

  it('is the space the job was told to add the inspection to', () => {
    const j = { ...job('j', INSP_C, 'done') };
    j.params = { ...j.params, spaces: { [INSP_C]: A.id } };
    expect(importedSpace(withB, j)?.id).toBe(A.id);
  });
});

describe('after an Inspector import', () => {
  it('the space the import filled becomes the one on screen, and a notice names it', () => {
    jobsChange([job('j-b', INSP_B, 'running')], [job('j-b', INSP_B, 'done')], withB);
    expect(shown()).toEqual({ id: B.id, layers: ['b1', 'b2'] });
    expect(notices()).toEqual(['Imported: now showing Space B. Switch spaces in the title bar.']);
  });

  it('a failed or cancelled import changes nothing', () => {
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      jobsChange([job('j-b', INSP_B, 'running')], [job('j-b', INSP_B, status)]);
    }
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('an import of another project changes nothing', () => {
    jobsChange(
      [job('j-b', INSP_B, 'running', 'E:/other')],
      [job('j-b', INSP_B, 'done', 'E:/other')],
    );
    open(withB);
    followImport([job('j-b', INSP_B, 'done', 'E:/other')]);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('a job that was already done when the list loaded changes nothing', () => {
    open(withB);
    jobsChange([], [job('j-b', INSP_B, 'done')]);
    jobsChange([job('j-b', INSP_B, 'done')], [job('j-b', INSP_B, 'done')]);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('the same export imported again shows its space', () => {
    open(withB);
    setActiveSpace('p1', B.id);
    jobsChange([job('j-a', INSP_A, 'running')], [job('j-a', INSP_A, 'done')], withB);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual(['Imported: now showing Space A. Switch spaces in the title bar.']);
  });

  it('a job list change before the manifest is read again loses nothing', () => {
    const done = [job('j-b', INSP_B, 'done')];
    expect(noteImports([job('j-b', INSP_B, 'running')], done, ROOT)).toBeNull();
    // the space is not in the manifest yet
    followImport(done);
    expect(shown().id).toBe(A.id);
    workspace.getState().replaceManifest(withB);
    followImport(done);
    expect(shown().id).toBe(B.id);
  });

  it('a project with one space gets no notice: there is nothing to switch', () => {
    jobsChange([job('j-a', INSP_A, 'running')], [job('j-a', INSP_A, 'done')], onlyA);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });
});

describe('chambers queued one after the other', () => {
  // the mission import makes the chambers' spaces ahead, pending until a job fills them
  const pendB = space(B.id, 'Space B', INSP_B, true);
  const pendC = space(C.id, 'Space C', INSP_C, true);
  const first = manifest([A, pendB, pendC], [cloud('a1', A.id), cloud('b1', B.id)]);
  const both = manifest(
    [A, B, pendC],
    [cloud('a1', A.id), cloud('b1', B.id), cloud('c1', C.id), cloud('c2', C.id)],
  );

  it('imports are left while a job runs or a chamber made ahead still waits', () => {
    expect(importsLeft(first, [job('j-b', INSP_B, 'done')], ROOT)).toBe(true);
    expect(importsLeft(both, [job('j-c', INSP_C, 'running')], ROOT)).toBe(true);
    expect(importsLeft(both, [job('j-c', INSP_C, 'done')], ROOT)).toBe(false);
    // a chamber whose import failed keeps its empty space to be resumed: it waits no more
    expect(importsLeft(first, [job('j-c', INSP_C, 'failed')], ROOT)).toBe(false);
    expect(importsLeft(first, [job('j-c', INSP_C, 'running', 'E:/other')], ROOT)).toBe(true);
  });

  it('switch once, when the last one has finished, to the last one', () => {
    open(manifest([A, pendB, pendC], [cloud('a1', A.id)]));
    setActiveSpace('p1', A.id);
    const b0 = job('j-b', INSP_B, 'running');
    const b1 = job('j-b', INSP_B, 'done');
    jobsChange([b0], [b1], first);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
    // the next chamber starts, then finishes
    const c0 = job('j-c', INSP_C, 'running');
    jobsChange([b1], [c0, b1]);
    expect(shown().id).toBe(A.id);
    jobsChange([c0, b1], [job('j-c', INSP_C, 'done'), b1], both);
    expect(shown()).toEqual({ id: C.id, layers: ['c1', 'c2'] });
    expect(notices()).toEqual(['Imported: now showing Space C. Switch spaces in the title bar.']);
  });

  it('when the last chamber fails, the last one that was imported shows', () => {
    open(manifest([A, pendB, pendC], [cloud('a1', A.id)]));
    setActiveSpace('p1', A.id);
    const b1 = job('j-b', INSP_B, 'done');
    jobsChange([job('j-b', INSP_B, 'running')], [b1], first);
    const c0 = job('j-c', INSP_C, 'running');
    jobsChange([b1], [c0, b1]);
    jobsChange([c0, b1], [job('j-c', INSP_C, 'failed'), b1]);
    expect(shown().id).toBe(B.id);
    expect(notices()).toEqual(['Imported: now showing Space B. Switch spaces in the title bar.']);
    // nothing more to show after
    clearToasts();
    followImport([job('j-c', INSP_C, 'failed'), b1]);
    expect(notices()).toEqual([]);
  });

  it('a cancel drops the chambers that waited: the last one imported shows', () => {
    const pendD = space('fly-dddddddd', 'Space D', 'dddddddd-0000-4000-8000-000000000004', true);
    open(manifest([A, pendB, pendC, pendD], [cloud('a1', A.id)]));
    setActiveSpace('p1', A.id);
    const b1 = job('j-b', INSP_B, 'done');
    jobsChange(
      [job('j-b', INSP_B, 'running')],
      [b1],
      manifest([A, pendB, pendC, pendD], [cloud('a1', A.id), cloud('b1', B.id)]),
    );
    expect(shown().id).toBe(A.id);
    const c0 = job('j-c', INSP_C, 'running');
    jobsChange([b1], [c0, b1]);
    // the space of the chamber behind it is still in the manifest, but it will not run
    jobsChange([c0, b1], [job('j-c', INSP_C, 'cancelled'), b1]);
    expect(shown().id).toBe(B.id);
  });
});

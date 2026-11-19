import { ProjectManifest, type ImportItem, type JobRecord } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const h = vi.hoisted(() => ({
  state: { importResult: null as { items: ImportItem[]; error: string | null } | null },
}));
// the import card's rows: the builder's module graph is large, and only this field is read
vi.mock('../builder/state', () => ({
  builder: {
    getState: () => h.state,
    setState: (p: Partial<typeof h.state>) => Object.assign(h.state, p),
  },
}));

import { activeSpace, setActiveSpace } from '../spaces/activeSpace';
import { activeSpaceOf, scopedManifest } from '../spaces/spaceModel';
import {
  connectFollowImport,
  followImport,
  importFinished,
  importedSpace,
  importsLeft,
  resetFollow,
} from './followImport';
import { onLaneNotice, setSpacesReload } from './queueWatch';

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
const manifest = (spaces: unknown[], layers: unknown[], id = 'p1') =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id,
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
const pendB = space(B.id, 'Space B', INSP_B, true);
const pendC = space(C.id, 'Space C', INSP_C, true);
const onlyA = manifest([A], [cloud('a1', A.id)]);
const withB = manifest([A, B], [cloud('a1', A.id), cloud('b1', B.id), cloud('b2', B.id)]);
const NOTICE_B = 'Imported: now showing Space B. Switch spaces in the title bar.';

const job = (
  id: string,
  inspections: string | string[],
  status: JobRecord['status'],
  project = ROOT,
  pipeline = 'flyability.import',
): JobRecord =>
  ({
    id,
    pipeline,
    project,
    status,
    progress: status === 'done' ? 1 : 0,
    params: { src: 'D:/export', inspections: [inspections].flat().map((i) => ({ id: i })) },
  }) as unknown as JobRecord;
const waitingRow = (inspection: string, jobId?: string): ImportItem => ({
  file: 'Export',
  kind: 'flyability',
  status: 'queued',
  message: 'Waits for the chamber before it, then converts.',
  inspections: [inspection],
  ...(jobId !== undefined ? { jobId } : {}),
});

const jobs = createStore<{ jobs: JobRecord[] }>()(() => ({ jobs: [] }));
let stop: () => void = () => undefined;

const open = (m: ProjectManifest, root = ROOT) => {
  workspace.getState().openProject({ id: m.id, root, manifest: m });
};
/**
 * The job list changes as in the app: the watcher sees it, and the app's reload of a manifest
 * writer (`App.tsx`) reads the manifest again and follows only when an Inspector import finished.
 */
const jobsChange = (next: JobRecord[], reloaded?: ProjectManifest) => {
  const prev = jobs.getState().jobs;
  jobs.setState({ jobs: next });
  if (!reloaded) return;
  const imported = importFinished(prev, next, workspace.getState().project?.root ?? '');
  workspace.getState().replaceManifest(reloaded);
  if (imported) followImport();
};
const shown = () => {
  const p = workspace.getState().project;
  if (!p) throw new Error('no project');
  const id = activeSpaceOf(p.manifest, activeSpace().getState().byProject[p.id]);
  return { id, layers: scopedManifest(p.manifest, id).layers.map((l) => l.id) };
};
const notices = () => toastQueue().map((x) => x.message);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clearToasts();
  resetFollow();
  h.state.importResult = null;
  jobs.setState({ jobs: [] });
  open(onlyA);
  setActiveSpace('p1', A.id);
  stop = connectFollowImport(jobs);
});
afterEach(() => {
  stop();
  workspace.getState().closeProject();
});

describe('the space an import filled', () => {
  it('is the space of the inspection of the job', () => {
    expect(importedSpace(withB, job('j', INSP_B, 'done'))?.id).toBe(B.id);
    expect(importedSpace(withB, job('j', INSP_C, 'done'))).toBeNull();
  });

  it('is the space the job was told to add the inspection to', () => {
    const j = { ...job('j', INSP_C, 'done') };
    j.params = { ...j.params, spaces: { [INSP_C]: A.id } };
    expect(importedSpace(withB, j)?.id).toBe(A.id);
  });

  it('is the last one of a job of several inspections', () => {
    expect(importedSpace(withB, job('j', [INSP_A, INSP_B], 'done'))?.id).toBe(B.id);
    expect(importedSpace(withB, job('j', [INSP_B, INSP_A], 'done'))?.id).toBe(A.id);
  });
});

describe('after an Inspector import', () => {
  it('the space the import filled becomes the one on screen, and a notice names it', () => {
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')], withB);
    expect(shown()).toEqual({ id: B.id, layers: ['b1', 'b2'] });
    expect(notices()).toEqual([NOTICE_B]);
  });

  it('a job of several inspections shows the last one', () => {
    jobsChange([job('j', [INSP_B, INSP_A], 'running')]);
    open(withB);
    setActiveSpace('p1', B.id);
    jobsChange([job('j', [INSP_B, INSP_A], 'done')], withB);
    expect(shown().id).toBe(A.id);
  });

  it('a failed or cancelled import changes nothing', () => {
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      jobsChange([job('j-b', INSP_B, 'running')]);
      jobsChange([job('j-b', INSP_B, status)]);
    }
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('an import of another project changes nothing', () => {
    jobsChange([job('j-b', INSP_B, 'running', 'E:/other')]);
    jobsChange([job('j-b', INSP_B, 'done', 'E:/other')]);
    workspace.getState().replaceManifest(withB);
    followImport();
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('a job that was already done when the list loaded changes nothing', () => {
    workspace.getState().replaceManifest(withB);
    jobsChange([job('j-b', INSP_B, 'done')], withB);
    followImport();
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('the same export imported again shows its space', () => {
    workspace.getState().replaceManifest(withB);
    setActiveSpace('p1', B.id);
    jobsChange([job('j-a', INSP_A, 'running')]);
    jobsChange([job('j-a', INSP_A, 'done')], withB);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual(['Imported: now showing Space A. Switch spaces in the title bar.']);
  });

  it('a job list change before the manifest is read again loses nothing', () => {
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')]);
    // the space is not in the manifest yet
    followImport();
    expect(shown().id).toBe(A.id);
    workspace.getState().replaceManifest(withB);
    followImport();
    expect(shown().id).toBe(B.id);
  });

  it('a project with one space gets no notice: there is nothing to switch', () => {
    jobsChange([job('j-a', INSP_A, 'running')]);
    jobsChange([job('j-a', INSP_A, 'done')], onlyA);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });
});

describe('chambers queued one after the other', () => {
  // the mission import makes the chambers' spaces ahead, pending until a job fills them
  const start = manifest([A, pendB, pendC], [cloud('a1', A.id)]);
  const first = manifest([A, pendB, pendC], [cloud('a1', A.id), cloud('b1', B.id)]);
  const both = manifest(
    [A, B, pendC],
    [cloud('a1', A.id), cloud('b1', B.id), cloud('c1', C.id), cloud('c2', C.id)],
  );
  /** B has imported; C still waits behind it. */
  const afterB = () => {
    workspace.getState().replaceManifest(start);
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')], first);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  };

  it('imports are left while a job runs or a chamber made ahead still waits', () => {
    expect(importsLeft(first, [job('j-b', INSP_B, 'done')], ROOT)).toBe(true);
    expect(importsLeft(both, [job('j-c', INSP_C, 'running')], ROOT)).toBe(true);
    expect(importsLeft(both, [job('j-c', INSP_C, 'done')], ROOT)).toBe(false);
    // a chamber whose import failed keeps its empty space to be resumed: it waits no more
    expect(importsLeft(first, [job('j-c', INSP_C, 'failed')], ROOT)).toBe(false);
    expect(importsLeft(first, [job('j-c', INSP_C, 'running', 'E:/other')], ROOT)).toBe(true);
  });

  it('imports are left while a row of the import card waits, with no space made ahead', () => {
    // a mission imported again goes into its chambers' spaces: nothing is pending
    const done = [job('j-b', INSP_B, 'done')];
    expect(importsLeft(withB, done, ROOT, [waitingRow(INSP_A)])).toBe(true);
    expect(importsLeft(withB, done, ROOT, [waitingRow(INSP_B, 'j-b')])).toBe(false);
    expect(importsLeft(withB, done, ROOT, [{ ...waitingRow(INSP_A), status: 'error' }])).toBe(
      false,
    );
    expect(importsLeft(withB, done, ROOT, [{ ...waitingRow(INSP_A), kind: 'photo' }])).toBe(false);
  });

  it('switch once, when the last one has finished, to the last one', () => {
    afterB();
    // the next chamber starts, then finishes
    jobsChange([job('j-c', INSP_C, 'running'), job('j-b', INSP_B, 'done')]);
    expect(shown().id).toBe(A.id);
    jobsChange([job('j-c', INSP_C, 'done'), job('j-b', INSP_B, 'done')], both);
    expect(shown()).toEqual({ id: C.id, layers: ['c1', 'c2'] });
    expect(notices()).toEqual(['Imported: now showing Space C. Switch spaces in the title bar.']);
  });

  it('a mission imported again switches once: the card rows say what still waits', () => {
    workspace.getState().replaceManifest(withB);
    setActiveSpace('p1', B.id);
    h.state.importResult = {
      items: [waitingRow(INSP_B, 'j-b'), waitingRow(INSP_A)],
      error: null,
    };
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')], withB);
    expect(notices()).toEqual([]);
    onLaneNotice({
      project: ROOT,
      src: 'D:/m/a',
      inspections: [INSP_A],
      state: 'started',
      jobId: 'j-a',
    });
    expect(notices()).toEqual([]);
    jobsChange([job('j-a', INSP_A, 'running'), job('j-b', INSP_B, 'done')]);
    jobsChange([job('j-a', INSP_A, 'done'), job('j-b', INSP_B, 'done')], withB);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual(['Imported: now showing Space A. Switch spaces in the title bar.']);
  });

  it('when the last chamber fails, the last one that was imported shows', () => {
    afterB();
    jobsChange([job('j-c', INSP_C, 'running'), job('j-b', INSP_B, 'done')]);
    jobsChange([job('j-c', INSP_C, 'failed'), job('j-b', INSP_B, 'done')]);
    expect(shown().id).toBe(B.id);
    expect(notices()).toEqual([NOTICE_B]);
    // nothing more to show after
    clearToasts();
    followImport();
    expect(notices()).toEqual([]);
  });

  it('a cancel drops the chambers that waited: the last one imported shows', () => {
    const pendD = space('fly-dddddddd', 'Space D', 'dddddddd-0000-4000-8000-000000000004', true);
    workspace.getState().replaceManifest(manifest([A, pendB, pendC, pendD], [cloud('a1', A.id)]));
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange(
      [job('j-b', INSP_B, 'done')],
      manifest([A, pendB, pendC, pendD], [cloud('a1', A.id), cloud('b1', B.id)]),
    );
    expect(shown().id).toBe(A.id);
    jobsChange([job('j-c', INSP_C, 'running'), job('j-b', INSP_B, 'done')]);
    // the space of the chamber behind it is still in the manifest, but it will not run
    jobsChange([job('j-c', INSP_C, 'cancelled'), job('j-b', INSP_B, 'done')]);
    expect(shown().id).toBe(B.id);
  });

  it('a waiting chamber that cannot start has no job: the tidy of its space ends the line', async () => {
    afterB();
    // main: the chamber did not start, its empty space is removed, the window reads the spaces
    const tidied = manifest([A, B], [cloud('a1', A.id), cloud('b1', B.id)]);
    setSpacesReload(() => {
      workspace.getState().replaceManifest(tidied);
      return Promise.resolve();
    });
    onLaneNotice({
      project: ROOT,
      src: 'D:/m/c',
      inspections: [INSP_C],
      state: 'failed',
      error: 'The processing tools are gone.',
    });
    // its space is in the manifest until the tidy
    expect(shown().id).toBe(A.id);
    onLaneNotice({ project: ROOT, state: 'tidied', removed: [C.id] });
    await flush();
    expect(shown().id).toBe(B.id);
    expect(notices()).toContain(NOTICE_B);
  });

  it('a waiting chamber with no space made ahead that cannot start ends the line at once', () => {
    workspace.getState().replaceManifest(withB);
    h.state.importResult = {
      items: [waitingRow(INSP_B, 'j-b'), waitingRow(INSP_A)],
      error: null,
    };
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')], withB);
    expect(shown().id).toBe(A.id);
    onLaneNotice({
      project: ROOT,
      src: 'D:/m/a',
      inspections: [INSP_A],
      state: 'failed',
      error: 'The processing tools are gone.',
    });
    expect(shown().id).toBe(B.id);
    expect(notices()).toContain(NOTICE_B);
  });

  it('a notice of another project follows nothing', () => {
    afterB();
    onLaneNotice({
      project: 'E:/other',
      src: 'D:/m/c',
      inspections: [INSP_C],
      state: 'dropped',
      reason: 'cancelled',
    });
    expect(shown().id).toBe(A.id);
  });
});

describe('nothing fires late', () => {
  const first = manifest([A, pendB, pendC], [cloud('a1', A.id), cloud('b1', B.id)]);
  const tidied = manifest([A, B], [cloud('a1', A.id), cloud('b1', B.id)]);
  /** B has imported and C still waits: a switch to B is armed. */
  const armed = () => {
    workspace.getState().replaceManifest(manifest([A, pendB, pendC], [cloud('a1', A.id)]));
    jobsChange([job('j-b', INSP_B, 'running')]);
    jobsChange([job('j-b', INSP_B, 'done')], first);
  };

  it("another pipeline's job that reloads the manifest switches nothing", () => {
    armed();
    const b = job('j-b', INSP_B, 'done');
    jobsChange([job('j-x', INSP_C, 'running', ROOT, 'pointcloud.to_copc'), b]);
    // the line is over by now (its last space was tidied), but no import ended here
    jobsChange([job('j-x', INSP_C, 'done', ROOT, 'pointcloud.to_copc'), b], tidied);
    expect(
      importFinished([job('j-x', INSP_C, 'running', ROOT, 'pointcloud.to_copc')], [b], ROOT),
    ).toBe(false);
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('closing the project forgets the import to show', () => {
    armed();
    workspace.getState().closeProject();
    open(tidied);
    setActiveSpace('p1', A.id);
    followImport();
    onLaneNotice({ project: ROOT, state: 'tidied', removed: [C.id] });
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('opening another project forgets it too', () => {
    armed();
    open(manifest([A, B], [cloud('a1', A.id), cloud('b1', B.id)], 'p2'), 'E:/q');
    open(tidied);
    setActiveSpace('p1', A.id);
    followImport();
    expect(shown().id).toBe(A.id);
    expect(notices()).toEqual([]);
  });

  it('after the watcher stops, a job that ends follows nothing', () => {
    stop();
    jobs.setState({ jobs: [job('j-b', INSP_B, 'running')] });
    jobs.setState({ jobs: [job('j-b', INSP_B, 'done')] });
    workspace.getState().replaceManifest(withB);
    followImport();
    expect(shown().id).toBe(A.id);
  });
});

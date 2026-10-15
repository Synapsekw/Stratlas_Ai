// @vitest-environment jsdom
import { issueEditor, issueSaver } from '@aio/annotate';
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; req: unknown }[],
  order: [] as string[],
  answer: null as null | { ok: false; error: string },
  actions: [] as { type: string; model?: unknown }[],
  /** While set, builder:updateClasses answers only after it resolves. */
  hold: null as null | Promise<void>,
}));

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: {
    call: (channel: string, req: { catalogues?: unknown }) => {
      h.calls.push({ channel, req });
      h.order.push(channel);
      if (channel === 'builder:updateClasses') {
        const answer = h.answer;
        const m = workspace.getState().project?.manifest;
        const reply = answer
          ? { ok: true, value: answer }
          : {
              ok: true,
              value: { ok: true, backup: 'b', manifest: { ...m, classCatalogues: req.catalogues } },
            };
        return (h.hold ?? Promise.resolve()).then(() => reply);
      }
      return Promise.resolve({ ok: true, value: [] });
    },
  },
}));
vi.mock('../detections/store', () => ({
  loadDetections: () => Promise.resolve(),
  dispatch: (a: { type: string }) => {
    h.actions.push(a);
    h.order.push(`dispatch:${a.type}`);
  },
}));

const { classes, createClass, deleteClass, editClass, undoClassEdit, redoClassEdit } =
  await import('./store');

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [
        { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' },
        { value: 3, label: 'Severe', color: '#f05653', criteria: 'S' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
};

const issue = (id: string, code: string, classId: string): Issue => ({
  id,
  code,
  classId,
  severityModelId: 'sev',
  severity: 3,
  status: 'draft',
  title: code,
  note: '',
  author: 'DR',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 1, y: 1, w: 2, h: 2 } },
  ],
  source: 'human',
});

const labels = () =>
  (workspace.getState().project?.manifest.classCatalogues ?? []).flatMap((c) =>
    c.classes.map((k) => k.label),
  );

beforeEach(() => {
  h.calls = [];
  h.order = [];
  h.answer = null;
  h.actions = [];
  h.hold = null;
  workspace.setState({ project: null, issues: [] });
  workspace.setState({
    project: { id: 'p', root: '/p', manifest },
    issues: [issue('i1', 'F01', 'rust'), issue('i2', 'F02', 'rust')],
  });
  vi.spyOn(issueSaver, 'flush').mockImplementation(() => {
    h.order.push('flush');
    return Promise.resolve();
  });
  // no real issue writes from the shared saver in a unit test
  vi.spyOn(issueSaver, 'schedule').mockImplementation(() => undefined);
  // the issue editor flushes on the project switch above; count only the store's own calls
  h.order = [];
});

describe('class store', () => {
  it('creates a class with just a name, writes once, and undo removes it', async () => {
    const cls = await createClass('Spalling');
    expect(cls).toMatchObject({ id: 'spalling', label: 'Spalling', severityModel: 'sev' });
    expect(h.calls.filter((c) => c.channel === 'builder:updateClasses')).toHaveLength(1);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling']);
    expect(classes.getState().notice).toMatchObject({
      text: 'Class Spalling created.',
      undo: true,
    });
    expect(await undoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(await redoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling']);
  });

  it('returns the existing class for a known label without writing', async () => {
    const cls = await createClass('crack');
    expect(cls.id).toBe('crack');
    expect(h.calls).toHaveLength(0);
  });

  it('keeps the manifest and reports when the write is refused', async () => {
    h.answer = { ok: false, error: 'disk full' };
    await expect(createClass('Spalling')).rejects.toThrow('disk full');
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(classes.getState().notice).toMatchObject({
      text: 'Classes not saved: disk full',
      error: true,
    });
  });

  it('edits a class and refuses a reserved hotkey inline', async () => {
    expect(await editClass('crack', { label: 'Wide crack' })).toBeNull();
    expect(labels()).toEqual(['Wide crack', 'Rust']);
    expect(await editClass('crack', { hotkey: 'a' })).toMatch(/reserved/);
  });

  it('deletes a used class: moves issues and detections, flushes the issue saver before writing', async () => {
    expect(await deleteClass('rust', null)).toBe(
      'Pick the class that takes over its issues and detections.',
    );
    expect(await deleteClass('rust', 'crack')).toBeNull();
    expect(workspace.getState().issues.map((i) => i.classId)).toEqual(['crack', 'crack']);
    expect(labels()).toEqual(['Crack']);
    expect(h.order).toEqual(['flush', 'builder:updateClasses', 'dispatch:reclass']);
    // detections move with the severity model of the class they go to
    expect(h.actions[0]).toMatchObject({ type: 'reclass', from: 'rust', to: 'crack' });
    expect(h.actions[0]?.model).toMatchObject({ id: 'sev' });
    expect(issueEditor.state.undoLabel).toBe('Move 2 issues from Rust to Crack');
    expect(await undoClassEdit()).toBe(true);
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(workspace.getState().issues.map((i) => i.classId)).toEqual(['rust', 'rust']);
  });

  it('deletes an unused class directly', async () => {
    workspace.setState({ issues: [] });
    expect(await deleteClass('rust', null)).toBeNull();
    expect(labels()).toEqual(['Crack']);
  });

  it('a refused delete changes nothing: issues roll back, detections stay', async () => {
    h.answer = { ok: false, error: 'disk full' };
    expect(await deleteClass('rust', 'crack')).toBe('disk full');
    expect(labels()).toEqual(['Crack', 'Rust']);
    expect(workspace.getState().issues.map((i) => i.classId)).toEqual(['rust', 'rust']);
    expect(h.actions).toEqual([]);
    expect(classes.getState().past).toEqual([]);
  });

  it('two creates at once both land, one after the other', async () => {
    const [a, b] = await Promise.all([createClass('Spalling'), createClass('Leak')]);
    expect([a.id, b.id]).toEqual(['spalling', 'leak']);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling', 'Leak']);
    const writes = h.calls.filter((c) => c.channel === 'builder:updateClasses');
    expect(writes).toHaveLength(2);
    const past = classes.getState().past;
    expect(past).toHaveLength(2);
    expect(past[0]?.before).not.toEqual(past[1]?.before);
    expect(past[1]?.before).toEqual(past[0]?.after);
  });

  it('a project switch during the write leaves no undo entry and no notice', async () => {
    let release: () => void = () => undefined;
    h.hold = new Promise<void>((r) => {
      release = r;
    });
    const pending = createClass('Spalling');
    await vi.waitFor(() => {
      expect(h.calls).toHaveLength(1);
    });
    workspace.setState({ project: { id: 'q', root: '/q', manifest: { ...manifest, id: 'q' } } });
    release();
    await expect(pending).rejects.toThrow(/project changed/);
    expect(classes.getState().past).toEqual([]);
    expect(classes.getState().notice).toBeNull();
    expect(labels()).toEqual(['Crack', 'Rust']);
  });

  it('undo refuses an edit made in another project', async () => {
    await createClass('Spalling');
    const edit = classes.getState().past.at(-1);
    workspace.setState({ project: { id: 'q', root: '/q', manifest: { ...manifest, id: 'q' } } });
    if (edit) classes.setState({ past: [edit] });
    h.calls = [];
    expect(await undoClassEdit()).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(labels()).toEqual(['Crack', 'Rust']);
  });

  it('undo of a create is refused while an unsaved issue uses the class', async () => {
    await createClass('Spalling');
    // the picker assigns the new class; the saver has not written issues.json yet
    workspace.setState({ issues: [issue('i1', 'F01', 'spalling'), issue('i2', 'F02', 'rust')] });
    h.calls = [];
    h.order = [];
    expect(await undoClassEdit()).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.order).toEqual([]);
    expect(labels()).toEqual(['Crack', 'Rust', 'Spalling']);
    expect(classes.getState().past).toHaveLength(1);
    expect(classes.getState().notice).toMatchObject({
      text: 'Classes not saved: Class "spalling" still has issues. Move them to another class first.',
      error: true,
    });
  });

  it('undo of a create flushes the issue saver before writing', async () => {
    await createClass('Spalling');
    h.order = [];
    expect(await undoClassEdit()).toBe(true);
    expect(h.order).toEqual(['flush', 'builder:updateClasses']);
  });

  it("a later edit clears the notice, so the notice's Undo cannot undo it", async () => {
    await createClass('Spalling');
    expect(classes.getState().notice?.undo).toBe(true);
    expect(await editClass('crack', { label: 'Wide crack' })).toBeNull();
    expect(classes.getState().notice).toBeNull();
  });
});

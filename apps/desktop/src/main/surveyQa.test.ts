import type { DraftOp } from '@aio/journal';
import type { JobRecord, SurveyQa, TerrainEditsFile } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { qaJobEvents, registerSurveyQaIpc } from './surveyQa';

const NOW = new Date('2026-10-09T08:00:00.000Z');

const held = (capture: string): SurveyQa => ({
  schema: 'aio.survey-qa/1',
  capture,
  level: 'strict',
  status: 'hold',
  checkpoints: {
    count: 2,
    rmseM: 0.08,
    meanM: -0.07,
    maxAbsM: 0.15,
    points: [
      { name: 'CHK1', dz: 0.01 },
      { name: 'CHK6', dz: -0.15 },
    ],
  },
  hold: { at: NOW.toISOString(), reason: 'Checkpoint RMSE 8.0 cm is above the Strict limit.' },
  checkedAt: NOW.toISOString(),
});

const edits: TerrainEditsFile = {
  schema: 'aio.terrain-edits/1',
  edits: [
    {
      id: 'exc',
      kind: 'cleanup',
      surface: 's-d2',
      ring: [
        [0, 0],
        [8, 0],
        [8, 5],
      ],
      method: 'thin-plate',
      enabled: true,
      createdAt: NOW.toISOString(),
    },
  ],
};

describe('survey QA IPC', () => {
  let root = '';
  let ops: DraftOp[] = [];
  const archive = new Map<string, Buffer>();
  let ipc: ReturnType<typeof collectHandlers>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'survey-qa-'));
    ops = [];
    const journal = (_r: string, drafts: readonly DraftOp[]) => {
      ops.push(...drafts);
      return Promise.resolve();
    };
    ipc = collectHandlers((handle) => {
      registerSurveyQaIpc({
        handle,
        projects: {
          root: (id) => (id === 'p' ? root : undefined),
          package: (id) => (id === 'pkg' ? {} : undefined),
        },
        projectPackage: () => ({
          entries: archive,
          read: (n) => Promise.resolve(archive.get(n) ?? Buffer.alloc(0)),
        }),
        journal,
        user: () => 'Surveyor',
        now: () => NOW,
      });
    });
  });

  afterEach(async () => {
    archive.clear();
    await rm(root, { recursive: true, force: true });
  });

  async function putQa(qa: SurveyQa) {
    await mkdir(join(root, 'survey', 'qa'), { recursive: true });
    await writeFile(join(root, 'survey', 'qa', `${qa.capture}.json`), JSON.stringify(qa));
  }

  it('registers the four channels', () => {
    expect(ipc.channels()).toEqual([
      'survey:readQa',
      'survey:readTerrainEdits',
      'survey:releaseHold',
      'survey:writeTerrainEdits',
    ]);
  });

  it('reads no QA results, then every one or one capture', async () => {
    expect(await ipc.call('survey:readQa', { projectId: 'p' })).toEqual({
      ok: true,
      files: [],
      readOnly: false,
    });
    await putQa(held('d3'));
    await putQa({ ...held('d1'), status: 'pass' });
    const all = await ipc.call('survey:readQa', { projectId: 'p' });
    expect(all.ok && all.files.map((f) => f.capture)).toEqual(['d1', 'd3']);
    const one = await ipc.call('survey:readQa', { projectId: 'p', capture: 'd3' });
    expect(one.ok && one.files.map((f) => f.status)).toEqual(['hold']);
    const none = await ipc.call('survey:readQa', { projectId: 'p', capture: 'd9' });
    expect(none.ok && none.files).toEqual([]);
    const bad = await ipc.call('survey:readQa', { projectId: 'p', capture: '../manifest' });
    expect(bad.ok).toBe(false);
  });

  it('releases a hold with a note: journaled first, then written with a .bak', async () => {
    await putQa(held('d3'));
    const r = await ipc.call('survey:releaseHold', {
      projectId: 'p',
      capture: 'd3',
      note: ' Checked against the GNSS log. ',
    });
    expect(r.ok).toBe(true);
    expect(ops).toEqual([
      {
        kind: 'survey.hold',
        target: { rec: 'survey', id: 'qa/d3' },
        payload: { capture: 'd3', action: 'release', note: 'Checked against the GNSS log.' },
      },
    ]);
    const disk = JSON.parse(
      await readFile(join(root, 'survey', 'qa', 'd3.json'), 'utf8'),
    ) as SurveyQa;
    expect(disk.status).toBe('released');
    expect(disk.release).toEqual({
      at: NOW.toISOString(),
      by: 'Surveyor',
      note: 'Checked against the GNSS log.',
    });
    // the hold and the checks stay
    expect(disk.hold).toEqual(held('d3').hold);
    expect(disk.checkpoints?.rmseM).toBe(0.08);
    expect(existsSync(join(root, 'survey', 'qa', 'd3.json.bak'))).toBe(true);
    // a released survey is not released again
    const again = await ipc.call('survey:releaseHold', {
      projectId: 'p',
      capture: 'd3',
      note: 'x',
    });
    expect(again).toMatchObject({
      ok: false,
      error: expect.stringContaining('not on hold') as unknown,
    });
  });

  it('releases once, and refuses a survey without a result or in a package', async () => {
    await putQa(held('d3'));
    const empty = await ipc.call('survey:releaseHold', {
      projectId: 'p',
      capture: 'd3',
      note: 'ok',
    });
    expect(empty.ok).toBe(true);
    expect(
      (await ipc.call('survey:releaseHold', { projectId: 'p', capture: 'd2', note: 'ok' })).ok,
    ).toBe(false);
    const pkg = await ipc.call('survey:releaseHold', {
      projectId: 'pkg',
      capture: 'd3',
      note: 'ok',
    });
    expect(pkg).toMatchObject({ ok: false, code: 'read-only' });
    expect(ops).toHaveLength(1);
  });

  it('reads a package in place, read only', async () => {
    archive.set('survey/qa/d3.json', Buffer.from(JSON.stringify(held('d3'))));
    archive.set('survey/cleanups.json', Buffer.from(JSON.stringify(edits)));
    const qa = await ipc.call('survey:readQa', { projectId: 'pkg' });
    expect(qa).toMatchObject({ ok: true, readOnly: true });
    expect(qa.ok && qa.files[0]?.capture).toBe('d3');
    const ed = await ipc.call('survey:readTerrainEdits', { projectId: 'pkg' });
    expect(ed).toEqual({ ok: true, file: edits, readOnly: true });
    const w = await ipc.call('survey:writeTerrainEdits', { projectId: 'pkg', file: edits });
    expect(w).toMatchObject({ ok: false, code: 'read-only' });
  });

  it('writes and reads back the terrain edits with a .bak; duplicate ids are refused', async () => {
    expect(await ipc.call('survey:readTerrainEdits', { projectId: 'p' })).toEqual({
      ok: true,
      file: { schema: 'aio.terrain-edits/1', edits: [] },
      readOnly: false,
    });
    expect(await ipc.call('survey:writeTerrainEdits', { projectId: 'p', file: edits })).toEqual({
      ok: true,
    });
    const off = { ...edits, edits: edits.edits.map((e) => ({ ...e, enabled: false })) };
    expect((await ipc.call('survey:writeTerrainEdits', { projectId: 'p', file: off })).ok).toBe(
      true,
    );
    expect(await ipc.call('survey:readTerrainEdits', { projectId: 'p' })).toEqual({
      ok: true,
      file: off,
      readOnly: false,
    });
    expect(existsSync(join(root, 'survey', 'cleanups.json.bak'))).toBe(true);
    const twice = { ...edits, edits: [...edits.edits, ...edits.edits] };
    const r = await ipc.call('survey:writeTerrainEdits', { projectId: 'p', file: twice });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('listed twice') as unknown,
    });
  });

  it('journals the hold of a finished survey.qa job, once, and nothing for a pass', async () => {
    await putQa(held('d3'));
    await putQa({ ...held('d2'), status: 'pass' });
    const seen: DraftOp[] = [];
    const listen = qaJobEvents({
      journal: (_r, drafts) => {
        seen.push(...drafts);
        return Promise.resolve();
      },
    });
    const job = (capture: string, status: JobRecord['status']): JobRecord => ({
      id: `j-${capture}`,
      pipeline: 'survey.qa',
      project: root,
      params: { capture, surface: `s-${capture}`, level: 'strict' },
      status,
      progress: 1,
      steps: [],
      artifacts: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    await listen({ type: 'update', job: job('d3', 'running') });
    await listen({ type: 'update', job: job('d3', 'done') });
    await listen({ type: 'update', job: job('d2', 'done') });
    await listen({ type: 'update', job: { ...job('d3', 'done'), pipeline: 'survey.compare' } });
    expect(seen).toEqual([
      {
        kind: 'survey.hold',
        target: { rec: 'survey', id: 'qa/d3' },
        payload: { capture: 'd3', action: 'hold', note: held('d3').hold?.reason },
      },
    ]);
  });
});

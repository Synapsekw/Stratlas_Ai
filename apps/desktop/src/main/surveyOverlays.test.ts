import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SurveyOverlay, SurveyOverlaysFile } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerSurveyOverlaysIpc } from './surveyOverlays';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const overlay = (id: string, kind: SurveyOverlay['kind'] = 'contours'): SurveyOverlay => ({
  id,
  name: `Overlay ${id}`,
  kind,
  source: { surface: 'dsm-c1' },
  options: { minorM: 0.5, majorM: 2.5 },
  dir: `survey/overlays/${id}`,
  visible: true,
  fingerprint: `sha256:${id}`,
  createdAt: '2026-10-09T06:00:00Z',
});
const file = (...o: SurveyOverlay[]): SurveyOverlaysFile => ({
  schema: 'aio.survey-overlays/1',
  overlays: o,
});

function setup(pkg?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'aio-overlays-'));
  dirs.push(root);
  const members = new Map(Object.entries(pkg ?? {}));
  const archive = {
    entries: members,
    read: (name: string) => Promise.resolve(Buffer.from(JSON.stringify(members.get(name)), 'utf8')),
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyOverlaysIpc({
      handle,
      projects: {
        root: (id) => (id === 'p' ? root : undefined),
        package: (id) => (id === 'pkg' ? {} : undefined),
      },
      projectPackage: (id) => (id === 'pkg' ? archive : undefined),
    });
  });
  /** What survey.overlay writes: the folder and the list. */
  const made = (f: SurveyOverlaysFile) => {
    for (const o of f.overlays) {
      mkdirSync(join(root, ...o.dir.split('/')), { recursive: true });
      writeFileSync(join(root, ...o.dir.split('/'), 'contours.geojson'), '{}');
    }
    mkdirSync(join(root, 'survey'), { recursive: true });
    writeFileSync(join(root, 'survey', 'overlays.json'), JSON.stringify(f));
  };
  return { root, ipc, made };
}

describe('survey overlays (G5)', () => {
  it('reads an empty list without a file, then what the pipeline wrote', async () => {
    const { ipc, made } = setup();
    expect(await ipc.call('survey:readOverlays', { projectId: 'p' })).toEqual({
      ok: true,
      file: file(),
      readOnly: false,
    });
    made(file(overlay('a')));
    const r = await ipc.call('survey:readOverlays', { projectId: 'p' });
    expect(r.ok && r.file.overlays.map((o) => o.id)).toEqual(['a']);
    expect(await ipc.call('survey:readOverlays', { projectId: 'nope' })).toMatchObject({
      ok: false,
    });
  });

  it('saves visibility and names with a .bak, and deletes a removed overlay folder', async () => {
    const { root, ipc, made } = setup();
    made(file(overlay('a'), overlay('b', 'slope')));
    await ipc.call('survey:readOverlays', { projectId: 'p' });
    const hidden = file(
      { ...overlay('a'), visible: false, name: 'Pad contours' },
      overlay('b', 'slope'),
    );
    expect(await ipc.call('survey:writeOverlays', { projectId: 'p', file: hidden })).toEqual({
      ok: true,
    });
    const disk = JSON.parse(
      readFileSync(join(root, 'survey', 'overlays.json'), 'utf8'),
    ) as SurveyOverlaysFile;
    expect(disk.overlays[0]).toMatchObject({ visible: false, name: 'Pad contours' });
    expect(existsSync(join(root, 'survey', 'overlays.json.bak'))).toBe(true);
    const without = file({ ...overlay('a'), visible: false, name: 'Pad contours' });
    expect(await ipc.call('survey:writeOverlays', { projectId: 'p', file: without })).toEqual({
      ok: true,
    });
    expect(existsSync(join(root, 'survey', 'overlays', 'b'))).toBe(false);
    expect(existsSync(join(root, 'survey', 'overlays', 'a', 'contours.geojson'))).toBe(true);
  });

  it('refuses changing what the pipeline wrote, adding overlays and duplicate ids', async () => {
    const { ipc, made } = setup();
    made(file(overlay('a')));
    await ipc.call('survey:readOverlays', { projectId: 'p' });
    const write = (f: SurveyOverlaysFile) =>
      ipc.call('survey:writeOverlays', { projectId: 'p', file: f });
    expect(await write(file({ ...overlay('a'), options: { minorM: 1, majorM: 5 } }))).toMatchObject(
      {
        ok: false,
        error: expect.stringContaining('keeps the options') as unknown,
      },
    );
    expect(await write(file({ ...overlay('a'), dir: 'rasters' }))).toMatchObject({ ok: false });
    expect(await write(file(overlay('a'), overlay('z')))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not an overlay of this site') as unknown,
    });
    expect(await write(file(overlay('a'), overlay('a')))).toMatchObject({ ok: false });
  });

  it('refuses a save after the pipeline changed the file since it was read', async () => {
    const { ipc, made } = setup();
    made(file(overlay('a')));
    await ipc.call('survey:readOverlays', { projectId: 'p' });
    made(file(overlay('a'), overlay('b')));
    const r = await ipc.call('survey:writeOverlays', {
      projectId: 'p',
      file: file({ ...overlay('a'), visible: false }),
    });
    expect(r.ok).toBe(false);
  });

  it('reads a package in place and never writes it', async () => {
    const { ipc } = setup({ 'survey/overlays.json': file(overlay('a')) });
    const r = await ipc.call('survey:readOverlays', { projectId: 'pkg' });
    expect(r).toMatchObject({ ok: true, readOnly: true });
    expect(r.ok && r.file.overlays).toHaveLength(1);
    expect(
      await ipc.call('survey:writeOverlays', { projectId: 'pkg', file: file() }),
    ).toMatchObject({
      ok: false,
      code: 'read-only',
    });
  });
});

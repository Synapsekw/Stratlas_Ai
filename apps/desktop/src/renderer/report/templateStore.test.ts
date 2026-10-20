// @vitest-environment jsdom
import {
  emptyMeasurements,
  emptyReportTemplate,
  type ProjectManifest,
  type ReportTemplateFile,
  type SitePoint,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The template on "disk", as main reads and writes it. */
const disk = vi.hoisted(() => ({
  file: null as ReportTemplateFile | null,
  readError: null as string | null,
  writes: 0,
}));
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, req: { file?: ReportTemplateFile }) => {
      if (channel === 'report:readTemplate')
        return Promise.resolve({
          ok: true,
          value: disk.readError
            ? { ok: false, error: disk.readError }
            : { ok: true, file: disk.file && structuredClone(disk.file) },
        });
      if (channel === 'report:writeTemplate') {
        disk.writes++;
        disk.file = structuredClone(req.file ?? null);
        return Promise.resolve({ ok: true, value: { ok: true } });
      }
      return Promise.resolve({ ok: false, error: 'Not configured' });
    },
  },
}));

const { addToReport, addManyToReport, templateStore, loadTemplate } =
  await import('./templateStore');
const { measureStore } = await import('../survey/measureStore');

const manifest = { captures: [], layers: [] } as unknown as ProjectManifest;
const m = (id: string, tool: 'distance' | 'area') => ({
  id,
  family: tool === 'area' ? ('polygon' as const) : ('line' as const),
  tool,
  label: id,
  scope: { kind: 'site' as const },
  items: [],
  results: [],
  points: [
    [0, 0, 0],
    [3, 4, 0],
    [3, 0, 0],
  ] as SitePoint[],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const ids = () =>
  (disk.file?.entries ?? []).map((e) =>
    e.kind === 'measurement' ? `${e.id}:${e.parts.join('+')}` : '',
  );

beforeEach(() => {
  disk.file = null;
  disk.readError = null;
  disk.writes = 0;
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [m('line', 'distance'), m('pad', 'area')] },
  });
});
afterEach(() => {
  workspace.getState().closeProject();
});

describe('report template store', () => {
  it('add to report appends once', async () => {
    expect(await addToReport('line')).toBe('added');
    expect(await addToReport('pad')).toBe('added');
    // a tool with a chart takes value and chart, one without the value alone
    expect(ids()).toEqual(['line:value+chart', 'pad:value']);
    expect(templateStore.getState().file).toEqual(disk.file);
  });

  it('already in the report on the second add', async () => {
    await addToReport('line');
    expect(await addToReport('line')).toBe('already');
    expect(ids()).toEqual(['line:value+chart']);
    // nothing new: nothing written
    expect(disk.writes).toBe(1);
  });

  it('adds several in the order given, the ones there already once', async () => {
    await addToReport('pad');
    expect(await addManyToReport(['line', 'pad'])).toEqual({ added: ['line'], already: ['pad'] });
    expect(ids()).toEqual(['pad:value', 'line:value+chart']);
  });

  it('keeps the entries already in the template, and takes the parts asked for', async () => {
    disk.file = {
      ...emptyReportTemplate(),
      entries: [{ kind: 'section', section: 'summary' }],
    };
    expect(await addToReport('pad', ['value', 'table'])).toBe('added');
    expect(disk.file.entries).toHaveLength(2);
    expect(ids()[1]).toBe('pad:value+table');
  });

  it('never writes over a template main could not read', async () => {
    disk.readError = 'report/template.json was saved by a newer version.';
    await expect(addToReport('line')).rejects.toThrow(/newer version/);
    expect(disk.writes).toBe(0);
  });

  it('loads the open project template', async () => {
    disk.file = { ...emptyReportTemplate() };
    await loadTemplate();
    expect(templateStore.getState()).toMatchObject({ projectId: 'p1', file: disk.file });
  });
});

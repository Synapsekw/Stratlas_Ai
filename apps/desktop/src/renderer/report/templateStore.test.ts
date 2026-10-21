// @vitest-environment jsdom
import {
  emptyMeasurements,
  emptyReportTemplate,
  isMeasurementEntry,
  ReportTemplateFile,
  type ProjectManifest,
  type SitePoint,
} from '@aio/schema';
import { t } from '@aio/ui';
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

const { addToReport, addManyToReport, templateStore, loadTemplate, TEMPLATE_MAX } =
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
    isMeasurementEntry(e) ? `${e.id}:${e.parts.join('+')}` : '',
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

  it('says the report is full instead of a schema error, and writes nothing', async () => {
    const at = '2026-10-20T10:00:00.000Z';
    disk.file = {
      ...emptyReportTemplate(),
      entries: Array.from({ length: TEMPLATE_MAX }, (_, i) => ({
        kind: 'measurement' as const,
        id: `x${String(i)}`,
        parts: ['value' as const],
        addedAt: at,
      })),
    };
    // the limit is the file's own
    expect(ReportTemplateFile.safeParse(disk.file).success).toBe(true);
    expect(
      ReportTemplateFile.safeParse({
        ...disk.file,
        entries: [...disk.file.entries, disk.file.entries[0]],
      }).success,
    ).toBe(false);
    await expect(addToReport('line')).rejects.toThrow(t('report.full', { count: TEMPLATE_MAX }));
    expect(disk.writes).toBe(0);
    // one there already is still "already", full or not
    expect(await addToReport('x0')).toBe('already');
  });

  it('says no project is open, in the app language', async () => {
    workspace.getState().closeProject();
    await expect(addToReport('line')).rejects.toThrow(t('report.noProject'));
  });

  it('loads the open project template', async () => {
    disk.file = { ...emptyReportTemplate() };
    await loadTemplate();
    expect(templateStore.getState()).toMatchObject({ projectId: 'p1', file: disk.file });
  });
});

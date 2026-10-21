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
  /** Measurement saves, in the order they came, with the template writes ("template"). */
  order: [] as string[],
  measureWriteFails: false,
  /** While set, a measurements write waits for it. */
  gate: null as Promise<void> | null,
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
      if (channel === 'survey:writeMeasurements') {
        disk.order.push('measurements');
        const answer = {
          ok: true,
          value: disk.measureWriteFails ? { ok: false, error: 'Disk full' } : { ok: true },
        };
        return disk.gate ? disk.gate.then(() => answer) : Promise.resolve(answer);
      }
      if (channel === 'report:writeTemplate') {
        disk.order.push('template');
        disk.writes++;
        disk.file = structuredClone(req.file ?? null);
        return Promise.resolve({ ok: true, value: { ok: true } });
      }
      return Promise.resolve({ ok: false, error: 'Not configured' });
    },
  },
}));

const {
  addToReport,
  addManyToReport,
  clearReportTemplate,
  removeFromReport,
  reportHolds,
  templateStore,
  loadTemplate,
  TEMPLATE_MAX,
} = await import('./templateStore');
const { isDirty, measureStore, saveMeasurements } = await import('../survey/measureStore');

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
  disk.order = [];
  disk.measureWriteFails = false;
  disk.gate = null;
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  measureStore.setState({
    projectId: null,
    status: 'idle',
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

  /** The store loaded for p1, with `line` and `pad` saved, and `fresh` drawn and not saved. */
  const loaded = () => {
    const saved = {
      ...emptyMeasurements(),
      measurements: [m('line', 'distance'), m('pad', 'area')],
    };
    measureStore.setState({
      projectId: 'p1',
      status: 'ready',
      readOnly: false,
      saving: false,
      file: saved,
      // the baseline as the store keeps it
      savedText: JSON.stringify(saved),
    });
    expect(isDirty(measureStore.getState())).toBe(false);
  };

  it('saves an unsaved measurement before adding it, so the report prints it', async () => {
    loaded();
    measureStore.setState((s) => ({
      file: { ...s.file, measurements: [...s.file.measurements, m('fresh', 'distance')] },
    }));
    expect(isDirty(measureStore.getState())).toBe(true);
    expect(await addToReport('fresh')).toBe('added');
    expect(disk.order).toEqual(['measurements', 'template']);
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(ids()).toEqual(['fresh:value+chart']);
  });

  it('Add to report right after Save waits for that save instead of refusing', async () => {
    loaded();
    measureStore.setState((s) => ({
      file: { ...s.file, measurements: [...s.file.measurements, m('fresh', 'distance')] },
    }));
    let open: () => void = () => undefined;
    disk.gate = new Promise<void>((r) => {
      open = r;
    });
    const saving = saveMeasurements();
    expect(measureStore.getState().saving).toBe(true);
    const adding = addToReport('fresh');
    open();
    expect(await saving).toBe(true);
    expect(await adding).toBe('added');
    // one save, the person's: nothing left to save before the add
    expect(disk.order).toEqual(['measurements', 'template']);
  });

  it('refuses with "Save the measurements first" when the save cannot be made', async () => {
    loaded();
    measureStore.setState((s) => ({
      file: { ...s.file, measurements: [...s.file.measurements, m('fresh', 'distance')] },
    }));
    disk.measureWriteFails = true;
    await expect(addToReport('fresh')).rejects.toThrow(t('report.saveFirst'));
    expect(disk.writes).toBe(0);
  });

  it('drops the entries of deleted measurements when it adds, and keeps what it does not know', async () => {
    loaded();
    const at = '2026-10-20T10:00:00.000Z';
    disk.file = {
      ...emptyReportTemplate(),
      entries: [
        { kind: 'measurement', id: 'gone', parts: ['value'], addedAt: at },
        { kind: 'banner', text: 'later build' },
        { kind: 'measurement', id: 'line', parts: ['value'], addedAt: at },
      ],
    };
    expect(await addToReport('pad')).toBe('added');
    expect(disk.file.entries.map((e) => (isMeasurementEntry(e) ? e.id : e.kind))).toEqual([
      'banner',
      'line',
      'pad',
    ]);
  });

  it('removes measurements from the report, and clears it', async () => {
    await addManyToReport(['line', 'pad']);
    expect(await removeFromReport(['line', 'nowhere'])).toEqual({ removed: ['line'] });
    expect(ids()).toEqual(['pad:value']);
    expect(templateStore.getState().file).toEqual(disk.file);
    // the sections and what a later build added stay; only the measurements go
    const at = '2026-10-20T10:00:00.000Z';
    disk.file = {
      ...emptyReportTemplate(),
      entries: [
        { kind: 'section', section: 'summary' },
        { kind: 'measurement', id: 'pad', parts: ['value'], addedAt: at },
        { kind: 'banner', text: 'later build' },
      ],
    };
    await clearReportTemplate();
    expect(disk.file.entries.map((e) => e.kind)).toEqual(['section', 'banner']);
    // nothing there: nothing written
    const writes = disk.writes;
    expect(await removeFromReport(['pad'])).toEqual({ removed: [] });
    expect(disk.writes).toBe(writes);
  });

  it('knows which measurements the report holds, once it is read for the project', async () => {
    templateStore.setState({ projectId: null, file: null, error: null });
    expect(reportHolds(['line'])).toBeNull();
    await addToReport('line');
    expect(reportHolds(['line', 'pad'])).toBe(true);
    expect(reportHolds(['pad'])).toBe(false);
  });

  it('loads the open project template', async () => {
    disk.file = { ...emptyReportTemplate() };
    await loadTemplate();
    expect(templateStore.getState()).toMatchObject({ projectId: 'p1', file: disk.file });
  });
});

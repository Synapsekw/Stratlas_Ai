// @vitest-environment jsdom
import { emptyMeasurements, type ProjectManifest, type SitePoint } from '@aio/schema';
import { actionsFor, announced, makeActionCtx, NO_HOST, t, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExportModule from '../../survey/card/exportMeasurement';

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  shell: { getState: () => ({ screen: 'scene', go: vi.fn() }) },
}));
const report = vi.hoisted(() => ({
  addManyToReport: vi.fn((ids: readonly string[]) =>
    Promise.resolve({ added: [...ids], already: [] as string[] }),
  ),
  removeFromReport: vi.fn((ids: readonly string[]) => Promise.resolve({ removed: [...ids] })),
  /** What the template holds, as last read: null when it was not read for this project. */
  inTemplate: null as string[] | null,
  reportHolds: vi.fn((ids: readonly string[]): boolean | null =>
    report.inTemplate === null ? null : ids.some((id) => report.inTemplate?.includes(id)),
  ),
}));
vi.mock('../../report/templateStore', () => report);
const exporter = vi.hoisted(() => ({
  exportMeasurement: vi.fn(() => Promise.resolve('C:/out/x.csv')),
}));
vi.mock('../../survey/card/exportMeasurement', async (orig) => ({
  ...(await orig<typeof ExportModule>()),
  exportMeasurement: exporter.exportMeasurement,
}));

const { registerReportActions } = await import('./reportActions');
const { measureStore } = await import('../../survey/measureStore');

const manifest = {
  captures: [],
  layers: [],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;
const m = (id: string, tool: 'distance' | 'area', label: string) => ({
  id,
  family: tool === 'area' ? ('polygon' as const) : ('line' as const),
  tool,
  label,
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

const notes: { text: string; danger: boolean }[] = [];
const ctx = (o: { pkg?: boolean; canEdit?: boolean } = {}) =>
  makeActionCtx({
    manifest,
    ...o,
    host: { ...NO_HOST, note: (text, danger) => notes.push({ text, danger: !!danger }) },
  });
const target = (ids: string[]): MenuTarget => ({
  kind: 'measurements',
  ids,
  clicked: ids[0] ?? '',
});
const item = (id: string, tg: MenuTarget, c = ctx()) => actionsFor(tg, c).find((i) => i.id === id);
const settle = () => new Promise((r) => setTimeout(r, 0));

let off: () => void;
beforeEach(() => {
  off = registerReportActions();
  notes.length = 0;
  report.addManyToReport.mockClear();
  report.removeFromReport.mockClear();
  report.inTemplate = null;
  exporter.exportMeasurement.mockClear();
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  // the tree sorts by name: "Alpha pad" before "Beta line"
  measureStore.setState({
    file: {
      ...emptyMeasurements(),
      measurements: [m('line', 'distance', 'Beta line'), m('pad', 'area', 'Alpha pad')],
    },
    readOnly: false,
  });
});
afterEach(() => {
  off();
  workspace.getState().closeProject();
});

describe('report and export actions', () => {
  it('adds the marked measurements in sidebar tree order and says so', async () => {
    item('measure.addToReport', target(['line', 'pad']))?.run();
    await settle();
    expect(report.addManyToReport).toHaveBeenCalledWith(['pad', 'line']);
    expect(Object.values(announced())).toContain(t('report.added'));
    expect(notes.at(-1)).toEqual({ text: t('report.added'), danger: false });
  });

  it('says already in the report when nothing was new', async () => {
    report.addManyToReport.mockResolvedValueOnce({ added: [], already: ['line'] });
    item('measure.addToReport', target(['line']))?.run();
    await settle();
    expect(notes.at(-1)).toEqual({ text: t('report.already'), danger: false });
  });

  it('shows a refused add as a failure', async () => {
    report.addManyToReport.mockRejectedValueOnce(new Error('saved by a newer version'));
    item('measure.addToReport', target(['line']))?.run();
    await settle();
    expect(notes.at(-1)).toEqual({ text: 'saved by a newer version', danger: true });
  });

  it('offers Remove from report for measurements in the report, and says so', async () => {
    report.inTemplate = ['line'];
    expect(item('measure.removeFromReport', target(['pad']))).toBeUndefined();
    const remove = item('measure.removeFromReport', target(['line', 'pad']));
    expect(remove?.label).toBe(t('report.removeFromReport'));
    remove?.run();
    await settle();
    expect(report.removeFromReport).toHaveBeenCalledWith(['line', 'pad']);
    expect(notes.at(-1)).toEqual({ text: t('report.removed'), danger: false });
    // the template not read yet: not offered (its read starts)
    report.inTemplate = null;
    expect(item('measure.removeFromReport', target(['line']))).toBeUndefined();
    // read, and the measurement went from it meanwhile: the answer says so
    report.inTemplate = ['line'];
    report.removeFromReport.mockResolvedValueOnce({ removed: [] });
    item('measure.removeFromReport', target(['line']))?.run();
    await settle();
    expect(notes.at(-1)).toEqual({ text: t('report.notIn'), danger: false });
    // greyed where Add to report is
    measureStore.setState({ readOnly: true });
    expect(item('measure.removeFromReport', target(['line']))?.disabled).toBe(
      t('actions.reason.package'),
    );
  });

  it('greys Add to report in a package and for a read-only file; Export stays', () => {
    for (const c of [ctx({ pkg: true, canEdit: false }), ctx({ canEdit: false })]) {
      expect(item('measure.addToReport', target(['line']), c)?.disabled).toBeTruthy();
      expect(item('measure.export', target(['line']), c)?.disabled).toBe(false);
    }
    measureStore.setState({ readOnly: true });
    expect(item('measure.addToReport', target(['line']))?.disabled).toBe(
      t('actions.reason.package'),
    );
    // the DXF runs in the project folder, which a package does not have
    const dxf = item('measure.export', target(['line']), ctx({ pkg: true }))?.sub.find(
      (s) => s.id === 'dxf',
    );
    expect(dxf?.disabled).toBeTruthy();
  });

  it('offers PNG only for a tool with a chart, and exports the format picked', async () => {
    const subs = (id: string) => item('measure.export', target([id]))?.sub.map((s) => s.id) ?? [];
    expect(subs('line')).toEqual(['csv', 'dxf', 'png']);
    expect(subs('pad')).toEqual(['csv', 'dxf']);
    // PNG greyed until the measurement's card shows its chart
    const pngItem = () => item('measure.export', target(['line']))?.sub.find((s) => s.id === 'png');
    expect(pngItem()?.disabled).toBe(t('mcard.chartNotShown'));
    document.body.innerHTML =
      '<section data-measure-id="line"><svg class="pc-svg"></svg></section>';
    expect(pngItem()?.disabled).toBe(false);
    document.body.innerHTML = '';
    item('measure.export', target(['pad']))?.run('csv');
    await settle();
    expect(exporter.exportMeasurement).toHaveBeenCalledWith('pad', 'csv');
  });
});

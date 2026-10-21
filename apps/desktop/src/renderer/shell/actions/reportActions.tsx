import {
  announce,
  defineAction,
  itemMeasureIds,
  registerActions,
  t,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type SubItem,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { addManyToReport, removeFromReport, reportHolds } from '../../report/templateStore';
import {
  exportChoices,
  exportMeasurement,
  type MeasurementExportFormat,
} from '../../survey/card/exportMeasurement';
import { buildMeasureItems } from '../../survey/measureRows';
import { measureStore } from '../../survey/measureStore';
import { measureEditBlocked } from './measureActions';

/*
 * The measurement actions that send a measurement out (volumetric parity W2, W8): Add to report
 * (the marked measurements, in the order the Datasets tree lists them), Remove from report (offered
 * while one of them is in the report template as read) and Export (the one the
 * menu opened on, as CSV, DXF or, where its tool draws a chart, PNG). Registered on the
 * measurement rows, so the card's "⋯" menu, built from the same registry, offers them too.
 */

type Target = Extract<MenuTarget, { kind: 'measurements' }>;

/** `ids` in the order the Datasets tree lists them (ids the tree does not list go last). */
function inTreeOrder(ids: readonly string[]): string[] {
  const ws = workspace.getState();
  const tree = buildMeasureItems(measureStore.getState(), ws.project?.manifest ?? null, {
    dates: ws.dates,
    hidden: ws.hidden,
  }).flatMap(itemMeasureIds);
  const want = new Set(ids);
  const ordered = tree.filter((id) => want.has(id));
  const listed = new Set(ordered);
  return [...ordered, ...ids.filter((id) => !listed.has(id))];
}

const FORMAT_LABEL = {
  csv: 'chart.csv',
  dxf: 'chart.dxf',
  png: 'chart.png',
} as const satisfies Record<MeasurementExportFormat, string>;

const isFormat = (s: string | undefined): s is MeasurementExportFormat =>
  s === 'csv' || s === 'dxf' || s === 'png';

const actions: readonly Action[] = [
  defineAction<'measurements'>({
    id: 'measure.addToReport',
    label: 'chart.addToReport',
    icon: 'report',
    section: 'file',
    targets: ['measurements'],
    multi: true,
    disabled: (_tg: Target, ctx: ActionCtx) => measureEditBlocked(ctx),
    run: async (tg, ctx) => {
      try {
        const r = await addManyToReport(inTreeOrder(tg.ids));
        const said = t(r.added.length > 0 ? 'report.added' : 'report.already');
        announce(said);
        ctx.host.note(said);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        announce(why, 'assertive');
        ctx.host.note(why, true);
      }
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.removeFromReport',
    label: 'report.removeFromReport',
    icon: 'x',
    section: 'file',
    targets: ['measurements'],
    multi: true,
    // offered while one of them is in the template (once it is read: asking starts the read)
    appliesTo: (tg: Target) => reportHolds(tg.ids) === true,
    disabled: (_tg: Target, ctx: ActionCtx) => measureEditBlocked(ctx),
    run: async (tg, ctx) => {
      try {
        const r = await removeFromReport(tg.ids);
        const said = t(r.removed.length > 0 ? 'report.removed' : 'report.notIn');
        announce(said);
        ctx.host.note(said);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        announce(why, 'assertive');
        ctx.host.note(why, true);
      }
    },
  }),
  defineAction<'measurements'>({
    id: 'measure.export',
    label: 'mcard.export',
    icon: 'download',
    section: 'file',
    targets: ['measurements'],
    present: 'submenu',
    // DXF greyed in a package, PNG until the measurement's chart is on screen
    submenu: (tg, ctx): SubItem[] =>
      exportChoices(tg.clicked, { pkg: ctx.pkg }).map((c) => ({
        id: c.format,
        label: t(FORMAT_LABEL[c.format]),
        testId: `measure-export-${c.format}`,
        disabled: c.disabled,
      })),
    run: async (tg, ctx, sub) => {
      if (!isFormat(sub)) return;
      try {
        const path = await exportMeasurement(tg.clicked, sub);
        if (path === null) return;
        const said = t('announce.exportDone', { file: path });
        announce(said);
        ctx.host.note(said);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        announce(why, 'assertive');
        ctx.host.note(why, true);
      }
    },
  }),
];

/** Register Add to report and Export on the measurement rows. */
export function registerReportActions(): () => void {
  return registerActions(actions);
}

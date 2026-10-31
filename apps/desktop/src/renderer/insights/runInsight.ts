/**
 * What a click in the site digest does (intelligence review I2): an action runs the right-click
 * registry's item where the insight names one (`measure.flyTo`, `date.compare`), or opens the
 * panel that answers it (Survey QA on the date, Changes on the pair); a click on the line itself
 * shows its first piece of evidence. Nothing here changes data.
 */
import type { EvidenceRef, Insight, InsightAction } from '@aio/insights';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { changeStore } from '@aio/change';
import { workspace } from '@aio/workspace';
import { openChangesTab } from '../change';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { toastHost } from '../shell/actions/toastHost';
import { revealMeasurement, select } from '../survey/measureStore';
import { openQaPanel } from '../survey/qaStore';
import { timeline } from '../workspace/timeline';

/** Run a registry item on a target; false when it is not offered or is greyed. */
function runRegistry(id: string, target: MenuTarget, sub?: string): boolean {
  const project = workspace.getState().project;
  if (!project) return false;
  registerSidebarActions();
  const pkg = shell.getState().pkg !== null;
  const item = actionsFor(
    target,
    makeActionCtx({
      manifest: project.manifest,
      hidden: workspace.getState().hidden,
      focus: timeline.getState().focus,
      pkg,
      canEdit: !pkg,
      host: toastHost(''),
    }),
  ).find((x) => x.id === id);
  if (item?.disabled !== false) return false;
  item.run(sub);
  return true;
}

function openQa(capture: string): void {
  timeline.getState().focusSurvey(capture);
  openQaPanel('qa');
}

function openChanges(pair: { from: string; to: string }): void {
  changeStore.getState().setPair(pair);
  openChangesTab();
}

/** Run one of an insight's actions; false when it could not run. */
export function runInsightAction(a: InsightAction): boolean {
  switch (a.id) {
    case 'measure.flyTo':
      return a.measurement !== undefined
        ? runRegistry(a.id, { kind: 'measurements', ids: [a.measurement], clicked: a.measurement })
        : false;
    case 'date.compare':
      return a.pair
        ? runRegistry(a.id, { kind: 'date', captureId: a.pair.from }, a.pair.to)
        : false;
    case 'insights.openQa':
      if (!a.capture) return false;
      openQa(a.capture);
      return true;
    case 'insights.openChanges':
      if (!a.pair) return false;
      openChanges(a.pair);
      return true;
  }
}

/** Show a piece of evidence: the measurement in the list, the date, its QA, or its change set. */
export function focusEvidence(e: EvidenceRef): boolean {
  switch (e.kind) {
    case 'measurement':
      select([e.id], e.id);
      revealMeasurement(e.id);
      return true;
    case 'capture':
      timeline.getState().focusSurvey(e.id);
      return true;
    case 'qa':
      openQa(e.capture);
      return true;
    case 'changeSet': {
      const set = changeStore.getState().summaries.find((s) => s.id === e.id);
      if (!set) return false;
      openChanges({ from: set.from, to: set.to });
      return true;
    }
  }
}

/** A click on the insight's line: its first evidence that can be shown. */
export function focusInsight(i: Insight): boolean {
  return i.evidence.some((e) => focusEvidence(e));
}

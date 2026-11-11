/**
 * What a click in the site digest does (intelligence review I2): an action runs the right-click
 * registry's item where the insight names one (`measure.flyTo`, `date.compare`), or opens the
 * panel that answers it (Survey QA on the date, Changes on the pair); a click on the line itself
 * shows its first piece of evidence. Nothing here changes data.
 */
import type { EvidenceRef, Insight, InsightAction } from '@aio/insights';
import { actionsFor, makeActionCtx, t, type MenuTarget } from '@aio/ui';
import { changeStore } from '@aio/change';
import { workspace } from '@aio/workspace';
import { openChangesTab } from '../change';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { toastHost } from '../shell/actions/toastHost';
import { revealMeasurement, select } from '../survey/measureStore';
import { openQaPanel } from '../survey/qaStore';
import { dispatch as reviewDispatch } from '../detections/store';
import { antennaStore, revealAntenna } from '../telecom/antennaStore';
import { timeline } from '../workspace/timeline';

/**
 * Run a registry item on a target as the right-click menu would: false, with its reason in a note,
 * when it is not offered, is greyed, or the sub item (a date to compare with) is refused.
 */
function runRegistry(id: string, target: MenuTarget, sub?: string): boolean {
  const project = workspace.getState().project;
  if (!project) return false;
  registerSidebarActions();
  const pkg = shell.getState().pkg !== null;
  const host = toastHost(t('insights.title'));
  const item = actionsFor(
    target,
    makeActionCtx({
      manifest: project.manifest,
      hidden: workspace.getState().hidden,
      focus: timeline.getState().focus,
      pkg,
      canEdit: !pkg,
      host,
    }),
  ).find((x) => x.id === id);
  if (!item) return false;
  if (item.disabled !== false) {
    host.note(item.disabled, true);
    return false;
  }
  if (sub !== undefined && item.sub.length > 0) {
    const entry = item.sub.find((x) => x.id === sub);
    const why = entry ? (entry.disabled ?? false) : t('insights.notFound');
    if (why !== false) {
      host.note(why, true);
      return false;
    }
  }
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

/** An antenna of the live inventory, shown in the Project list with its details. */
function openAntenna(unit: string): boolean {
  if (!antennaStore.getState().file?.units.some((u) => u.id === unit)) return false;
  revealAntenna(unit, undefined, 'review');
  return true;
}

/** A hot spot in Inspect: its photo opened and the detection picked. */
function openHotspot(a: { detection?: string; layer?: string; photo?: string }): boolean {
  if (!a.detection || !a.layer || !a.photo) return false;
  workspace.getState().select({ kind: 'photo', id: a.photo, layer: a.layer });
  shell.getState().go('inspect');
  reviewDispatch({ type: 'select', id: a.detection });
  return true;
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
    case 'insights.openAntenna':
      return a.unit !== undefined && openAntenna(a.unit);
    case 'insights.openHotspot':
      return openHotspot(a);
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
    case 'track':
      // the object itself: an antenna in the list, a region's pair in Changes; a hot spot only
      // through its action (it needs its photo)
      if (e.object === 'antenna') return openAntenna(e.ref);
      if (e.object === 'region') {
        const set = changeStore.getState().sets[e.ref.split('/')[0] ?? ''];
        if (!set) return false;
        openChanges({ from: set.from, to: set.to });
        return true;
      }
      return false;
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

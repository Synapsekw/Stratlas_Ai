import { t } from '@aio/ui';
import { applyAssemblyField, removeAssemblyOverrides, type ComponentsPanel } from '@aio/modelling';
import type { ProcModel } from '@aio/schema';
import type { RunState } from './runStore';

/**
 * The review panel of an engineering model (Model builder, Components) from the run store: what the
 * run found unresolved or flagged, the identity conflicts, and the model file check, with the
 * person's view state and the actions the host wires to the store. A pure function, so the host
 * (the engineering model layer, behind ENGINEERING_MODEL_UI) only mounts it.
 */
export interface ReviewUi {
  selected: string | null;
  hidden: readonly string[];
  sourceVisible: boolean;
  modelVisible: boolean;
  /** Values were changed and the model is waiting to be rebuilt. */
  stale: boolean;
  thumbnails: Readonly<Record<string, string>>;
  locked?: boolean;
}

export type ReviewHandlers = Pick<
  ComponentsPanel,
  | 'onSelect'
  | 'onToggle'
  | 'onStatus'
  | 'onRemove'
  | 'onAdd'
  | 'onField'
  | 'onFocus'
  | 'onSourceVisible'
  | 'onModelVisible'
  | 'onRebuild'
>;

type Source = Pick<RunState, 'model' | 'build' | 'report' | 'conflicts' | 'unresolved' | 'flagged'>;

/** What the model file check found, as sentences. Nothing found: nothing. */
export function checkNotes(report: RunState['report']): string[] {
  if (!report) return [];
  const out: string[] = [];
  if (report.validatorErrors > 0)
    out.push(t('review.check.errors', { count: report.validatorErrors }));
  out.push(...report.messages.slice(0, 5));
  if (report.unintendedHoles.length > 0)
    out.push(t('review.check.holes', { count: report.unintendedHoles.length }));
  if (report.openingProblems.length > 0)
    out.push(t('review.check.openings', { count: report.openingProblems.length }));
  if (!report.withinBudget) out.push(t('review.check.budget'));
  return out;
}

export function buildComponentsPanel(s: Source, ui: ReviewUi, h: ReviewHandlers): ComponentsPanel {
  const flagged = s.flagged.map((f) => `${f.id}: ${f.reason}`);
  return {
    selected: ui.selected,
    hidden: ui.hidden,
    thumbnails: ui.thumbnails,
    scale: s.model?.scale,
    sourceVisible: ui.sourceVisible,
    modelVisible: ui.modelVisible,
    unresolved: [...s.unresolved, ...flagged],
    conflicts: s.conflicts,
    report: s.build
      ? {
          failed: s.build.failed,
          simplified: s.build.simplified,
          overBudget: s.build.overBudget,
          notes: [...s.build.notes, ...checkNotes(s.report)],
        }
      : null,
    stale: ui.stale,
    ...(ui.locked !== undefined ? { locked: ui.locked } : {}),
    ...h,
  };
}

/**
 * The store call for an edit: a changed value (or a removal) is a rebuild with the person's
 * overrides, so ids and accepted components stay (`mergeModels`), not an edit of the model file.
 */
export function rebuildFor(
  model: ProcModel,
  edit: { id: string; key: string; value: number | string | boolean } | { remove: string },
) {
  return 'remove' in edit
    ? removeAssemblyOverrides(model, edit.remove)
    : applyAssemblyField(model, edit.id, edit.key, edit.value);
}

/**
 * What Ask AI looks for: everything in the project's classes, one class, or one installed local
 * detector. The list offered in the Ask AI menu, in that order.
 */
import type { DetectorWhere, IpcResponse } from '@aio/schema';
import { t } from '@aio/ui';
import type { AskBackendPref } from './prefs';

export type AskCheck =
  | { kind: 'everything' }
  | { kind: 'class'; classId: string }
  | { kind: 'detector'; where: DetectorWhere; id: string };

export type DetectorItem = IpcResponse<'detectors:list'>['items'][number];

export interface CheckOption {
  check: AskCheck;
  label: string;
}

/** Everything first, then each project class, then each installed detector (not under `cloud`). */
export function checkOptions(
  classes: readonly { id: string; label: string }[],
  detectors: readonly DetectorItem[],
  pref: AskBackendPref,
): CheckOption[] {
  return [
    { check: { kind: 'everything' }, label: t('askAi.check.everything') },
    ...classes.map((c) => ({ check: { kind: 'class', classId: c.id } as const, label: c.label })),
    ...(pref === 'cloud'
      ? []
      : detectors.map((d) => ({
          check: { kind: 'detector', where: d.where, id: d.detector.id } as const,
          label: t('askAi.check.detector', { name: d.detector.name }),
        }))),
  ];
}

export function sameCheck(a: AskCheck, b: AskCheck): boolean {
  if (a.kind === 'everything') return b.kind === 'everything';
  if (a.kind === 'class') return b.kind === 'class' && a.classId === b.classId;
  return b.kind === 'detector' && a.where === b.where && a.id === b.id;
}

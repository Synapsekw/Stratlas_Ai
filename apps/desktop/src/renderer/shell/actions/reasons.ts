import type { Capture } from '@aio/schema';
import { formatDate, t, type ActionCtx } from '@aio/ui';

/** What the greyed reasons read: a package, and whether this person may change the project. */
type EditCtx = Pick<ActionCtx, 'pkg' | 'canEdit'>;

/** Why a change to the project is greyed (a package, a reviewer who may only look), or false. */
export function editBlocked(ctx: EditCtx): string | false {
  if (ctx.pkg) return t('actions.reason.package');
  return readOnly(ctx);
}

/** Why a change is greyed for a reviewer who may only look, or false. */
export function readOnly(ctx: EditCtx): string | false {
  return ctx.canEdit ? false : t('actions.reason.readOnly');
}

/** Why a file action is greyed in a package (its files stay inside it), or false. */
export function inPackage(ctx: EditCtx): string | false {
  return ctx.pkg ? t('actions.reason.package') : false;
}

/** A survey date as the menus show it: its day, then its name when it has its own. */
export function dateLabel(c: Capture): string {
  return c.label !== c.date ? `${formatDate(c.date)} · ${c.label}` : formatDate(c.date);
}

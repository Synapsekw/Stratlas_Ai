import { useT } from '@aio/ui';
import { DateSteps } from './DatePicker';
import { useTimeline } from './timeline';

/** Keys typed into a field belong to the field: shortcuts must leave them alone. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** The survey date in focus, with arrows to step and a calendar to pick. Hidden without dates. */
export function DateBar() {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  if (!index || index.captures.length === 0 || !focus) return null;
  const at = index.captures.findIndex((c) => c.id === focus);
  return (
    <div className="dbar" role="toolbar" aria-label={t('datebar.label')} data-testid="date-bar">
      <DateSteps />
      <span className="dbar-count" data-testid="date-bar-count">
        {t('datebar.count', { n: at + 1, total: index.captures.length })}
      </span>
    </div>
  );
}

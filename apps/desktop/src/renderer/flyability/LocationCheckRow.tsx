import type { Issue } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { locationLine } from './locationCheck';

/** The location check of an imported finding, under the card's fields; nothing for any other issue. */
export function LocationCheckRow({ issue }: { issue: Issue }) {
  const t = useT();
  if (!issue.external) return null;
  const line = locationLine(issue.external);
  return (
    <div className="ic-loc" data-testid="fly-location-check" data-tone={line.tone}>
      {line.tone === 'warn' && <Icon name="warn" size={14} />}
      <span>{t(line.text, line.vars)}</span>
    </div>
  );
}

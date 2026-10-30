/**
 * A one-line pointer where a section used to be before Settings was grouped by topic: what moved,
 * and a button to the page (and section) that holds it now.
 */
import { t, type MessageKey } from '@aio/ui';
import type { ReactElement } from 'react';
import { shell } from '../../shell';
import type { SettingsFocus } from '../../store';

export function MovedNote({
  text,
  action,
  to,
  testId,
}: {
  text: MessageKey;
  action: MessageKey;
  to: SettingsFocus;
  testId: string;
}): ReactElement {
  return (
    <p className="help settings-moved" data-testid={testId}>
      {t(text)}{' '}
      <button
        type="button"
        className="btn link sm"
        onClick={() => {
          shell.getState().openSettings(to);
        }}
      >
        {t(action)}
      </button>
    </p>
  );
}

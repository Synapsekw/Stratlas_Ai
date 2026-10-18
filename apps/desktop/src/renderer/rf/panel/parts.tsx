/** Small parts the Coverage panel and the RF bench share. */
import { Switch, type SwitchProps } from '@aio/ui';
import type { ReactElement } from 'react';

/** A number with `d` decimals, as the RF bench shows its values. */
export const fmt = (n: number, d = 1): string => n.toFixed(d);

/** A switch with its name shown beside it (the Switch part names itself for assistive tech only). */
export function LabelledSwitch(props: SwitchProps): ReactElement {
  return (
    <div className="rf-switch">
      <Switch {...props} />
      <span aria-hidden="true">{props.label}</span>
    </div>
  );
}

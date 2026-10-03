import type { WindowKind } from '@aio/schema';
import { workspace } from '@aio/workspace';
import type { HTMLAttributes, ReactNode } from 'react';

interface FocusZoneProps extends HTMLAttributes<HTMLDivElement> {
  kind: WindowKind;
  children: ReactNode;
}

/** Whichever window or panel the person interacts with becomes the agent's focused window. */
export function FocusZone({ kind, children, ...rest }: FocusZoneProps) {
  const take = () => {
    if (workspace.getState().focusedWindow !== kind) workspace.getState().focus(kind);
  };
  return (
    <div {...rest} data-focus-kind={kind} onPointerDownCapture={take} onFocusCapture={take}>
      {children}
    </div>
  );
}

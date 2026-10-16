import { useEffect } from 'react';
import { actionsFor, ContextMenu, type ActionCtx, type ActionHost, type MenuTarget } from '@aio/ui';
// the menu look is the drone and photo menus' (`.dmenu`)
import '../builder/builder.css';

export interface TreeMenuRequest {
  target: MenuTarget;
  x: number;
  y: number;
  title: string;
  label: string;
  testId: string;
  host: Partial<ActionHost>;
  initialSub?: string | undefined;
}

/** A Datasets menu: the registered actions on its target, recomputed on every render. */
export function TreeMenu({
  request,
  ctx,
  onClose,
}: {
  request: TreeMenuRequest;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const items = actionsFor(request.target, { ...ctx, host: { ...ctx.host, ...request.host } });
  const empty = items.length === 0;
  // an empty menu draws nothing; let go of it so it does not reappear later
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (empty) return null;
  return (
    <ContextMenu
      items={items}
      x={request.x}
      y={request.y}
      label={request.label}
      title={request.title}
      testId={request.testId}
      initialSub={request.initialSub}
      onClose={onClose}
    />
  );
}

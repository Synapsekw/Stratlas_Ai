import { useT } from '@aio/ui';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { hitLayer, useStagePick } from '../builder/pick';
import { useToastNotice } from '../exports/useToastNotice';
import { IssueMenuMount } from './IssueMenuMount';
import { applyMovePoint, cancelMovePoint, moveSession } from './movePoint';

/**
 * Arms the 3D pick while a Move point session is open: a click on the point cloud moves the
 * finding there, Escape (or closing the prompt) cancels. It also hosts the issue register's
 * right-click menu (Place on model, Move point). The Stage mounts it.
 */
export function MovePointMount() {
  const t = useT();
  const open = useStore(moveSession, (s) => s.issueId !== null);
  useStagePick(open, (hit) => {
    const layerId = hit ? hitLayer(hit) : null;
    applyMovePoint(
      hit && layerId !== null ? { layerId, point: hit.point.toArray() } : null,
      new Date().toISOString(),
    );
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelMovePoint();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  useToastNotice(
    'fly-move-prompt',
    open
      ? {
          message: t('fly.move.prompt'),
          ttlMs: 0,
          onDismiss: cancelMovePoint,
          testId: 'fly-move-prompt',
        }
      : null,
  );
  return <IssueMenuMount />;
}

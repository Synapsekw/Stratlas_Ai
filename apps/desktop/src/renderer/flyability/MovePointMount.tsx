import { useT } from '@aio/ui';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { hitLayer, useStagePick } from '../builder/pick';
import { useToastNotice } from '../exports/useToastNotice';
import { useShell } from '../shell';
import { applyMovePoint, cancelMovePoint, moveSession } from './movePoint';

/** True once the 3D pane is on screen (the pick arms only if it is); polls while `wanted`. */
function usePaneReady(wanted: boolean): boolean {
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    const check = () => {
      const here = document.querySelector('.pane-3d') !== null;
      setFound(here);
      return here;
    };
    const timer = window.setInterval(() => {
      if (check()) window.clearInterval(timer);
    }, 100);
    const first = window.setTimeout(check, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [wanted]);
  return wanted && found;
}

/**
 * Arms the 3D pick while a Move point session is open: a click on the point cloud moves the
 * finding there, Escape (or closing the prompt) cancels, and so does leaving the Scene screen.
 * The Stage mounts it.
 */
export function MovePointMount() {
  const t = useT();
  const open = useStore(moveSession, (s) => s.issueId !== null);
  const screen = useShell((s) => s.screen);
  const ready = usePaneReady(open);
  useStagePick(ready, (hit) => {
    const layerId = hit ? hitLayer(hit) : null;
    applyMovePoint(
      hit && layerId !== null ? { layerId, point: hit.point.toArray() } : null,
      new Date().toISOString(),
    );
  });
  useEffect(
    () => () => {
      cancelMovePoint();
    },
    [],
  );
  useEffect(() => {
    if (open && screen !== 'scene') cancelMovePoint();
  }, [open, screen]);
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
  return null;
}

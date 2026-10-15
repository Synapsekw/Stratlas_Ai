import { useEffect } from 'react';
import type { EntryDialogProps } from './projectMenuModel';

/** Stub: the next task fills it in. It closes at once. */
export function CoverDialog(p: EntryDialogProps) {
  useEffect(() => {
    p.onClose();
  }, [p]);
  return null;
}

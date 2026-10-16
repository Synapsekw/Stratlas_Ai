import { NO_HOST, type ActionHost } from '@aio/ui';
import { toasts } from '../../exports/exports';

let seq = 0;

/**
 * The host of a menu opened away from the Datasets list (a notice, the 3D view): what a run says,
 * a failure above all, shows as a toast under `title` instead of going nowhere.
 */
export function toastHost(title: string): ActionHost {
  return {
    ...NO_HOST,
    note: (text, danger) => {
      seq += 1;
      const id = `menu-note-${String(seq)}`;
      const ts = toasts.getState();
      ts.start(id, title);
      ts.finish(id, danger ? 'error' : 'done', text);
    },
  };
}

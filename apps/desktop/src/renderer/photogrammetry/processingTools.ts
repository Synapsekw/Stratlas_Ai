import { shell } from '../shell';
import { photoUi } from './store';

/**
 * Where **Update processing tools** takes the person: Settings, where the processing tools are
 * installed and updated. The one place that knows the destination, so a jump straight to the
 * tools section of Settings replaces the body of this function and nothing else.
 */
export function openProcessingTools(): void {
  photoUi.getState().close();
  shell.getState().go('settings');
}

import { shell } from '../shell';
import { photoUi } from './store';

/**
 * Where **Update processing tools** takes the person: Settings, on the page that shows the
 * processing tools (the pipeline pack) of this computer. The one place that knows the
 * destination, so a jump straight to an install or update flow replaces the body of this function
 * and nothing else.
 */
export function openProcessingTools(): void {
  photoUi.getState().close();
  shell.getState().openSettingsPage('data');
}

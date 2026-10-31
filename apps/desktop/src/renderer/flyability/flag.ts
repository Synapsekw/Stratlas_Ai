import { FLYABILITY_IMPORT_UI } from '@aio/project/flags';

/** Whether the Flyability Inspector entry points are live (a function, so tests can switch it). */
export function isInspectorUiOn(): boolean {
  return FLYABILITY_IMPORT_UI;
}

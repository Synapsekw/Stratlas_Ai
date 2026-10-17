import { registerDateActions } from './dateActions';
import { registerKindActions } from './kindActions';
import { registerLayerActions } from './layerActions';
import { registerPinActions } from './pinActions';
import { registerProjectActions } from './projectActions';

let done = false;

/** Register every Datasets menu action once (the registry replaces an id registered twice). */
export function registerSidebarActions(): void {
  if (done) return;
  done = true;
  registerProjectActions();
  registerDateActions();
  registerLayerActions();
  registerKindActions();
  registerPinActions();
}

import { registerAntennaActions } from './antennaActions';
import { registerAreaActions } from './areaActions';
import { registerDateActions } from './dateActions';
import { registerKindActions } from './kindActions';
import { registerLayerActions } from './layerActions';
import { registerMeasureActions } from './measureActions';
import { registerPinActions } from './pinActions';
import { registerPositionActions } from './positionActions';
import { registerProjectActions } from './projectActions';
import { registerReportActions } from './reportActions';
import { registerRereadActions } from './rereadActions';
import { registerRfActions } from './rfActions';
import { registerThermalActions } from './thermalActions';

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
  registerPositionActions();
  registerRereadActions();
  registerMeasureActions();
  registerReportActions();
  registerAreaActions();
  registerRfActions();
  registerThermalActions();
  registerAntennaActions();
}
